// Server-queued check jobs (DR-003, BOS-316), run by the runner itself. A job belongs to this process, not to any agent
// session: it keeps going when a run ends and an agent has no command that can stop it (only the server's check.cancel).
// The server holds the slots, so nothing here takes a lock file.
import { VERIFY_TIMEOUT_MS, type RunnerMessage } from "@boss-man/shared";
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
    return [...this.cancels.keys()];
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
          this.send({ type: "check.progress", jobId: cmd.jobId, tail });
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
