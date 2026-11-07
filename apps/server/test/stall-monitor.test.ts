// BOS-432: event-loop stalls are recorded with memory, GC time and the requests that were in flight.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "node:inspector";
import { describe, expect, it, vi } from "vitest";
import { createStallMonitor } from "../src/services/stall-monitor.js";
import { summariseProfile } from "../src/services/stall-profile.js";

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function busyStallForTest(ms: number) {
  const end = performance.now() + ms;
  let x = 0;
  // Mostly pure JS between clock reads, so the samples land in this function rather than in the clock call.
  while (performance.now() < end) for (let i = 0; i < 200_000; i++) x = (x * 31 + i) % 1_000_003;
  return x;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("stall monitor", () => {
  it("records a stall over the threshold with memory and in-flight requests, and logs one line", async () => {
    const lines: string[] = [];
    const m = createStallMonitor({ thresholdMs: 1000, probeMs: 50, runnerSockets: () => 3, log: (l) => lines.push(l) });
    m.start();
    try {
      const a = {};
      const b = {};
      m.requestStarted(a, "GET /api/companies/:id/board");
      m.requestStarted(b, "POST /mcp");
      m.requestEnded(b);
      await sleep(120);
      block(1500);
      await sleep(200);
      const s = m.summary();
      expect(s.count).toBe(1);
      expect(s.lastHour).toBe(1);
      const st = s.recent[0]!;
      expect(st.ms).toBeGreaterThan(1300);
      expect(s.worstMs).toBe(st.ms);
      expect(st.inFlight).toBe(1);
      expect(st.oldest).toEqual([{ route: "GET /api/companies/:id/board", ageMs: expect.any(Number) }]);
      expect(st.runnerSockets).toBe(3);
      expect(st.memory.heapUsedMb).toBeGreaterThan(0);
      expect(st.memory.heapLimitMb).toBeGreaterThan(st.memory.heapUsedMb);
      expect(s.loopDelayMs.max).toBeGreaterThan(1000);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^STALL: event loop blocked \d+ ms; GC \d+ ms of it.*rss \d+ MB.*1 request\(s\) in flight \(oldest: GET \/api\/companies\/:id\/board \d+ ms\); 3 runner socket\(s\); process CPU \d+ ms, \d+ major fault\(s\)/);
      // Profiling is off outside the live server (NODE_ENV is "test" here).
      expect(st.profile).toBeNull();
    } finally {
      m.stop();
    }
  });

  // BOS-602: tell "the process was made to wait" from "our code computed", and name the code.
  it("a sleeping block uses almost no CPU; a busy block uses about its length and the profile names the function", async () => {
    const cg = mkdtempSync(join(tmpdir(), "stall-cg-"));
    const events = (high: number) => `low 0\nhigh ${high}\nmax 0\noom 0\n`;
    writeFileSync(join(cg, "memory.events"), events(5));
    writeFileSync(join(cg, "cpu.stat"), "usage_usec 1\nnr_throttled 0\nthrottled_usec 1000\n");
    writeFileSync(join(cg, "memory.pressure"), "some avg10=31.00 avg60=1.00 avg300=0.00 total=9\nfull avg10=19.50 avg60=1.00 avg300=0.00 total=9\n");
    const lines: string[] = [];
    const m = createStallMonitor({ thresholdMs: 1000, probeMs: 50, log: (l) => lines.push(l), profileIntervalUs: 5000, cgroupDir: cg });
    m.start();
    try {
      await sleep(150);
      writeFileSync(join(cg, "memory.events"), events(9));
      block(1300);
      await sleep(250);
      busyStallForTest(1300);
      await sleep(250);
      const [sleeping, busy] = m.summary().recent;
      expect(sleeping!.cpuMs).toBeLessThan(300);
      expect(sleeping!.cgroup).toEqual({ memoryFullAvg10: 19.5, cpuSomeAvg10: null, ioFullAvg10: null, sinceLast: expect.objectContaining({ memoryHighEvents: 4, memoryMaxEvents: 0, cpuThrottledMs: 0 }) });
      // Loose bounds: on a loaded runner the busy loop and the sampler thread both get less than a full core.
      expect(busy!.cpuMs).toBeGreaterThan(400);
      expect(busy!.profile!.sampledMs).toBeGreaterThan(300);
      expect(busy!.profile!.top[0]!.fn).toMatch(/^busyStallForTest .*stall-monitor\.test\.ts:\d+$/);
      expect(lines[1]).toMatch(/process CPU \d+ ms.*top: busyStallForTest .*; cgroup avg10 memory full 19.5%.*memory.high 0/);
    } finally {
      m.stop();
      rmSync(cg, { recursive: true, force: true });
    }
  });

  it("a profile summary names the leaf, its nearest server-code caller, and only the samples inside the window", () => {
    const frame = (functionName: string, url: string, lineNumber = 9) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: "1" });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame("(root)", ""), children: [2] },
        { id: 2, callFrame: frame("sweep", "file:///app/apps/server/src/services/sweeps.ts"), children: [3, 4] },
        { id: 3, callFrame: frame("stringify", "file:///app/node_modules/.pnpm/x/node_modules/fast-json/index.js"), children: [] },
        { id: 4, callFrame: frame("tidy", "file:///app/apps/server/src/services/sweeps.ts", 41), children: [] },
      ],
      startTime: 0,
      endTime: 100_000,
      // 10 samples 10 ms apart: two outside the window (t=10 ms, t=100 ms), then 6 in stringify and 2 in tidy inside it.
      samples: [3, 3, 3, 3, 3, 3, 3, 4, 4, 2],
      timeDeltas: Array(10).fill(10_000),
    };
    const s = summariseProfile(profile, 15_000, 95_000);
    expect(s.sampledMs).toBe(80);
    expect(s.top).toEqual([
      { fn: "stringify fast-json/index.js:10", ms: 60, via: "sweep apps/server/src/services/sweeps.ts:10" },
      { fn: "tidy apps/server/src/services/sweeps.ts:42", ms: 20, via: null },
    ]);
    expect(s.app).toEqual([
      { fn: "sweep apps/server/src/services/sweeps.ts:10", ms: 60 },
      { fn: "tidy apps/server/src/services/sweeps.ts:42", ms: 20 },
    ]);
  });

  // BOS-602: on the live server the profiler is on by default; BOSSMAN_STALL_PROFILE=0 starts no inspector session at all.
  it("BOSSMAN_STALL_PROFILE=0 starts no profiler session on the live server; without it one starts", () => {
    const connect = vi.spyOn(Session.prototype, "connect");
    vi.stubEnv("NODE_ENV", "production");
    try {
      vi.stubEnv("BOSSMAN_STALL_PROFILE", "0");
      const off = createStallMonitor({ thresholdMs: 1000, probeMs: 50 });
      off.start();
      off.stop();
      expect(connect).not.toHaveBeenCalled();
      // Control: the same set-up without the switch does start one, so the spy sees it.
      vi.stubEnv("BOSSMAN_STALL_PROFILE", "");
      const on = createStallMonitor({ thresholdMs: 1000, probeMs: 50 });
      on.start();
      on.stop();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      connect.mockRestore();
    }
  });

  it("short blips under the threshold are not stalls", async () => {
    const m = createStallMonitor({ thresholdMs: 1000, probeMs: 50 });
    m.start();
    try {
      await sleep(100);
      block(300);
      await sleep(150);
      expect(m.summary().count).toBe(0);
    } finally {
      m.stop();
    }
  });
});
