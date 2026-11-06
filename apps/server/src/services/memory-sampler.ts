// Where the server's memory sits, sampled every few minutes (BOS-410 step 1). The live server
// holds 10-13 GiB while its JS heap is capped near 4 GiB, so most of it is off-heap. This logs
// one structured "memory" line per sample (docker logs | grep '"msg":"memory"' gives a time
// series, no DB writes) and keeps the last two hours for server_status. Pure reading: no
// behaviour change. It runs on every process, standby included, not as leader-only background
// work, because the standby colour's numbers matter too.
//
// Jump watch (BOS-410 step 2): on 5 Nov the server went from 2-3 GiB to 15 GiB in one go somewhere in a
// 35-minute window, then stayed flat, so a five-minute trend can't say what set it off. Every 15 s it reads
// only rss and the peak rss (VmHWM); a rise of 512 MiB or more in either logs one "memory jump" line at once,
// with the full breakdown and the requests open and just finished. The peak matters once the image's malloc
// threshold hands big blocks straight back: a burst then leaves rss but still raises the peak.
import { readFileSync } from "node:fs";
import v8 from "node:v8";

const MiB = 1024 * 1024;
const mib = (bytes: number) => Math.round(bytes / MiB);

export type MemorySample = {
  at: string;
  uptimeSeconds: number;
  /** All in MiB. */
  rss: number;
  heapTotal: number;
  heapUsed: number;
  heapLimit: number;
  external: number;
  arrayBuffers: number;
  /** rss − heapTotal − external: memory neither V8 nor Buffers account for (malloc arenas, WASM such as PGlite, native addons, code). */
  nativeOther: number;
  /** Share of one core used since the previous sample (1 = one full core). */
  cpuCores: number | null;
  /** Cheap counters for the suspects (open sockets, their unsent bytes, runner events waiting to be stored). */
  extra: Record<string, number>;
  /** What the native part is made of (native-memory.ts, BOS-410 step 2): threads, smaps by kind, V8 malloc, handles. */
  native?: Record<string, number>;
};

export type MemorySamplerDeps = {
  everyMs?: number;
  log: (sample: MemorySample) => void;
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  heapLimit?: () => number;
  cpuUsage?: () => NodeJS.CpuUsage;
  uptime?: () => number;
  extra?: () => Record<string, number>;
  /** Slower native breakdown, read once per sample after the cheap figures; its failure never stops the line. */
  native?: () => Promise<Record<string, number>>;
  /** How many samples to keep (default 24: two hours at five minutes). */
  keep?: number;
  /** Jump watch (BOS-410): see createMemorySampler. Off when left out. */
  jump?: JumpWatchDeps;
};

export type JumpWatchDeps = {
  /** How often to look (default 15 s). */
  everyMs?: number;
  /** Rise in MiB since the last look that counts as a jump (default 512). */
  thresholdMiB?: number;
  /** Fewest ms between two jump lines (default 60 s); a held-back rise is reported at the next look after it. */
  minGapMs?: number;
  /** Cheap readings in MiB: rss now, and the peak rss so far (VmHWM) when the platform has one. */
  read: () => { rss: number; peak: number | null };
  /** What the server was doing (requests open and just finished, sockets), added to the line. */
  context?: (windowMs: number) => Record<string, unknown>;
  log: (line: MemoryJump) => void;
};

export type MemoryJump = {
  seconds: number;
  rss: { from: number; to: number };
  peak: { from: number; to: number } | null;
  sample: MemorySample;
  context: Record<string, unknown>;
};

/** VmHWM and VmRSS from /proc/self/status (Linux), else process.memoryUsage.rss(); MiB. Sync: a ~1 KiB read. */
export function readRssAndPeak(): { rss: number; peak: number | null } {
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const kib = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? NaN);
    const rss = kib("VmRSS");
    const peak = kib("VmHWM");
    if (Number.isFinite(rss) && Number.isFinite(peak)) return { rss: Math.round(rss / 1024), peak: Math.round(peak / 1024) };
  } catch {
    // not Linux
  }
  return { rss: mib(process.memoryUsage.rss()), peak: null };
}

export const DEFAULT_MEMORY_LOG_MS = 5 * 60_000;

