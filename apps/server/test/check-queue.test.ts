import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { checkJobs, companies, projects, settings, tickets } from "../src/db/schema.js";
import { CHECK_SLOTS_KEY, checkQueue } from "../src/services/check-queue.js";
import { FULL_LOG_MAX } from "@boss-man/shared";
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
    // BOS-1384: urgency is read from the ticket when the queue serves, not from the priority stored at enqueue.
    const urgentTicket = await s.ticket();
    await (await shared).db.update(tickets).set({ urgent: true }).where(eq(tickets.id, urgentTicket));
    const urgent = (await s.req({ tree: "d", ticketId: urgentTicket })).job;
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

  it("with 3 slots, merge checks leave the last slot to a waiting quick check (BOS-1264), and use it when none waits", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 3 });
    const merges = [await s.req({ tree: "m1" }), await s.req({ tree: "m2" }), await s.req({ tree: "m3" })].map((r) => r.job);
    const quick = (await s.req({ tree: "q1", kind: "pre_review", scope: "quick" })).job;
    // Two merges start, then the quick check takes the third slot ahead of the third merge.
    expect((await s.q.claimNext(null)).map((j) => j.id)).toEqual([merges[0]!.id, merges[1]!.id, quick.id]);
    await s.q.complete(quick.id, { commit: quick.commit, exitCode: 0, logTail: "", runnerId: null });
    // No quick check waits any more, so the last merge may use the free slot.
    expect((await s.q.claimNext(null)).map((j) => j.id)).toEqual([merges[2]!.id]);
    await s.close();
  });

  it("a full-scope pre-review check counts as long and cannot sit in the quick reserve (DR-056)", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 3 });
    const m1 = (await s.req({ tree: "m1" })).job;
    const m2 = (await s.req({ tree: "m2" })).job;
    const fullPre = (await s.req({ tree: "f1", kind: "pre_review", scope: "full" })).job;
    const quick = (await s.req({ tree: "q1", kind: "pre_review", scope: "quick" })).job;
    // Two long jobs run; the full pre-review is held and the quick check gets the reserved slot.
    expect((await s.q.claimNext(null)).map((j) => j.id)).toEqual([m1.id, m2.id, quick.id]);
    expect(fullPre.id).not.toBe(quick.id);
    await s.close();
  });

  it("a quick check that has waited 10 minutes is served in queue-time order with the merges (DR-056)", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 3 });
    const m1 = (await s.req({ tree: "m1" })).job; // oldest
    const q1 = (await s.req({ tree: "q1", kind: "pre_review", scope: "quick" })).job;
    const m2 = (await s.req({ tree: "m2" })).job; // queued after q1
    const q2 = (await s.req({ tree: "q2", kind: "pre_review", scope: "quick" })).job;
    const later = new Date(Date.now() + 11 * 60_000);
    // All quick checks are 11 minutes old, so the order is m1, q1, m2, q2 (queue time): the 3 slots go to the first three.
    expect((await s.q.claimNext(null, later)).map((j) => j.id)).toEqual([m1.id, q1.id, m2.id]);
    expect(q2.id).toBeTruthy();
    // Young quick checks (not yet 10 minutes) stay behind the merges.
    const s2 = await setup();
    await s2.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 3 });
    await s2.req({ tree: "x1" }); // a merge already queued
    const fresh = (await s2.req({ tree: "x2", kind: "pre_review", scope: "quick" })).job;
    const order = (await s2.q.claimNext(null)).map((j) => j.id);
    expect(order[order.length - 1]).toBe(fresh.id);
    expect(m2.id).toBeTruthy();
    await s2.close();
    await s.close();
  });

  it("a merge that fixes main is never held by the quick-check reserve", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 2 });
    const fix1 = (await s.req({ tree: "f1", fixesMain: true })).job;
    const fix2 = (await s.req({ tree: "f2", fixesMain: true })).job;
    await s.req({ tree: "q", kind: "pre_review", scope: "quick" });
    expect((await s.q.claimNext(null)).map((j) => j.id)).toEqual([fix1.id, fix2.id]);
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
    expect((await s.req({ tree: "t1", kind: "pre_review", scope: "quick" })).reused).toBe("passed");
    const q2 = (await s.req({ tree: "t2", kind: "pre_review", scope: "quick" })).job;
    await s.q.claimNext(null);
    await s.q.complete(q2.id, { commit: q2.commit, exitCode: 0, logTail: "", runnerId: null });
    expect((await s.req({ tree: "t2", kind: "pre_review", scope: "full" })).reused).toBeNull();
    expect((await s.req({ tree: "t2", kind: "pre_review", scope: "quick" })).reused).toBe("passed");
    // BOS-1043: a pre-review pass ran without the owner's list, so it never answers a merge request.
    const merge = await s.req({ tree: "t1" });
    expect(merge.reused).toBeNull();
    expect(merge.job.id).not.toBe(a.id);
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

  it("a pre-review job claimed between the read and the lift is not turned into a merge job; the merge gets a fresh one (BOS-1390)", async () => {
    const s = await setup();
    const ticketId = await s.ticket();
    const a = (await s.req({ ticketId, tree: "r", kind: "pre_review" })).job;
    expect(a.state).toBe("queued");
    // Reproduce the race: a pump holds check_jobs_claim (a different lock from enqueue's), so it can claim the queued job and
    // dispatch it as pre-review between enqueue's read and the lift's UPDATE. enqueue runs inside db.transaction, so wrap the
    // tx it hands the callback: the first checkJobs UPDATE of a row (the lift) first marks the row running the way a pump does
    // (pglite is one connection, so a real claimNext would open a nested transaction and block), so the row is queued at the
    // read and running by the time the lift's WHERE is evaluated.
    const real = s.db as unknown as {
      transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    type Chain = { set: (v: unknown) => { where: (w: unknown) => Promise<unknown> } };
    let fired = false;
    const wrapTx = (tx: unknown) => {
      const t = tx as { update: (x: unknown) => Chain; execute: (q: unknown) => Promise<unknown> };
      return new Proxy(tx as object, {
        get(target, prop, recv) {
          if (prop !== "update") return Reflect.get(target, prop, recv);
          return (table: unknown) => {
            const upd = t.update(table);
            if (table !== checkJobs) return upd;
            return {
              set: (v: unknown) => {
                const after = upd.set(v);
                return {
                  where: (w: unknown) => {
                    const q = after.where(w) as unknown as { then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise<unknown>; returning?: () => Promise<unknown> };
                    if (fired) return q;
                    fired = true;
                    // The pump claims the still-queued job first (state running, no owner's list in its dispatch), then the
                    // lift's own WHERE runs against the claimed row: the queued guard sees "running", so no row comes back.
                    const claim = () => (t.update(checkJobs) as Chain).set({ state: "running", startedAt: new Date() } as never).where(eq(checkJobs.id, a.id));
                    return {
                      then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => claim().then(() => q.then(a, b)),
                      returning: () => claim().then(() => (q.returning ? q.returning() : q as unknown as Promise<unknown>)),
                    };
                  },
                };
              },
            };
          };
        },
      });
    };
    const wrapped = new Proxy(s.db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return (fn: (tx: unknown) => Promise<unknown>) => real.transaction((tx) => fn(wrapTx(tx)));
      },
    });
    const q = checkQueue(wrapped as never);
    const m = await q.enqueue({ companyId: s.companyId, projectId: s.projectId, ticketId, kind: "merge", commit: "c-r", tree: "r", requestedBy: null });
    expect(fired).toBe(true); // the lift's UPDATE ran (after the claim)
    // The claimed job was NOT turned into a merge job: it is still a running pre-review job.
    const after = (await s.db.select().from(checkJobs).where(eq(checkJobs.id, a.id)))[0]!;
    expect(after.state).toBe("running");
    expect(after.kind).toBe("pre_review");
    // The merge request got a fresh merge job instead of reusing the claimed one as "live".
    expect(m.reused).toBeNull();
    expect(m.job.id).not.toBe(a.id);
    expect(m.job.kind).toBe("merge");
    await s.close();
  });

  it("a merge request is never answered by a running pre-review job, which ran without the owner's list (BOS-1043)", async () => {
    const s = await setup();
    const ticketId = await s.ticket();
    const a = await s.req({ ticketId, tree: "r1", kind: "pre_review", scope: "full" });
    await s.q.claimNext(null);
    const b = await s.req({ ticketId, tree: "r1", kind: "merge" });
    expect(b.reused).toBeNull();
    expect(b.job.id).not.toBe(a.job.id);
    expect(b.job.kind).toBe("merge");
    await s.close();
  });

  it("a merge pass answers a later merge request on the same tree (BOS-1043)", async () => {
    const s = await setup();
    const m = (await s.req({ tree: "m1", kind: "merge" })).job;
    await s.q.claimNext(null);
    await s.q.complete(m.id, { commit: m.commit, exitCode: 0, logTail: "", runnerId: null });
    const again = await s.req({ tree: "m1", kind: "merge" });
    expect(again.reused).toBe("passed");
    expect(again.job.id).toBe(m.id);
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

  // BOS-1228: the whole log of a failed job is kept, redacted, capped, readable by company and ticket, and pruned after 14 days.
  describe("kept full log", () => {
    // Fake secrets, made up for this test; none is a real credential.
    const FAKES = ["MY_API_KEY=hunter2fakevalue", "Bearer fakebearer1234567890", "postgres://svc:fakepassw0rd@db.internal/app", "Zq8Lm2Xv9Rt4Bn7Cw3Dk6Fh1Jg5Ps0Aa"];
    const dirty = (extra = "") => `FAIL  related tests (exit 1)\n${FAKES.join("\n")}\n${extra}`;

    it("stores a failed job's whole log with the planted secrets removed, and keeps a pass's log out", async () => {
      const s = await setup();
      const bad = (await s.req({ tree: "l1" })).job;
      await s.q.claimNext(null);
      const done = await s.q.complete(bad.id, { commit: bad.commit, exitCode: 1, logTail: "tail", runnerId: null, fullLog: dirty("x".repeat(20_000)) });
      expect(done?.state).toBe("failed");
      const kept = await s.q.readLog(s.companyId, bad.ticketId, bad.id);
      expect(kept?.log).toContain("FAIL  related tests");
      expect(kept!.log.length).toBeGreaterThan(20_000); // more than the 8 KB tail
      expect(kept!.log).not.toMatch(/hunter2fakevalue|fakebearer1234567890|fakepassw0rd|Zq8Lm2Xv9Rt4Bn7Cw3Dk6Fh1Jg5Ps0Aa/);
      expect(await s.q.logChars(bad.id)).toBe(kept!.chars);

      const good = (await s.req({ tree: "l2" })).job;
      await s.q.claimNext(null);
      await s.q.complete(good.id, { commit: good.commit, exitCode: 0, logTail: "", runnerId: null, fullLog: "fine" });
      expect(await s.q.logChars(good.id)).toBeNull();
      await s.close();
    });

    it("redacts again on the server even when the runner sent the secrets as they were", async () => {
      const s = await setup();
      const j = (await s.req({ tree: "l3" })).job;
      await s.q.claimNext(null);
      await s.q.complete(j.id, { commit: j.commit, exitCode: 2, logTail: "", runnerId: null, fullLog: dirty() });
      expect((await s.q.readLog(s.companyId, j.ticketId, null))?.log).not.toMatch(/hunter2fakevalue|fakebearer1234567890|fakepassw0rd|Zq8Lm2Xv9Rt4Bn7Cw3Dk6Fh1Jg5Ps0Aa/);
      await s.close();
    });

    it("cuts a huge log to the cap, keeping its start and its end", async () => {
      const s = await setup();
      const j = (await s.req({ tree: "l4" })).job;
      await s.q.claimNext(null);
      const huge = `START-LINE\n${"a ".repeat(1_200_000)}\nEND-LINE`;
      await s.q.complete(j.id, { commit: j.commit, exitCode: 1, logTail: "", runnerId: null, fullLog: huge });
      const kept = await s.q.readLog(s.companyId, j.ticketId, j.id);
      expect(kept!.chars).toBeLessThanOrEqual(FULL_LOG_MAX + 200);
      expect(kept!.log.startsWith("START-LINE")).toBe(true);
      expect(kept!.log.endsWith("END-LINE")).toBe(true);
      expect(kept!.log).toMatch(/characters cut from the middle/);
      await s.close();
    });

    it("is readable only for the company and ticket it belongs to", async () => {
      const s = await setup();
      const j = (await s.req({ tree: "l5" })).job;
      await s.q.claimNext(null);
      await s.q.complete(j.id, { commit: j.commit, exitCode: 1, logTail: "", runnerId: null, fullLog: "secret-free log" });
      expect(await s.q.readLog(OTHER_RUNNER, j.ticketId, j.id)).toBeNull(); // another company
      expect(await s.q.readLog(s.companyId, await s.ticket(), j.id)).toBeNull(); // another ticket
      expect((await s.q.readLog(s.companyId, j.ticketId, null))?.jobId).toBe(j.id); // newest, no job id
      await s.close();
    });

    it("deletes logs older than the retention period and no others", async () => {
      const s = await setup();
      const j = (await s.req({ tree: "l6" })).job;
      await s.q.claimNext(null);
      await s.q.complete(j.id, { commit: j.commit, exitCode: 1, logTail: "", runnerId: null, fullLog: "old" }, T(0));
      expect(await s.q.pruneLogs(new Date(T(0).getTime() + 13 * 86_400_000))).toBe(0);
      expect(await s.q.logChars(j.id)).not.toBeNull();
      expect(await s.q.pruneLogs(new Date(T(0).getTime() + 15 * 86_400_000))).toBe(1);
      expect(await s.q.logChars(j.id)).toBeNull();
      await s.close();
    });
  });
});
