// The workflow scorecard (docs/19-workflow-retros.md parts 1 and 5): the transition log, then the numbers built on it.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, costEvents, decisions, features, fundingSources, activity, reviewRequests, runs, ticketDependencies, ticketReviews, ticketTransitions, tickets, watchdogFlags } from "../src/db/schema.js";
import { longestPath, median, percentile, workflowService } from "../src/services/workflow.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const H = 3_600_000;
const D = 24 * H;
const NOW = new Date("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Wf Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Notes" })).json() as { id: string };
  const db = t.db;
  const agent = async (name: string, template: string) => (await db.insert(agents).values({ companyId: company.id, name, role: "worker", agentKind: "claude", template }).returning())[0]!;
  /** A ticket that walks through [state, how long ago] steps; the trigger logs each step at that time. */
  const ticket = async (steps: [string, number][], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const [first, ...rest] = steps;
    const [row] = await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: "Task", systemState: first![0] as "backlog", stateChangedAt: ago(first![1]), ...patch }).returning();
    for (const [state, at] of rest) await db.update(tickets).set({ systemState: state as "done", stateChangedAt: ago(at) }).where(eq(tickets.id, row!.id));
    return row!;
  };
  const feature = async (title: string, patch: Partial<typeof features.$inferInsert> = {}) => (await db.insert(features).values({ companyId: company.id, title, status: "in_progress", ...patch }).returning())[0]!;
  const svc = workflowService(db, { now: () => NOW });
  return { req, db, company, project, agent, ticket, feature, svc };
}

describe("ticket_transitions", () => {
  it("logs the first state, each change, and nothing for other edits", async () => {
    const c = await setup();
    const row = await c.ticket([["backlog", 3 * H], ["in_progress", 2 * H]]);
    await c.db.update(tickets).set({ title: "Renamed" }).where(eq(tickets.id, row.id));
    const log = await c.db.select().from(ticketTransitions).where(eq(ticketTransitions.ticketId, row.id)).orderBy(ticketTransitions.at);
    expect(log.map((l) => [l.fromState, l.toState])).toEqual([[null, "backlog"], ["backlog", "in_progress"]]);
    expect(log[1]!.at).toEqual(ago(2 * H));
    // The clock itself still works as before.
    const [after] = await c.db.select().from(tickets).where(eq(tickets.id, row.id));
    expect(after!.stateChangedAt).toEqual(ago(2 * H));
  });

  it("keeps the clock moving when the writer doesn't set it", async () => {
    const c = await setup();
    const row = await c.ticket([["backlog", 3 * H]]);
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, row.id));
    const [after] = await c.db.select().from(tickets).where(eq(tickets.id, row.id));
    expect(after!.stateChangedAt.getTime()).toBeGreaterThan(ago(3 * H).getTime());
    expect(await c.db.select().from(ticketTransitions).where(eq(ticketTransitions.ticketId, row.id))).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("takes percentiles and medians", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.85)).toBeCloseTo(4.4);
  });

  it("finds the heaviest chain and survives a cycle", () => {
    const n = (id: string, weight: number) => ({ id, weight });
    expect(longestPath([], [])).toEqual([]);
    // a -> b -> d is 1+1+1; a -> c -> d is 1+5+1.
    expect(longestPath([n("a", 1), n("b", 1), n("c", 5), n("d", 1)], [["a", "b"], ["b", "d"], ["a", "c"], ["c", "d"]])).toEqual(["a", "c", "d"]);
    // A loop and a self-edge are ignored rather than followed forever.
    const loop = longestPath([n("a", 1), n("b", 1), n("c", 1)], [["a", "b"], ["b", "c"], ["c", "a"], ["b", "b"]]);
    expect(loop).toHaveLength(3);
    expect(new Set(loop).size).toBe(3);
    // Edges to tickets outside the set (done, or in another feature) are ignored.
    expect(longestPath([n("a", 1)], [["a", "zzz"]])).toEqual(["a"]);
  });
});

