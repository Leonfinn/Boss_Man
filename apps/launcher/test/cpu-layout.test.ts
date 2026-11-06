import { describe, expect, it } from "vitest";
import { allowedThreads, formatCpuList, parseCpuList, parseReservedThreads, planReserve } from "../src/cpu-layout.js";
import { containerSpec } from "../src/spec.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
// 12 threads as 6 cores with hyperthreads: 0/6, 1/7 ... (the common Intel/AMD numbering) or 0/1, 2/3 ...
const pairsAdjacent = (id: number) => [id - (id % 2), id - (id % 2) + 1];
const pairsFar = (id: number) => [id % 6, (id % 6) + 6];

describe("cpu lists", () => {
  it("parses and formats", () => {
    expect(parseCpuList("0-3,8,10-11")).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(formatCpuList([0, 1, 2, 3, 8, 10, 11])).toBe("0-3,8,10-11");
    expect(() => parseCpuList("a")).toThrow();
  });
  it("reads the cgroup cpuset first, then affinity", () => {
    expect(allowedThreads((p) => (p.endsWith("cpuset.cpus.effective") ? "2-5\n" : null))).toEqual([2, 3, 4, 5]);
    expect(allowedThreads((p) => (p === "/proc/self/status" ? "Name:\tx\nCpus_allowed_list:\t0,2\n" : null))).toEqual([0, 2]);
  });
});

describe("planReserve", () => {
  it("auto keeps one core (2 threads) on a 12-thread host, siblings together", () => {
    const a = planReserve({ mode: "auto" }, range(12), pairsAdjacent);
    expect(a).toMatchObject({ on: true, reserved: [10, 11], hostThreads: 12 });
    expect(formatCpuList(a.runnerThreads)).toBe("0-9");
    const b = planReserve({ mode: "auto" }, range(12), pairsFar);
    expect(b.reserved).toEqual([5, 11]);
    expect(b.runnerThreads).not.toContain(5);
    expect(b.runnerThreads).not.toContain(11);
  });
  it("without topology info, takes the highest threads", () => {
    expect(planReserve({ mode: "auto" }, range(8)).reserved).toEqual([6, 7]);
  });
  it("auto stays off below 6 threads, and says why", () => {
    const p = planReserve({ mode: "auto" }, range(4));
    expect(p).toMatchObject({ on: false, reserved: [], runnerThreads: [] });
    expect(p.reason).toContain("4 threads");
    expect(planReserve({ mode: "auto" }, range(6)).on).toBe(true);
  });
  it("respects a cpuset with gaps (LXC) and a thread count", () => {
    const p = planReserve({ mode: "count", threads: 3 }, [4, 5, 6, 7, 8, 9], () => null);
    expect(p.reserved).toEqual([7, 8, 9]);
    expect(p.runnerThreads).toEqual([4, 5, 6]);
  });
  it("off, and refusing to starve the runners", () => {
    expect(planReserve({ mode: "off" }, range(12)).on).toBe(false);
    expect(planReserve({ mode: "count", threads: 11 }, range(12)).on).toBe(false);
    expect(planReserve({ mode: "count", threads: 4 }, range(4)).reason).toContain("fewer than");
  });
  it("parses the setting", () => {
    // Off unless asked for (BOS-586 CEO decision: the freezes were not CPU starvation).
    expect(parseReservedThreads(undefined)).toEqual({ mode: "off" });
    expect(parseReservedThreads("")).toEqual({ mode: "off" });
    expect(parseReservedThreads("auto")).toEqual({ mode: "auto" });
    expect(parseReservedThreads("off")).toEqual({ mode: "off" });
    expect(parseReservedThreads("0")).toEqual({ mode: "off" });
    expect(parseReservedThreads("4")).toEqual({ mode: "count", threads: 4 });
    expect(() => parseReservedThreads("lots")).toThrow();
  });
});

describe("runner spec", () => {
  const base = { dataRoot: "/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 1 << 30, pidsLimit: 4096 };
  it("confines runners only when a cpuset is set", () => {
    expect(containerSpec(base, "acme").HostConfig).not.toHaveProperty("CpusetCpus");
    expect(containerSpec({ ...base, cpuset: "0-9" }, "acme").HostConfig).toMatchObject({ CpusetCpus: "0-9" });
  });
});
