// R46 (BOS-1814): a free check slot that won't take a queued job says why, and the alarm tells the CEO at 5 minutes and the owner at 30.
import { afterAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, projects, settings, tickets } from "../src/db/schema.js";
import { checkQueue } from "../src/services/check-queue.js";
import { DEPLOY_WAIT_KEY } from "../src/services/deploy-wait-hold.js";
import { checkIdleService, idleLine, IDLE_CEO_AFTER_MS, IDLE_OWNER_AFTER_MS } from "../src/services/check-idle.js";
import type { IdleSlot } from "../src/services/check-dispatcher.js";

const shared = openPglite();
afterAll(async () => (await shared).close());
const T = (n: number) => new Date(Date.UTC(2026, 10, 4, 12, n));

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const q = checkQueue(db);
  const req = async (over: Partial<Parameters<typeof q.enqueue>[0]> & { tree: string }) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n }).returning();
    return q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind: "merge", commit: `c-${over.tree}`, ...over });
  };
  const worker = async (over: Partial<typeof checkWorkers.$inferInsert> = {}) =>
    (await db.insert(checkWorkers).values({ name: "box", tokenHash: `h-${Math.random()}`, companyIds: [co!.id], ...over }).returning())[0]!;
  return { db, q, req, worker, companyId: co!.id };
}

describe("claimOnWhy: a reason, not a bare empty list", () => {
  it("says the update pause is the reason (expected) for the company runner, and for a worker holding only merges", async () => {
    const s = await setup();
    const w = await s.worker();
    const merge = (await s.req({ tree: "m" })).job;
    await s.db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: { phase: "waiting", approvedAt: T(0).toISOString() } });
    const runner = await s.q.claimNextWhy(null, T(1), s.companyId);
    expect(runner.jobs).toEqual([]);
    expect(runner.declined).toMatchObject({ jobId: merge.id, code: "update_hold", expected: true });
    const onWorker = await s.q.claimOnWhy({ workerId: w.id }, 2, T(1), s.companyId);
    expect(onWorker.jobs).toEqual([]);
    expect(onWorker.declined).toMatchObject({ jobId: merge.id, code: "update_hold", expected: true });
  });

  it("names the job and the reason for a checks-only machine facing a merge, as expected (the owner's own setting)", async () => {
    const s = await setup();
    const w = await s.worker();
    const merge = (await s.req({ tree: "m" })).job;
    const r = await s.q.claimOnWhy({ workerId: w.id }, 2, T(1), s.companyId, undefined, { policy: { takes: "checks", mergeKept: 0 } });
    expect(r.jobs).toEqual([]);
    expect(r.declined).toMatchObject({ jobId: merge.id, code: "machine_policy", expected: true });
    expect(r.declined!.text).toContain("pre-review checks only");
  });

  it("is an alarm reason, not an expected one, when a worker skipped a job because it could not get the code", async () => {
    const s = await setup();
    const w = await s.worker();
    const job = (await s.req({ tree: "q", kind: "pre_review", scope: "quick" })).job;
    const r = await s.q.claimOnWhy({ workerId: w.id }, 2, T(1), s.companyId, (id) => id === job.id);
    expect(r.declined).toMatchObject({ jobId: job.id, code: "no_code", expected: false });
  });

  it("has no reason when the slots are full, nothing is queued, or the job was taken", async () => {
    const s = await setup();
    const w = await s.worker();
    expect((await s.q.claimOnWhy({ workerId: w.id }, 1, T(1), s.companyId)).declined).toBeNull();
    const a = (await s.req({ tree: "a", kind: "pre_review", scope: "quick" })).job;
    await s.req({ tree: "b", kind: "pre_review", scope: "quick" });
    const first = await s.q.claimOnWhy({ workerId: w.id }, 1, T(1), s.companyId);
    expect(first.jobs.map((j) => j.id)).toEqual([a.id]);
    expect(first.declined).toBeNull();
    // The one slot is now busy: not a free slot, so nothing to explain.
    expect((await s.q.claimOnWhy({ workerId: w.id }, 1, T(2), s.companyId)).declined).toBeNull();
  });

  it("claimOn still returns the plain job list", async () => {
    const s = await setup();
    const w = await s.worker();
    const a = (await s.req({ tree: "a", kind: "pre_review", scope: "quick" })).job;
    expect((await s.q.claimOn({ workerId: w.id }, 1, T(1), s.companyId)).map((j) => j.id)).toEqual([a.id]);
  });
});

