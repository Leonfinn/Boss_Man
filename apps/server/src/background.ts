// The server's recurring passes. Rule: background loops start only through startBackground().
// stopBackground() clears the timers and waits for passes already running, so a shutdown (or,
// later, a demotion) never cuts a pass in half.
export type Loop = { name: string; everyMs: number; run: () => Promise<unknown> };

export function createBackground(loops: Loop[], onError: (err: unknown, name: string) => void = () => {}) {
  let timers: NodeJS.Timeout[] = [];
  // shortcut: passes in flight in this process; lost on restart, harmless because stopBackground() waits for them.
  const inFlight = new Set<Promise<void>>();
  // A pass slower than its interval skips the ticks it misses rather than piling up (BOS-414): one
  // loop never runs two passes at once. Each timer keeps its own promise, so one slow loop only
  // skips its own ticks.
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
    },
    async stopBackground() {
      timers.forEach(clearInterval);
      timers = [];
      while (inFlight.size) await Promise.all([...inFlight]);
    },
  };
}
