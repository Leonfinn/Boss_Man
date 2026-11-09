// Event-loop stalls and GC pauses (BOS-432). The live server froze for 4-11 s at a time and nobody could say why.
// This records every stall over a threshold (default 1 s) with what the process looked like at that moment: memory,
// the GC time that fell inside the stall, the requests in flight (route patterns only, never ids or query strings)
// and open runner sockets. One `STALL:` log line per stall; the last few and running totals show in server_status.
//
// How a stall is seen: a probe timer every `probeMs`; if it fires much later than due, the loop was blocked for
// the difference. GC entries arrive through a PerformanceObserver; they are delivered after the stall ends, so a
// stall is finished (GC summed, logged) a moment after it is seen.
//
// What blocked it (BOS-602): each stall also carries the process CPU time and major page faults during it (from
// getrusage, read on every probe), a CPU profile of the main thread for the stall window (stall-profile.ts, live
// server only) and the container's cgroup pressure and throttling counters. CPU close to the stall's length plus a
// profile names our own synchronous code; CPU near zero means the process was made to wait (kernel memory
// throttling, swap-in, CPU quota), which the cgroup figures then name.
import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { startLoopProfiler, type LoopProfiler, type StallProfile } from "./stall-profile.js";
import { sinceHours } from "@boss-man/shared";

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
  /** Process CPU (all threads, user + system) and major page faults (swap or file reads) during the stall. */
  cpuMs: number;
  majorFaults: number;
  /** What the main thread ran during the stall; null when profiling is off. */
  profile: StallProfile | null;
  /** The container's pressure (10 s averages, %) and the throttling events since the previous stall; null off Linux cgroup v2. */
  cgroup: CgroupAtStall | null;
};

export type CgroupAtStall = {
  memoryFullAvg10: number | null;
  cpuSomeAvg10: number | null;
  ioFullAvg10: number | null;
  sinceLast: { seconds: number; memoryHighEvents: number; memoryMaxEvents: number; cpuThrottledMs: number };
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
  /** What the server was doing over the last `windowMs`: oldest open requests, and routes that finished in it (BOS-410 memory jumps). */
  activity(windowMs: number): { inFlight: number; oldest: { route: string; ageMs: number }[]; finished: Record<string, { count: number; maxMs: number }> };
  /** Stalls that started at or after `sinceMs` (epoch ms), from the last `keep` kept, and the longest (server-health.ts, BOS-640). */
  since(sinceMs: number): { count: number; worstMs: number; thresholdMs: number };
};

export type StallMonitorOptions = {
  thresholdMs?: number;
  probeMs?: number;
  keep?: number;
  runnerSockets?: () => number;
  log?: (line: string) => void;
  /** CPU profile sampling interval in µs; 0 turns it off. Default 10 ms on the live server (NODE_ENV=production), off elsewhere; BOSSMAN_STALL_PROFILE=0 turns it off. */
  profileIntervalUs?: number;
  /** cgroup v2 folder to read pressure and throttling from (tests point it elsewhere). */
  cgroupDir?: string;
};

const GC_KINDS: Record<number, string> = { 1: "minor", 2: "major", 4: "incremental", 8: "weakcb" };

// Ended profiles are dropped this often when no stall cut one, so the samples kept stay small.
const PROFILE_ROTATE_MS = 120_000;

const defaultProfileUs = () => (process.env.NODE_ENV === "production" && process.env.BOSSMAN_STALL_PROFILE !== "0" ? 10_000 : 0);

type CgroupCounters = { at: number; memoryHigh: number; memoryMax: number; throttledUs: number; memoryFullAvg10: number | null; cpuSomeAvg10: number | null; ioFullAvg10: number | null };

