// Sends queued check jobs to the company's runner and takes its answers (DR-003, BOS-316).
// The queue itself (order, slots, reuse, reasons) is check-queue.ts; this file only moves jobs between it and the runner,
// and wakes the agent that asked for a check when the job ends, for whatever reason.
// BOS-1435 (DR-060): check workers on other machines take jobs the company runner has no free slot for. The runner is
// always filled first; each ready worker then claims with its own limit. With no ready worker every path is as before.
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { fullLogPointer, HEARTBEAT_MS, type CheckBundleInfo, type CheckLimits, type RunnerCommand, type WorkerCommand, type WorkerRepos } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, runners } from "../db/schema.js";
import type { CheckBundleStore } from "./check-bundles.js";
import { checkQueue, DEFAULT_SLOT_POLICY, isDefaultPolicy, type CheckJob, type MachineView } from "./check-queue.js";
import type { Eligible } from "./check-workers.js";
import { scanListReader, type ScanListWarning } from "./scan-list.js";

/** scripts/install-packages.sh (used by check-quick.sh and check-all.sh) prints this and exits 75 when the install stopped on a machine error. */
export const MACHINE_FAULT_MARKER = "check-quick: install stopped on a machine fault";
export const MACHINE_FAULT_RETRIES = 3;

export type CheckDispatcherDeps = {
  send: (runnerId: string, command: RunnerCommand) => boolean;
  isConnected: (runnerId: string) => boolean;
  can: (runnerId: string) => boolean;
  /** Wake the agent that asked for the check, with the outcome. */
  wake?: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
  /** Called when a job ends in any way, e.g. so the merge gate or the main-red logic can react. */
  onEnded?: (job: CheckJob) => Promise<unknown> | unknown;
  /** The command a job runs when the request named none. */
  defaultCommand?: (job: CheckJob) => string;
  /** The runner's own time limit for a job, in ms. */
  timeoutMs?: number;
  /** The owner's private-details list for the merge-line scan (BOS-979); null or absent when none is set. Never logged. */
  scanList?: () => Promise<string | null>;
  /** Says so when a set list can't be read (BOS-1093): one warning and one owner notification per failure streak. */
  scanListWarning?: ScanListWarning;
  /** BOS-1435: check workers. Absent (as in older tests) means none. */
  workers?: {
    eligible: (companyId: string) => Promise<Eligible[]>;
    send: (workerId: string, command: WorkerCommand) => boolean;
    isConnected: (workerId: string) => boolean;
  };
  /**
   * BOS-1436: how a worker gets the code. The company runner packs the job's commit as a git bundle and uploads it; the
   * worker downloads it. Absent, or a runner without the "check-bundle" feature: no worker gets a job (it couldn't check
   * anything), and every path is as before.
   */
  bundles?: {
    store: Pick<CheckBundleStore, "remove" | "sweep">;
    canPack: (runnerId: string) => boolean;
    pack: (runnerId: string, cmd: { projectId: string; jobId: string; commit: string; haves: string[]; full: boolean }) => Promise<CheckBundleInfo>;
  };
  /** How long a dropped worker has to come back before its jobs go back in line (default three heartbeats). */
  workerGraceMs?: number;
  /** Only the leader re-queues a dropped worker's jobs (a standby closed the socket itself). Absent: always the leader. */
  isLeader?: () => boolean;
  /** A runner drain (image update or setting change) is under way (BOS-1471): no new job goes to any runner until it ends. Running ones finish; queued ones wait. */
  drainPending?: () => Promise<boolean>;
};

const DEFAULT_TIMEOUT = 30 * 60_000;
/** The full check takes 30 to 50 minutes (CLAUDE.md), so a full job gets longer than a quick one. */
const FULL_TIMEOUT = 90 * 60_000;
const verdict = (j: CheckJob) =>
  j.state === "passed" ? `The ${j.scope} check of your ticket passed.` : j.state === "failed" ? `The ${j.scope} check of your ticket FAILED: ${j.reason ?? ""}` : `Your ${j.scope} check did not finish (${j.state}): ${j.reason ?? "no reason recorded"}`;

