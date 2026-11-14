// Sends queued check jobs to the company's runner and takes its answers (DR-003, BOS-316).
// The queue itself (order, slots, reuse, reasons) is check-queue.ts; this file only moves jobs between it and the runner,
// and wakes the agent that asked for a check when the job ends, for whatever reason.
// BOS-1435 (DR-060): check workers on other machines take jobs the company runner has no free slot for. The runner is
// always filled first; each ready worker then claims with its own limit. With no ready worker every path is as before.
import { and, eq, lt } from "drizzle-orm";
import { fullLogPointer, HEARTBEAT_MS, type CheckLimits, type RunnerCommand, type WorkerCommand } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, runners } from "../db/schema.js";
import { checkQueue, type CheckJob } from "./check-queue.js";
import type { Eligible } from "./check-workers.js";
import { scanListReader, type ScanListWarning } from "./scan-list.js";

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
  /** How long a dropped worker has to come back before its jobs go back in line (default three heartbeats). */
  workerGraceMs?: number;
  /** Only the leader re-queues a dropped worker's jobs (a standby closed the socket itself). Absent: always the leader. */
  isLeader?: () => boolean;
};

const DEFAULT_TIMEOUT = 30 * 60_000;
/** The full check takes 30 to 50 minutes (CLAUDE.md), so a full job gets longer than a quick one. */
const FULL_TIMEOUT = 90 * 60_000;
const verdict = (j: CheckJob) =>
  j.state === "passed" ? `The ${j.scope} check of your ticket passed.` : j.state === "failed" ? `The ${j.scope} check of your ticket FAILED: ${j.reason ?? ""}` : `Your ${j.scope} check did not finish (${j.state}): ${j.reason ?? "no reason recorded"}`;

export function checkDispatcher(db: Db, deps: CheckDispatcherDeps) {
  const queue = checkQueue(db);
  const scanList = deps.scanList ? scanListReader({ read: deps.scanList, ...deps.scanListWarning }) : null;
  const graceMs = deps.workerGraceMs ?? HEARTBEAT_MS * 3;
  // shortcut: a dropped worker's pending re-queue, cancelled if it says hello again in time; lost on restart, harmless because
  // a worker that comes back re-syncs in its hello (onWorkerHello), and one that never does is ended by the no-output sweep, as for a runner.
  const graceTimers = new Map<string, NodeJS.Timeout>();

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
    const queuedCompanies = await db.selectDistinct({ companyId: checkJobs.companyId }).from(checkJobs).where(eq(checkJobs.state, "queued"));
    for (const { companyId } of queuedCompanies) {
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      const runnerUp = !!runner && deps.isConnected(runner.id) && deps.can(runner.id);
      const workers = (await deps.workers?.eligible(companyId)) ?? [];
      if (!runnerUp && !workers.length) continue;
      // A list that can't be read must not stop the line: the scan then runs its secret rules only, and says so once (BOS-1093).
      const list = await scanList?.forScan();
      // The company runner first, so a worker only gets what the runner has no free slot for.
      if (runnerUp)
        for (const job of await queue.claimNext(runner!.id, new Date(), companyId)) {
          const sent = deps.send(runner!.id, runCommand(job, list));
          if (!sent) await queue.requeue(job.id, "The runner could not be reached when the check was due to start, so it went back in line.");
        }
      // BOS-1435: then each ready worker. A merge job carries the owner's list here too: a worker has the runner's trust for
      // checks (it already sees the source), the socket is TLS like the runner's, and the list is never logged.
      for (const w of workers)
        for (const job of await queue.claimOn({ workerId: w.id }, w.limit, new Date(), companyId)) {
          const sent = deps.workers!.send(w.id, runCommand(job, list, w.limits));
          if (!sent) await queue.requeue(job.id, `The check worker "${w.name}" could not be reached when the check was due to start, so it went back in line.`);
        }
    }
  }

  /**
   * The whole number of checks a company can run at once: the runner's slots plus each ready worker's limit. The merge
   * train seats one member per slot (DR-059), so its seats grow with the machines; with no worker this is the slots setting.
   */
  async function capacity(companyId: string): Promise<number> {
    const workers = (await deps.workers?.eligible(companyId)) ?? [];
    return (await queue.slots()) + workers.reduce((n, w) => n + w.limit, 0);
  }

  async function done(machine: string | { workerId: string }, msg: { jobId: string; commit: string; exitCode: number | null; timedOut: boolean; tail: string; fullLog?: string }) {
    const job = await queue.complete(msg.jobId, { runnerId: machine, commit: msg.commit, exitCode: msg.exitCode, logTail: msg.tail, timedOut: msg.timedOut, fullLog: msg.fullLog });
    // The machine may forget the result once the server has seen the job end, whether or not this answer counted.
    const ack = { type: "check.ack" as const, jobId: msg.jobId };
    if (typeof machine === "string") deps.send(machine, ack);
    else deps.workers?.send(machine.workerId, ack);
    if (job) await ended(job);
    await pump();
  }

  return {
    pump,
    capacity,

    onDone: (runnerId: string, msg: Parameters<typeof done>[1]) => done(runnerId, msg),

    async onProgress(runnerId: string, msg: { jobId: string; tail: string }) {
      await queue.progress(msg.jobId, runnerId, msg.tail);
    },

    /** A runner said hello with the jobs it is running: any this runner was given but does not list are gone (it restarted). */
    async onHello(runnerId: string, running: string[] | undefined) {
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
    async onWorkerHello(workerId: string, running: string[] | undefined, helloAt = new Date()) {
      const t = graceTimers.get(workerId);
      if (t) clearTimeout(t);
      graceTimers.delete(workerId);
      const mine = new Set(
        (
          await db
            .select({ id: checkJobs.id })
            .from(checkJobs)
            .where(and(eq(checkJobs.state, "running"), eq(checkJobs.workerId, workerId), lt(checkJobs.startedAt, helloAt)))
        ).map((r) => r.id),
      );
      const alive = new Set(running ?? []);
      for (const id of mine) if (!alive.has(id)) await queue.requeue(id, "The check worker restarted or lost this check, so it was put back in line.");
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
          .then(() => pump())
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
      for (const j of jobs) deps.workers?.send(workerId, { type: "check.cancel", jobId: j.id });
      await pump();
      return jobs;
    },

    /** Periodic: running jobs with no output for too long become stuck (and are stopped on the runner); everyone is told why. */
    async sweep(now = new Date()) {
      await queue.pruneLogs(now).catch(() => 0); // BOS-1228: kept logs older than the retention period go
      const stuck = await queue.sweepStuck(now);
      for (const job of stuck) {
        stopOn(job);
        await ended(job);
      }
      await pump();
      return stuck;
    },

    /** Server-side cancel with a recorded reason; also stops it on the machine running it. */
    async cancel(jobId: string, reason: string) {
      const [before] = await db.select().from(checkJobs).where(eq(checkJobs.id, jobId));
      const job = await queue.cancel(jobId, reason);
      if (job) {
        if (before?.state === "running") stopOn(before);
        await ended(job);
        await pump();
      }
      return job;
    },
  };
}
