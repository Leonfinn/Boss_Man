// BOS-1435 (DR-060): check workers take the jobs the company runner has no free slot for. PGlite, the real worker service
// and queue, and fake sockets for the runner and the workers.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, checkWorkers, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, CHECK_SLOTS_KEY, checkQueue } from "../src/services/check-queue.js";
import { checkDispatcher } from "../src/services/check-dispatcher.js";
import { BUNDLE_FEATURE, checkWorkersService } from "../src/services/check-workers.js";
import { hashToken } from "../src/auth.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);

async function setup(opts: { runnerSlots?: number; graceMs?: number } = {}) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(checkWorkers);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  await db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: opts.runnerSlots ?? 1 });
  const company = async (name: string) => {
    const [co] = await db.insert(companies).values({ name: `${name} ${Math.random()}` }).returning();
    const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
    const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: `h${Math.random()}`, imageCommit: COMMIT } as never).returning();
    const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude", instructions: "x" } as never).returning();
    return { id: co!.id, projectId: p!.id, runnerId: r!.id, agentId: a!.id };
  };
  const co = await company("Co");
  const workers = checkWorkersService(db);
  const toRunner: Array<{ runnerId: string; command: any }> = [];
  const toWorker: Array<{ workerId: string; command: any }> = [];
  const closed: Array<{ workerId: string; code: number }> = [];
  let runnerUp = true;
  const d = checkDispatcher(db, {
    send: (runnerId, command) => (runnerUp ? (toRunner.push({ runnerId, command }), true) : false),
    isConnected: () => runnerUp,
    can: () => true,
    workers,
    workerGraceMs: opts.graceMs ?? 30,
  });
  const q = checkQueue(db);
  let n = 0;
  const req = async (c: typeof co, extra: Record<string, unknown> = {}) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: c.id, projectId: c.projectId, title: `T${n}`, number: n }).returning();
    return (await q.enqueue({ companyId: c.id, projectId: c.projectId, ticketId: t!.id, kind: "pre_review", scope: "quick", commit: `c${n}`.padEnd(8, "0"), tree: `tree-${n}-${Math.random()}`, requestedBy: c.agentId, ...extra } as never)).job;
  };
  /** Adds a worker and connects it with a fake socket, as the socket route does after hello. */
  const worker = async (o: { companyIds?: string[]; slots?: number; reported?: number; features?: string[]; commit?: string | null; enabled?: boolean; threads?: number | null; memoryMb?: number | null } = {}) => {
    const { worker: w, token } = await workers.register({ name: `W${Math.random()}`, companyIds: o.companyIds ?? [co.id], slots: o.slots ?? 1, checkThreads: o.threads ?? null, checkMemoryMb: o.memoryMb ?? null, enabled: o.enabled ?? true });
    const features = o.features ?? ["check-jobs", BUNDLE_FEATURE];
    await workers.touch(w.id, { imageCommit: o.commit === null ? undefined : (o.commit ?? COMMIT), imageVersion: "1", checkSlots: o.reported, features });
    const release = workers.connect(w.id, (command) => (toWorker.push({ workerId: w.id, command }), true), (code) => void closed.push({ workerId: w.id, code }), features);
    return { id: w.id, token, release };
  };
  const job = async (id: string) => (await db.select().from(checkJobs).where(eq(checkJobs.id, id)))[0]!;
  return { db, d, q, co, company, workers, worker, req, job, toRunner, toWorker, closed, setRunnerUp: (v: boolean) => (runnerUp = v) };
}

const ran = (sent: Array<{ command: any }>) => sent.filter((s) => s.command.type === "check.run").map((s) => s.command.jobId);

