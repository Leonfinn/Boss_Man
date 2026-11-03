// Event-loop stalls and GC pauses (BOS-432). The live server froze for 4-11 s at a time and nobody could say why.
// This records every stall over a threshold (default 1 s) with what the process looked like at that moment: memory,
// the GC time that fell inside the stall, the requests in flight (route patterns only, never ids or query strings)
// and open runner sockets. One `STALL:` log line per stall; the last few and running totals show in server_status.
//
// How a stall is seen: a probe timer every `probeMs`; if it fires much later than due, the loop was blocked for
// the difference. GC entries arrive through a PerformanceObserver; they are delivered after the stall ends, so a
// stall is finished (GC summed, logged) a moment after it is seen.
import { monitorEventLoopDelay, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

const MB = 1024 * 1024;
const mb = (n: number) => Math.round(n / MB);

export type MemorySnapshot = { rssMb: number; heapUsedMb: number; heapTotalMb: number; heapLimitMb: number; externalMb: number; arrayBuffersMb: number };

export type Stall = {
  at: string;
  ms: number;
  /** GC time that overlapped the stall, and the longest single pause in it (with its kind). */
  gcMs: number;
  longestGc: { ms: number; kind: string } | null;
  memory: MemorySnapshot;
  inFlight: number;
  /** The oldest requests still open when the stall ended: method, route pattern and age. */
  oldest: { route: string; ageMs: number }[];
  runnerSockets: number;
};

export type StallSummary = {
  thresholdMs: number;
  since: string;
  count: number;
  lastHour: number;
  worstMs: number;
  /** Event-loop delay since start, from Node's histogram. */
  loopDelayMs: { p50: number; p99: number; max: number };
  gc: Record<string, { count: number; totalMs: number; maxMs: number }>;
  memory: MemorySnapshot;
  inFlight: number;
  recent: Stall[];
};

export type StallMonitor = {
  start(): void;
  stop(): void;
  /** Request tracking (app.ts onRequest / response close). */
  requestStarted(key: object, route: string): void;
  requestEnded(key: object): void;
  summary(): StallSummary;
};

export type StallMonitorOptions = {
  thresholdMs?: number;
  probeMs?: number;
  keep?: number;
  runnerSockets?: () => number;
  log?: (line: string) => void;
};

const GC_KINDS: Record<number, string> = { 1: "minor", 2: "major", 4: "incremental", 8: "weakcb" };

export function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), heapLimitMb: mb(getHeapStatistics().heap_size_limit), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) };
}

export function createStallMonitor(opts: StallMonitorOptions = {}): StallMonitor {
  const thresholdMs = opts.thresholdMs ?? 1000;
  const probeMs = opts.probeMs ?? 250;
  const keep = opts.keep ?? 50;
  const log = opts.log ?? (() => {});
  const since = new Date().toISOString();

  const open = new Map<object, { route: string; startedAt: number }>();
  const recent: Stall[] = [];
  const gcTotals: StallSummary["gc"] = {};
  // GC pauses of the last minute, in performance.now() time, to sum into a stall that just ended.
  let gcs: { start: number; end: number; kind: string }[] = [];
  let count = 0;
  let worstMs = 0;
  let probe: NodeJS.Timeout | null = null;
  let observer: PerformanceObserver | null = null;
  const histogram = monitorEventLoopDelay({ resolution: 20 });

  const finish = (startPerf: number, endPerf: number, ms: number) => {
    const inStall = gcs.filter((g) => g.end > startPerf && g.start < endPerf);
    let gcMs = 0;
    let longestGc: Stall["longestGc"] = null;
    for (const g of inStall) {
      const d = Math.min(g.end, endPerf) - Math.max(g.start, startPerf);
      gcMs += d;
      if (!longestGc || g.end - g.start > longestGc.ms) longestGc = { ms: Math.round(g.end - g.start), kind: g.kind };
    }
    const now = performance.now();
    const oldest = [...open.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 5)
      .map((r) => ({ route: r.route, ageMs: Math.round(now - r.startedAt) }));
    const stall: Stall = {
      at: new Date(Date.now() - (now - startPerf)).toISOString(),
      ms: Math.round(ms),
      gcMs: Math.round(gcMs),
      longestGc,
      memory: memorySnapshot(),
      inFlight: open.size,
      oldest,
      runnerSockets: opts.runnerSockets?.() ?? 0,
    };
    count++;
    worstMs = Math.max(worstMs, stall.ms);
    recent.push(stall);
    if (recent.length > keep) recent.shift();
    const m = stall.memory;
    log(
      `STALL: event loop blocked ${stall.ms} ms; GC ${stall.gcMs} ms of it` +
        (longestGc ? ` (longest ${longestGc.kind} ${longestGc.ms} ms)` : "") +
        `; rss ${m.rssMb} MB, heap ${m.heapUsedMb}/${m.heapTotalMb} MB (limit ${m.heapLimitMb}), external ${m.externalMb} MB, arrayBuffers ${m.arrayBuffersMb} MB` +
        `; ${stall.inFlight} request(s) in flight` +
        (oldest.length ? ` (oldest: ${oldest.map((o) => `${o.route} ${o.ageMs} ms`).join(", ")})` : "") +
        `; ${stall.runnerSockets} runner socket(s)`,
    );
  };

  return {
    start() {
      if (probe) return;
      histogram.enable();
      observer = new PerformanceObserver((list) => {
        const cutoff = performance.now() - 60_000;
        for (const e of list.getEntries() as (PerformanceEntry & { detail?: { kind?: number } })[]) {
          const kind = GC_KINDS[e.detail?.kind ?? 0] ?? "other";
          gcs.push({ start: e.startTime, end: e.startTime + e.duration, kind });
          const t = (gcTotals[kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
          t.count++;
          t.totalMs += e.duration;
          t.maxMs = Math.max(t.maxMs, e.duration);
        }
        gcs = gcs.filter((g) => g.end > cutoff);
      });
      observer.observe({ entryTypes: ["gc"] });
      let last = performance.now();
      probe = setInterval(() => {
        const now = performance.now();
        const ms = now - last - probeMs;
        const startPerf = last;
        last = now;
        // The GC entries of a stall are delivered just after it; finish it once they are in.
        if (ms >= thresholdMs) setTimeout(() => finish(startPerf + probeMs, now, ms), 50).unref();
      }, probeMs);
      probe.unref();
    },
    stop() {
      if (probe) clearInterval(probe);
      probe = null;
      observer?.disconnect();
      observer = null;
      histogram.disable();
    },
    requestStarted(key, route) {
      open.set(key, { route, startedAt: performance.now() });
    },
    requestEnded(key) {
      open.delete(key);
    },
    summary() {
      const hourAgo = Date.now() - 3_600_000;
      const ns = (n: number) => (Number.isFinite(n) ? Math.round(n / 1e6) : 0);
      const gc: StallSummary["gc"] = {};
      for (const [k, v] of Object.entries(gcTotals)) gc[k] = { count: v.count, totalMs: Math.round(v.totalMs), maxMs: Math.round(v.maxMs) };
      return {
        thresholdMs,
        since,
        count,
        lastHour: recent.filter((s) => Date.parse(s.at) >= hourAgo).length,
        worstMs,
        loopDelayMs: { p50: ns(histogram.percentile(50)), p99: ns(histogram.percentile(99)), max: ns(histogram.max) },
        gc,
        memory: memorySnapshot(),
        inFlight: open.size,
        recent: recent.slice(-10),
      };
    },
  };
}
