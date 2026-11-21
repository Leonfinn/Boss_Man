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
import { decisions, runners, settings, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
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

  // BOS-1907 criterion 2: the agent records a watch (one line and an end date) when it moves a merged ticket to Blocked.
  it("records a watch on a merged ticket, refuses one on an unmerged ticket or without a future date", async () => {
    const c = await setup();
    const agent = await c.mcp(c.worker.id);
    const crit = [{ text: "A week of real use shows no new alerts", after: "merge" as const }];
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress", mergeCommit: "d".repeat(40), mergedAt: new Date(), acceptanceCriteria: crit });
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(await c.block(agent, t.id, { watching_for: "a week with no new stuck alerts", watch_until: until })).toContain("is now blocked");
    const r = await c.row(t.id);
    expect(r.systemState).toBe("blocked");
    expect(r.watchingFor).toBe("a week with no new stuck alerts");
    expect(r.watchUntil?.toISOString()).toBe(until);
    // Already Blocked: a new line replaces the watch.
    expect(await c.block(agent, t.id, { watching_for: "two weeks, not one", watch_until: until })).toContain("is now blocked");
    expect((await c.row(t.id)).watchingFor).toBe("two weeks, not one");
    // Open-ended: only the line; the end date stays empty and the 14-day default applies (shared watchEndsAt).
    const open = await c.ticket();
    await c.put(open.id, { systemState: "in_progress", mergeCommit: "e".repeat(40), mergedAt: new Date(), acceptanceCriteria: crit });
    expect(await c.block(agent, open.id, { watching_for: "the nightly job" })).toContain("is now blocked");
    expect((await c.row(open.id)).watchUntil).toBeNull();
    // Refused: not merged, a past date, a date without a line.
    const plain = await c.ticket();
    expect(await c.block(agent, plain.id, { watching_for: "x", blocked_until: tomorrow(), blocked_reason: "y" })).toMatch(/has not merged/);
    // test-lines-ok: a date one second in the past is refused however slow the machine is
    expect(await c.block(agent, t.id, { watching_for: "x", watch_until: new Date(Date.now() - 1000).toISOString() })).toMatch(/must be in the future/);
    expect(await c.block(agent, t.id, { watch_until: until })).toMatch(/goes with watching_for/);
  });

  it("accepts a merged ticket waiting to go live, but not a live one whose after-merge checks are all that is left (R36)", async () => {
    const c = await setup();
    const t = await c.ticket();
    const crit = [{ text: "Panel shows the host", after: "merge" as const }];
    await c.put(t.id, { systemState: "in_progress", mergeCommit: "a".repeat(40), goLiveWait: "server", acceptanceCriteria: crit });
    const agent = await c.mcp(c.worker.id);
    expect(await c.block(agent, t.id)).toContain("is now blocked");
    expect((await c.row(t.id)).systemState).toBe("blocked");

    // BOS-1907 (criterion 3): live now, with the checks unreported and no date, link or card: accepted ("Merged, watching").
    const live = await c.ticket();
    await c.put(live.id, { systemState: "in_progress", mergeCommit: "c".repeat(40), goLiveWait: null, acceptanceCriteria: crit });
    expect(await c.block(agent, live.id)).toContain("is now blocked");
    expect((await c.row(live.id)).systemState).toBe("blocked");

    // Every after-merge check already reported: nothing is left to watch, so the hold is gone and Blocked refuses it.
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
    await c.put(merged.id, { systemState: "blocked", stateChangedAt: old, mergeCommit: "a".repeat(40), goLiveWait: "server", acceptanceCriteria: [{ text: "Panel shows the host", after: "merge" as const }] });
    // BOS-1907: live, with after-merge checks unreported and nothing else holding it: stays in Blocked ("Merged, watching"; R36 used to free it).
    const live = await c.ticket();
    await c.put(live.id, { systemState: "blocked", stateChangedAt: old, mergeCommit: "b".repeat(40), goLiveWait: null, acceptanceCriteria: [{ text: "Panel shows the host", after: "merge" as const }] });
    await c.sweeps.run();
    expect((await c.row(stranded.id)).systemState).toBe("ready");
    expect((await c.row(stranded.id)).stateNote).toMatch(/^Ready: nothing is holding it any more/);
    for (const id of [withCard.id, withDate.id, merged.id, live.id]) expect((await c.row(id)).systemState).toBe("blocked");
  });

  it("refuses a note that names a colleague with only a date behind it, and accepts it once their ticket is linked (R36)", async () => {
    const c = await setup();
    const other = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Brian - Release Manager" })).json();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress" });
    const agent = await c.mcp(c.worker.id);
    const args = { blocked_until: tomorrow(), blocked_reason: "redeploy", summary: "Waiting for Brian's redeploy." };
    const msg = await c.block(agent, t.id, args);
    expect(msg).toMatch(/waits on Brian/);
    expect((await c.row(t.id)).systemState).toBe("in_progress");
    const theirs = await c.ticket({ assigneeAgentId: other.id });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerTicketId: theirs.id, until: "done" });
    expect(await c.block(agent, t.id, args)).toContain("is now blocked");
    // No name, a date alone: still fine.
    const u = await c.ticket();
    await c.put(u.id, { systemState: "in_progress" });
    expect(await c.block(agent, u.id, { blocked_until: tomorrow(), blocked_reason: "72h of data", summary: "Collecting data." })).toContain("is now blocked");
  });

  it("BOS-2141: a merged ticket in its watch is refused a note that names a colleague without a link, but a quiet watch note is accepted", async () => {
    const c = await setup();
    const other = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Brian - Release Manager" })).json();
    const crit = [{ text: "Panel shows the host", after: "merge" as const }];
    const agent = await c.mcp(c.worker.id);
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress", mergeCommit: "d".repeat(40), goLiveWait: null, acceptanceCriteria: crit });
    expect(await c.block(agent, t.id, { summary: "Waiting on Brian's check." })).toMatch(/waits on Brian/);
    expect((await c.row(t.id)).systemState).toBe("in_progress");
    // No name, no date: still "Merged, watching" (BOS-1907).
    expect(await c.block(agent, t.id, { summary: "Watching for a week of real use." })).toContain("is now blocked");
    // Named and linked: accepted.
    const u = await c.ticket();
    await c.put(u.id, { systemState: "in_progress", mergeCommit: "e".repeat(40), goLiveWait: null, acceptanceCriteria: crit });
    const theirs = await c.ticket({ assigneeAgentId: other.id });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: u.id, blockerTicketId: theirs.id, until: "done" });
    expect(await c.block(agent, u.id, { summary: "Waiting on Brian's check." })).toContain("is now blocked");
  });

  it("wakes the CEO once on the third date-only park in a row (R36)", async () => {
    const c = await setup();
    const t = await c.ticket();
    const agent = await c.mcp(c.worker.id);
    const ceoWakes = async () => (await c.db.select().from(wakes).where(eq(wakes.ticketId, t.id))).filter((w) => w.agentId === c.ceo.id).length;
    for (let i = 1; i <= 4; i++) {
      await c.put(t.id, { systemState: "in_progress" });
      expect(await c.block(agent, t.id, { blocked_until: tomorrow(), blocked_reason: "waiting for data", summary: `Park ${i}.` })).toContain("is now blocked");
      expect(await ceoWakes(), `after park ${i}`).toBe(i === 3 ? 1 : 0); // put() clears the ticket's wakes each round, so a 4th wake would show
    }
  });
});

