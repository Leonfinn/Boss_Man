import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, objectives, projects, reviewRequests, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { MISSED_REASON, REVIEW_REASON } from "../src/services/scheduler.js";
import type { Leader } from "../src/leader.js";

const HOUR = 3_600_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function setup(leader?: Leader) {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: clock, leader });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  /** A ticket assigned straight in the database, as if its "assigned" wake was lost. Idle for an hour. */
  const forgotten = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "ready", lastActivityAt: new Date(Date.now() - HOUR), ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  const hire = async (name: string) => (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
  const missed = (ticketId?: string) => db.select().from(wakes).where(and(eq(wakes.reason, MISSED_REASON), ticketId ? eq(wakes.ticketId, ticketId) : undefined));
  /** The agent got the wake and ran (or the wake was dropped): it no longer waits in the queue. */
  const settle = () => db.update(wakes).set({ status: "launched" }).where(eq(wakes.reason, MISSED_REASON));
  const stuckDecisions = () => db.select().from(decisions).where(like(decisions.dedupeKey, "missed:%"));
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, worker, project, forgotten, hire, missed, settle, stuckDecisions, advance };
}

describe("missed-work sweep (R82)", () => {
  it("wakes the assignee of a forgotten ready ticket once, with a plain note", async () => {
    ctx = await setup();
    const id = await ctx.forgotten("Add checkout");
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 1, gaveUp: 0 } });
    const [w] = await ctx.missed(id);
    expect(w).toMatchObject({ agentId: ctx.worker.id, ticketId: id, status: "queued" });
    expect(w!.note).toContain("Nothing is running on this ticket");
    expect(w!.note).toContain("last active at");
    // It waits in the queue, so the next pass leaves it alone.
    await ctx.sweeps.run();
    expect(await ctx.missed(id)).toHaveLength(1);
  });

  it("leaves alone a ticket waiting on a scheduled check", async () => {
    ctx = await setup();
    const id = await ctx.forgotten("Wait for CI", { systemState: "in_progress", monitorAt: new Date(Date.now() + HOUR), monitorNote: "CI on the PR" });
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 0 } });
    expect(await ctx.missed(id)).toHaveLength(0);
  });

  it("leaves alone tickets that are queued, running, recent, blocked, in review, awaiting a plan or unassigned", async () => {
    ctx = await setup();
    // The queued and running tickets have agents of their own, so only those tickets are in question.
    const [a, b] = [await ctx.hire("Queued"), await ctx.hire("Running")];
    const queued = await ctx.forgotten("Has a queued wake", { assigneeAgentId: a.id });
    await ctx.scheduler.wake({ agentId: a.id, ticketId: queued, reason: "assigned" });
    const running = await ctx.forgotten("Has a run", { assigneeAgentId: b.id });
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: b.id, ticketId: running });
    await ctx.forgotten("Updated just now", { lastActivityAt: new Date() });
    const ranRecently = await ctx.forgotten("Run just ended");
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, ticketId: ranRecently, endedAt: new Date() });
    const waitsOnTicket = await ctx.forgotten("Waits on a ticket");
    const blocker = await ctx.forgotten("Blocker", { assigneeAgentId: null });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: waitsOnTicket, blockerTicketId: blocker });
    const waitsOnDecision = await ctx.forgotten("Waits on a decision");
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.worker.id, question: "Which one?", options: ["A"], recommended: "A" });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: waitsOnDecision, blockerDecisionId: d.id });
    await ctx.forgotten("In review", { systemState: "review" });
    await ctx.forgotten("Plan not approved", { planFirst: true });
    await ctx.forgotten("Nobody's", { assigneeAgentId: null });

    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 0, gaveUp: 0 } });
    expect(await ctx.missed()).toEqual([]);

    // Once the blocker is done, the ticket it held up is forgotten work like any other.
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, blocker));
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 1 } });
    expect((await ctx.missed()).map((w) => w.ticketId)).toEqual([waitsOnTicket]);
  });

  it("leaves a busy agent's other ready tickets alone, they're only waiting their turn", async () => {
    ctx = await setup();
    const a = await ctx.forgotten("Being worked on");
    await ctx.forgotten("Next up");
    await ctx.forgotten("After that");
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, ticketId: a });
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 0, gaveUp: 0 } });
    // An owner chat doesn't keep an agent busy.
    await ctx.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.ticketId, a));
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, purpose: "chat" });
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 1 } });
  });

  it("wakes an idle agent about one ticket per pass, the one serving the more important objective", async () => {
    ctx = await setup();
    const [p1, p3] = await ctx.db.insert(objectives).values([{ companyId: ctx.company.id, title: "Launch", priority: 1 }, { companyId: ctx.company.id, title: "Tidy up", priority: 3 }]).returning();
    const kr = async (objectiveId: string) => (await ctx.req("POST", `/api/objectives/${objectiveId}/key-results`, { title: "Done", target: 1 })).json() as { id: string };
    const low = await ctx.forgotten("Tidy", { keyResultId: (await kr(p3!.id)).id, lastActivityAt: new Date(Date.now() - 5 * HOUR) });
    const high = await ctx.forgotten("Launch it", { keyResultId: (await kr(p1!.id)).id });
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 1 } });
    expect((await ctx.missed()).map((w) => w.ticketId)).toEqual([high]);
    // Its wake is queued, so the other ticket waits until that run is over.
    await ctx.sweeps.run();
    expect((await ctx.missed()).map((w) => w.ticketId)).toEqual([high]);
    await ctx.settle();
    await ctx.sweeps.run();
    expect((await ctx.missed()).map((w) => w.ticketId).sort()).toEqual([high, low].sort());
  });

  it("wakes at most once per window, then gives up after two and tells the owner once", async () => {
    ctx = await setup();
    const id = await ctx.forgotten("Stuck for good");
    await ctx.sweeps.run();
    await ctx.settle();
    expect(await ctx.missed(id)).toHaveLength(1);

    ctx.advance(3 * HOUR);
    await ctx.sweeps.run();
    expect(await ctx.missed(id)).toHaveLength(1);

    ctx.advance(2 * HOUR); // past the 4 hour window
    await ctx.sweeps.run();
    await ctx.settle();
    expect(await ctx.missed(id)).toHaveLength(2);
    expect(await ctx.stuckDecisions()).toEqual([]); // the second wake gets its window first

    ctx.advance(5 * HOUR);
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 0, gaveUp: 1 } });
    expect(await ctx.missed(id)).toHaveLength(2);
    const [told] = await ctx.stuckDecisions();
    expect(told).toMatchObject({ status: "open", kind: "question", companyId: ctx.company.id });
    expect(told!.question).toContain("looks stuck");

    // Not told again, and no more wakes while it's open, even after a day.
    ctx.advance(20 * HOUR);
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { woken: 0, gaveUp: 0 } });
    expect(await ctx.stuckDecisions()).toHaveLength(1);
    expect(await ctx.missed(id)).toHaveLength(2);
  });

  it("does not wake a paused or retired agent, or a paused company's", async () => {
    ctx = await setup();
    const id = await ctx.forgotten("Waiting");
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.worker.id));
    await ctx.sweeps.run();
    await ctx.db.update(agents).set({ paused: false, retiredAt: new Date() }).where(eq(agents.id, ctx.worker.id));
    await ctx.sweeps.run();
    await ctx.db.update(agents).set({ retiredAt: null }).where(eq(agents.id, ctx.worker.id));
    await ctx.db.update(companies).set({ paused: true }).where(eq(companies.id, ctx.company.id));
    await ctx.sweeps.run();
    expect(await ctx.missed(id)).toEqual([]);

    await ctx.db.update(companies).set({ paused: false }).where(eq(companies.id, ctx.company.id));
    await ctx.sweeps.run();
    expect(await ctx.missed(id)).toHaveLength(1);
  });
});

