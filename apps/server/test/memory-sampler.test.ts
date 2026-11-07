import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { createMemorySampler, readRssAndPeak, type MemoryJump, type MemorySample } from "../src/services/memory-sampler.js";
import { serverStatusService } from "../src/services/server-status.js";

// BOS-410 step 1: log where the server's memory sits, and show the latest in server_status.
const MiB = 1024 * 1024;

function fakeSampler(opts: { keep?: number; extra?: () => Record<string, number> } = {}) {
  let t = Date.parse("2026-11-04T12:00:00Z");
  let rss = 1000 * MiB;
  let cpuMicros = 0;
  const logged: MemorySample[] = [];
  const sampler = createMemorySampler({
    everyMs: 5 * 60_000,
    keep: opts.keep,
    log: (s) => logged.push(s),
    now: () => t,
    memoryUsage: () => ({ rss, heapTotal: 300 * MiB, heapUsed: 200 * MiB, external: 150 * MiB, arrayBuffers: 100 * MiB }),
    heapLimit: () => 4096 * MiB,
    cpuUsage: () => ({ user: cpuMicros, system: 0 }),
    uptime: () => 42.4,
    extra: opts.extra,
  });
  // One tick five minutes on, with rss grown by `grow` MiB and `cores` worth of CPU used.
  const advance = (grow: number, cores = 1) => {
    t += 5 * 60_000;
    rss += grow * MiB;
    cpuMicros += cores * 5 * 60_000 * 1000;
    sampler.tick();
  };
  return { sampler, logged, advance };
}

describe("memory sampler", () => {
  it("records every memoryUsage figure in MiB, the heap limit and what neither V8 nor Buffers explain", () => {
    const { sampler, logged } = fakeSampler({ extra: () => ({ sockets: 2, runnerEventsWaiting: 7 }) });
    sampler.tick();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      at: "2026-11-04T12:00:00.000Z",
      uptimeSeconds: 42,
      rss: 1000,
      heapTotal: 300,
      heapUsed: 200,
      heapLimit: 4096,
      external: 150,
      arrayBuffers: 100,
      nativeOther: 550, // 1000 - 300 - 150
      cpuCores: null, // no earlier sample to measure from
      extra: { sockets: 2, runnerEventsWaiting: 7 },
    });
  });

  it("logs one line per tick, measures CPU between ticks, and keeps only the last `keep` samples", () => {
    const { sampler, logged, advance } = fakeSampler({ keep: 3 });
    sampler.tick();
    for (let i = 0; i < 4; i++) advance(10, 1);
    expect(logged).toHaveLength(5);
    expect(logged[1]!.cpuCores).toBe(1);
    expect(sampler.samples().map((s) => s.rss)).toEqual([1020, 1030, 1040]);
  });

  it("keeps two hours (24 samples) by default", () => {
    const { sampler, advance } = fakeSampler();
    sampler.tick();
    for (let i = 0; i < 30; i++) advance(1);
    expect(sampler.samples()).toHaveLength(24);
  });

  it("status gives a fresh reading and how each figure moved across the kept samples", () => {
    const { sampler, advance } = fakeSampler();
    expect(sampler.status().trend).toBeNull(); // nothing sampled yet
    sampler.tick();
    advance(40, 0.5);
    advance(60, 0.5);
    const s = sampler.status();
    expect(s).toMatchObject({ unit: "MiB", everySeconds: 300, samples: 3, lastCpuCores: 0.5 });
    expect(s.current.rss).toBe(1100);
    expect(s.trend).toEqual({ since: "2026-11-04T12:00:00.000Z", minutes: 10, rss: 100, heapUsed: 0, external: 0, arrayBuffers: 0, nativeOther: 100 });
    // Reading status does not add a sample.
    expect(sampler.samples()).toHaveLength(3);
  });

  it("a counter that throws never stops the memory line", () => {
    const { sampler, logged } = fakeSampler({ extra: () => { throw new Error("boom"); } });
    sampler.tick();
    expect(logged[0]!.extra).toEqual({});
  });

  it("start samples at once and stop clears the timer", () => {
    const { sampler, logged } = fakeSampler();
    sampler.start();
    sampler.start(); // a second start is a no-op
    expect(logged).toHaveLength(1);
    sampler.stop();
  });
});

