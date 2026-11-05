// BOS-432: event-loop stalls are recorded with memory, GC time and the requests that were in flight.
import { describe, expect, it } from "vitest";
import { createStallMonitor } from "../src/services/stall-monitor.js";

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
      expect(lines[0]).toMatch(/^STALL: event loop blocked \d+ ms; GC \d+ ms of it.*rss \d+ MB.*1 request\(s\) in flight \(oldest: GET \/api\/companies\/:id\/board \d+ ms\); 3 runner socket\(s\)$/);
    } finally {
      m.stop();
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
