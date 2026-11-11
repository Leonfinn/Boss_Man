// Server-queued check jobs (DR-003, BOS-316), run by the runner itself. A job belongs to this process, not to any agent
// session: it keeps going when a run ends and an agent has no command that can stop it (only the server's check.cancel).
// The server's slots order the jobs; each job also takes a slot in the runner's own check line (BOS-805), so jobs, agents'
// hand-run checks and the vitest guard share the machine's real limit. The runner's count caps the server's check_slots.
import { CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, VERIFY_TIMEOUT_MS, type RunnerMessage } from "@boss-man/shared";
import type { Workspaces } from "./workspace.js";

type Done = Extract<RunnerMessage, { type: "check.done" }>;
const PROGRESS_EVERY_MS = 30_000;

export class CheckJobs {
  private cancels = new Map<string, () => void>();
  /** Finished jobs the server hasn't been told about yet (socket down): sent again on every reconnect until acknowledged by a new job state. */
  private unsent = new Map<string, Done>();

  constructor(
    private readonly workspaces: Pick<Workspaces, "runCommitCheck">,
    private readonly send: (m: RunnerMessage) => void,
    private readonly log: (m: string) => void = () => {},
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

  run(cmd: { jobId: string; projectId: string; commit: string; command: string; timeoutMs?: number }) {
    if (this.cancels.has(cmd.jobId)) return; // the server asked twice
    let lastSent = 0;
    let cancelled = false;
    this.cancels.set(cmd.jobId, () => {
      cancelled = true;
    });
    void this.workspaces
      .runCommitCheck({ projectId: cmd.projectId, jobId: cmd.jobId, commit: cmd.commit }, cmd.command, cmd.timeoutMs ?? VERIFY_TIMEOUT_MS, {
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
        (r) => ({ exitCode: cancelled ? null : r.exitCode, timedOut: r.timedOut && !cancelled, tail: cancelled ? `${r.output}\nStopped by the server.` : r.output }),
        (err: Error) => ({ exitCode: null as number | null, timedOut: false, tail: `The runner could not start the check: ${String(err.message).slice(0, 1000)}` }),
      )
      .then((r) => {
        this.cancels.delete(cmd.jobId);
        const done: Done = { type: "check.done", jobId: cmd.jobId, commit: cmd.commit, exitCode: r.exitCode, timedOut: r.timedOut, tail: r.tail.slice(-8192) };
        this.unsent.set(cmd.jobId, done);
        this.send(done);
        this.log(`check job ${cmd.jobId} ended (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})`);
      });
  }

  cancel(jobId: string) {
    this.cancels.get(jobId)?.();
  }
}
