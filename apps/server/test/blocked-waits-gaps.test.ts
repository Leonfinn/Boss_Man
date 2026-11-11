// QA for BOS-1171 / BOS-1172, the paths their own tests left out:
//  1. a ticket Blocked until a date wakes someone once, after the date plus the grace, and not before;
//  2. every accepted wait keeps a Blocked ticket out of both in-progress limits (company and per agent, BOS-1029),
//     and a new start is allowed at the limit while a real in-progress ticket still holds it;
//  3. an in-progress ticket with a waits-on link or a plan card waiting on the owner does not count at the limit,
//     and the board gives the reason.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runs, settings, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { agentWipCount, countInProgress } from "../src/services/agent-wip.js";
import { WATCHDOG_REASON } from "../src/services/watchdog.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const MIN = 60_000;

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const sm = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Scrum Master" })).json() as { id: string };
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const board = async () => ((await req("GET", `/api/projects/${project.id}/board`)).json() as { columns: { tickets: { id: string; wipExempt?: string | null }[] }[] }).columns.flatMap((c) => c.tickets);
  const switchOn = async () => {
    const r = await req("PATCH", `/api/companies/${company.id}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true });
    expect(r.statusCode).toBe(200);
  };
  const smWakes = () => db.select().from(wakes).where(and(eq(wakes.agentId, sm.id), eq(wakes.reason, WATCHDOG_REASON)));
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { ...built, db, close, req, company, worker, sm, project, ticket, row, board, switchOn, smWakes, advance, now: () => clock };
}

describe("a ticket Blocked until a date is flagged once the date and grace have passed (BOS-1171)", () => {
  it("nothing before the date or inside the grace; one hand-over to the Scrum Master after; none again straight away", async () => {
    ctx = await setup();
    const c = ctx;
    await c.switchOn();
    const t = await c.ticket("blocked", { blockedUntil: new Date(c.now().getTime() + 60 * MIN), blockedUntilReason: "72h of data", stateChangedAt: new Date(c.now().getTime() - 10 * MIN) });
    await c.watchdog.run();
    expect(await c.smWakes()).toHaveLength(0); // before the date
    c.advance(61 * MIN);
    await c.watchdog.run();
    expect(await c.smWakes()).toHaveLength(0); // date passed, inside the 2 h grace
    c.advance(58 * MIN); // date + 119 min: one minute short of the 2 h grace
    await c.watchdog.run();
    expect(await c.smWakes()).toHaveLength(0);
    c.advance(3 * MIN); // date + 122 min
    await c.watchdog.run();
    const wakesNow = await c.smWakes();
    expect(wakesNow).toHaveLength(1);
    expect(wakesNow[0]!.note).toContain("blocked until");
    await c.watchdog.run(); // same moment again: the flag backs off, no second wake
    expect(await c.smWakes()).toHaveLength(1);
    expect((await c.row(t.id)).systemState).toBe("blocked");
  });

  it("the Scrum Master's nudge then wakes the assignee exactly once", async () => {
    ctx = await setup();
    const c = ctx;
    await c.switchOn();
    const t = await c.ticket("blocked", { blockedUntil: new Date(c.now().getTime() + 30 * MIN), stateChangedAt: new Date(c.now().getTime() - 10 * MIN) });
    c.advance(30 * MIN + 121 * MIN);
    await c.watchdog.run();
    expect(await c.smWakes()).toHaveLength(1);
    const [run] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.sm.id, purpose: "work", startedAt: c.now() }).returning();
    await c.watchdog.nudge(c.company.id, c.sm.id, run!.id, { ticketId: t.id, reason: "the date has passed" });
    const woken = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.ticketId, t.id)));
    expect(woken).toHaveLength(1);
  });

  it("a Blocked ticket with no date is not flagged by this rule", async () => {
    ctx = await setup();
    const c = ctx;
    await c.switchOn();
    await c.ticket("blocked", { stateChangedAt: new Date(c.now().getTime() - 10 * MIN) });
    c.advance(200 * MIN);
    await c.watchdog.run();
    expect((await c.smWakes()).filter((w) => (w.note ?? "").includes("blocked until"))).toHaveLength(0);
  });
});

describe("Blocked tickets are out of both limits, whichever wait holds them (BOS-1171, BOS-1029)", () => {
  it("waits-on, plan card, date and after-merge checks all count 0; a new start is allowed at the limit", async () => {
    ctx = await setup();
    const c = ctx;
    await c.db.insert(settings).values({ key: "wip_limits", value: { agent: 1, company: 1 } });
    const blocker = await c.ticket("review");
    const byLink = await c.ticket("blocked");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: byLink.id, blockerTicketId: blocker.id, until: "merged" });
    const byPlan = await c.ticket("blocked", { planFirst: true, plan: "The plan" });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Plan?", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", tier: "ceo", context: { type: "permission", plan: true, ticketId: byPlan.id, runnerId: randomUUID(), runId: randomUUID(), requestId: "r1" } });
    await c.ticket("blocked", { blockedUntil: new Date(c.now().getTime() + 86_400_000) });
    await c.ticket("blocked", { mergedAt: new Date(), mergeCommit: "a".repeat(40), goLiveWait: "server", acceptanceCriteria: [{ text: "Panel shows the host", after: "merge" }] });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(0);
    expect(await countInProgress(c.db, eq(tickets.companyId, c.company.id))).toBe(0);

    const first = await c.ticket("ready");
    const second = await c.ticket("ready");
    await c.work.updateTicket(first.id, { state: "in_progress" });
    expect((await c.row(first.id)).systemState).toBe("in_progress"); // allowed at the limit: the blocked five don't count
    await c.work.updateTicket(second.id, { state: "in_progress" });
    expect((await c.row(second.id)).systemState).not.toBe("in_progress"); // a real in-progress ticket still holds the limit
    expect(await agentWipCount(c.db, c.worker.id)).toBe(1);
  });

  it("the company limit alone also ignores them (another agent's blocked tickets, no per-agent limit)", async () => {
    ctx = await setup();
    const c = ctx;
    await c.db.insert(settings).values({ key: "wip_limits", value: { agent: null, company: 1 } });
    await c.ticket("blocked", { blockedUntil: new Date(c.now().getTime() + 86_400_000) });
    await c.ticket("blocked", { blockedUntil: new Date(c.now().getTime() + 86_400_000) });
    const t = await c.ticket("ready");
    await c.work.updateTicket(t.id, { state: "in_progress" });
    expect((await c.row(t.id)).systemState).toBe("in_progress");
  });
});

describe("in-progress tickets that wait on a link or a plan card don't hold the limit, and the board says why (BOS-1172)", () => {
  it("a new start is allowed at the limit; the board reasons are 'waits' and 'plan'", async () => {
    ctx = await setup();
    const c = ctx;
    await c.db.insert(settings).values({ key: "wip_limits", value: { agent: 1, company: 1 } });
    const blocker = await c.ticket("review");
    const linked = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: linked.id, blockerTicketId: blocker.id, until: "done" });
    const planned = await c.ticket("in_progress", { planFirst: true, plan: "The plan" });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(0);
    const b = await c.board();
    expect(b.find((x) => x.id === linked.id)?.wipExempt).toBe("waits");
    expect(b.find((x) => x.id === planned.id)?.wipExempt).toBe("plan");

    const start = await c.ticket("ready");
    await c.work.updateTicket(start.id, { state: "in_progress" });
    expect((await c.row(start.id)).systemState).toBe("in_progress");
    expect((await c.board()).find((x) => x.id === start.id)?.wipExempt ?? null).toBeNull(); // the real one carries no reason

    const next = await c.ticket("ready");
    await c.work.updateTicket(next.id, { state: "in_progress" });
    expect((await c.row(next.id)).systemState).not.toBe("in_progress"); // limit is real again
  });

  it("a plan that is approved, or a link whose blocker is done, counts again", async () => {
    ctx = await setup();
    const c = ctx;
    const blocker = await c.ticket("review");
    const linked = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: linked.id, blockerTicketId: blocker.id, until: "done" });
    const planned = await c.ticket("in_progress", { planFirst: true, plan: "The plan" });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(0);
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed" }).where(eq(tickets.id, blocker.id));
    await c.db.update(tickets).set({ planApprovedAt: new Date() }).where(eq(tickets.id, planned.id));
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
    const b = await c.board();
    expect(b.find((x) => x.id === linked.id)?.wipExempt ?? null).toBeNull();
    expect(b.find((x) => x.id === planned.id)?.wipExempt ?? null).toBeNull();
    void agents;
  });
});
