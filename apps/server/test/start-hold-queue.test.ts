// BOS-1489: hold new starts while the merge line or the quick-check queue is long. A Ready ticket is not started while the
// company's approved-merges-waiting count (the Merge queue page's own figure) or its queued quick checks are at or over the
// company's setting; work already started, urgent tickets and every other company carry on; the ticket says why; and it
// starts by itself once the line is shorter. Both settings are off (null) by default.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, companies, decisions, reviewRequests, runs, tickets, wakes } from "../src/db/schema.js";
import { moveTicket } from "../src/services/ticket-moves.js";
import { canStartNow } from "../src/services/agent-wip.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, () => true);
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${Math.random().toString(16).slice(2, 6)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  /** `n` approved tickets waiting to merge: in review with an approved code review. */
  const approved = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const t = await ticket("review");
      await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    }
  };
  const queuedQuick = async (n: number) => {
    const t = await ticket("in_progress");
    for (let i = 0; i < n; i++)
      await db.insert(checkJobs).values({ companyId: company.id, projectId: project.id, ticketId: t.id, kind: "pre_review", scope: "quick", state: "queued", commit: `${i}`.padStart(40, "a"), tree: `${i}`.padStart(40, "a") });
  };
  const set = (patch: { holdStartsMergesWaiting?: number | null; holdStartsQuickChecksQueued?: number | null; holdStartsOwnerWaiting?: number | null }) => db.update(companies).set(patch).where(eq(companies.id, company.id));
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const start = (id: string) => moveTicket(db, id, "in_progress", { internal: true, overLimit: true });
  /** `n` open owner cards (BOS-2196): plain questions in the owner's queue, the kind the Dashboard's Needs you counts. */
  const ownerCards = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [d] = await db.insert(decisions).values({ companyId: company.id, kind: "question", tier: "owner", question: `Which way, ${i}?`, options: ["Yes", "No"], recommendedOption: "Yes" }).returning({ id: decisions.id });
      ids.push(d!.id);
    }
    return ids;
  };
  const needYou = async () => ((await req("GET", `/api/decisions/tally?companyId=${company.id}`)).json() as { open: number }).open;
  return { ...built, db, close, req, company, ceo, project, worker, runnerId: reg.runnerId, ticket, approved, queuedQuick, set, row, start, ownerCards, needYou };
}

describe("merges waiting", () => {
  it("is off by default: a long merge line holds nothing", async () => {
    const c = (ctx = await setup());
    await c.approved(5);
    const t = await c.ticket("ready");
    const r = await c.start(t.id);
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("holds a Ready ticket at the limit, with the plain-words reason, and the wake does not start it", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsMergesWaiting: 3 });
    await c.approved(3);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    const after = await c.row(t.id);
    expect(after.systemState).toBe("ready");
    expect(after.stateNote).toMatch(/^Held: 3 merges waiting \(limit 3\)\./);
    expect(after.wipHeldAt).not.toBeNull();
  });

  it("the count is the Merge queue page's own figure", async () => {
    const c = (ctx = await setup());
    await c.approved(4);
    await c.ticket("review"); // in review with no verdict: not waiting to merge
    const view = await c.mergeQueue.get(c.company.id);
    expect(view.waitingCount).toBe(4);
    expect(await c.mergeQueue.waitingCount(c.company.id)).toBe(view.waitingCount);
  });

  it("lets it start below the limit, and starts a held ticket again once the line is shorter", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsMergesWaiting: 3 });
    await c.approved(3);
    const t = await c.ticket("ready");
    expect((await c.start(t.id)).held).toMatch(/^Held: 3 merges waiting \(limit 3\)/);
    expect(await canStartNow(c.db, await c.row(t.id))).toBe(false);
    // One merges: 2 are waiting, under the limit of 3.
    const [done] = await c.db.select().from(tickets).where(eq(tickets.systemState, "review")).limit(1);
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, done!.id));
    expect(await canStartNow(c.db, await c.row(t.id))).toBe(true);
    const r = await c.start(t.id);
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
    expect(r.ticket.wipHeldAt).toBeNull();
  });

  it("does not hold work already started or an urgent ticket", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsMergesWaiting: 1 });
    await c.approved(2);
    // Sent back from review: it was in progress before, so coming back is finishing.
    const first = await c.ticket("ready");
    await c.set({ holdStartsMergesWaiting: null });
    await c.start(first.id);
    await c.set({ holdStartsMergesWaiting: 1 });
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, first.id));
    expect((await c.start(first.id)).held).toBeNull();
    // Urgent.
    const urgent = await c.ticket("ready", { urgent: true });
    expect((await c.start(urgent.id)).ticket.systemState).toBe("in_progress");
  });
});

