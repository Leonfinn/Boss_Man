// BOS-1161: a question card can name the condition that clears it (clearsWhen), more events flag a card
// "may be out of date" and wake its author, and a new plan card for a ticket supersedes the older ones.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { alertClearing } from "../src/services/alert-clearing.js";
import { runnerRebuilt, STALE_REASON, STATE_CHANGE_GRACE_MS, ticketStateChanged } from "../src/services/stale-requests.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id })).json() as { id: string };
  return { ...built, db, close, company, worker, mcp, clients, ticket, req };
}

/** The runner's hello on an image built from `commit`; says whether Boss Man took it as a finished rebuild. */
async function helloOf(c: Awaited<ReturnType<typeof setup>>) {
  const reg = (await c.req("POST", `/api/companies/${c.company.id}/runner`)).json() as { runnerId: string };
  const [r] = await c.db.select().from(runners).where(eq(runners.id, reg.runnerId));
  return async (commit: string) => (await c.runners.touch(r!, "img", undefined, commit)).imageChanged;
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type S = Awaited<ReturnType<typeof setup>>;
async function ask(c: S, args: Record<string, unknown>) {
  const mcp = await c.mcp(c.worker.id);
  const r = await mcp.callTool({ name: "raise_decision", arguments: { options: ["Wait", "Go on"], recommended: "Wait", triedFirst: "Looked at the live state", ...args } });
  const id = /Decision ([0-9a-f-]{36})/.exec(textOf(r))?.[1];
  return { r, id };
}
const closer = (c: S, liveCommit: string | null = null) => alertClearing(c.db, { isConnected: () => false, hasRoom: async () => true, liveCommit: () => liveCommit });
const cardOf = async (c: S, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;

describe("clearsWhen on raise_decision (BOS-1161)", () => {
  it("closes a card by itself when the ticket it names merges, and records why", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("The fix");
    const { id } = await ask(c, { question: "Shall I wait for the fix to merge?", clearsWhen: { ticketMerged: t.id } });
    expect(id).toBeTruthy();
    expect(await closer(c).check()).toBe(0);
    expect((await cardOf(c, id!)).status).toBe("open");

    await c.db.update(tickets).set({ mergeCommit: SHA_A }).where(eq(tickets.id, t.id));
    expect(await closer(c).check()).toBe(1);
    const done = await cardOf(c, id!);
    expect(done.status).toBe("withdrawn");
    expect(JSON.stringify(done.context)).toMatch(/is merged/);
    expect((done.context as { withdrawn: { by: string } }).withdrawn.by).toBe("system");
  });

  it("closes a card once the runners are rebuilt (the image commit changes), not before", async () => {
    const c = (ctx = await setup());
    const hello = await helloOf(c);
    expect(await hello(SHA_A)).toBe(true); // the first image commit seen counts as a change
    const { id } = await ask(c, { question: "Shall I wait for the runner rebuild?", clearsWhen: { runnerRebuilt: true } });
    expect(await closer(c).check()).toBe(0);
    expect(await hello(SHA_A)).toBe(false); // a reconnect on the same image is not a rebuild
    expect(await closer(c).check()).toBe(0);
    expect(await hello(SHA_B)).toBe(true);
    expect(await closer(c).check()).toBe(1);
    expect((await cardOf(c, id!)).status).toBe("withdrawn");
  });

  it("closes a card when the running server contains the commit, judged from merge order", async () => {
    const c = (ctx = await setup());
    const first = await c.ticket("First");
    const second = await c.ticket("Second");
    // Merge order is the order tickets finished: the gate merges one at a time.
    await c.db.update(tickets).set({ systemState: "done", mergeCommit: SHA_A, stateChangedAt: new Date("2026-11-11T10:00:00Z") }).where(eq(tickets.id, first.id));
    await c.db.update(tickets).set({ systemState: "done", mergeCommit: SHA_B, stateChangedAt: new Date("2026-11-11T11:00:00Z") }).where(eq(tickets.id, second.id));
    const { id } = await ask(c, { question: "Shall I wait for the deploy with the first fix?", clearsWhen: { serverHasCommit: SHA_B.slice(0, 12) } });
    expect(id).toBeTruthy();
    expect(await closer(c, SHA_A).check()).toBe(0); // the server runs the older merge
    expect((await cardOf(c, id!)).status).toBe("open"); // stays open, and the sweep did not throw
    expect(await closer(c, null).check()).toBe(0); // unknown live commit never clears
    expect(await closer(c, SHA_B).check()).toBe(1);
    expect(JSON.stringify((await cardOf(c, id!)).context)).toMatch(/server running now contains/);
  });

  it("refuses a condition it could never check, and an empty clearsWhen", async () => {
    const c = (ctx = await setup());
    const unknown = await ask(c, { question: "Wait for a deploy?", clearsWhen: { serverHasCommit: "c".repeat(12) } });
    expect(isError(unknown.r)).toBe(true);
    expect(textOf(unknown.r)).toMatch(/can't place that commit/);
    const foreign = await ask(c, { question: "Wait for the ticket?", clearsWhen: { ticketDone: randomUUID() } });
    expect(isError(foreign.r)).toBe(true);
    const empty = await ask(c, { question: "Wait for nothing?", clearsWhen: {} });
    expect(isError(empty.r)).toBe(true);
    expect(textOf(empty.r)).toMatch(/names no condition/);
  });

  it("never closes a card that names no condition, however much changes", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("The fix");
    const { id } = await ask(c, { question: "Shall I carry on?", blocksTicketId: t.id });
    await c.db.update(tickets).set({ mergeCommit: SHA_A, systemState: "done" }).where(eq(tickets.id, t.id));
    await (await helloOf(c))(SHA_B);
    expect(await closer(c, SHA_B).check()).toBe(0);
    expect((await cardOf(c, id!)).status).toBe("open");
  });
});

describe("more events flag a card and wake its author (BOS-1161)", () => {
  it("a runner rebuild flags open cards that talk about the runners, wakes the author once, and closes nothing", async () => {
    const c = (ctx = await setup());
    const about = await ask(c, { question: "Shall I wait for you to press Build and update runners?" });
    const other = await ask(c, { question: "Which colour for the header?" });
    const wake = async () => runnerRebuilt(c.db, { companyId: c.company.id, wake: (input) => c.scheduler.notify(input.agentId, input as { ticketId: string; reason: string; note: string }) });
    const r = await wake();
    expect(r.flaggedDecisions).toEqual([about.id]);
    const card = await cardOf(c, about.id!);
    expect(card.status).toBe("open");
    expect(card.staleReason).toMatch(/runners were rebuilt/);
    expect((await cardOf(c, other.id!)).staleAt).toBeNull();
    expect((await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON))))).toHaveLength(1);
    // A second rebuild leaves the already-flagged card and wakes nobody again.
    expect((await wake()).flaggedDecisions).toEqual([]);
  });

  it("flags a card whose own ticket changed state after the grace period, and not one that moved while raising it", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("The plan");
    const { id } = await ask(c, { question: "Is this the right approach?", blocksTicketId: t.id });
    const wake = () => ticketStateChanged(c.db, { wake: (input) => c.scheduler.notify(input.agentId, input as { ticketId: string; reason: string; note: string }) });
    // Raising the card blocks the ticket: that move is inside the grace period and is not an event.
    expect((await wake()).flaggedDecisions).toEqual([]);
    const card = await cardOf(c, id!);
    await c.db.update(tickets).set({ stateChangedAt: new Date(card.createdAt.getTime() + STATE_CHANGE_GRACE_MS + 60_000) }).where(eq(tickets.id, t.id));
    expect((await wake()).flaggedDecisions).toEqual([id]);
    const flagged = await cardOf(c, id!);
    expect(flagged.status).toBe("open");
    expect(flagged.staleReason).toMatch(/ticket it is about changed state/);
    expect((await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON))))).toHaveLength(1);
    expect((await wake()).flaggedDecisions).toEqual([]);
  });

  it("a ticket merging flags the open cards about it and wakes the author", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("The fix");
    const { id } = await ask(c, { question: "Shall I go on without the owner's say?", blocksTicketId: t.id });
    await c.scheduler.onTicketMerged(t.id);
    const card = await cardOf(c, id!);
    expect(card.staleReason).toMatch(/merged/);
    expect(card.status).toBe("open");
  });
});

