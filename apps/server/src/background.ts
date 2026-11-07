// The server's recurring passes. Rule: background loops start only through startBackground().
// stopBackground() clears the timers and waits for passes already running, so a shutdown (or,
// later, a demotion) never cuts a pass in half.
// firstAfterMs: also run one pass this long after start, so a slow loop (daily) still runs on a server that restarts often.
export type Loop = { name: string; everyMs: number; run: () => Promise<unknown>; firstAfterMs?: number };

export function createBackground(loops: Loop[], onError: (err: unknown, name: string) => void = () => {}) {
  let timers: NodeJS.Timeout[] = [];
  let firsts: NodeJS.Timeout[] = [];
  // shortcut: passes in flight in this process; lost on restart, harmless because stopBackground() waits for them.
  const inFlight = new Set<Promise<void>>();
  // shortcut: the loops with a pass running now; lost on restart, harmless because a fresh process starts with none.
  // A pass slower than its interval skips the ticks it misses rather than piling up (BOS-414): one loop never
  // runs two passes at once, and each timer keeps its own promise, so a slow loop only skips its own ticks.
  const running = new Set<Loop>();

  const pass = (l: Loop) => {
    if (running.has(l)) return;
    running.add(l);
    const p: Promise<void> = l
      .run()
      .then(() => undefined, (err) => onError(err, l.name))
      .finally(() => {
        running.delete(l);
        inFlight.delete(p);
      });
    inFlight.add(p);
  };

  return {
    startBackground() {
      if (timers.length) return;
      timers = loops.map((l) => setInterval(() => pass(l), l.everyMs));
      firsts = loops.filter((l) => l.firstAfterMs !== undefined).map((l) => setTimeout(() => pass(l), l.firstAfterMs));
    },
    async stopBackground() {
      timers.forEach(clearInterval);
      timers = [];
      firsts.forEach(clearTimeout);
      firsts = [];
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