async function readCgroup(dir: string): Promise<CgroupCounters | null> {
  const read = (f: string) => readFile(`${dir}/${f}`, "utf8").catch(() => "");
  const [events, cpuStat, mem, cpu, io] = await Promise.all(["memory.events", "cpu.stat", "memory.pressure", "cpu.pressure", "io.pressure"].map(read));
  if (!events && !cpuStat && !mem && !cpu && !io) return null;
  const field = (text: string, key: string) => Number(new RegExp(`^${key} (\\d+)$`, "m").exec(text ?? "")?.[1] ?? 0);
  const avg10 = (text: string | undefined, line: "some" | "full") => {
    const m = new RegExp(`^${line} avg10=([\\d.]+)`, "m").exec(text ?? "");
    return m ? Number(m[1]) : null;
  };
  return {
    at: Date.now(),
    memoryHigh: field(events!, "high"),
    memoryMax: field(events!, "max"),
    throttledUs: field(cpuStat!, "throttled_usec"),
    memoryFullAvg10: avg10(mem, "full"),
    cpuSomeAvg10: avg10(cpu, "some"),
    ioFullAvg10: avg10(io, "full"),
  };
}

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

  // lost on restart, harmless because it only lists this process's own requests in flight (diagnostics, never shared state).
  const open = new Map<object, { route: string; startedAt: number }>();
  const recent: Stall[] = [];
  // The last 200 finished requests (route pattern, end time, duration), so a memory jump can name what just ran.
  const finished: { route: string; endedAt: number; ms: number }[] = [];
  const gcTotals: StallSummary["gc"] = {};
  // GC pauses of the last minute, in performance.now() time, to sum into a stall that just ended.
  let gcs: { start: number; end: number; kind: string }[] = [];
  let count = 0;
  let worstMs = 0;
  let probe: NodeJS.Timeout | null = null;
  let observer: PerformanceObserver | null = null;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const profileUs = opts.profileIntervalUs ?? defaultProfileUs();
  const cgroupDir = opts.cgroupDir ?? "/sys/fs/cgroup";
  let profiler: LoopProfiler | null = null;
  let lastCgroup: CgroupCounters | null = null;

  const finish = async (startPerf: number, endPerf: number, ms: number, used: { cpuMs: number; majorFaults: number; profile: StallProfile | null }) => {
    const cg = await readCgroup(cgroupDir).catch(() => null);
    const prev = lastCgroup;
    if (cg) lastCgroup = cg;
    const cgroup: CgroupAtStall | null = cg
      ? {
          memoryFullAvg10: cg.memoryFullAvg10,
          cpuSomeAvg10: cg.cpuSomeAvg10,
          ioFullAvg10: cg.ioFullAvg10,
          sinceLast: {
            seconds: prev ? Math.round((cg.at - prev.at) / 1000) : 0,
            memoryHighEvents: prev ? cg.memoryHigh - prev.memoryHigh : 0,
            memoryMaxEvents: prev ? cg.memoryMax - prev.memoryMax : 0,
            cpuThrottledMs: prev ? Math.round((cg.throttledUs - prev.throttledUs) / 1000) : 0,
          },
        }
      : null;
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
      cpuMs: used.cpuMs,
      majorFaults: used.majorFaults,
      profile: used.profile,
      cgroup,
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
        `; ${stall.runnerSockets} runner socket(s)` +
        `; process CPU ${stall.cpuMs} ms, ${stall.majorFaults} major fault(s)` +
        (stall.profile
          ? `; sampled ${stall.profile.sampledMs} ms, top: ${stall.profile.top.map((t) => `${t.fn} ${t.ms} ms${t.via ? ` via ${t.via}` : ""}`).join(" | ") || "none"}`
          : "") +
        (cgroup
          ? `; cgroup avg10 memory full ${cgroup.memoryFullAvg10 ?? "?"}%, cpu some ${cgroup.cpuSomeAvg10 ?? "?"}%, io full ${cgroup.ioFullAvg10 ?? "?"}%` +
            `; since last ${cgroup.sinceLast.seconds} s: memory.high ${cgroup.sinceLast.memoryHighEvents}, memory.max ${cgroup.sinceLast.memoryMaxEvents}, cpu throttled ${cgroup.sinceLast.cpuThrottledMs} ms`
          : ""),
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
      if (profileUs > 0) profiler = startLoopProfiler(profileUs);
      void readCgroup(cgroupDir).then((cg) => (lastCgroup ??= cg), () => undefined);
      let last = performance.now();
      let lastUsage = process.resourceUsage();
      let lastRotate = last;
      probe = setInterval(() => {
        const now = performance.now();
        const usage = process.resourceUsage();
        const ms = now - last - probeMs;
        const startPerf = last;
        const before = lastUsage;
        last = now;
        lastUsage = usage;
        if (ms >= thresholdMs) {
          // Cut the profile now, in the same callback that saw the stall, so no rotation can drop its samples.
          const used = {
            cpuMs: Math.round((usage.userCPUTime - before.userCPUTime + usage.systemCPUTime - before.systemCPUTime) / 1000),
            majorFaults: usage.majorPageFault - before.majorPageFault,
            profile: profiler?.cut(startPerf, now) ?? null,
          };
          lastRotate = now;
          // The GC entries of a stall are delivered just after it; finish it once they are in.
          setTimeout(() => void finish(startPerf + probeMs, now, ms, used).catch(() => undefined), 50).unref();
        } else if (profiler && now - lastRotate >= PROFILE_ROTATE_MS) {
          profiler.rotate();
          lastRotate = now;
        }
      }, probeMs);
      probe.unref();
    },
    stop() {
      if (probe) clearInterval(probe);
      probe = null;
      profiler?.stop();
      profiler = null;
      observer?.disconnect();
      observer = null;
      histogram.disable();
    },
    requestStarted(key, route) {
      open.set(key, { route, startedAt: performance.now() });
    },
    requestEnded(key) {
      const r = open.get(key);
      open.delete(key);
      if (!r) return;
      const endedAt = performance.now();
      finished.push({ route: r.route, endedAt, ms: Math.round(endedAt - r.startedAt) });
      if (finished.length > 200) finished.shift();
    },
    activity(windowMs) {
      const now = performance.now();
      const oldest = [...open.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, 5)
        .map((r) => ({ route: r.route, ageMs: Math.round(now - r.startedAt) }));
      const finishedByRoute: Record<string, { count: number; maxMs: number }> = {};
      for (const f of finished) {
        if (f.endedAt < now - windowMs) continue;
        const t = (finishedByRoute[f.route] ??= { count: 0, maxMs: 0 });
        t.count++;
        t.maxMs = Math.max(t.maxMs, f.ms);
      }
      return { inFlight: open.size, oldest, finished: finishedByRoute };
    },
    since(sinceMs) {
      const hits = recent.filter((s) => Date.parse(s.at) >= sinceMs);
      return { count: hits.length, worstMs: hits.reduce((m, s) => Math.max(m, s.ms), 0), thresholdMs };
    },
    summary() {
      const hourAgo = sinceHours(new Date()).getTime();
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