describe("check workers: scheduling (BOS-1435)", () => {
  it("fills the company runner first; a worker takes only what is left, and the job records the worker", async () => {
    const s = await setup({ runnerSlots: 1 });
    const w = await s.worker({ slots: 2 });
    const a = await s.req(s.co);
    const b = await s.req(s.co);
    const c = await s.req(s.co);
    const e = await s.req(s.co);
    await s.d.pump();
    expect(ran(s.toRunner)).toEqual([a.id]);
    expect(ran(s.toWorker)).toEqual([b.id, c.id]);
    const onWorker = await s.job(b.id);
    expect(onWorker).toMatchObject({ state: "running", workerId: w.id, runnerId: null });
    expect(await s.job(a.id)).toMatchObject({ state: "running", runnerId: s.co.runnerId, workerId: null });
    expect((await s.job(e.id)).state).toBe("queued");
  });

  it("with no worker the runner's claims are exactly as before (one slot, the rest wait)", async () => {
    const s = await setup({ runnerSlots: 1 });
    const a = await s.req(s.co);
    const b = await s.req(s.co);
    await s.d.pump();
    expect(ran(s.toRunner)).toEqual([a.id]);
    expect((await s.job(b.id)).state).toBe("queued");
    expect(await s.d.capacity(s.co.id)).toBe(1);
  });

  it("gives no job to a worker that can't fetch code yet, is built from another commit, is off or isn't set up for the company, and says why", async () => {
    const s = await setup({ runnerSlots: 1 });
    const other = await s.company("Other");
    const noBundle = await s.worker({ features: ["check-jobs"] });
    const oldCommit = await s.worker({ commit: OTHER });
    const off = await s.worker({ enabled: false });
    const elsewhere = await s.worker({ companyIds: [other.id] });
    await s.req(s.co);
    await s.req(s.co);
    await s.d.pump();
    expect(ran(s.toWorker)).toEqual([]);
    const list = await s.workers.list();
    const by = (id: string) => list.find((x) => x.id === id)!;
    expect(by(noBundle.id).reason).toMatch(/can't fetch the code/);
    expect(by(oldCommit.id).reason).toBeNull();
    expect(by(oldCommit.id).companies[0]).toMatchObject({ ready: false, reason: expect.stringMatching(/different commit than the company's runner/) });
    expect(by(off.id).reason).toBe("Turned off.");
    expect(by(elsewhere.id).companies[0]!.id).toBe(other.id);
    const w = await s.workers.get(elsewhere.id);
    expect(s.workers.readiness(w!, s.co.id, COMMIT)).toEqual({ ok: false, reason: "Not set up for this company." });
    expect(await s.d.capacity(s.co.id)).toBe(1);
  });

  it("gives no job when the runner's image commit is unknown, and none to a worker that hasn't said its commit", async () => {
    const s = await setup({ runnerSlots: 1 });
    await s.db.update(runners).set({ imageCommit: null }).where(eq(runners.id, s.co.runnerId));
    await s.worker();
    await s.req(s.co);
    await s.req(s.co);
    await s.d.pump();
    expect(ran(s.toWorker)).toEqual([]);
    await s.db.update(runners).set({ imageCommit: COMMIT }).where(eq(runners.id, s.co.runnerId));
    const quiet = await s.worker({ commit: null });
    expect((await s.workers.list()).find((x) => x.id === quiet.id)!.reason).toMatch(/hasn't said which commit/);
  });

  it("caps a worker at the smaller of the owner's slots and what it reports, and counts its slots across companies", async () => {
    const s = await setup({ runnerSlots: 1 });
    const other = await s.company("Other");
    const w = await s.worker({ companyIds: [s.co.id, other.id], slots: 4, reported: 1 });
    expect(await s.d.capacity(s.co.id)).toBe(2);
    s.setRunnerUp(false); // both runners away: only the worker runs anything
    const a = await s.req(s.co);
    const b = await s.req(other);
    await s.d.pump();
    expect(ran(s.toWorker)).toHaveLength(1);
    const running = await s.db.select().from(checkJobs).where(eq(checkJobs.workerId, w.id));
    expect(running).toHaveLength(1);
    expect([a.id, b.id]).toContain(running[0]!.id);
  });

  it("keeps the long-job reserve per machine: with two slots a merge can't take the worker's last one while a quick check waits", async () => {
    const s = await setup({ runnerSlots: 1 });
    s.setRunnerUp(false);
    await s.worker({ slots: 2, reported: 2 });
    const m1 = await s.req(s.co, { kind: "merge", scope: "full" });
    const m2 = await s.req(s.co, { kind: "merge", scope: "full" });
    const quick = await s.req(s.co);
    await s.d.pump();
    expect(ran(s.toWorker).sort()).toEqual([m1.id, quick.id].sort());
    expect((await s.job(m2.id)).state).toBe("queued");
  });

  it("sends the worker's per-check caps with the job, and the owner's private-details list only with a merge job", async () => {
    const { db } = await shared;
    const s = await setup({ runnerSlots: 1 });
    s.setRunnerUp(false);
    const workers = s.workers;
    const sent: any[] = [];
    const w = await s.worker({ threads: 3, memoryMb: 7168 });
    const d = checkDispatcher(db, { send: () => false, isConnected: () => false, can: () => true, scanList: async () => "ip\t192.0.2.77", workers: { ...workers, send: (_id, c) => (sent.push(c), true) } });
    await s.req(s.co, { kind: "merge", scope: "full" });
    await d.pump();
    expect(sent[0]).toMatchObject({ type: "check.run", limits: { threads: 3, memoryMb: 7168 }, scanList: "ip\t192.0.2.77" });
    w.release();
  });

  it("accepts a result or progress only from the machine the job was sent to", async () => {
    const s = await setup({ runnerSlots: 1 });
    const w = await s.worker();
    const other = await s.worker();
    const onRunner = await s.req(s.co);
    const onWorker = await s.req(s.co);
    await s.d.pump();
    const done = (id: string, commit: string) => ({ jobId: id, commit, exitCode: 0, timedOut: false, tail: "ok" });
    // The runner can't answer for the worker's job, nor another worker, nor a null runner.
    await s.d.onDone(s.co.runnerId, done(onWorker.id, onWorker.commit));
    await s.d.onWorkerDone(other.id, done(onWorker.id, onWorker.commit));
    expect(await s.q.complete(onWorker.id, { runnerId: null, commit: onWorker.commit, exitCode: 0, logTail: "" })).toBeNull();
    expect((await s.job(onWorker.id)).state).toBe("running");
    // The worker can't answer for the runner's job.
    await s.d.onWorkerDone(w.id, done(onRunner.id, onRunner.commit));
    expect((await s.job(onRunner.id)).state).toBe("running");
    // Progress from the wrong machine is ignored too.
    await s.d.onProgress(s.co.runnerId, { jobId: onWorker.id, tail: "from the runner" });
    expect((await s.job(onWorker.id)).logTail).toBeNull();
    await s.d.onWorkerProgress(w.id, { jobId: onWorker.id, tail: "from the worker" });
    expect((await s.job(onWorker.id)).logTail).toBe("from the worker");
    // The right machines answer.
    await s.d.onWorkerDone(w.id, done(onWorker.id, onWorker.commit));
    await s.d.onDone(s.co.runnerId, done(onRunner.id, onRunner.commit));
    expect((await s.job(onWorker.id)).state).toBe("passed");
    expect((await s.job(onRunner.id)).state).toBe("passed");
    expect(s.toWorker.some((x) => x.workerId === w.id && x.command.type === "check.ack" && x.command.jobId === onWorker.id)).toBe(true);
  });

  it("puts a dropped worker's jobs back in line after the grace period, but not if it reconnects in time", async () => {
    const s = await setup({ runnerSlots: 1, graceMs: 40 });
    s.setRunnerUp(false);
    const w = await s.worker();
    const a = await s.req(s.co);
    await s.d.pump();
    expect((await s.job(a.id)).workerId).toBe(w.id);
    // Drops and comes back inside the grace period: the job stays on it.
    w.release();
    s.d.onWorkerGone(w.id);
    const back = s.workers.connect(w.id, () => true, () => {}, ["check-jobs", BUNDLE_FEATURE]);
    await s.d.onWorkerHello(w.id, [a.id]);
    await new Promise((r) => setTimeout(r, 80));
    expect(await s.job(a.id)).toMatchObject({ state: "running", workerId: w.id });
    // Drops for good: back in line with the reason.
    back();
    s.d.onWorkerGone(w.id);
    const end = Date.now() + 2000;
    while ((await s.job(a.id)).state !== "queued" && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(await s.job(a.id)).toMatchObject({ state: "queued", workerId: null, reason: expect.stringMatching(/went offline/) });
  });

  it("on hello, re-queues a job the worker lost and stops one it runs that the server didn't give it", async () => {
    const s = await setup({ runnerSlots: 1 });
    s.setRunnerUp(false);
    const w = await s.worker({ slots: 2, reported: 2 });
    const a = await s.req(s.co);
    await s.d.pump();
    const stray = "00000000-0000-4000-8000-000000000001";
    s.toWorker.length = 0;
    await s.d.onWorkerHello(w.id, [stray]);
    expect(s.toWorker.find((x) => x.command.type === "check.cancel")?.command.jobId).toBe(stray);
    // a was re-queued, then claimed again by the pump at the end of hello.
    expect(s.toWorker.filter((x) => x.command.type === "check.run").map((x) => x.command.jobId)).toEqual([a.id]);
  });

  it("turning a worker off puts its jobs back in line at once and stops them on it", async () => {
    const s = await setup({ runnerSlots: 1 });
    s.setRunnerUp(false);
    const w = await s.worker();
    const a = await s.req(s.co);
    await s.d.pump();
    await s.workers.update(w.id, { enabled: false });
    const back = await s.d.onWorkerOff(w.id, "turned off");
    expect(back.map((j) => j.id)).toEqual([a.id]);
    expect(await s.job(a.id)).toMatchObject({ state: "queued", workerId: null, reason: "turned off" });
    expect(s.toWorker.some((x) => x.command.type === "check.cancel" && x.command.jobId === a.id)).toBe(true);
  });

  it("stops a stuck or cancelled job on the worker that runs it, not on the runner", async () => {
    const s = await setup({ runnerSlots: 1 });
    s.setRunnerUp(false);
    await s.worker();
    const a = await s.req(s.co);
    await s.d.pump();
    s.setRunnerUp(true);
    s.toRunner.length = 0;
    await s.d.cancel(a.id, "owner cancelled");
    expect(s.toWorker.some((x) => x.command.type === "check.cancel" && x.command.jobId === a.id)).toBe(true);
    expect(s.toRunner.some((x) => x.command.type === "check.cancel")).toBe(false);
  });

  it("names the worker where a check runs in the queue list", async () => {
    const s = await setup({ runnerSlots: 1 });
    const w = await s.worker();
    const name = (await s.workers.get(w.id))!.name;
    const a = await s.req(s.co);
    const b = await s.req(s.co);
    await s.d.pump();
    const view = await s.q.list(s.co.id, new Date(), await s.d.capacity(s.co.id));
    expect(view.slots).toBe(2);
    expect(view.rows.find((r) => r.id === a.id)!.ranOn).toBe("company runner");
    expect(view.rows.find((r) => r.id === b.id)!.ranOn).toBe(name);
  });

  it("keeps only the token's hash, and a runner's token never authenticates as a worker", async () => {
    const s = await setup();
    const w = await s.worker();
    const row = (await s.db.select().from(checkWorkers).where(eq(checkWorkers.id, w.id)))[0]!;
    expect(row.tokenHash).toBe(hashToken(w.token));
    expect(JSON.stringify(row)).not.toContain(w.token);
    expect((await s.workers.authenticate(w.token))?.id).toBe(w.id);
    expect(await s.workers.authenticate(undefined)).toBeNull();
    const runnerHash = (await s.db.select({ h: runners.tokenHash }).from(runners).where(eq(runners.id, s.co.runnerId)))[0]!.h;
    expect(await s.workers.authenticate(runnerHash)).toBeNull();
  });

  it("refuses slots or caps out of range", async () => {
    const s = await setup();
    const base = { name: "W", companyIds: [], checkThreads: null, checkMemoryMb: null, enabled: true };
    await expect(s.workers.register({ ...base, slots: 0 })).rejects.toThrow(/Slots/);
    await expect(s.workers.register({ ...base, slots: 1, checkThreads: 0 })).rejects.toThrow(/threads/);
    await expect(s.workers.register({ ...base, slots: 1, checkMemoryMb: 10 })).rejects.toThrow(/Memory/);
  });
});