describe("one 'held in Blocked' rule on the way in and the way out (BOS-1532, DR-061 Q2a)", () => {
  const card = (c: Awaited<ReturnType<typeof setup>>, ticketId: string) =>
    c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", tier: "ceo", context: { type: "permission", plan: true, ticketId, runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID() } }).returning();

  it("answering a linked card does not release a ticket whose date is still ahead", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "blocked", blockedUntil: new Date(Date.now() + 86_400_000) });
    const [d] = await card(c, t.id);
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve plan" });
    expect((await c.row(t.id)).systemState).toBe("blocked");
  });

  it("answering one card does not release a ticket another open card (not linked) still names", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "blocked" });
    const [a] = await card(c, t.id);
    await card(c, t.id);
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: a!.id });
    await c.req("POST", `/api/decisions/${a!.id}/answer`, { answer: "Approve plan" });
    expect((await c.row(t.id)).systemState).toBe("blocked");
  });

  it("answering the last card releases a ticket whose date has passed", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "blocked", blockedUntil: new Date(Date.now() - 3_600_000) });
    const [d] = await card(c, t.id);
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve plan" });
    expect((await c.row(t.id)).systemState).toBe("ready");
  });

  it("the stranded sweep releases a ticket whose date has passed and keeps a go-live wait", async () => {
    const c = await setup();
    const old = new Date(Date.now() - 3_600_000);
    const past = await c.ticket();
    const live = await c.ticket();
    await c.put(past.id, { systemState: "blocked", stateChangedAt: old, blockedUntil: new Date(Date.now() - 1_800_000) });
    await c.put(live.id, { systemState: "blocked", stateChangedAt: old, goLiveWait: "own" });
    await c.sweeps.run();
    expect((await c.row(past.id)).systemState).toBe("ready");
    expect((await c.row(live.id)).systemState).toBe("blocked");
  });

  it("Blocked accepts a go-live wait, as the sweep keeps it", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "in_progress", mergeCommit: "a".repeat(40), goLiveWait: "own" });
    expect(await c.block(await c.mcp(c.worker.id), t.id)).toContain("is now blocked");
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