describe("server_status memory", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function serverPart(memory?: { status: () => unknown }) {
    const opened = await openPglite();
    close = opened.close;
    const svc = serverStatusService(opened.db, {
      role: () => "leader", isConnected: () => false, hold: async () => null,
      errors: { recent: () => [], count: () => 0, untagged: () => 0 } as never,
      deploy: async () => ({ enabled: false, pending: false, status: null, available: null }),
      commit: "dev", startedAt: new Date(0),
      ...(memory ? { memory: memory as never } : {}),
    });
    return (await svc.status(randomUUID())).server;
  }

  it("shows the sampler's reading when one is wired", async () => {
    const { sampler } = fakeSampler();
    sampler.tick();
    const server = await serverPart(sampler);
    expect(server.memory).toMatchObject({ unit: "MiB", current: { rss: 1000, nativeOther: 550 }, samples: 1 });
  });

  it("is null when no sampler is wired, so existing callers see no change", async () => {
    expect((await serverPart()).memory).toBeNull();
  });
});

// BOS-410 step 2: the 5 Nov jump (2-3 GiB to 15 GiB in one go) needs its moment and context caught.
describe("memory jump watch", () => {
  function jumpSampler(opts: { native?: () => Promise<Record<string, number>> } = {}) {
    let t = Date.parse("2026-11-06T10:00:00Z");
    let reading: { rss: number; peak: number | null } = { rss: 2000, peak: 2100 };
    const lines: MemoryJump[] = [];
    const windows: number[] = [];
    const sampler = createMemorySampler({
      log: () => {},
      now: () => t,
      memoryUsage: () => ({ rss: reading.rss * MiB, heapTotal: 100 * MiB, heapUsed: 90 * MiB, external: 1 * MiB, arrayBuffers: 1 * MiB }),
      heapLimit: () => 4096 * MiB,
      native: opts.native,
      jump: {
        read: () => reading,
        context: (w) => {
          windows.push(w);
          return { inFlight: 1 };
        },
        log: (l) => lines.push(l),
      },
    });
    const look = async (r: { rss: number; peak: number | null }, ms = 15_000) => {
      t += ms;
      reading = r;
      await sampler.jumpTick();
    };
    return { sampler, lines, windows, look };
  }

  it("logs one line with before, after, the breakdown and the context when rss rises 512 MiB in one look", async () => {
    const { sampler, lines, windows, look } = jumpSampler({ native: async () => ({ mapBrkHeap: 2500 }) });
    await sampler.jumpTick(); // baseline
    await look({ rss: 2300, peak: 2300 }); // +300: not a jump
    expect(lines).toHaveLength(0);
    await look({ rss: 2900, peak: 2900 }); // +600 since the last look
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ seconds: 15, rss: { from: 2300, to: 2900 }, peak: { from: 2300, to: 2900 }, context: { inFlight: 1 } });
    expect(lines[0]!.sample.rss).toBe(2900);
    expect(lines[0]!.sample.native).toEqual({ mapBrkHeap: 2500 });
    expect(windows).toEqual([15_000]);
    // The jump line is not a trend sample.
    expect(sampler.samples()).toHaveLength(0);
  });

  it("catches a burst that was already freed through the peak", async () => {
    const { sampler, lines, look } = jumpSampler();
    await sampler.jumpTick();
    await look({ rss: 2000, peak: 9000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rss: { from: 2000, to: 2000 }, peak: { from: 2100, to: 9000 } });
  });

  it("logs at most one line a minute, and a held-back rise is reported later from the old baseline", async () => {
    const { sampler, lines, look } = jumpSampler();
    await sampler.jumpTick();
    await look({ rss: 3000, peak: 3000 });
    await look({ rss: 4000, peak: 4000 }); // 15 s later: held back
    await look({ rss: 4000, peak: 4000 }); // 30 s
    await look({ rss: 4000, peak: 4000 }); // 45 s
    expect(lines).toHaveLength(1);
    await look({ rss: 4000, peak: 4000 }); // 60 s: reported, measured from the first jump's end
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ seconds: 60, rss: { from: 3000, to: 4000 } });
  });

  it("works without a peak (not Linux), and a failing reader never throws", async () => {
    const { sampler, lines, look } = jumpSampler();
    await look({ rss: 2000, peak: null });
    await look({ rss: 2600, peak: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.peak).toBeNull();
    const broken = createMemorySampler({ log: () => {}, jump: { read: () => { throw new Error("no /proc"); }, log: () => {} } });
    expect(() => broken.jumpTick()).not.toThrow();
  });

  it("reads this process's rss and peak in MiB", () => {
    const r = readRssAndPeak();
    expect(r.rss).toBeGreaterThan(10);
    if (process.platform === "linux") expect(r.peak).toBeGreaterThanOrEqual(r.rss);
  });
});
