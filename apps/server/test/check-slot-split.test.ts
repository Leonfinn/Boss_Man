// BOS-1602: per machine, which kinds of check it takes and how many slots are kept for merges. The rule itself (`admits`)
// is pure; the dispatch order, the train's seats and the queue's "why it waits" run on PGlite with the real queue, worker
// service and dispatcher, and fake sockets, as in check-workers.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, checkWorkers, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { admits, CHECK_QUEUE_MODE_KEY, CHECK_SLOTS_KEY, checkQueue, DEFAULT_SLOT_POLICY, type SlotPolicy, type SlotUse } from "../src/services/check-queue.js";
import { checkDispatcher } from "../src/services/check-dispatcher.js";
import { BUNDLE_FEATURE, checkWorkersService } from "../src/services/check-workers.js";

const merge = { kind: "merge", scope: "full", fixesMain: false } as const;
const fixMain = { ...merge, fixesMain: true } as const;
const quick = { kind: "pre_review", scope: "quick", fixesMain: false } as const;
const full = { kind: "pre_review", scope: "full", fixesMain: false } as const;
const use = (merge: number, check = 0, longCheck = 0): SlotUse => ({ merge, check, longCheck });
const kept = (n: number): SlotPolicy => ({ takes: "both", mergeKept: n });

describe("admits: which job a machine may start (BOS-1602)", () => {
  it("with nothing set, is the DR-056 / BOS-1264 rule: a long job may not take the last slot while a quick check waits", () => {
    const p = DEFAULT_SLOT_POLICY;
    expect(admits(3, p, use(2), merge, { quickWaits: true })).toBe(false);
    expect(admits(3, p, use(2), quick, { quickWaits: true })).toBe(true);
    expect(admits(3, p, use(2), merge, { quickWaits: false })).toBe(true);
    expect(admits(3, p, use(2), fixMain, { quickWaits: true })).toBe(true);
    // A full pre-review check counts as long too.
    expect(admits(3, p, use(1, 1, 1), full, { quickWaits: true })).toBe(false);
    // One slot: no reserve, as before.
    expect(admits(1, p, use(0), merge, { quickWaits: true })).toBe(true);
    expect(admits(3, p, use(1, 2), quick, { quickWaits: true })).toBe(false);
    // Nothing is set aside, so the dispatcher's first pass takes nothing.
    expect(admits(3, p, use(0), merge, { quickWaits: false, dedicatedOnly: true })).toBe(false);
    expect(admits(3, p, use(0), quick, { quickWaits: false, dedicatedOnly: true })).toBe(false);
  });

  it("3 slots with 2 kept for merges: merges get the kept two first; the third goes to a waiting quick check, else to a merge", () => {
    const p = kept(2);
    expect(admits(3, p, use(0), merge, { quickWaits: true, dedicatedOnly: true })).toBe(true);
    expect(admits(3, p, use(1), merge, { quickWaits: true, dedicatedOnly: true })).toBe(true);
    expect(admits(3, p, use(2), merge, { quickWaits: true, dedicatedOnly: true })).toBe(false);
    expect(admits(3, p, use(2), merge, { quickWaits: true })).toBe(false);
    expect(admits(3, p, use(2), quick, { quickWaits: true })).toBe(true);
    expect(admits(3, p, use(2), merge, { quickWaits: false })).toBe(true);
    expect(admits(3, p, use(2), fixMain, { quickWaits: true })).toBe(true);
    // A quick check never takes a kept slot, even with both kept slots free.
    expect(admits(3, p, use(0, 1), quick, { quickWaits: true })).toBe(false);
    expect(admits(3, p, use(0), quick, { quickWaits: true, dedicatedOnly: true })).toBe(false);
    // A merge in the either slot leaves a kept slot free for the next merge (slots have no identity).
    expect(admits(3, p, use(1, 1), merge, { quickWaits: false })).toBe(true);
    expect(admits(3, p, use(3), merge, { quickWaits: false })).toBe(false);
  });

  it("checks only: never a merge; DR-056 still holds between full and quick checks", () => {
    const p: SlotPolicy = { takes: "checks", mergeKept: 0 };
    expect(admits(2, p, use(0), merge, { quickWaits: false })).toBe(false);
    expect(admits(2, p, use(0), fixMain, { quickWaits: false })).toBe(false);
    expect(admits(2, p, use(0, 1), quick, { quickWaits: true, dedicatedOnly: true })).toBe(true);
    expect(admits(2, p, use(0, 2), quick, { quickWaits: true })).toBe(false);
    expect(admits(2, p, use(0, 1, 1), full, { quickWaits: true })).toBe(false);
    expect(admits(2, p, use(0, 1, 1), full, { quickWaits: false })).toBe(true);
  });

  it("merges only: never a pre-review check, every slot for merges", () => {
    const p: SlotPolicy = { takes: "merge", mergeKept: 0 };
    expect(admits(2, p, use(0), quick, { quickWaits: true })).toBe(false);
    expect(admits(2, p, use(1), merge, { quickWaits: true, dedicatedOnly: true })).toBe(true);
    expect(admits(2, p, use(2), merge, { quickWaits: false })).toBe(false);
  });

  it("clamps kept slots to the machine's real limit (a machine can report fewer slots than the owner set)", () => {
    // 3 kept on a machine now running 2: both are merge-only, so no quick check can start there.
    expect(admits(2, kept(3), use(0), quick, { quickWaits: true })).toBe(false);
    expect(admits(2, kept(3), use(1), merge, { quickWaits: true })).toBe(true);
  });
});

