// The network guard's fast path (BOS-335). A runner that restarts by itself (a crash, Docker coming back, a host
// reboot) gets a fresh network namespace, and the guard's rules die with the old one. The 5 s timer in main.ts used to
// be the only check, so new connections to private addresses were possible for up to 5 s. Docker's own event stream
// says a runner started or restarted at once, so this watches it and runs the same reconcile the timer does.
import type { Docker } from "./docker.js";

/** How long to wait before watching again after Docker's stream ends or errors (1 s: events since are replayed). */
export const RECONNECT_MS = 1_000;
/** The longest pause after Docker keeps failing: the 5 s timer is the backstop, so there's no need to poll faster. */
export const MAX_RECONNECT_MS = 5_000;

export type GuardWatch = { stop: () => void };

export type GuardWatchDeps = {
  docker: Pick<Docker, "events">;
  /** The label runner containers carry, e.g. `boss-man.launcher` (the launcher's own constant). */
  label: string;
  /** Runs the guard check; `why` says what asked (start, a Docker event, the timer). */
  reconcile: (why: string) => void;
  log?: (level: "info" | "error", entry: Record<string, unknown>) => void;
  now?: () => number;
};

/** The pause before watching again: 1 s while it works, backing off to MAX_RECONNECT_MS when Docker keeps failing. */
export function reconnectWait(failures: number): number {
  return Math.min(RECONNECT_MS * 2 ** Math.max(0, failures - 1), MAX_RECONNECT_MS);
}

/**
 * Watches Docker for the runner events that need a guard check and calls `reconcile("docker event")` for each.
 * It reconciles once at start (as the launcher did before) and reconnects after a stream error until `stop()`. The
 * caller's timer stays the backstop for anything missed. Never rejects.
 */
export function watchGuardEvents({ docker, label, reconcile, log = () => undefined, now = Date.now }: GuardWatchDeps): GuardWatch {
  const abort = new AbortController();
  let lastEventAt = now();
  /** Consecutive streams that ended without ever connecting (Docker down): the pause grows so it doesn't log every second. */
  let failures = 0;
  const watch = async () => {
    while (!abort.signal.aborted) {
      // `since` is whole Unix seconds, so go back one to be sure nothing between a crash and the reconnect is missed.
      const since = Math.floor(lastEventAt / 1000) - 1;
      let connected = false;
      await docker.events(
        { type: "container", action: ["start", "restart", "die"], label },
        since,
        () => {
          connected = true;
          lastEventAt = now();
          reconcile("docker event");
        },
        (err) => log("error", { msg: "watching Docker events failed; the 5 s check is still running", error: err.message }),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      failures = connected ? 0 : failures + 1;
      await new Promise((r) => setTimeout(r, reconnectWait(failures)));
    }
  };
  reconcile("start");
  log("info", { msg: "watching Docker events for runner restarts" });
  void watch();
  return { stop: () => abort.abort() };
}
