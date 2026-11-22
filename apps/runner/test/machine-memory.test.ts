// BOS-2217: the check worker reports the memory its machine really has, and warns at start-up using today's measured peak.
import { describe, expect, it } from "vitest";
import { CHECK_PEAK_MB } from "@boss-man/shared";
import { machineMemoryMb, startupMemoryWarning } from "../src/machine-memory.js";

const GB = 1024 ** 3;
const files = (m: Record<string, string>) => (f: string) => (f in m ? m[f]! : null);

describe("machineMemoryMb", () => {
  it("uses the cgroup v2 limit when the container has one", () => {
    expect(machineMemoryMb(files({ "/sys/fs/cgroup/memory.max": `${8 * GB}\n` }), 64 * GB)).toBe(8192);
  });
  it("uses the cgroup v1 limit when there is no v2 file", () => {
    expect(machineMemoryMb(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${6 * GB}` }), 64 * GB)).toBe(6144);
  });
  it("uses the host's memory when the limit is unlimited (max, or the v1 huge value)", () => {
    expect(machineMemoryMb(files({ "/sys/fs/cgroup/memory.max": "max\n" }), 16 * GB)).toBe(16384);
    expect(machineMemoryMb(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }), 16 * GB)).toBe(16384);
  });
  it("uses the host's memory when no cgroup file exists, and never more than the host has", () => {
    expect(machineMemoryMb(files({}), 4 * GB)).toBe(4096);
    expect(machineMemoryMb(files({ "/sys/fs/cgroup/memory.max": `${32 * GB}` }), 4 * GB)).toBe(4096);
  });
});

describe("startupMemoryWarning", () => {
  it("assumes today's measured peak (about 5 GB a check), not the old 3 GB", () => {
    expect(CHECK_PEAK_MB).toBeGreaterThanOrEqual(4800);
    expect(startupMemoryWarning(2, 8192)).toMatch(/2 full checks at once need about 12 GB/);
    expect(startupMemoryWarning(2, 12 * 1024)).toBeNull();
    expect(startupMemoryWarning(1, 8192)).toBeNull();
  });
});

describe("a check worker's hello", () => {
  it("carries the machine's memory limit, and the server's hello schema accepts it", async () => {
    const { WebSocketServer } = await import("ws");
    const { RunnerConnection } = await import("../src/connection.js");
    const { WorkerMessage } = await import("@boss-man/shared");
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const first = new Promise<string>((resolve) => wss.on("connection", (ws) => ws.once("message", (d) => resolve(String(d)))));
    const conn = new RunnerConnection({ url: `ws://127.0.0.1:${port}`, token: "t", runnerVersion: "test", onCommand: () => {}, checkWorker: { slots: 2, memoryMb: 8192, features: ["check-jobs"] } });
    conn.start();
    const raw = await first;
    conn.stop();
    wss.close();
    const hello = JSON.parse(raw);
    expect(hello).toMatchObject({ type: "hello", checkSlots: 2, memoryMb: 8192 });
    expect(WorkerMessage.safeParse(hello).success).toBe(true);
  });
});