describe("stalled review sweep", () => {
  it("re-wakes a reviewer who never gave a verdict, then tells the owner", async () => {
    ctx = await setup();
    const reviewer = await ctx.hire("Senior Developer");
    const id = await ctx.forgotten("Refresh the brief", { systemState: "review" });
    const [r] = await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: reviewer.id, round: 1, createdAt: new Date(Date.now() - 2 * HOUR) }).returning();
    const reviewWakes = () => ctx.db.select().from(wakes).where(and(eq(wakes.agentId, reviewer.id), eq(wakes.reason, REVIEW_REASON)));
    const settle = () => ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.reason, REVIEW_REASON));
    const told = () => ctx.db.select().from(decisions).where(like(decisions.dedupeKey, "review-stall:%"));

    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 1 } });
    const [w] = await reviewWakes();
    expect(w!.note).toContain(`- ${id} "Refresh the brief": still waiting for your code review`);
    // Still queued, then too soon after the last wake.
    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 0 } });
    await settle();
    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 0 } });

    for (const n of [2, 3]) {
      ctx.advance(HOUR);
      expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 1 } });
      await settle();
      expect(await reviewWakes()).toHaveLength(n);
    }
    ctx.advance(HOUR);
    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 0, gaveUp: 1 } });
    expect((await told())[0]!.question).toContain("waiting for Senior Developer's code review");
    ctx.advance(HOUR);
    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 0, gaveUp: 0 } });

    // A verdict ends it.
    await ctx.db.update(reviewRequests).set({ status: "approved" }).where(eq(reviewRequests.id, r!.id));
    ctx.advance(30 * HOUR);
    expect(await ctx.sweeps.run()).toMatchObject({ stalledReviews: { woken: 0, gaveUp: 0 } });
  });
});

