// BOS-1489: hold new starts while the merge line or the quick-check queue is long. A Ready ticket is not started while the
// company's approved-merges-waiting count (the Merge queue page's own figure) or its queued quick checks are at or over the
// company's setting; work already started, urgent tickets and every other company carry on; the ticket says why; and it
// starts by itself once the line is shorter. Both settings are off (null) by default.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, reviewRequests, tickets, wakes } from "../src/db/schema.js";
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
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
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
  const set = (patch: { holdStartsMergesWaiting?: number | null; holdStartsQuickChecksQueued?: number | null }) => db.update(companies).set(patch).where(eq(companies.id, company.id));
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const start = (id: string) => moveTicket(db, id, "in_progress", { internal: true, overLimit: true });
  return { ...built, db, close, req, company, project, worker, ticket, approved, queuedQuick, set, row, start };
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