export function createMemorySampler(deps: MemorySamplerDeps) {
  const everyMs = deps.everyMs && deps.everyMs > 0 ? deps.everyMs : DEFAULT_MEMORY_LOG_MS;
  const keep = deps.keep ?? 24;
  const now = deps.now ?? Date.now;
  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage());
  const heapLimit = deps.heapLimit ?? (() => v8.getHeapStatistics().heap_size_limit);
  const cpuUsage = deps.cpuUsage ?? (() => process.cpuUsage());
  const uptime = deps.uptime ?? (() => process.uptime());
  const ring: MemorySample[] = [];
  let lastCpu: { usage: NodeJS.CpuUsage; at: number } | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** Reads the numbers now. Records it in the ring (and moves the CPU baseline) only when asked. */
  function read(record: boolean): MemorySample {
    const at = now();
    const m = memoryUsage();
    const cpu = cpuUsage();
    let cpuCores: number | null = null;
    if (lastCpu && at > lastCpu.at) {
      const usedMicros = cpu.user - lastCpu.usage.user + (cpu.system - lastCpu.usage.system);
      cpuCores = Math.round((usedMicros / 1000 / (at - lastCpu.at)) * 100) / 100;
    }
    let extra: Record<string, number> = {};
    try {
      extra = deps.extra?.() ?? {};
    } catch {
      extra = {}; // a broken counter never stops the memory line
    }
    const sample: MemorySample = {
      at: new Date(at).toISOString(),
      uptimeSeconds: Math.round(uptime()),
      rss: mib(m.rss),
      heapTotal: mib(m.heapTotal),
      heapUsed: mib(m.heapUsed),
      heapLimit: mib(heapLimit()),
      external: mib(m.external),
      arrayBuffers: mib(m.arrayBuffers),
      nativeOther: mib(m.rss - m.heapTotal - m.external),
      cpuCores,
      extra,
    };
    if (record) {
      lastCpu = { usage: cpu, at };
      ring.push(sample);
      if (ring.length > keep) ring.splice(0, ring.length - keep);
    }
    return sample;
  }

  const log = (sample: MemorySample) => {
    try {
      deps.log(sample);
    } catch {
      // logging must never take the server down
    }
  };

  /** Returns a promise only when a native reader is wired, so the line waits for its breakdown. */
  function tick(): Promise<void> | void {
    let sample: MemorySample;
    try {
      sample = read(true);
    } catch {
      return;
    }
    if (!deps.native) return log(sample);
    return deps
      .native()
      .then((d) => { sample.native = d; }, () => undefined)
      .then(() => log(sample));
  }

  const jump = deps.jump;
  const jumpEveryMs = jump?.everyMs && jump.everyMs > 0 ? jump.everyMs : 15_000;
  const jumpThreshold = jump?.thresholdMiB ?? 512;
  const jumpGapMs = jump?.minGapMs ?? 60_000;
  // The readings a rise is measured from; moved on only when no jump is pending, so a held-back rise still shows.
  let jumpBase: { at: number; rss: number; peak: number | null } | null = null;
  let lastJumpAt = -Infinity;
  let jumpTimer: NodeJS.Timeout | null = null;

  /** One jump look. Returns the line's promise when a jump was logged (for tests). */
  function jumpTick(): Promise<void> | void {
    if (!jump) return;
    let cur: { rss: number; peak: number | null };
    try {
      cur = jump.read();
    } catch {
      return;
    }
    const at = now();
    const base = jumpBase;
    if (!base) {
      jumpBase = { at, ...cur };
      return;
    }
    const rose = cur.rss - base.rss >= jumpThreshold || (cur.peak != null && base.peak != null && cur.peak - base.peak >= jumpThreshold);
    if (!rose || at - lastJumpAt < jumpGapMs) {
      if (!rose) jumpBase = { at, ...cur };
      return;
    }
    lastJumpAt = at;
    jumpBase = { at, ...cur };
    const windowMs = at - base.at;
    let sample: MemorySample;
    let context: Record<string, unknown> = {};
    try {
      sample = read(false);
      context = jump.context?.(windowMs) ?? {};
    } catch {
      return;
    }
    const line: MemoryJump = {
      seconds: Math.round(windowMs / 1000),
      rss: { from: base.rss, to: cur.rss },
      peak: cur.peak != null && base.peak != null ? { from: base.peak, to: cur.peak } : null,
      sample,
      context,
    };
    const emit = () => {
      try {
        jump.log(line);
      } catch {
        // logging must never take the server down
      }
    };
    if (!deps.native) return emit();
    return deps
      .native()
      .then((d) => { sample.native = d; }, () => undefined)
      .then(emit);
  }

  return {
    everyMs,
    tick,
    jumpTick,
    /** First sample at once, then every everyMs; the jump watch every 15 s. The timers never keep the process alive. */
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), everyMs);
      timer.unref();
      if (jump) {
        jumpTick();
        jumpTimer = setInterval(() => void jumpTick(), jumpEveryMs);
        jumpTimer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      if (jumpTimer) clearInterval(jumpTimer);
      timer = null;
      jumpTimer = null;
    },
    samples: () => [...ring],
    /** For server_status: a fresh reading, plus how each figure moved across the kept samples. */
    status() {
      const current = read(false);
      const first = ring[0];
      const last = ring[ring.length - 1];
      const trend =
        first && last && first !== last
          ? {
              since: first.at,
              minutes: Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000),
              rss: last.rss - first.rss,
              heapUsed: last.heapUsed - first.heapUsed,
              external: last.external - first.external,
              arrayBuffers: last.arrayBuffers - first.arrayBuffers,
              nativeOther: last.nativeOther - first.nativeOther,
            }
          : null;
      return { unit: "MiB", everySeconds: Math.round(everyMs / 1000), current, lastCpuCores: last?.cpuCores ?? null, lastNative: last?.native ?? null, trend, samples: ring.length };
    },
  };
}

export type MemorySampler = ReturnType<typeof createMemorySampler>;