export function checkDispatcher(db: Db, deps: CheckDispatcherDeps) {
  const queue = checkQueue(db);
  /** Checks at once each connected runner said it runs (hello, BOS-1471). A runner that said nothing has no entry: no cap. */
  const runnerSlots = new Map<string, number>(); // lost on restart, harmless because each runner says its count again when it reconnects.
  const scanList = deps.scanList ? scanListReader({ read: deps.scanList, ...deps.scanListWarning }) : null;
  const graceMs = deps.workerGraceMs ?? HEARTBEAT_MS * 3;
  // shortcut: a dropped worker's pending re-queue, cancelled if it says hello again in time; lost on restart, harmless because
  // a worker that comes back re-syncs in its hello (onWorkerHello), and one that never does is ended by the no-output sweep, as for a runner.
  const graceTimers = new Map<string, NodeJS.Timeout>();

  // BOS-1436, all in memory: a restart re-queues every running job anyway, and the bundle folder is cleared at start-up.
  // shortcut: what each worker last said it holds, per project (the next bundle's base); lost on restart, harmless because
  // a worker sends its repos again in its hello.
  const haves = new Map<string, Map<string, string[]>>();
  // shortcut: the job a runner may upload a bundle for right now, and which runner (the upload route asks); lost on restart,
  // harmless because the pack request dies with the process and the job is re-queued.
  const uploading = new Map<string, string>();
  // shortcut: each worker job getting its code, and whether the full history was already sent; lost on restart, harmless
  // because the job is re-queued and starts over.
  const fetching = new Map<string, { job: CheckJob; worker: Eligible; list: string | null | undefined; full: boolean }>();
  // shortcut: workers that couldn't get a job's code, so the job goes elsewhere instead of looping back to them; lost on restart,
  // harmless because at worst the job is offered to that worker once more and fails over again.
  const noCodeOn = new Map<string, Set<string>>();

  // shortcut: code being packed for a worker right now (not awaited by pump); settled() waits for them, for tests and shutdown.
  // Lost on restart, harmless because the promises die with the process.
  const inFlight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const t = p.catch(() => {}).finally(() => inFlight.delete(t));
    inFlight.add(t);
  };

  /** The company runner, when it is up and can pack code for workers; null means no worker can get any job's code. */
  async function packerFor(companyId: string): Promise<string | null> {
    if (!deps.bundles) return null;
    const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
    return runner && deps.isConnected(runner.id) && deps.bundles.canPack(runner.id) ? runner.id : null;
  }

  /** BOS-1628: how many times a job went back in line after a machine fault (the counter is lost on a server restart, which only allows a few more tries). */
  // shortcut: lost on restart, harmless because a restart only allows a few more tries of a job that is capped at MACHINE_FAULT_RETRIES.
  const machineFaults = new Map<string, number>();

  /** A job ended, was cancelled or went back in line: its bundle and its fetch state go. */
  function forgetCode(jobId: string, alsoExclusions: boolean) {
    deps.bundles?.store.remove(jobId);
    fetching.delete(jobId);
    uploading.delete(jobId);
    if (alsoExclusions) noCodeOn.delete(jobId);
  }

  const stillOn = async (jobId: string, workerId: string) =>
    (await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), eq(checkJobs.workerId, workerId)))).length > 0;

  /**
   * The worker couldn't get the code: the job goes back in line (not a failed check, so no ticket bounces) and this worker
   * is left out for it, so the runner or another worker takes it.
   */
  async function noCode(jobId: string, w: { id: string; name: string }, why: string) {
    const out = noCodeOn.get(jobId) ?? new Set<string>();
    out.add(w.id);
    noCodeOn.set(jobId, out);
    forgetCode(jobId, false);
    await queue.requeue(jobId, `Couldn't get the code to the check worker "${w.name}" (${why.slice(0, 300)}), so the check went back in line.`, { workerId: w.id });
    await pump();
  }

  /** Has the company runner pack the job's code for the worker, then sends the worker the job with it. Never throws. */
  async function codeFor(job: CheckJob, w: Eligible, list: string | null | undefined, runnerId: string, full: boolean) {
    fetching.set(job.id, { job, worker: w, list, full });
    uploading.set(job.id, runnerId);
    // Also resets the no-output clock: a first full bundle can take a minute or two to pack and upload.
    await queue.progress(job.id, { workerId: w.id }, "Getting the code to the check worker.").catch(() => {});
    let info: CheckBundleInfo;
    try {
      info = await deps.bundles!.pack(runnerId, { projectId: job.projectId, jobId: job.id, commit: job.commit, haves: full ? [] : (haves.get(w.id)?.get(job.projectId) ?? []), full });
    } catch (err) {
      uploading.delete(job.id);
      if (await stillOn(job.id, w.id)) await noCode(job.id, w, `the company runner couldn't pack it: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      return;
    }
    uploading.delete(job.id);
    // Cancelled, re-queued or ended while the runner packed: the bundle has nobody to go to.
    if (!(await stillOn(job.id, w.id))) {
      forgetCode(job.id, false);
      return;
    }
    const sent = deps.workers!.send(w.id, { ...runCommand(job, list, w.limits), bundle: info });
    if (!sent) {
      forgetCode(job.id, false);
      await queue.requeue(job.id, `The check worker "${w.name}" could not be reached when the check was due to start, so it went back in line.`, { workerId: w.id });
      await pump();
    }
  }

  async function ended(job: CheckJob) {
    if (job.requestedBy && deps.wake) {
      const kept = job.state === "failed" ? await queue.logChars(job.id).catch(() => null) : null;
      const where = kept ? `\n\n${fullLogPointer(job.id, job.ticketId, kept)}` : "";
      const tail = (job.logTail ? `\n\nEnd of the log:\n${job.logTail.slice(-1500)}` : "") + where;
      await Promise.resolve(deps.wake(job.requestedBy, { ticketId: job.ticketId, reason: "check_result", note: `${verdict(job)}${tail}`, priority: 2 })).catch(() => {});
    }
    await Promise.resolve(deps.onEnded?.(job)).catch(() => {});
  }

  const runCommand = (job: CheckJob, list: string | null | undefined, limits?: CheckLimits) => {
    // BOS-1043: only the merge gate's job carries the list. An agent-requested check reports its scan result back to the
    // agent, so a listed value named by file and line would let it test guesses against the owner's list.
    const sendList = !!list && job.kind === "merge";
    return {
      type: "check.run" as const,
      jobId: job.id,
      projectId: job.projectId,
      ticketId: job.ticketId,
      commit: job.commit,
      command: job.command ?? deps.defaultCommand?.(job) ?? (job.scope === "full" ? "scripts/check-all.sh" : "scripts/check-quick.sh"),
      timeoutMs: deps.timeoutMs ?? (job.scope === "full" ? FULL_TIMEOUT : DEFAULT_TIMEOUT),
      ...(sendList ? { scanList: list } : {}),
      ...(limits ? { limits } : {}),
    };
  };

  /** Stop a job on whichever machine has it. */
  const stopOn = (job: Pick<CheckJob, "id" | "runnerId" | "workerId">) => {
    if (job.workerId) deps.workers?.send(job.workerId, { type: "check.cancel", jobId: job.id });
    else if (job.runnerId) deps.send(job.runnerId, { type: "check.cancel", jobId: job.id });
  };

  /** Start whatever the free slots allow. Safe to call any time: a job is never claimed twice. */
  async function pump(): Promise<void> {
    if ((await queue.mode()) !== "server") return;
    // The runner is about to be swapped: a job started now would be killed by it. Workers wait too: a worker only takes
    // jobs while its image commit equals the runner's (DR-042), and the swap is what changes the runner's commit.
    if (await deps.drainPending?.()) return;
    const queuedCompanies = await db.selectDistinct({ companyId: checkJobs.companyId }).from(checkJobs).where(eq(checkJobs.state, "queued"));
    for (const { companyId } of queuedCompanies) {
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      const runnerUp = !!runner && deps.isConnected(runner.id) && deps.can(runner.id);
      // BOS-1436: a worker gets the code only through the company runner, so with no runner able to pack it, no worker is used.
      const packer = runner && deps.bundles && deps.isConnected(runner.id) && deps.bundles.canPack(runner.id) ? runner.id : null;
      const workers = packer ? ((await deps.workers?.eligible(companyId)) ?? []) : [];
      if (!runnerUp && !workers.length) continue;
      // A list that can't be read must not stop the line: the scan then runs its secret rules only, and says so once (BOS-1093).
      const list = await scanList?.forScan();
      // BOS-1602: two passes. The first fills only slots set aside for one kind (kept for merges, a merges-only or a
      // checks-only machine), so a merge goes to a kept slot and a quick check to a checks-only machine before either takes
      // an "either" slot. The second fills the either slots as before. With nothing set there are no such slots, the first
      // pass claims nothing and this is the old order: the runner first, then each worker.
      const split = !isDefaultPolicy(await queue.runnerPolicy()) || workers.some((w) => w.policy && !isDefaultPolicy(w.policy));
      for (const dedicatedOnly of split ? [true, false] : [false]) {
        // The company runner first, so a worker only gets what the runner has no free slot for. BOS-1471: the runner's
        // limit is also capped by the slots it reported in hello.
        if (runnerUp)
          for (const job of await queue.claimNext(runner!.id, new Date(), companyId, runnerSlots.get(runner!.id), { dedicatedOnly })) {
            const sent = deps.send(runner!.id, runCommand(job, list));
            if (!sent) await queue.requeue(job.id, "The runner could not be reached when the check was due to start, so it went back in line.");
          }
        // BOS-1435: then each ready worker. A merge job carries the owner's list here too: a worker has the runner's trust for
        // checks (it already sees the source), the socket is TLS like the runner's, and the list is never logged.
        // BOS-1436: the job starts on the worker once the runner has packed its code (not awaited, so a 190 MB first bundle
        // never holds up the line); a job this worker couldn't get the code for is left to the others.
        for (const w of workers)
          for (const job of await queue.claimOn({ workerId: w.id }, w.limit, new Date(), companyId, (id) => !!noCodeOn.get(id)?.has(w.id), { policy: w.policy, dedicatedOnly }))
            track(codeFor(job, w, list, packer!, false));
      }
    }
  }

  /** BOS-1602: the company's ready machines with their limits and splits, for "why it waits" on the queue view. */
  async function machines(companyId: string): Promise<MachineView[]> {
    const workers = (await packerFor(companyId)) ? ((await deps.workers?.eligible(companyId)) ?? []) : [];
    return [{ workerId: null, limit: await queue.slots(), policy: await queue.runnerPolicy() }, ...workers.map((w) => ({ workerId: w.id, limit: w.limit, policy: w.policy ?? DEFAULT_SLOT_POLICY }))];
  }

  /**
   * BOS-1602: the merge train seats one member per slot that can run a merge check (DR-059), so a checks-only machine adds
   * no seat. Never below one, so the train still lands one at a time if the owner set every machine to checks only.
   */
  async function mergeCapacity(companyId: string): Promise<number> {
    const n = (await machines(companyId)).reduce((sum, m) => sum + (m.policy.takes === "checks" ? 0 : m.limit), 0);
    return Math.max(1, n);
  }

  /**
   * The whole number of checks a company can run at once: the runner's slots plus each ready worker's limit. The merge
   * train seats one member per slot (DR-059), so its seats grow with the machines; with no worker this is the slots setting.
   */
  async function capacity(companyId: string): Promise<number> {
    const workers = (await packerFor(companyId)) ? ((await deps.workers?.eligible(companyId)) ?? []) : [];
    return (await queue.slots()) + workers.reduce((n, w) => n + w.limit, 0);
  }

  async function done(machine: string | { workerId: string }, msg: { jobId: string; commit: string; exitCode: number | null; timedOut: boolean; tail: string; fullLog?: string }) {
    // BOS-1628: the install died of the machine (EAGAIN, ENOSPC, EMFILE), not the branch. Back in line, never a failed check for
    // the agent, up to MACHINE_FAULT_RETRIES times for one job; after that it fails with the reason in the log, so it can't loop.
    if (msg.exitCode === 75 && !msg.timedOut && msg.tail.includes(MACHINE_FAULT_MARKER)) {
      const n = machineFaults.get(msg.jobId) ?? 0;
      if (n < MACHINE_FAULT_RETRIES) {
        const back = await queue.requeue(msg.jobId, `The check could not install its packages on this machine (a machine fault, not the code), so it went back in line (try ${n + 1} of ${MACHINE_FAULT_RETRIES}).`, machine);
        if (back) {
          machineFaults.set(msg.jobId, n + 1);
          const ack = { type: "check.ack" as const, jobId: msg.jobId };
          if (typeof machine === "string") deps.send(machine, ack);
          else deps.workers?.send(machine.workerId, ack);
          forgetCode(msg.jobId, false);
          await pump();
          return;
        }
      }
    }
    const job = await queue.complete(msg.jobId, { runnerId: machine, commit: msg.commit, exitCode: msg.exitCode, logTail: msg.tail, timedOut: msg.timedOut, fullLog: msg.fullLog });
    // The machine may forget the result once the server has seen the job end, whether or not this answer counted.
    const ack = { type: "check.ack" as const, jobId: msg.jobId };
    if (typeof machine === "string") deps.send(machine, ack);
    else deps.workers?.send(machine.workerId, ack);
    if (job) forgetCode(job.id, true);
    if (job) await ended(job);
    await pump();
  }

  return {
    pump,
    capacity,
    mergeCapacity,
    machines,

    /** Resolves once no worker's code is being packed (it keeps waiting while new ones start). */
    async settled() {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    onDone: (runnerId: string, msg: Parameters<typeof done>[1]) => done(runnerId, msg),

    async onProgress(runnerId: string, msg: { jobId: string; tail: string }) {
      await queue.progress(msg.jobId, runnerId, msg.tail);
    },

    /** A runner said hello with the jobs it is running: any this runner was given but does not list are gone (it restarted). */
    /** The checks at once this runner reported in hello, or undefined (older runner, or none said yet). Settings → Checks shows the smaller of this and check_slots. */
    runnerSlots: (runnerId: string): number | undefined => runnerSlots.get(runnerId),

    async onHello(runnerId: string, running: string[] | undefined, slots?: number) {
      if (slots) runnerSlots.set(runnerId, slots);
      else runnerSlots.delete(runnerId);
      const mine = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.state, "running"), eq(checkJobs.runnerId, runnerId)));
      const alive = new Set(running ?? []);
      for (const { id } of mine) if (!alive.has(id)) await queue.requeue(id, "The runner restarted or lost this check, so it was put back in line.");
      await pump();
    },

    onWorkerDone: (workerId: string, msg: Parameters<typeof done>[1]) => done({ workerId }, msg),

    async onWorkerProgress(workerId: string, msg: { jobId: string; tail: string }) {
      await queue.progress(msg.jobId, { workerId }, msg.tail);
    },

    /**
     * A worker said hello with the jobs it is running. Jobs it was given but doesn't list go back in line (it restarted);
     * jobs it lists that the server didn't give it (re-queued while it was away, or given elsewhere) are stopped on it,
     * so a late duplicate can't run on.
     * `helloAt` is when the hello arrived, taken before the worker was marked connected: a pump in between may already have
     * sent it a job its hello couldn't list, and that job (started at or after `helloAt`) must not be re-queued.
     */
    async onWorkerHello(workerId: string, running: string[] | undefined, helloAt = new Date(), repos?: WorkerRepos) {
      const t = graceTimers.get(workerId);
      if (t) clearTimeout(t);
      graceTimers.delete(workerId);
      if (repos) haves.set(workerId, new Map(repos.map((r) => [r.projectId, r.haves])));
      const mine = new Set(
        (
          await db
            .select({ id: checkJobs.id })
            .from(checkJobs)
            .where(and(eq(checkJobs.state, "running"), eq(checkJobs.workerId, workerId), lt(checkJobs.startedAt, helloAt)))
        ).map((r) => r.id),
      );
      const alive = new Set(running ?? []);
      // A job whose code the runner is still packing hasn't been sent to the worker yet, so it isn't in its list: it stays.
      for (const id of mine)
        if (!alive.has(id) && !uploading.has(id)) {
          forgetCode(id, false);
          await queue.requeue(id, "The check worker restarted or lost this check, so it was put back in line.");
        }
      for (const id of alive) if (!mine.has(id)) deps.workers?.send(workerId, { type: "check.cancel", jobId: id });
      await pump();
    },

    /**
     * A worker's socket closed. Unlike a company runner it may never come back, so its running jobs go back in line after
     * the grace period unless it has reconnected by then.
     */
    onWorkerGone(workerId: string) {
      const old = graceTimers.get(workerId);
      if (old) clearTimeout(old);
      const t = setTimeout(() => {
        graceTimers.delete(workerId);
        // A server that stepped down closed every socket itself; the worker redials the new leader, which owns its jobs now.
        if (deps.workers?.isConnected(workerId) || (deps.isLeader && !deps.isLeader())) return;
        void queue
          .requeueWorker(workerId, "The check worker running this check went offline, so it was put back in line.")
          .then((jobs) => {
            for (const j of jobs) forgetCode(j.id, false);
            return pump();
          })
          .catch(() => {});
      }, graceMs);
      t.unref?.();
      graceTimers.set(workerId, t);
    },

    /** The owner turned a worker off or removed it: its running jobs go back in line now (the caller closes its socket). */
    async onWorkerOff(workerId: string, why: string) {
      const t = graceTimers.get(workerId);
      if (t) clearTimeout(t);
      graceTimers.delete(workerId);
      const jobs = await queue.requeueWorker(workerId, why);
      for (const j of jobs) {
        forgetCode(j.id, false);
        deps.workers?.send(workerId, { type: "check.cancel", jobId: j.id });
      }
      haves.delete(workerId);
      await pump();
      return jobs;
    },

    /** BOS-1436: the worker lacks a thin bundle's base. It gets the full history once; a second ask gives up on it. */
    async onWorkerNeedCode(workerId: string, jobId: string) {
      const f = fetching.get(jobId);
      if (!f || f.worker.id !== workerId || !(await stillOn(jobId, workerId))) return;
      if (f.full) return noCode(jobId, f.worker, "the full history didn't work either");
      const packer = await packerFor(f.job.companyId);
      if (!packer) return noCode(jobId, f.worker, "the company runner is offline");
      await codeFor(f.job, f.worker, f.list, packer, true);
    },

    /** BOS-1436: the worker couldn't get the code at all: back in line, not a failed check. */
    async onWorkerNoCode(workerId: string, jobId: string, reason: string) {
      if (!(await stillOn(jobId, workerId))) return;
      await noCode(jobId, { id: workerId, name: fetching.get(jobId)?.worker.name ?? "worker" }, reason);
    },

    /** BOS-1436: what the worker holds now (after a fetch); its job is under way, so its bundle can go. */
    onWorkerRepos(workerId: string, repos: WorkerRepos) {
      haves.set(workerId, new Map(repos.map((r) => [r.projectId, r.haves])));
    },

    /** BOS-1436: whether this runner may upload a bundle for this job now (only while the server is waiting on it to). */
    acceptsUpload: (jobId: string, runnerId: string) => uploading.get(jobId) === runnerId,

    /** BOS-1436: the worker has its code (a whole download): the bundle has done its job. */
    delivered(jobId: string) {
      deps.bundles?.store.remove(jobId);
    },

    /** Periodic: running jobs with no output for too long become stuck (and are stopped on the runner); everyone is told why. */
    async sweep(now = new Date()) {
      await queue.pruneLogs(now).catch(() => 0); // BOS-1228: kept logs older than the retention period go
      const stuck = await queue.sweepStuck(now);
      for (const job of stuck) {
        stopOn(job);
        forgetCode(job.id, true);
        await ended(job);
      }
      // BOS-1436: bundles whose job no longer runs on a worker (ended, re-queued, or left by a crash) go.
      if (deps.bundles) {
        const live = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.state, "running"), isNotNull(checkJobs.workerId)));
        deps.bundles.store.sweep(new Set(live.map((r) => r.id)));
        // Exclusions only matter while the job still waits; drop those of jobs that ended.
        if (noCodeOn.size) {
          const open = new Set((await db.select({ id: checkJobs.id }).from(checkJobs).where(inArray(checkJobs.state, ["queued", "running"]))).map((r) => r.id));
          for (const id of noCodeOn.keys()) if (!open.has(id)) noCodeOn.delete(id);
        }
      }
      await pump();
      return stuck;
    },

    /** Server-side cancel with a recorded reason; also stops it on the machine running it. */
    async cancel(jobId: string, reason: string) {
      const [before] = await db.select().from(checkJobs).where(eq(checkJobs.id, jobId));
      const job = await queue.cancel(jobId, reason);
      if (job) {
        forgetCode(jobId, true);
        if (before?.state === "running") stopOn(before);
        await ended(job);
        await pump();
      }
      return job;
    },
  };
}
