// Server-queued check jobs (DR-003, BOS-316), run by the runner itself. A job belongs to this process, not to any agent
// session: it keeps going when a run ends and an agent has no command that can stop it (only the server's check.cancel).
// The server's slots order the jobs; each job also takes a slot in the runner's own check line (BOS-805), so jobs, agents'
// hand-run checks and the vitest guard share the machine's real limit. The runner's count caps the server's check_slots.
import { CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, CheckLimits, VERIFY_TIMEOUT_MS, redactForModel, withCheckFacts, type CheckBundleInfo, type RunnerMessage } from "@boss-man/shared";
import type { Workspaces } from "./workspace.js";
import type { DiskGuard } from "./disk-guard.js";

/** What a job needs from check.run (tests pass only some of it). */
export type CheckRunCommand = { jobId: string; projectId: string; commit: string; command: string; timeoutMs?: number; scanList?: string; limits?: CheckLimits; bundle?: CheckBundleInfo };

type Done = Extract<RunnerMessage, { type: "check.done" }>;
const PROGRESS_EVERY_MS = 30_000;

/**
 * BOS-1435: the owner's per-check caps for this machine, as the job's environment. BOSSMAN_CHECK_THREADS is what
 * check-all.sh and every vitest config already read as their worker cap (Playwright runs inside vitest); the memory figure
 * is passed on for the scripts to use. Only bounded whole numbers, never free-form variables: anything else is dropped.
 */
export function checkLimitsEnv(limits: unknown): Record<string, string> {
  const ok = CheckLimits.safeParse(limits ?? {});
  if (!ok.success) return {};
  return { ...(ok.data.threads ? { BOSSMAN_CHECK_THREADS: String(ok.data.threads) } : {}), ...(ok.data.memoryMb ? { BOSSMAN_CHECK_MEMORY_MB: String(ok.data.memoryMb) } : {}) };
}

export class CheckJobs {
  private cancels = new Map<string, () => void>();
  /** Finished jobs the server hasn't been told about yet (socket down): sent again on every reconnect until acknowledged by a new job state. */
  private unsent = new Map<string, Done>();

  constructor(
    private readonly workspaces: Pick<Workspaces, "runCommitCheck">,
    private readonly send: (m: RunnerMessage) => void,
    private readonly log: (m: string) => void = () => {},
    /**
     * BOS-1436, check workers only: gets the job's code onto this machine before the check. False means the check doesn't
     * run here and prepare has told the server why (it asked for the full history, or couldn't get the code at all), so
     * no result is sent. The company runner has none: its shared repo already holds every commit it is sent.
     */
    private readonly prepare?: (cmd: CheckRunCommand) => Promise<boolean>,
    /** BOS-2182: while the disk is almost full a job waits (progress says why) and starts by itself when space is back. */
    private readonly diskGuard?: DiskGuard,
  ) {}

  /** Job ids this runner is running now, for the hello message: the server puts back in line any it thinks run here but don't. */
  running(): string[] {
    // Finished jobs the server has not acknowledged still count: it must not put them back in line and run a 30-50 minute check again.
    return [...new Set([...this.cancels.keys(), ...this.unsent.keys()])];
  }

  /** Called on every (re)connect: results that could not be delivered go out again. */
  resend() {
    for (const done of this.unsent.values()) this.send(done);
  }

  /** The server has recorded this result. */
  acknowledge(jobId: string) {
    this.unsent.delete(jobId);
  }

  run(cmd: CheckRunCommand) {
    if (this.cancels.has(cmd.jobId)) return; // the server asked twice
    const job = { cancelled: false };
    this.cancels.set(cmd.jobId, () => {
      job.cancelled = true;
    });
    if (this.diskGuard && this.diskGuard.hold() !== null) {
      const guard = this.diskGuard;
      void guard
        .waitForRoom({
          cancelled: () => job.cancelled,
          logEveryMs: PROGRESS_EVERY_MS,
          onHold: (reason) => {
            this.send({ type: "check.progress", jobId: cmd.jobId, tail: reason });
            this.log(`check job ${cmd.jobId} is held: ${reason}`);
          },
        })
        .then((room) => {
          if (room && !job.cancelled) return this.begin(cmd, job);
          this.cancels.delete(cmd.jobId);
        });
      return;
    }
    this.begin(cmd, job);
  }

  private begin(cmd: CheckRunCommand, job: { cancelled: boolean }) {
    if (!this.prepare) return this.check(cmd, job);
    void this.prepare(cmd)
      .catch((err: Error) => {
        this.log(`check job ${cmd.jobId}: getting the code failed: ${String(err?.message ?? err).slice(0, 300)}`);
        return false;
      })
      .then((go) => {
        if (go && !job.cancelled) return this.check(cmd, job);
        // Not run here: prepare has told the server (it re-sends the job with the full history, or puts it back in line),
        // and a job cancelled meanwhile needs no answer. Freed, so a re-sent check.run for it is taken.
        this.cancels.delete(cmd.jobId);
      });
  }

  private check(cmd: CheckRunCommand, job: { cancelled: boolean }) {
    let lastSent = 0;
    let cancelled = job.cancelled;
    this.cancels.set(cmd.jobId, () => {
      cancelled = true;
    });
    void this.workspaces
      .runCommitCheck({ projectId: cmd.projectId, jobId: cmd.jobId, commit: cmd.commit }, cmd.command, cmd.timeoutMs ?? VERIFY_TIMEOUT_MS, {
        scanList: cmd.scanList,
        limitsEnv: checkLimitsEnv(cmd.limits),
        onStart: (kill) => {
          this.cancels.set(cmd.jobId, () => {
            cancelled = true;
            kill();
          });
        },
        onOutput: (tail) => {
          const now = Date.now();
          if (now - lastSent < PROGRESS_EVERY_MS) return;
          lastSent = now;
          // BOS-805: waiting in the runner's own check line (the output prints its place every 30 s, which is also the heartbeat).
          const waiting = tail.lastIndexOf(CHECK_QUEUED_MARKER) > tail.lastIndexOf(CHECK_STARTED_MARKER);
          this.send({ type: "check.progress", jobId: cmd.jobId, tail: waiting ? `waiting for a runner check slot\n${tail}`.slice(-8192) : tail });
        },
      })
      .then(
        (r) => ({ stages: r.stages, ranFull: r.ranFull, exitCode: cancelled ? null : r.exitCode, timedOut: r.timedOut && !cancelled, tail: cancelled ? `${r.output}\nStopped by the server.` : r.output, fullLog: r.fullLog === undefined ? undefined : cancelled ? `${r.fullLog}\nStopped by the server.` : r.fullLog }),
        (err: Error) => ({ stages: undefined, ranFull: undefined, exitCode: null as number | null, timedOut: false, tail: `The runner could not start the check: ${String(err.message).slice(0, 1000)}`, fullLog: undefined as string | undefined }),
      )
      .then((r) => {
        this.cancels.delete(cmd.jobId);
        const done: Done = { type: "check.done", jobId: cmd.jobId, commit: cmd.commit, exitCode: r.exitCode, timedOut: r.timedOut, tail: redactForModel(withCheckFacts(r.tail)), ...(r.fullLog !== undefined ? { fullLog: r.fullLog } : {}), ...(r.stages ? { stages: r.stages, ranFull: r.ranFull } : {}) };
        this.unsent.set(cmd.jobId, done);
        this.send(done);
        this.log(`check job ${cmd.jobId} ended (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})`);
      });
  }

  cancel(jobId: string) {
    this.cancels.get(jobId)?.();
  }
}