describe("quick checks queued", () => {
  it("holds at the limit and names it; either limit is enough; both are named when both apply", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsQuickChecksQueued: 2 });
    await c.queuedQuick(1);
    const ok = await c.ticket("ready");
    expect((await c.start(ok.id)).held).toBeNull();
    await c.queuedQuick(1);
    const held = await c.ticket("ready");
    expect((await c.start(held.id)).held).toMatch(/^Held: 2 quick checks queued \(limit 2\)/);
    await c.set({ holdStartsMergesWaiting: 1 });
    await c.approved(1);
    expect((await c.start(held.id)).held).toMatch(/^Held: 1 merge waiting \(limit 1\); 2 quick checks queued \(limit 2\)/);
  });

  it("a full check or a merge check in the queue is not a quick check", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsQuickChecksQueued: 1 });
    const t0 = await c.ticket("in_progress");
    await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: t0.id, kind: "merge", scope: "full", state: "queued", commit: "b".repeat(40), tree: "b".repeat(40) });
    await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: t0.id, kind: "pre_review", scope: "full", state: "queued", commit: "c".repeat(40), tree: "c".repeat(40) });
    const t = await c.ticket("ready");
    expect((await c.start(t.id)).held).toBeNull();
  });
});

// BOS-2196: the third limit, cards that need the owner (the Dashboard's Needs you figure). Its own exemptions: urgent,
// live-fix and CEO tickets pass it; the merge and check limits keep their urgent-only rule.
describe("cards that need you", () => {
  it("is off by default: a long Needs you queue holds nothing", async () => {
    const c = (ctx = await setup());
    await c.ownerCards(4);
    const t = await c.ticket("ready");
    const r = await c.start(t.id);
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("holds a Ready ticket at the limit with the Dashboard's own number and words, and the wake does not start it", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsOwnerWaiting: 2 });
    await c.ownerCards(2);
    const shown = await c.needYou();
    expect(shown).toBe(2);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    const after = await c.row(t.id);
    expect(after.systemState).toBe("ready");
    expect(after.stateNote).toBe(`Held: ${shown} need you (limit 2). It starts by itself when fewer need you.`);
    expect(after.wipHeldAt).not.toBeNull();
  });

  it("lets it start below the limit, and starts a held ticket by itself once a card is answered", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsOwnerWaiting: 2 });
    const [first] = await c.ownerCards(2);
    const t = await c.ticket("ready");
    expect((await c.start(t.id)).held).toMatch(/^Held: 2 need you \(limit 2\)/);
    expect(await canStartNow(c.db, await c.row(t.id))).toBe(false);
    // The owner answers one card: 1 needs them, under the limit of 2.
    expect((await c.req("POST", `/api/decisions/${first}/answer`, { answer: "Yes" })).statusCode).toBe(200);
    expect(await c.needYou()).toBe(1);
    expect(await canStartNow(c.db, await c.row(t.id))).toBe(true);
    const r = await c.start(t.id);
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
    expect(r.ticket.wipHeldAt).toBeNull();
  });

  it("at 3 of 3 a new start is held, and work already in progress is not stopped", async () => {
    const c = (ctx = await setup());
    const going = await c.ticket("ready");
    await c.start(going.id);
    await c.set({ holdStartsOwnerWaiting: 3 });
    await c.ownerCards(3);
    const t = await c.ticket("ready");
    expect((await c.start(t.id)).held).toBe("Held: 3 need you (limit 3). It starts by itself when fewer need you.");
    await c.sweeps.run();
    await c.scheduler.tick();
    expect((await c.row(going.id)).systemState).toBe("in_progress");
    expect((await c.row(t.id)).systemState).toBe("ready");
  });

  it("when the count drops to 2 the next pass starts the held ticket with no owner step, also after a server restart", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsOwnerWaiting: 3 });
    const [first] = await c.ownerCards(3);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    expect((await c.row(t.id)).wipHeldAt).not.toBeNull();
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.agentId, c.worker.id));
    // A restart: the old process goes, a new one starts on the same database and registers its count source again.
    await c.app.close();
    const again = await buildApp({ db: c.db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    ctx = { ...c, ...again };
    again.runners.connect(c.runnerId, () => true);
    // Still 3 cards: a pass after the restart keeps it held.
    await again.sweeps.run();
    await again.scheduler.tick();
    expect((await c.row(t.id)).systemState).toBe("ready");
    // The owner answers one card on the new process (2 need them, under 3); the next pass starts it with nothing else done.
    const login = await again.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${login.cookies.find((k) => k.name === "bm_session")!.value}`;
    expect((await again.app.inject({ method: "POST", url: `/api/decisions/${first}/answer`, headers: { cookie }, payload: { answer: "Yes" } })).statusCode).toBe(200);
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.agentId, c.worker.id));
    expect(await canStartNow(c.db, await c.row(t.id))).toBe(true);
    await again.sweeps.run();
    await again.scheduler.tick();
    const after = await c.row(t.id);
    expect(after.systemState).toBe("in_progress");
    expect(after.wipHeldAt).toBeNull();
  });

  it("an owner reply on a ticket in progress still wakes its agent while the hold is on", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("ready");
    await c.start(t.id);
    await c.set({ holdStartsOwnerWaiting: 1 });
    await c.ownerCards(2);
    expect((await c.req("POST", `/api/tickets/${t.id}/messages`, { text: "Please also cover the empty case." })).statusCode).toBe(201);
    await c.scheduler.tick();
    const launched = await c.db.select({ status: wakes.status, statusReason: wakes.statusReason }).from(wakes).where(eq(wakes.ticketId, t.id));
    expect(launched.some((w) => w.status === "launched" && w.statusReason === null)).toBe(true);
    expect((await c.row(t.id)).systemState).toBe("in_progress");
  });

  it("does not hold work already started, an urgent ticket, a live fix or the CEO's own ticket", async () => {
    const c = (ctx = await setup());
    await c.ownerCards(3);
    // Sent back from review: it was in progress before, so coming back is finishing.
    const back = await c.ticket("ready");
    await c.start(back.id);
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, back.id));
    await c.set({ holdStartsOwnerWaiting: 1 });
    // Each started ticket then goes to review, so the agent's own in-progress limit never answers for the owner hold.
    const startsThenReview = async (id: string) => {
      const r = await c.start(id);
      expect(r.held).toBeNull();
      expect(r.ticket.systemState).toBe("in_progress");
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, id));
    };
    await startsThenReview(back.id);
    await startsThenReview((await c.ticket("ready", { urgent: true })).id);
    await startsThenReview((await c.ticket("ready", { fixesLive: "server freezes as memory climbs" })).id);
    await startsThenReview((await c.ticket("ready", { assigneeAgentId: c.ceo.id })).id);
    // A plain ticket for the worker is held: the exemptions are the ticket's, not a gap in the hold.
    const plain = await c.ticket("ready");
    expect((await c.start(plain.id)).held).toMatch(/^Held: 3 need you \(limit 1\)/);
  });

  it("leaves the merge limit as it was: a live fix and the CEO's ticket are still held by merges waiting", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsMergesWaiting: 1, holdStartsOwnerWaiting: 1 });
    await c.approved(1);
    await c.ownerCards(1);
    const liveFix = await c.ticket("ready", { fixesLive: "server freezes as memory climbs" });
    expect((await c.start(liveFix.id)).held).toBe("Held: 1 merge waiting (limit 1). It starts by itself when the line is shorter.");
    const ceos = await c.ticket("ready", { assigneeAgentId: c.ceo.id });
    expect((await c.start(ceos.id)).held).toBe("Held: 1 merge waiting (limit 1). It starts by itself when the line is shorter.");
    // A plain ticket names both limits.
    const plain = await c.ticket("ready");
    expect((await c.start(plain.id)).held).toBe("Held: 1 merge waiting (limit 1); 1 needs you (limit 1). It starts by itself when the line is shorter.");
  });

  it("is saved through the company route, null turns it off, and each change is on the activity log", async () => {
    const c = (ctx = await setup());
    const r = await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsOwnerWaiting: 5 });
    expect(r.json()).toMatchObject({ holdStartsOwnerWaiting: 5, holdStartsMergesWaiting: null });
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsOwnerWaiting: 0 })).statusCode).toBe(400);
    const off = await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsOwnerWaiting: null });
    expect(off.json()).toMatchObject({ holdStartsOwnerWaiting: null });
    const lines = (await c.db.select({ summary: activity.summary }).from(activity).where(eq(activity.companyId, c.company.id))).map((a) => a.summary);
    expect(lines).toContain("Owner set new starts to be held while 5 or more cards need you");
    expect(lines).toContain("Owner turned off holding new starts on cards that need you");
  });
});

describe("the setting", () => {
  it("is saved per company through the company route, and null turns it off", async () => {
    const c = (ctx = await setup());
    const r = await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsMergesWaiting: 20, holdStartsQuickChecksQueued: 10 });
    expect(r.json()).toMatchObject({ holdStartsMergesWaiting: 20, holdStartsQuickChecksQueued: 10 });
    const off = await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsMergesWaiting: null });
    expect(off.json()).toMatchObject({ holdStartsMergesWaiting: null, holdStartsQuickChecksQueued: 10 });
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { holdStartsMergesWaiting: 0 })).statusCode).toBe(400);
  });

  it("shows held tickets in the plan's 'What's holding work up' data", async () => {
    const c = (ctx = await setup());
    await c.set({ holdStartsMergesWaiting: 1 });
    await c.approved(1);
    const t = await c.ticket("ready");
    await c.start(t.id);
    const plan = (await c.req("GET", `/api/companies/${c.company.id}/plan`)).json() as { startHold: { reason: string; tickets: { id: string }[] } | null };
    expect(plan.startHold?.reason).toMatch(/^Held: 1 merge waiting \(limit 1\)/);
    expect(plan.startHold?.tickets.map((x) => x.id)).toEqual([t.id]);
  });
});
