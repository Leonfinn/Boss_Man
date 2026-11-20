import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaneWatch } from "../src/services/lane-watch.js";

afterEach(() => vi.useRealTimers());

describe("lane watch (BOS-1955)", () => {
  it("names a pass that never ends, with its kind and how long, every minute, and stops when it ends", async () => {
    vi.useFakeTimers();
    let t = 0;
    const lines: string[] = [];
    const watch = createLaneWatch({ log: (m) => lines.push(m), clock: () => t });
    let finish!: () => void;
    const pass = watch.run("queue", () => new Promise<void>((resolve) => (finish = resolve)));
    expect(watch.current()).toEqual({ kind: "queue", runningMs: 0 });
    t = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    t = 120_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toEqual(["pass-stuck: a queue scheduling pass has been running for 60 s", "pass-stuck: a queue scheduling pass has been running for 120 s"]);
    expect(watch.current()).toEqual({ kind: "queue", runningMs: 120_000 });
    finish();
    await pass;
    expect(watch.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(lines).toHaveLength(2); // nothing more once the pass ended
  });

  it("says nothing for a pass that ends in time, passes its result through, and clears on an error", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const watch = createLaneWatch({ log: (m) => lines.push(m) });
    await expect(watch.run("slow checks", async () => 7)).resolves.toBe(7);
    await expect(watch.run("queue", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(watch.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(lines).toEqual([]);
  });
});