describe("idle check slot alarm", () => {
  const slot = (over: Partial<IdleSlot> = {}): IdleSlot => ({
    companyId: "co1",
    machineKey: "worker:w1",
    machine: 'check worker "box"',
    jobId: "job1",
    ticketId: "t1",
    kind: "pre_review",
    scope: "quick",
    code: "slot_rules",
    text: "its slot rules do not allow it yet",
    expected: false,
    since: T(0),
    minutes: 0,
    ...over,
  });
  function rig(slots: IdleSlot[]) {
    const clock = { at: T(0) };
    const ceo: string[] = [];
    const owner: Array<{ level: string; body: string }> = [];
    const svc = checkIdleService({
      slots: () => slots,
      tellCeo: async ({ note }) => void ceo.push(note),
      notify: async (i) => void owner.push({ level: i.level, body: i.body }),
      now: () => clock.at,
    });
    return { svc, clock, ceo, owner };
  }

  it("says nothing before 5 minutes, wakes the CEO once at 5, pages the owner once at 30", async () => {
    const r = rig([slot()]);
    r.clock.at = new Date(T(0).getTime() + IDLE_CEO_AFTER_MS - 1000);
    await r.svc.run();
    expect(r.ceo).toEqual([]);
    r.clock.at = new Date(T(0).getTime() + IDLE_CEO_AFTER_MS);
    await r.svc.run();
    await r.svc.run();
    expect(r.ceo).toHaveLength(1);
    expect(r.ceo[0]).toContain('check worker "box" has a free slot and is not taking');
    expect(r.owner).toEqual([]);
    r.clock.at = new Date(T(0).getTime() + IDLE_OWNER_AFTER_MS);
    await r.svc.run();
    await r.svc.run();
    expect(r.ceo).toHaveLength(1);
    expect(r.owner).toHaveLength(1);
    expect(r.owner[0]!.level).toBe("page");
  });

  it("never alarms on an expected reason (the update pause, the owner's own machine setting)", async () => {
    const r = rig([slot({ expected: true, code: "update_hold" })]);
    r.clock.at = new Date(T(0).getTime() + 2 * IDLE_OWNER_AFTER_MS);
    await r.svc.run();
    expect(r.ceo).toEqual([]);
    expect(r.owner).toEqual([]);
  });

  it("tells again for a different job on the same slot, but not for the same one after a blip is gone and back", async () => {
    const slots = [slot()];
    const r = rig(slots);
    r.clock.at = new Date(T(0).getTime() + IDLE_CEO_AFTER_MS);
    await r.svc.run();
    slots[0] = slot({ jobId: "job2", since: T(0) });
    await r.svc.run();
    expect(r.ceo).toHaveLength(2);
  });

  describe("the slot kept for merges (BOS-1959)", () => {
    function merges(active: { on: boolean }, slots: IdleSlot[] = [slot()]) {
      const clock = { at: T(0) };
      const ceo: string[] = [];
      const owner: string[] = [];
      const svc = checkIdleService({
        slots: () => slots,
        mergeActive: async () => active.on,
        tellCeo: async ({ note }) => void ceo.push(note),
        notify: async (i) => void owner.push(i.body),
        now: () => clock.at,
      });
      return { svc, clock, ceo, owner };
    }
    const after = (min: number) => new Date(T(0).getTime() + min * 60_000);

    it("does not wake the CEO or page the owner while merges are active, and shows the slot as expected", async () => {
      const r = merges({ on: true });
      r.clock.at = after(45);
      await r.svc.run();
      expect(r.ceo).toEqual([]);
      expect(r.owner).toEqual([]);
      expect((await r.svc.view("co1"))[0]).toMatchObject({ expected: true });
    });

    it("wakes the CEO once when no merge activity has been seen for 60 minutes, and pages the owner 25 minutes later", async () => {
      const active = { on: true };
      const r = merges(active);
      r.clock.at = after(20);
      await r.svc.run(); // active at minute 20
      active.on = false;
      r.clock.at = after(20 + 59);
      await r.svc.run();
      expect(r.ceo).toEqual([]);
      expect((await r.svc.view("co1"))[0]).toMatchObject({ expected: false });
      r.clock.at = after(20 + 60);
      await r.svc.run();
      await r.svc.run();
      expect(r.ceo).toHaveLength(1);
      expect(r.owner).toEqual([]);
      r.clock.at = after(20 + 85);
      await r.svc.run();
      expect(r.owner).toHaveLength(1);
    });

    it("leaves the other reasons alone: a no_code decline still wakes at 5 minutes while merges are active", async () => {
      const r = merges({ on: true }, [slot({ code: "no_code" })]);
      r.clock.at = after(5);
      await r.svc.run();
      expect(r.ceo).toHaveLength(1);
    });

    it("stays quiet if merge activity can't be read", async () => {
      const svc = checkIdleService({
        slots: () => [slot()],
        mergeActive: async () => {
          throw new Error("db down");
        },
        tellCeo: async () => {
          throw new Error("should not wake");
        },
        notify: async () => undefined,
        now: () => after(45),
      });
      expect(await svc.run()).toEqual({ ceo: 0, owner: 0 });
    });
  });

  it("writes the line a person can act on", () => {
    expect(idleLine({ machine: "the company runner", text: "the last free slot is kept for a quick check", minutes: 7, ref: "the queued merge check" })).toBe(
      "the company runner has a free slot and is not taking the queued merge check because the last free slot is kept for a quick check (7 min).",
    );
  });
});
