import { afterAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { CHECK_SLOTS_KEY, checkQueue } from "../src/services/check-queue.js";
const OTHER_RUNNER = "00000000-0000-4000-8000-000000000001";

// One database for the whole file (each test uses its own company); the queue is global, so tests clear it first.
const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const close = async () => {};
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const ticket = async () => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n }).returning();
    return t!.id;
  };
  const q = checkQueue(db);
  const req = async (over: Partial<Parameters<typeof q.enqueue>[0]> & { tree: string }) =>
    q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: over.ticketId ?? (await ticket()), kind: "merge", commit: `c-${over.tree}`, ...over });
  return { db, close, q, req, ticket, companyId: co!.id, projectId: p!.id };
}
const T = (n: number) => new Date(Date.UTC(2026, 10, 4, 12, n));

describe("check queue", () => {
  it("serves merge jobs first, then fixes of main, urgent, oldest; one slot by default", async () => {
    const s = await setup();
    const pre = (await s.req({ tree: "a", kind: "pre_review", scope: "quick" })).job;
    const m1 = (await s.req({ tree: "b" })).job;
    const m2 = (await s.req({ tree: "c" })).job;
    const urgent = (await s.req({ tree: "d", priority: 0 })).job;
    const first = await s.q.claimNext(null);
    expect(first.map((j) => j.id)).toEqual([urgent.id]);
    expect(await s.q.claimNext(null)).toEqual([]); // the one slot is taken
    await s.q.complete(urgent.id, { commit: urgent.commit, exitCode: 0, logTail: "ok", runnerId: null });
    expect((await s.q.claimNext(null))[0]!.id).toBe(m1.id);
    await s.q.complete(m1.id, { commit: m1.commit, exitCode: 0, logTail: "", runnerId: null });
    expect((await s.q.claimNext(null))[0]!.id).toBe(m2.id);
    await s.q.complete(m2.id, { commit: m2.commit, exitCode: 1, logTail: "boom", runnerId: null });
    expect((await s.q.claimNext(null))[0]!.id).toBe(pre.id);
    await s.close();
  });

  it("slots is a setting", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 2 });
    await s.req({ tree: "a" });
    await s.req({ tree: "b" });
    await s.req({ tree: "c" });
    expect(await s.q.claimNext(null)).toHaveLength(2);
    await s.close();
  });

  it("a pass of one command never stands in for another on the same tree", async () => {
    const s = await setup();
    const quick = (await s.req({ tree: "c1", kind: "pre_review", scope: "full", command: "scripts/check-quick.sh" })).job;
    await s.q.claimNext(null);
    await s.q.complete(quick.id, { commit: quick.commit, exitCode: 0, logTail: "", runnerId: null });
    const first = await s.req({ tree: "c1", command: "pnpm verify" });
    expect(first.reused).toBeNull();
    await s.q.claimNext(null);
    await s.q.complete(first.job.id, { commit: first.job.commit, exitCode: 0, logTail: "", runnerId: null });
    expect((await s.req({ tree: "c1", command: "pnpm verify" })).reused).toBe("passed");
    expect((await s.req({ tree: "c1", command: "pnpm deep" })).reused).toBeNull();
    await s.close();
  });
  it("reuses a pass on the same tree, wider scope satisfying narrower, never the reverse", async () => {
    const s = await setup();
    const a = (await s.req({ tree: "t1", kind: "pre_review", scope: "full" })).job;
    await s.q.claimNext(null);
    await s.q.complete(a.id, { commit: a.commit, exitCode: 0, logTail: "", runnerId: null });
    const merge = await s.req({ tree: "t1" });
    expect(merge.reused).toBe("passed");
    expect(merge.job.id).toBe(a.id);
    const q2 = (await s.req({ tree: "t2", kind: "pre_review", scope: "quick" })).job;
    await s.q.claimNext(null);
    await s.q.complete(q2.id, { commit: q2.commit, exitCode: 0, logTail: "", runnerId: null });
    expect((await s.req({ tree: "t2", scope: "full" })).reused).toBeNull();
    expect((await s.req({ tree: "t2", kind: "pre_review", scope: "quick" })).reused).toBe("passed");
    await s.close();
  });

  it("does not queue the same ticket twice on one tree, and a merge request lifts a queued pre-review job", async () => {
    const s = await setup();
    const ticketId = await s.ticket();
    const a = await s.req({ ticketId, tree: "x", kind: "pre_review" });
    const b = await s.req({ ticketId, tree: "x", kind: "merge" });
    expect(b.reused).toBe("live");
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.kind).toBe("merge");
    await s.close();
  });

  it("a later quick request never drops a queued full check, and concurrent requests for one tree queue one job", async () => {
    const s = await setup();
    const ticketId = await s.ticket();
    const full = (await s.req({ ticketId, tree: "a", kind: "pre_review", scope: "full" })).job;
    const quick = (await s.req({ ticketId, tree: "b", kind: "pre_review", scope: "quick" })).job;
    const status = await s.q.status(s.companyId);
    expect(status.queued.map((j) => j.id).sort()).toEqual([full.id, quick.id].sort());
    const t2 = await s.ticket();
    await Promise.all([s.req({ ticketId: t2, tree: "same", kind: "pre_review" }), s.req({ ticketId: t2, tree: "same", kind: "merge" })]);
    const rows = await s.db.select().from(checkJobs);
    expect(rows.filter((j) => j.tree === "same").length).toBe(1);
    await s.close();
  });

  it("a newer commit drops the ticket's older queued job with a reason", async () => {
    const s = await setup();
    const ticketId = await s.ticket();
    const old = (await s.req({ ticketId, tree: "old" })).job;
    const fresh = (await s.req({ ticketId, tree: "new" })).job;
    expect(fresh.id).not.toBe(old.id);
    const status = await s.q.status(s.companyId);
    expect(status.queued.map((j) => j.id)).toEqual([fresh.id]);
    expect(status.recent[0]).toMatchObject({ id: old.id, state: "cancelled" });
    expect(status.recent[0]!.reason).toMatch(/newer commit/);
    await s.close();
  });

  it("while main is red only fixes of main run; other merge jobs wait, pre-review jobs keep running", async () => {
    const s = await setup();
    await s.q.setMainState(s.projectId, "red", "deadbeef");
    const other = (await s.req({ tree: "o" })).job;
    const pre = (await s.req({ tree: "p", kind: "pre_review", scope: "quick" })).job;
    const fix = (await s.req({ tree: "f", fixesMain: true })).job;
    expect((await s.q.claimNext(null))[0]!.id).toBe(fix.id);
    await s.q.complete(fix.id, { commit: fix.commit, exitCode: 0, logTail: "", runnerId: null });
    expect((await s.q.claimNext(null))[0]!.id).toBe(pre.id);
    await s.q.complete(pre.id, { commit: pre.commit, exitCode: 0, logTail: "", runnerId: null });
    expect(await s.q.claimNext(null)).toEqual([]);
    const held = await s.q.status(s.companyId);
    expect(held.held.map((j) => j.id)).toEqual([other.id]);
    expect(held.main.find((m) => m.projectId === s.projectId)).toMatchObject({ state: "red", commit: "deadbeef" });
    expect((await s.q.setMainState(s.projectId, "green", "abc")).changed).toBe(true);
    expect((await s.q.claimNext(null))[0]!.id).toBe(other.id);
    await s.close();
  });

  it("ignores a late answer for another commit or a job that is no longer running", async () => {
    const s = await setup();
    await s.req({ tree: "a" });
    const running = (await s.q.claimNext(null))[0]!;
    expect(await s.q.complete(running.id, { commit: running.commit, exitCode: 0, logTail: "", runnerId: OTHER_RUNNER })).toBeNull();
    await s.q.progress(running.id, OTHER_RUNNER, "forged");
    expect((await s.q.claimNext(null)).length).toBe(0); // still running, not finished by the other runner
    expect(await s.q.complete(running.id, { commit: "someone-elses", exitCode: 0, logTail: "", runnerId: null })).toBeNull();
    expect((await s.q.complete(running.id, { commit: running.commit, exitCode: 0, logTail: "", runnerId: null }))?.state).toBe("passed");
    expect(await s.q.complete(running.id, { commit: running.commit, exitCode: 1, logTail: "", runnerId: null })).toBeNull();
    await s.close();
  });

  it("re-queues running jobs of a gone runner with a reason, and marks silent jobs stuck with a reason", async () => {
    const s = await setup();
    const a = (await s.req({ tree: "a" })).job;
    await s.q.claimNext(null, T(0));
    const requeued = await s.q.requeueRunning(null, "The runner disconnected; the check was put back in line.");
    expect(requeued.map((j) => j.id)).toEqual([a.id]);
    expect(requeued[0]!.reason).toMatch(/disconnected/);
    expect((await s.q.claimNext(null, T(1)))[0]!.id).toBe(a.id);
    expect(await s.q.sweepStuck(T(10), 20)).toEqual([]);
    const stuck = await s.q.sweepStuck(T(30), 20);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ state: "stuck" });
    expect(stuck[0]!.reason).toMatch(/No output/);
    await expect(s.q.cancel(a.id, " ")).rejects.toThrow(/reason/);
    await s.close();
  });
});
