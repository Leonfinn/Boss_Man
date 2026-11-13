// Sends queued check jobs to the company's runner and takes its answers (DR-003, BOS-316).
// The queue itself (order, slots, reuse, reasons) is check-queue.ts; this file only moves jobs between it and the runner,
// and wakes the agent that asked for a check when the job ends, for whatever reason.
import { and, eq } from "drizzle-orm";
import { fullLogPointer, type NotifyLevel, type RunnerCommand } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, runners } from "../db/schema.js";
import { checkQueue, type CheckJob } from "./check-queue.js";
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
};

const DEFAULT_TIMEOUT = 30 * 60_000;
/** The full check takes 30 to 50 minutes (CLAUDE.md), so a full job gets longer than a quick one. */
const FULL_TIMEOUT = 90 * 60_000;
const verdict = (j: CheckJob) =>
  j.state === "passed" ? `The ${j.scope} check of your ticket passed.` : j.state === "failed" ? `The ${j.scope} check of your ticket FAILED: ${j.reason ?? ""}` : `Your ${j.scope} check did not finish (${j.state}): ${j.reason ?? "no reason recorded"}`;

export function checkDispatcher(db: Db, deps: CheckDispatcherDeps) {
  const queue = checkQueue(db);
  const scanList = deps.scanList ? scanListReader({ read: deps.scanList, ...deps.scanListWarning }) : null;

  async function ended(job: CheckJob) {
    if (job.requestedBy && deps.wake) {
      const kept = job.state === "failed" ? await queue.logChars(job.id).catch(() => null) : null;
      const where = kept ? `\n\n${fullLogPointer(job.id, job.ticketId, kept)}` : "";
      const tail = (job.logTail ? `\n\nEnd of the log:\n${job.logTail.slice(-1500)}` : "") + where;
      await Promise.resolve(deps.wake(job.requestedBy, { ticketId: job.ticketId, reason: "check_result", note: `${verdict(job)}${tail}`, priority: 2 })).catch(() => {});
    }
    await Promise.resolve(deps.onEnded?.(job)).catch(() => {});
  }

  /** Start whatever the free slots allow. Safe to call any time: a job is never claimed twice. */
  async function pump(): Promise<void> {
    if ((await queue.mode()) !== "server") return;
    const queuedCompanies = await db.selectDistinct({ companyId: checkJobs.companyId }).from(checkJobs).where(eq(checkJobs.state, "queued"));
    for (const { companyId } of queuedCompanies) {
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      if (!runner || !deps.isConnected(runner.id) || !deps.can(runner.id)) continue;
      // A list that can't be read must not stop the line: the scan then runs its secret rules only, and says so once (BOS-1093).
      const list = await scanList?.forScan();
      for (const job of await queue.claimNext(runner.id, new Date(), companyId)) {
        const sent = deps.send(runner.id, {
          type: "check.run",
          jobId: job.id,
          projectId: job.projectId,
          ticketId: job.ticketId,
          commit: job.commit,
          command: job.command ?? deps.defaultCommand?.(job) ?? (job.scope === "full" ? "scripts/check-all.sh" : "scripts/check-quick.sh"),
          timeoutMs: deps.timeoutMs ?? (job.scope === "full" ? FULL_TIMEOUT : DEFAULT_TIMEOUT),
          ...(list ? { scanList: list } : {}),
        });
        if (!sent) await queue.requeue(job.id, "The runner could not be reached when the check was due to start, so it went back in line.");
      }
    }
  }

  return {
    pump,

    async onDone(runnerId: string, msg: { jobId: string; commit: string; exitCode: number | null; timedOut: boolean; tail: string; fullLog?: string }) {
      const job = await queue.complete(msg.jobId, { runnerId, commit: msg.commit, exitCode: msg.exitCode, logTail: msg.tail, timedOut: msg.timedOut, fullLog: msg.fullLog });
      // The runner may forget the result once the server has seen the job end, whether or not this answer counted.
      deps.send(runnerId, { type: "check.ack", jobId: msg.jobId });
      if (job) await ended(job);
      await pump();
    },

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

    /** Periodic: running jobs with no output for too long become stuck (and are stopped on the runner); everyone is told why. */
    async sweep(now = new Date()) {
      await queue.pruneLogs(now).catch(() => 0); // BOS-1228: kept logs older than the retention period go
      const stuck = await queue.sweepStuck(now);
      for (const job of stuck) {
        if (job.runnerId) deps.send(job.runnerId, { type: "check.cancel", jobId: job.id });
        await ended(job);
      }
      await pump();
      return stuck;
    },

    /** Server-side cancel with a recorded reason; also stops it on the runner if it was running. */
    async cancel(jobId: string, reason: string) {
      const [before] = await db.select().from(checkJobs).where(eq(checkJobs.id, jobId));
      const job = await queue.cancel(jobId, reason);
      if (job) {
        if (before?.state === "running" && before.runnerId) deps.send(before.runnerId, { type: "check.cancel", jobId });
        await ended(job);
        await pump();
      }
      return job;
    },
  };
}