describe("scorecard", () => {
  async function seed() {
    const c = await setup();
    const dee = await c.agent("Dee", "developer");
    const rae = await c.agent("Rae", "reviewer");
    const base = { assigneeAgentId: dee.id };
    // Three of Dee's tickets: 24h, 24h and 48h from first start to done.
    const t1 = await c.ticket([["backlog", 11 * D], ["in_progress", 9 * D], ["done", 8 * D]], base);
    const t2 = await c.ticket([["backlog", 7 * D], ["in_progress", 6 * D], ["done", 5 * D]], base);
    const t3 = await c.ticket([["backlog", 5 * D], ["in_progress", 4 * D], ["done", 2 * D]], base);
    // Enough unassigned history for the company-wide times to count (10 or more).
    for (let i = 0; i < 10; i++) await c.ticket([["backlog", 30 * D], ["in_progress", 20 * D], ["done", 19 * D]]);
    await c.db.insert(ticketReviews).values([
      { ticketId: t1.id, reviewer: "Rae", verdict: "changes_requested" },
      { ticketId: t1.id, reviewer: "Rae", verdict: "approved" },
      { ticketId: t2.id, reviewer: "Rae", verdict: "approved" },
      { ticketId: t3.id, reviewer: "Rae", verdict: "approved" },
    ]);
    await c.db.insert(reviewRequests).values([
      { ticketId: t1.id, kind: "code", reviewerAgentId: rae.id, round: 1, status: "changes_requested", createdAt: ago(9 * D), decidedAt: ago(9 * D - 2 * H) },
      { ticketId: t1.id, kind: "code", reviewerAgentId: rae.id, round: 2, status: "approved", createdAt: ago(8 * D + H), decidedAt: ago(8 * D) },
    ]);
    const [src] = await c.db.insert(fundingSources).values({ name: "Pay as you go", kind: "api_payg", provider: "anthropic" }).returning();
    const [run] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: dee.id, ticketId: t1.id, startedAt: ago(9 * D) }).returning();
    await c.db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: c.company.id, agentId: dee.id, costMicros: 3_000_000 });
    // The reviewer's run on Dee's ticket counts in the ticket's cost, not in Dee's own.
    const [review] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: rae.id, ticketId: t1.id, startedAt: ago(9 * D - H) }).returning();
    await c.db.insert(costEvents).values({ runId: review!.id, fundingSourceId: src!.id, companyId: c.company.id, agentId: rae.id, costMicros: 6_000_000 });
    await c.db.insert(watchdogFlags).values({ companyId: c.company.id, ticketId: t1.id, rule: "stale_review", openedAt: ago(8 * D) });
    await c.db.insert(decisions).values([
      { companyId: c.company.id, kind: "question", question: "A?", recommendedOption: "Yes", raisedByAgentId: dee.id, status: "answered", answer: "Yes", answeredAt: ago(D) },
      { companyId: c.company.id, kind: "question", question: "B?", recommendedOption: "Yes", raisedByAgentId: dee.id, status: "answered", answer: "No", answeredAt: ago(D) },
    ]);
    // An assignment picked up half an hour later.
    await c.db.insert(activity).values({ companyId: c.company.id, ticketId: t2.id, kind: "assigned", summary: "Assigned to Dee", at: ago(6 * D) });
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: dee.id, ticketId: t2.id, startedAt: ago(6 * D - H / 2) });
    return { ...c, dee, rae, t1 };
  }

  it("gives whole-team figures and the window before (BOS-1936)", async () => {
    const c = await seed();
    const card = await c.svc.scorecardWithPrevious(c.company.id, 7);
    // Last 7 days: t2 (5d ago) and t3 (2d ago) finished; the middle of 24h and 48h is 36h.
    expect(card.overall).toMatchObject({ done: 2, medianCycleMs: 36 * H });
    // The 7 days before (7 to 14 days ago): only t1, finished 8 days ago after 24h.
    expect(card.previous.overall).toMatchObject({ done: 1, medianCycleMs: D, watchdogFlags: 1 });
    expect(Object.keys(card.previous).sort()).toEqual(["handoffs", "overall"]);
    expect(card.previous.handoffs.find((h) => h.kind === "review")).toMatchObject({ from: "developer", to: "reviewer", count: 2 });
    // The whole team over 14 days matches the one role that finished everything.
    const wide = await c.svc.scorecard(c.company.id, 14);
    expect(wide.overall).toMatchObject({ done: 3, medianCycleMs: D, answered: 2 });
  });

  it("scores roles and agents", async () => {
    const c = await seed();
    const card = await c.svc.scorecard(c.company.id, 14);
    const dev = card.byRole.find((r) => r.role === "developer")!;
    expect(dev).toMatchObject({ done: 3, agents: 1, watchdogFlags: 1, answered: 2, overrideShare: 0.5, medianCycleMs: D, costPerDoneMicros: 3_000_000, ownCostPerDoneMicros: 1_000_000 });
    expect(card.costBasis).toBe("estimate");
    expect(dev.firstPassRate).toBeCloseTo(2 / 3);
    expect(dev.meanRework).toBeCloseTo(1 / 3);
    expect(card.byAgent).toEqual([expect.objectContaining({ agentId: c.dee.id, name: "Dee", role: "developer", done: 3 })]);
    // Nothing finished in a one-day window.
    expect((await c.svc.scorecard(c.company.id, 1)).byRole.find((r) => r.role === "developer")).toMatchObject({ done: 0, firstPassRate: null, medianCycleMs: null });
  });

  it("measures handoff waits and bounces", async () => {
    const c = await seed();
    const { handoffs } = await c.svc.scorecard(c.company.id, 14);
    expect(handoffs).toContainEqual({ from: "developer", to: "reviewer", kind: "review", count: 2, medianWaitMs: 1.5 * H, bounceRate: 0.5 });
    expect(handoffs).toContainEqual({ from: "owner", to: "developer", kind: "assign", count: 1, medianWaitMs: H / 2, bounceRate: null });
  });

  it("flags a slow feature tail and measures the lag on a released one", async () => {
    const c = await seed();
    const f = await c.feature("Search");
    const finished = (days: number) => c.ticket([["backlog", 15 * D], ["in_progress", days * D + D], ["done", days * D]], { featureId: f.id });
    await Promise.all([finished(8), finished(7), finished(6), finished(5)]);
    // The last task has been open for ten days, with nobody on it.
    const late = await c.ticket([["backlog", 12 * D], ["in_progress", 10 * D]], { featureId: f.id, title: "Wire it up" });
    const rel = await c.feature("Export", { status: "released", releasedAt: ago(D) });
    for (const days of [6, 5, 4, 1]) await c.ticket([["backlog", 9 * D], ["done", days * D]], { featureId: rel.id });

    const card = await c.svc.scorecard(c.company.id, 14);
    const open = card.features.find((x) => x.id === f.id)!;
    expect(open).toMatchObject({ tasksDone: 4, tasksTotal: 5, tailFlag: true });
    expect(open.tail).toEqual([expect.objectContaining({ id: late.id, state: "in_progress", assignee: null, ageMs: 10 * D })]);
    // Durations fall back to the company's (the developer role has fewer than 10 samples), so one task is one typical day.
    expect(open.criticalPath).toMatchObject({ chain: [expect.objectContaining({ id: late.id })], p50Ms: D, p85Ms: D, ageing: [{ id: late.id, reasons: ["Nobody is assigned", "Older than usual for this role"] }] });

    const released = card.features.find((x) => x.id === rel.id)!;
    expect(released.criticalPath).toBeNull();
    expect(released.tailLagMs).toBeCloseTo(2.25 * D);
  });

  it("gives the chain but no estimate when the company has too little history", async () => {
    const c = await setup();
    const f = await c.feature("Tiny");
    const a = await c.ticket([["ready", D]], { featureId: f.id, title: "First" });
    const b = await c.ticket([["blocked", D]], { featureId: f.id, title: "Second" });
    await c.ticket([["ready", D]], { featureId: f.id, title: "Alone" });
    await c.db.insert(ticketDependencies).values({ blockerTicketId: a.id, blockedTicketId: b.id });
    // A loop between the two must not hang it.
    await c.db.insert(ticketDependencies).values({ blockerTicketId: b.id, blockedTicketId: a.id });
    const [row] = (await c.svc.scorecard(c.company.id, 14)).features;
    expect(row!.criticalPath!.chain).toHaveLength(2);
    expect(row!.criticalPath).toMatchObject({ p50Ms: null, p85Ms: null });
    expect(row!.criticalPath!.ageing.find((x) => x.id === b.id)!.reasons).toEqual(["Nobody is assigned", "Blocked"]);
    expect(row!.tailFlag).toBe(false);
  });
});

