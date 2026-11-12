// BOS-1171: Blocked is for every kind of wait. set_ticket_state blocked accepts a waits-on ticket, an open card (plan
// cards too), a blocked_until date and a merged ticket with after-merge checks left; a plan card moves its ticket to
// Blocked by itself; and blocked tickets never count toward the in-progress limits.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, settings, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { agentWipCount } from "../src/services/agent-wip.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close().catch(() => undefined))), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const ticket = async (fields: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id, ...fields })).json() as { id: string };
  const put = async (id: string, patch: Partial<typeof tickets.$inferInsert>) => {
    await db.update(tickets).set(patch).where(eq(tickets.id, id));
    await db.delete(wakes).where(eq(wakes.ticketId, id));
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const block = async (c: Client, ticketId: string, extra: Record<string, unknown> = {}) =>
    textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId, state: "blocked", summary: "Waiting.", ...extra } }));
  return { ...built, db, req, company, ceo, worker, project, sent, emit, ticket, put, row, mcp, block };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

describe("Blocked accepts every kind of wait (BOS-1171)", () => {
  it("refuses a ticket with nothing it waits on, and the message lists the accepted waits", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress" });
    const msg = await c.block(await c.mcp(c.worker.id), t.id);
    expect(msg).toMatch(/waits on another ticket/);
    expect(msg).toMatch(/plan card included/);
    expect(msg).toMatch(/blocked_until/);
    expect(msg).toMatch(/after-merge/);
    expect((await c.row(t.id)).systemState).toBe("in_progress");
  });

  it("accepts a known date (blocked_until with blocked_reason)", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress" });
    expect(await c.block(await c.mcp(c.worker.id), t.id, { blocked_until: tomorrow(), blocked_reason: "72h of data" })).toContain("is now blocked");
    const r = await c.row(t.id);
    expect(r.systemState).toBe("blocked");
    expect(r.blockedUntilReason).toBe("72h of data");
  });

  it("accepts an open card on the ticket, a plan card included, even when it is not linked", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress" });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", tier: "ceo", context: { type: "permission", plan: true, ticketId: t.id, runnerId: randomUUID(), runId: randomUUID(), requestId: "r1" } });
    expect(await c.block(await c.mcp(c.worker.id), t.id)).toContain("is now blocked");
    expect((await c.row(t.id)).systemState).toBe("blocked");
  });

  it("accepts a merged ticket with after-merge criteria not yet reported, and refuses one with none left", async () => {
    const c = await setup();
    const t = await c.ticket();
    const crit = [{ text: "Panel shows the host", after: "merge" as const }];
    await c.put(t.id, { systemState: "in_progress", mergeCommit: "a".repeat(40), acceptanceCriteria: crit });
    const agent = await c.mcp(c.worker.id);
    expect(await c.block(agent, t.id)).toContain("is now blocked");
    expect((await c.row(t.id)).systemState).toBe("blocked");

    const u = await c.ticket();
    await c.put(u.id, { systemState: "in_progress", mergeCommit: "b".repeat(40), acceptanceCriteria: crit, stateNote: "1 pass" });
    expect(await c.block(agent, u.id)).toMatch(/Blocked is for a ticket that only waits/);
  });

  it("a plan card moves its ticket to Blocked by itself, and answering it releases the ticket", async () => {
    const c = await setup();
    const t = await c.ticket({ planFirst: true, state: "ready" });
    await c.db.delete(wakes);
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    expect((await c.row(t.id)).systemState).toBe("in_progress");
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p1", title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once", "allow_always", "reject_once"], detail: "1. Do it." });
    expect((await c.row(t.id)).systemState).toBe("blocked");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve plan" });
    expect((await c.row(t.id)).systemState).not.toBe("blocked");
  });
});

describe("Blocked on an open card is freed when the card is answered (BOS-1209)", () => {
  const plan = (c: Awaited<ReturnType<typeof setup>>, ticketId: string) =>
    c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", tier: "ceo", context: { type: "permission", plan: true, ticketId, runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID() } }).returning();

  it("an unlinked card the agent blocked on gets a hold row, so the answer releases the ticket with a plain note", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress" });
    const [d] = await plan(c, t.id);
    expect(await c.block(await c.mcp(c.worker.id), t.id)).toContain("is now blocked");
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve plan" });
    const r = await c.row(t.id);
    expect(r.systemState).toBe("ready");
    expect(r.stateNote).toMatch(/^Ready: the owner answered "Plan\?" \(Approve plan\)\. Starts when Engineer has a free slot\.$/);
  });

  it("the sweep frees a Blocked ticket nothing holds, but not one with a card, a date or an unreported after-merge check", async () => {
    const c = await setup();
    const old = new Date(Date.now() - 3_600_000);
    const stranded = await c.ticket();
    const withCard = await c.ticket();
    const withDate = await c.ticket();
    const merged = await c.ticket();
    await c.put(stranded.id, { systemState: "blocked", stateChangedAt: old, stateNote: "Waiting on the owner." });
    await c.put(withCard.id, { systemState: "blocked", stateChangedAt: old });
    await plan(c, withCard.id);
    await c.put(withDate.id, { systemState: "blocked", stateChangedAt: old, blockedUntil: new Date(Date.now() + 86_400_000) });
    await c.put(merged.id, { systemState: "blocked", stateChangedAt: old, mergeCommit: "a".repeat(40), acceptanceCriteria: [{ text: "Panel shows the host", after: "merge" as const }] });
    await c.sweeps.run();
    expect((await c.row(stranded.id)).systemState).toBe("ready");
    expect((await c.row(stranded.id)).stateNote).toMatch(/^Ready: nothing is holding it any more/);
    for (const id of [withCard.id, withDate.id, merged.id]) expect((await c.row(id)).systemState).toBe("blocked");
  });
});

describe("blocked tickets do not count toward the in-progress limits (BOS-1171)", () => {
  it("an agent with blocked tickets can still start new ones, and the count ignores them", async () => {
    const c = await setup();
    await c.db.insert(settings).values({ key: "wip_limits", value: { agent: 2, company: 2 } });
    for (let i = 0; i < 3; i++) {
      const b = await c.ticket();
      await c.put(b.id, { systemState: "blocked" });
    }
    expect(await agentWipCount(c.db, c.worker.id)).toBe(0);
    const a = await c.ticket();
    const b = await c.ticket();
    await c.put(a.id, { systemState: "ready" });
    await c.put(b.id, { systemState: "ready" });
    await c.work.updateTicket(a.id, { state: "in_progress" });
    await c.work.updateTicket(b.id, { state: "in_progress" });
    expect((await c.row(a.id)).systemState).toBe("in_progress");
    expect((await c.row(b.id)).systemState).toBe("in_progress");
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
  });
});
