import { describe, expect, it } from "vitest";
import { parseSmaps, parseStatus, readNativeDetail, v8AndHandles } from "../src/services/native-memory.js";
import { createMemorySampler, type MemorySample } from "../src/services/memory-sampler.js";

// BOS-410 step 2: split the memory outside the JS heap into threads, arenas, brk heap, other anonymous maps and V8's own.
const STATUS = `Name:\tnode
VmHWM:\t15990784 kB
VmRSS:\t15938560 kB
RssAnon:\t15900000 kB
RssFile:\t38000 kB
RssShmem:\t560 kB
Threads:\t27
`;

// One brk heap, one 64 MiB-aligned thread arena (rw part + its ---p remainder), one big unaligned anonymous map, a stack and a file.
const SMAPS = `55d0c0000000-55d0c8000000 rw-p 00000000 00:00 0                          [heap]
Size:             131072 kB
Rss:              102400 kB
7f3c04000000-7f3c07ff0000 rw-p 00000000 00:00 0
Size:              65472 kB
Rss:               65000 kB
7f3c07ff0000-7f3c08000000 ---p 00000000 00:00 0
Size:                 64 kB
Rss:                   0 kB
7f3c10100000-7f3c50100000 rw-p 00000000 00:00 0
Size:            1048576 kB
Rss:             1048576 kB
7ffd1a000000-7ffd1a021000 rw-p 00000000 00:00 0                          [stack]
Size:                132 kB
Rss:                  40 kB
7f3c60000000-7f3c60400000 r-xp 00000000 08:01 1234                       /usr/local/bin/node
Size:               4096 kB
Rss:                2048 kB
`;

describe("native memory breakdown", () => {
  it("reads rss parts and the thread count from /proc status, in MiB", () => {
    expect(parseStatus(STATUS)).toEqual({ rssPeak: 15616, vmRss: 15565, rssAnon: 15527, rssFile: 37, rssShmem: 1, threads: 27 });
  });

  it("splits resident memory by mapping kind: brk heap, thread arenas, other anonymous, stacks, files", () => {
    expect(parseSmaps(SMAPS)).toEqual({ mapBrkHeap: 100, mapArenas: 63, arenas: 1, mapOtherAnon: 1024, mapLargestAnon: 1024, mapStacks: 0, mapFile: 2, maps: 6 });
  });

  it("adds V8's own malloc, context counts and open handles by type", () => {
    const d = v8AndHandles();
    expect(d.v8Malloced).toBeGreaterThanOrEqual(0);
    expect(d.nativeContexts).toBeGreaterThanOrEqual(1);
    expect(d.detachedContexts).toBeGreaterThanOrEqual(0);
    const t = setTimeout(() => undefined, 10_000);
    expect(v8AndHandles().handle_Timeout).toBeGreaterThanOrEqual(1);
    clearTimeout(t);
  });

  it("reads this process without throwing, and leaves out /proc parts where there is none", async () => {
    const here = await readNativeDetail();
    if (process.platform === "linux") expect(here.threads).toBeGreaterThanOrEqual(1);
    const nowhere = await readNativeDetail("/nonexistent-proc");
    expect(nowhere.threads).toBeUndefined();
    expect(nowhere.maps).toBeUndefined();
    expect(nowhere.nativeContexts).toBeGreaterThanOrEqual(1);
  });
});

describe("memory sampler with the native breakdown", () => {
  const MiB = 1024 * 1024;
  const base = {
    everyMs: 60_000,
    memoryUsage: () => ({ rss: 1000 * MiB, heapTotal: 100 * MiB, heapUsed: 90 * MiB, external: 10 * MiB, arrayBuffers: 5 * MiB }),
    heapLimit: () => 4096 * MiB,
    cpuUsage: () => ({ user: 0, system: 0 }),
    uptime: () => 1,
  };

  it("logs the line once the breakdown is in, and status shows the last breakdown", async () => {
    const logged: MemorySample[] = [];
    const sampler = createMemorySampler({ ...base, log: (s) => logged.push(s), native: async () => ({ threads: 27, mapArenas: 800 }) });
    await sampler.tick();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.native).toEqual({ threads: 27, mapArenas: 800 });
    expect(sampler.status().lastNative).toEqual({ threads: 27, mapArenas: 800 });
  });

  it("a failing breakdown still logs the cheap figures", async () => {
    const logged: MemorySample[] = [];
    const sampler = createMemorySampler({ ...base, log: (s) => logged.push(s), native: async () => { throw new Error("no /proc"); } });
    await sampler.tick();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.native).toBeUndefined();
    expect(logged[0]!.nativeOther).toBe(890);
  });
});