describe("a new plan card supersedes the older ones for the ticket (BOS-1161)", () => {
  it("closes the older open plan card, records which card replaced it, and frees the hold", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Big change");
    const plan = (text: string) => c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: `Plan: ${text}`, options: ["Approve plan", "Keep planning"], recommended: "Approve plan", blocksTicketId: t.id, triedFirst: "Investigated", plan: text });
    const older = await plan("first draft");
    const other = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "A plain question on the same ticket?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Looked" });
    const newer = await plan("second draft");

    const old = await cardOf(c, older.id);
    expect(old.status).toBe("withdrawn");
    expect((old.context as { withdrawn: { by: string; note: string } }).withdrawn).toMatchObject({ by: "system", note: `superseded by ${newer.id}` });
    expect((await cardOf(c, newer.id)).status).toBe("open");
    expect((await cardOf(c, other.id)).status).toBe("open"); // only plan cards are superseded
  });

  it("does not close a plan card on another ticket", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket("Ticket A");
    const b = await c.ticket("Ticket B");
    const plan = (ticketId: string) => c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: `Plan for ${ticketId}`, options: ["Approve plan", "Keep planning"], recommended: "Approve plan", blocksTicketId: ticketId, triedFirst: "Investigated", plan: "the plan" });
    const forA = await plan(a.id);
    await plan(b.id);
    expect((await cardOf(c, forA.id)).status).toBe("open");
  });
});