const shared = openPglite();
afterAll(async () => (await shared).close());
const COMMIT = "a".repeat(40);

async function setup(o: { runnerSlots: number; runnerPolicy?: SlotPolicy }) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(checkWorkers);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  await db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: o.runnerSlots });
  const q = checkQueue(db);
  if (o.runnerPolicy) await q.setRunnerPolicy(o.runnerPolicy);
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: `h${Math.random()}`, imageCommit: COMMIT } as never).returning();
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude", instructions: "x" } as never).returning();
  const workers = checkWorkersService(db);
  const toRunner: string[] = [];
  const toWorker: string[] = [];
  const d = checkDispatcher(db, {
    send: (_id, command) => (command.type === "check.run" && toRunner.push(command.jobId), true),
    isConnected: () => true,
    can: () => true,
    workers,
    bundles: { store: { remove: () => {}, sweep: () => [] }, canPack: () => true, pack: async () => ({ sha256: "f".repeat(64), bytes: 1, mainRef: "refs/remotes/origin/main", mainCommit: COMMIT, empty: false }) },
  });
  const worker = async (slots: number, policy: SlotPolicy) => {
    const { worker: w } = await workers.register({ name: `W${Math.random()}`, companyIds: [co!.id], slots, checkThreads: null, checkMemoryMb: null, enabled: true, ...policy });
    const features = ["check-jobs", BUNDLE_FEATURE];
    await workers.touch(w.id, { imageCommit: COMMIT, imageVersion: "1", features });
    workers.connect(w.id, (command) => (command.type === "check.run" && toWorker.push(command.jobId), true), () => {}, features);
    return w.id;
  };
  let n = 0;
  const req = async (kind: "merge" | "pre_review") => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n }).returning();
    const scope = kind === "merge" ? "full" : "quick";
    // One minute apart, oldest first, so the serving order is the order queued.
    const job = (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: t!.id, kind, scope, commit: `c${n}`.padEnd(8, "0"), tree: `tree-${n}-${Math.random()}`, requestedBy: a!.id })).job;
    await db.update(checkJobs).set({ queuedAt: new Date(Date.now() - (100 - n) * 1000) }).where(eq(checkJobs.id, job.id));
    return job.id;
  };
  const pump = async () => {
    await d.pump();
    await d.settled();
  };
  return { db, q, d, co: co!, worker, req, pump, toRunner, toWorker };
}

