// Where the server's memory sits, sampled every few minutes (BOS-410 step 1). The live server
// holds 10-13 GiB while its JS heap is capped near 4 GiB, so most of it is off-heap. This logs
// one structured "memory" line per sample (docker logs | grep '"msg":"memory"' gives a time
// series, no DB writes) and keeps the last two hours for server_status. Pure reading: no
// behaviour change. It runs on every process, standby included, not as leader-only background
// work, because the standby colour's numbers matter too.
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
  /** How many samples to keep (default 24: two hours at five minutes). */
  keep?: number;
};

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

  function tick() {
    try {
      deps.log(read(true));
    } catch {
      // logging must never take the server down
    }
  }

  return {
    everyMs,
    tick,
    /** First sample at once, then every everyMs. The timer never keeps the process alive. */
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
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
      return { unit: "MiB", everySeconds: Math.round(everyMs / 1000), current, lastCpuCores: last?.cpuCores ?? null, trend, samples: ring.length };
    },
  };
}

export type MemorySampler = ReturnType<typeof createMemorySampler>;
