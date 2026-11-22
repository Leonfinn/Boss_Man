/**
 * BOS-1955: names a scheduling pass that does not end. The scheduler's lane runs one pass at a time, so one pass that
 * never resolves freezes every later pass, and the drain's wait for `settled()` (bounded at 60 s since BOS-1954) could
 * only say "a pass has not ended", not which one or for how long. This watches each pass: while it runs it logs a
 * `pass-stuck` line every `everyMs` with the pass kind and how long it has been going, and `current()` says the same on demand.
 * It changes nothing about the pass: no cancel, no timeout.
 */
export type LaneWatch = {
  run: <T>(kind: string, fn: () => Promise<T>) => Promise<T>;
  /** The pass running now, or null. */
  current: () => { kind: string; runningMs: number } | null;
};

export const PASS_STUCK_LOG_MS = 60_000;

export function createLaneWatch(opts: { log?: (msg: string) => void; everyMs?: number; clock?: () => number }): LaneWatch {
  const clock = opts.clock ?? Date.now;
  const everyMs = opts.everyMs ?? PASS_STUCK_LOG_MS;
  let active: { kind: string; since: number } | null = null;
  return {
    async run(kind, fn) {
      const since = clock();
      active = { kind, since };
      const timer = setInterval(() => opts.log?.(`pass-stuck: a ${kind} scheduling pass has been running for ${Math.round((clock() - since) / 1000)} s`), everyMs);
      timer.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        active = null;
      }
    },
    current: () => (active ? { kind: active.kind, runningMs: clock() - active.since } : null),
  };
}
