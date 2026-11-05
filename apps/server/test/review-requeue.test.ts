// BOS-433 (BOS-428 fix B): a review wake that leaves tickets unanswered re-queues them at once, one per
// wake; the stall count covers only the current round's unanswered wakes; and a run cut off by a restart
// (interrupted, or lost by the server) is not a missed verdict for either no-verdict detector.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { SENIOR_DEV_TEMPLATE } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, reviewRequests, runs, tickets, wakes } from "../src/db/schema.js";
import { REVIEW_REASON } from "../src/services/scheduler.js";

const HOUR = 3_600_000;
const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined as never;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const hire = async (name: string, set: Partial<typeof agents.$inferInsert> = {}) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    if (Object.keys(set).length) await db.update(agents).set(set).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "review", ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  const advance = (ms: number) => (offset += ms);
  const reviewWakes = (agentId: string) => db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.reason, REVIEW_REASON)));
  const stallCards = () => db.select().from(decisions).where(like(decisions.dedupeKey, "review-stall:%"));
  const silentCards = (id: string) => db.select().from(decisions).where(like(decisions.dedupeKey, `review-silent:${id}:%`));
  return { ...built, db, close, req, company, worker, project, hire, ticket, advance, reviewWakes, stallCards, silentCards };
}

/** A review wake that named several tickets and ended having answered none of them. */
async function ranReviewWake(reviewerId: string, ticketIds: string[], outcome = "end_turn") {
  const [run] = await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: reviewerId, startedAt: new Date(Date.now() - MIN), endedAt: new Date(), outcome, origin: REVIEW_REASON }).returning();
  await ctx.db.insert(wakes).values({
    companyId: ctx.company.id,
    agentId: reviewerId,
    reason: REVIEW_REASON,
    status: "launched",
    runId: run!.id,
    note: ticketIds.map((id) => `- ${id} "ticket": ready`).join("\n"),
    createdAt: new Date(Date.now() - 2 * MIN),
  });
  return run!;
}

describe("a review wake that leaves tickets unanswered", () => {
  it("re-wakes the reviewer for each ticket it did not answer, one wake per ticket", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
    const ids = [await ctx.ticket("A"), await ctx.ticket("B"), await ctx.ticket("C")];
    for (const id of ids) await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 1 });
    const run = await ranReviewWake(reviewer.id, ids);
    // The reviewer gave a verdict on A only.
    await ctx.db.update(reviewRequests).set({ status: "approved", decidedAt: new Date() }).where(eq(reviewRequests.ticketId, ids[0]!));

    await ctx.scheduler.afterReviewRun(run.id);
    const fresh = (await ctx.reviewWakes(reviewer.id)).filter((w) => w.note?.startsWith(`- ${ids[1]}`) || w.note?.startsWith(`- ${ids[2]}`));
    // One wake for B, one for C; A is answered and left alone (the original multi-ticket wake stays as history).
    expect(fresh.map((w) => w.note!.match(/^- ([0-9a-f-]{36}) /)![1]).sort()).toEqual([ids[1], ids[2]].sort());
    expect(fresh).toHaveLength(2);
  });

  it("does nothing for a single-ticket wake, or a run cut off by a restart", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
    const only = await ctx.ticket("Only");
    await ctx.db.insert(reviewRequests).values({ ticketId: only, kind: "code", reviewerAgentId: reviewer.id, round: 1 });
    const single = await ranReviewWake(reviewer.id, [only]);
    expect(await ctx.scheduler.afterReviewRun(single.id)).toEqual([]);
    const before = (await ctx.reviewWakes(reviewer.id)).length;

    const a = await ctx.ticket("A");
    const b = await ctx.ticket("B");
    for (const id of [a, b]) await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 1 });
    const cut = await ranReviewWake(reviewer.id, [a, b], "interrupted");
    expect(await ctx.scheduler.afterReviewRun(cut.id)).toEqual([]);
    // Only the original wake (and the cut one) exist: the interrupted run re-queued nothing.
    expect((await ctx.reviewWakes(reviewer.id)).length).toBe(before + 1);
  });
});