describe("unmerged approvals sweep", () => {
  it("tries an interrupted merge once by itself, asks the owner once if that fails too, and leaves one waiting on sign-off", async () => {
    ctx = await setup();
    const approve = (ticketId: string) => ctx.db.insert(reviewRequests).values({ ticketId, kind: "code", reviewerAgentId: ctx.worker.id, round: 1, status: "approved" });
    // No repo: trying again simply closes it.
    const plain = await ctx.forgotten("Ship it", { systemState: "review" });
    await approve(plain);
    // A repo, but the company's runner is offline: the retry fails, so the owner is asked.
    const repo = await ctx.forgotten("Ship the API", { systemState: "review" });
    const p2 = (await ctx.req("POST", `/api/companies/${ctx.company.id}/projects`, { name: "API" })).json() as { id: string };
    await ctx.db.update(projects).set({ repoUrl: "https://github.com/Leonfinn/api.git" }).where(eq(projects.id, p2.id));
    await ctx.db.update(tickets).set({ projectId: p2.id }).where(eq(tickets.id, repo));
    await approve(repo);
    // Still pending somewhere: not this sweep's business.
    const waiting = await ctx.forgotten("Still reviewing", { systemState: "review" });
    await ctx.db.insert(reviewRequests).values({ ticketId: waiting, kind: "code", reviewerAgentId: ctx.worker.id, round: 1 });
    // Approved but waiting on the owner's sign-off.
    const signoff = await ctx.forgotten("Needs sign-off", { systemState: "review" });
    await approve(signoff);
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "approval", question: "Merge?", options: ["Approve and merge"], recommendedOption: "Approve and merge", context: { type: "risk_review", ticketId: signoff, reviewer: "x" } }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: signoff, blockerDecisionId: d!.id });

    expect(await ctx.sweeps.run()).toMatchObject({ unmergedApprovals: 2 });
    // The retry runs in the background.
    await new Promise((r) => setTimeout(r, 300));
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, plain)))[0]!.systemState).toBe("done");
    const asked = await ctx.db.select().from(decisions).where(like(decisions.dedupeKey, "merge-stuck:%"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ dedupeKey: `merge-stuck:${repo}`, options: ["Run the check again", "Send it back to the agent"] });
    expect(asked[0]!.question).toContain('"Ship the API" was approved, but its merge didn\'t finish');
    // Asked once, not every pass, and not retried again.
    expect(await ctx.sweeps.run()).toMatchObject({ unmergedApprovals: 0 });
  });

  it("a server that handed over mid-merge leaves it to the one now in charge, without asking the owner", async () => {
    let leading = true;
    const leader: Leader = { role: () => (leading ? "leader" : "standby") as never, isLeader: () => leading, onPromote: () => {}, onDemote: () => {}, start: async () => {}, stop: async () => {}, demote: async () => {}, promote: async () => {} };
    ctx = await setup(leader);
    const id = await ctx.forgotten("Ship the API", { systemState: "review" });
    const p2 = (await ctx.req("POST", `/api/companies/${ctx.company.id}/projects`, { name: "API" })).json() as { id: string };
    await ctx.db.update(projects).set({ repoUrl: "https://github.com/Leonfinn/api.git" }).where(eq(projects.id, p2.id));
    await ctx.db.update(tickets).set({ projectId: p2.id }).where(eq(tickets.id, id));
    leading = false;
    await expect(ctx.review.land(id, "Reviewer")).rejects.toThrow();
    expect(await ctx.db.select().from(decisions).where(like(decisions.dedupeKey, "merge-stuck:%"))).toHaveLength(0);
  });
});