describe("dispatch with the owner's split (BOS-1602)", () => {
  it("runner 3 slots with 2 kept for merges, worker 2 slots quick checks only: merges on the runner, quick checks on the worker first, the third runner slot to a waiting quick check", async () => {
    const s = await setup({ runnerSlots: 3, runnerPolicy: kept(2) });
    await s.worker(2, { takes: "checks", mergeKept: 0 });
    const m1 = await s.req("merge");
    const m2 = await s.req("merge");
    const m3 = await s.req("merge");
    const q1 = await s.req("pre_review");
    const q2 = await s.req("pre_review");
    const q3 = await s.req("pre_review");
    await s.pump();
    expect(s.toRunner).toEqual([m1, m2, q3]);
    expect(s.toWorker).toEqual([q1, q2]);
    const view = await s.q.list(s.co.id, new Date(), await s.d.capacity(s.co.id), await s.d.machines(s.co.id));
    expect(view.rows.find((r) => r.id === m3)).toMatchObject({ state: "waiting", heldBy: "waiting for a merge slot: 3 of the 3 slots that take merge checks busy" });
  });

  it("a quick check goes to the quick-checks-only worker before the runner's either slot, and a merge never goes to that worker", async () => {
    const s = await setup({ runnerSlots: 3, runnerPolicy: kept(2) });
    await s.worker(2, { takes: "checks", mergeKept: 0 });
    const q1 = await s.req("pre_review");
    await s.pump();
    expect(s.toWorker).toEqual([q1]);
    expect(s.toRunner).toEqual([]);
    // Four merges: three fit on the runner (no quick check waits, so the either slot takes one), the worker takes none.
    const ms = [await s.req("merge"), await s.req("merge"), await s.req("merge"), await s.req("merge")];
    await s.pump();
    expect(s.toRunner).toEqual(ms.slice(0, 3));
    expect(s.toWorker).toEqual([q1]);
  });

  it("never starves quick checks while a slot that may take them is free: worker offline, the runner's either slot serves them", async () => {
    const s = await setup({ runnerSlots: 3, runnerPolicy: kept(2) });
    const m = [await s.req("merge"), await s.req("merge"), await s.req("merge")];
    const q1 = await s.req("pre_review");
    await s.pump();
    expect(s.toRunner).toEqual([m[0], m[1], q1]);
  });

  it("merge train seats count only slots that can run merges; a quick-checks-only worker adds none", async () => {
    const s = await setup({ runnerSlots: 3, runnerPolicy: kept(2) });
    expect(await s.d.mergeCapacity(s.co.id)).toBe(3);
    await s.worker(2, { takes: "checks", mergeKept: 0 });
    expect(await s.d.mergeCapacity(s.co.id)).toBe(3);
    expect(await s.d.capacity(s.co.id)).toBe(5);
    await s.worker(1, { takes: "both", mergeKept: 0 });
    expect(await s.d.mergeCapacity(s.co.id)).toBe(4);
  });

  it("says so when no ready machine takes a kind; with nothing set the old 'all slots busy' line stands", async () => {
    const s = await setup({ runnerSlots: 1, runnerPolicy: { takes: "merge", mergeKept: 0 } });
    const q1 = await s.req("pre_review");
    await s.pump();
    expect(s.toRunner).toEqual([]);
    const view = await s.q.list(s.co.id, new Date(), 1, await s.d.machines(s.co.id));
    expect(view.rows.find((r) => r.id === q1)?.heldBy).toBe("no machine that takes pre-review checks is ready");
    expect(await s.d.mergeCapacity(s.co.id)).toBe(1);

    const d = await setup({ runnerSlots: 1 });
    const a = await d.req("pre_review");
    const b = await d.req("pre_review");
    await d.pump();
    expect(d.toRunner).toEqual([a]);
    const plain = await d.q.list(d.co.id, new Date(), 1, await d.d.machines(d.co.id));
    expect(plain.rows.find((r) => r.id === b)?.heldBy).toBe("all 1 check slot is busy");
  });

  it("a worker's split is saved, shown on its row, and kept slots are stored as 0 for a one-kind worker", async () => {
    const s = await setup({ runnerSlots: 1 });
    const { db } = await shared;
    const workers = checkWorkersService(db);
    const id = await s.worker(2, kept(1));
    expect((await workers.list()).find((w) => w.id === id)).toMatchObject({ takes: "both", mergeKept: 1 });
    await workers.update(id, { takes: "checks", mergeKept: 1 });
    expect((await workers.list()).find((w) => w.id === id)).toMatchObject({ takes: "checks", mergeKept: 0 });
    await expect(workers.update(id, { takes: "sometimes" as never })).rejects.toThrow(/Takes/);
    await expect(workers.update(id, { mergeKept: -1 })).rejects.toThrow(/Kept for merges/);
  });
});
