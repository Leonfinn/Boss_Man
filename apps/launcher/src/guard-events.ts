// The network guard's fast path (BOS-335). A runner that restarts by itself (a crash, Docker coming back, a host
// reboot) gets a fresh network namespace, and the guard's rules die with the old one. The 5 s timer in main.ts used to
// be the only check, so new connections to private addresses were possible for up to 5 s. Docker's own event stream
// says a runner started or restarted at once, so this watches it and runs the same reconcile the timer does.
import type { Docker } from "./docker.js";

/** How long to wait before watching again after Docker's stream ends or errors (1 s: events since are replayed). */
export const RECONNECT_MS = 1_000;

export type GuardWatch = { stop: () => void };

export type GuardWatchDeps = {
  docker: Pick<Docker, "events">;
  /** The runner label to watch (`boss-man.launcher=1`). */
  label: string;
  /** Runs the guard check; `why` says what asked (start, a Docker event, the timer). */
  reconcile: (why: string) => void;
  log?: (level: "info" | "error", entry: Record<string, unknown>) => void;
  now?: () => number;
};

/**
 * Watches Docker for the runner events that need a guard check and calls `reconcile("docker event")` for each.
 * It reconciles once at start (as the launcher did before) and reconnects after a stream error until `stop()`. The
 * caller's timer stays the backstop for anything missed. Never rejects.
 */
export function watchGuardEvents({ docker, label, reconcile, log = () => undefined, now = Date.now }: GuardWatchDeps): GuardWatch {
  const abort = new AbortController();
  let lastEventAt = now();
  const watch = async () => {
    while (!abort.signal.aborted) {
      // `since` is whole Unix seconds, so go back one to be sure nothing between a crash and the reconnect is missed.
      const since = Math.floor(lastEventAt / 1000) - 1;
      await docker.events(
        { type: "container", action: ["start", "restart", "die"], label },
        since,
        () => {
          lastEventAt = now();
          reconcile("docker event");
        },
        (err) => log("error", { msg: "watching Docker events failed; the 5 s check is still running", error: err.message }),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  };
  reconcile("start");
  log("info", { msg: "watching Docker events for runner restarts" });
  void watch();
  return { stop: () => abort.abort() };
}