describe("GET /api/companies/:id/workflow", () => {
  it("answers for the owner and checks the period", async () => {
    const c = await setup();
    const ok = await c.req("GET", `/api/companies/${c.company.id}/workflow?days=7`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ days: 7, byRole: [], byAgent: [], handoffs: [], features: [] });
    expect((await c.req("GET", `/api/companies/${c.company.id}/workflow`)).json().days).toBe(14);
    expect((await c.req("GET", `/api/companies/${c.company.id}/workflow?days=0`)).statusCode).toBe(400);
    expect((await c.req("GET", `/api/companies/${c.company.id}/workflow?days=91`)).statusCode).toBe(400);
    const anon = await t!.app.inject({ method: "GET", url: `/api/companies/${c.company.id}/workflow` });
    expect(anon.statusCode).toBe(401);
  });
});

describe("sizes (docs/19 part 6)", () => {
  /** A developer's finished ticket of a size: it took `cycle`, and finished `doneAgo` ago. */
  async function setupSized() {
    const c = await setup();
    const dee = await c.agent("Dee", "developer");
    const done = (size: number | null, cycle: number, doneAgo: number, patch: Partial<typeof tickets.$inferInsert> = {}) =>
      c.ticket([["backlog", doneAgo + cycle + D], ["in_progress", doneAgo + cycle], ["done", doneAgo]], { assigneeAgentId: dee.id, size, ...patch });
    return { ...c, dee, done };
  }

  it("tabulates role and size, and says which sizes behave like the next one", async () => {
    const c = await setupSized();
    for (const ago_ of [5, 6, 7, 8]) await c.done(2, D, ago_ * D);
    const threes = [];
    for (const ago_ of [3, 4, 9]) threes.push(await c.done(3, 3 * D, ago_ * D));
    for (const ago_ of [1, 2, 10]) await c.done(5, 3.2 * D, ago_ * D);
    await c.done(null, D, 2 * D);
    await c.db.insert(ticketReviews).values({ ticketId: threes[0]!.id, reviewer: "Rae", verdict: "changes_requested" });
    const [src] = await c.db.insert(fundingSources).values({ name: "Pay as you go", kind: "api_payg", provider: "anthropic" }).returning();
    const [run] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.dee.id, ticketId: threes[0]!.id, startedAt: ago(4 * D) }).returning();
    await c.db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: c.company.id, agentId: c.dee.id, costMicros: 3_000_000 });

    // The sizes table covers 90 days whatever the scorecard's own window is.
    const card = await c.svc.scorecard(c.company.id, 1);
    expect(card.sizes).toEqual([
      { role: "developer", size: 2, done: 4, p50CycleMs: D, p85CycleMs: D, meanCostMicros: 0, meanRework: 0 },
      { role: "developer", size: 3, done: 3, p50CycleMs: 3 * D, p85CycleMs: 3 * D, meanCostMicros: 1_000_000, meanRework: 1 / 3 },
      { role: "developer", size: 5, done: 3, p50CycleMs: 3.2 * D, p85CycleMs: 3.2 * D, meanCostMicros: 0, meanRework: 0 },
    ]);
    // 3s take 3 days: 0.2 from the 5s and 2 from the 2s.
    expect(card.sizeNotes).toEqual([expect.objectContaining({ role: "developer", size: 3, likeSize: 5 })]);
    // Three newest tickets per size, newest first, as reference points.
    const twos = card.sizeExamples.filter((e) => e.size === 2);
    expect(twos.map((e) => e.cycleMs)).toEqual([D, D, D]);
    expect(card.sizeExamples.filter((e) => e.size === 3)[0]).toMatchObject({ role: "developer", cycleMs: 3 * D, costMicros: 3_000_000, rework: 1 });
  });

  it("stays quiet when the sizes are spread out, or too thin to judge", async () => {
    const c = await setupSized();
    for (const [size, cycle] of [[2, 1], [3, 2], [5, 4]] as const) for (const n of [1, 2, 3]) await c.done(size, cycle * D, n * D);
    expect((await c.svc.scorecard(c.company.id, 14)).sizeNotes).toEqual([]);
    const thin = await setupSized();
    await thin.done(2, D, D);
    await thin.done(3, 3 * D, D);
    await thin.done(5, 3.2 * D, D);
    expect((await thin.svc.scorecard(thin.company.id, 14)).sizeNotes).toEqual([]);
  });

  it("times the critical path by role and size once that pair has 10 finished tickets, else by role", async () => {
    const c = await setupSized();
    for (let i = 1; i <= 14; i++) await c.done(2, D, i * D);
    for (let i = 1; i <= 10; i++) await c.done(5, 4 * D, i * D);
    // Three 3s are too few for their own 10 days: the role's times apply.
    for (let i = 1; i <= 3; i++) await c.done(3, 10 * D, i * D);
    const open = async (title: string, size: number | null) => {
      const f = await c.feature(title);
      await c.ticket([["ready", D]], { featureId: f.id, assigneeAgentId: c.dee.id, size, title });
      return f.id;
    };
    const [big, small, mid, unsized] = [await open("Big", 5), await open("Small", 2), await open("Mid", 3), await open("Unsized", null)];
    const card = await c.svc.scorecard(c.company.id, 14);
    const path = (id: string) => card.features.find((f) => f.id === id)!.criticalPath!;
    expect(path(big).p50Ms).toBe(4 * D);
    expect(path(small).p50Ms).toBe(D);
    // 27 timed tickets role-wide (fourteen 1-day, ten 4-day, three 10-day): the middle is 1 day.
    expect(path(mid).p50Ms).toBe(D);
    expect(path(unsized).p50Ms).toBe(D);
  });
});