describe("the stall count covers only the current round", () => {
  it("does not report a reviewer who answered rounds 1-2 for round 3 until round 3 is missed twice", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Back again");

    // Round 1 and 2 were answered: their wakes and verdicts are history.
    for (const round of [1, 2]) {
      await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round, status: "changes_requested", createdAt: new Date(Date.now() - 5 * HOUR) });
      await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: reviewer.id, ticketId: id, reason: REVIEW_REASON, status: "launched", note: `- ${id} "x": r${round}`, createdAt: new Date(Date.now() - 4 * HOUR) });
    }
    // Round 3 opened 40 minutes ago with no wakes yet. The old rounds' wakes don't count for it, so it
    // starts from zero: this round's first wake goes out, and no card is raised.
    await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 3, createdAt: new Date(Date.now() - 40 * MIN) });
    expect((await ctx.sweeps.run()).stalledReviews).toEqual({ woken: 1, gaveUp: 0 });
    expect(await ctx.stallCards()).toHaveLength(0);
    const settle = () => ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.reason, REVIEW_REASON));
    await settle();

    // Round 3 must actually be missed before the card is raised, not count the two answered rounds: the
    // card stays away after two wakes in this round, and only a third unanswered wake raises it.
    ctx.advance(31 * MIN);
    expect((await ctx.sweeps.run()).stalledReviews).toMatchObject({ woken: 1, gaveUp: 0 });
    expect(await ctx.stallCards()).toHaveLength(0);
    await settle();
    ctx.advance(31 * MIN);
    expect((await ctx.sweeps.run()).stalledReviews).toMatchObject({ woken: 1, gaveUp: 0 });
    expect(await ctx.stallCards()).toHaveLength(0);
    await settle();
    ctx.advance(31 * MIN);
    expect((await ctx.sweeps.run()).stalledReviews).toMatchObject({ gaveUp: 1 });
    expect(await ctx.stallCards()).toHaveLength(1);
  });

  it("keeps BOS-404's action card rather than a bare 'Got it'", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Stuck");
    await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 1, createdAt: new Date(Date.now() - 4 * HOUR) });
    for (const h of [3, 2, 1]) {
      await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: reviewer.id, ticketId: id, reason: REVIEW_REASON, status: "launched", note: `- ${id} "x": r1`, createdAt: new Date(Date.now() - h * HOUR) });
    }
    await ctx.sweeps.run();
    const [card] = await ctx.stallCards();
    expect(card!.options).not.toEqual(["Got it"]);
    expect(card!.options).toEqual(expect.arrayContaining(["Take the review myself", "Give it to another reviewer", "Send it back to the author", "Leave it another hour"]));
  });
});

describe("interrupted or lost review runs are not a missed verdict", () => {
  const runAt = async (reviewerId: string, ticketId: string, outcome: string, startedAgoMin: number) => {
    const [run] = await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: reviewerId, startedAt: new Date(Date.now() - startedAgoMin * MIN), endedAt: new Date(Date.now() - (startedAgoMin - 10) * MIN), outcome }).returning();
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: reviewerId, reason: REVIEW_REASON, status: "launched", runId: run!.id, note: `- ${ticketId} "x": r1`, createdAt: new Date(Date.now() - startedAgoMin * MIN) });
    return run!;
  };

  it("raises no card and moves no review for two interrupted runs", async () => {
    ctx = await setup();
    const a = await ctx.hire("Reviewer A", { template: SENIOR_DEV_TEMPLATE });
    await ctx.hire("Reviewer B", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Restart mid-review");
    const [req] = await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: a.id, round: 1, createdAt: new Date(Date.now() - 3 * HOUR) }).returning();
    await runAt(a.id, id, "interrupted", 150);
    await runAt(a.id, id, "interrupted", 60);
    expect((await ctx.sweeps.run()).progress.reviewsMoved).toBe(0);
    const [after] = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.id, req!.id));
    expect(after!.reviewerAgentId).toBe(a.id);
    expect(await ctx.silentCards(req!.id)).toHaveLength(0);
  });

  it("counts lost runs the same way", async () => {
    ctx = await setup();
    const a = await ctx.hire("Reviewer A", { template: SENIOR_DEV_TEMPLATE });
    await ctx.hire("Reviewer B", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Lost runs");
    const [req] = await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: a.id, round: 1, createdAt: new Date(Date.now() - 3 * HOUR) }).returning();
    await runAt(a.id, id, "lost: runner offline", 150);
    await runAt(a.id, id, "lost: never started", 60);
    expect((await ctx.sweeps.run()).progress.reviewsMoved).toBe(0);
    expect(await ctx.silentCards(req!.id)).toHaveLength(0);
  });

  it("moves the review and raises the card when the same two runs ended normally", async () => {
    ctx = await setup();
    const a2 = await ctx.hire("Reviewer A", { template: SENIOR_DEV_TEMPLATE });
    await ctx.hire("Reviewer B", { template: SENIOR_DEV_TEMPLATE });
    const id2 = await ctx.ticket("Normal runs");
    const [req2] = await ctx.db.insert(reviewRequests).values({ ticketId: id2, kind: "code", reviewerAgentId: a2.id, round: 1, createdAt: new Date(Date.now() - 3 * HOUR) }).returning();
    await runAt(a2.id, id2, "end_turn", 150);
    await runAt(a2.id, id2, "end_turn", 60);
    expect((await ctx.sweeps.run()).progress.reviewsMoved).toBe(1);
    expect(await ctx.silentCards(req2!.id)).toHaveLength(1);
  });

  it("does not let an interrupted run hold the stall sweep back as if it had looked", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Cut off");
    await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 1, createdAt: new Date(Date.now() - 4 * HOUR) });
    // A run that ended 10 minutes ago, but was interrupted: it never looked, so the quiet clock doesn't reset.
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: reviewer.id, startedAt: new Date(Date.now() - 20 * MIN), endedAt: new Date(Date.now() - 10 * MIN), outcome: "interrupted" });
    const result = await ctx.sweeps.run();
    expect(result.stalledReviews.woken).toBe(1);
  });
});
