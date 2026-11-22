import { describe, expect, it } from "vitest";
import { CheckJobs } from "../src/check-jobs.js";
import { DEFAULT_DISK_LEVELS, DiskGuard, classify, holdReason, levelsFromEnv } from "../src/disk-guard.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("disk levels", () => {
  it("warns under 10% or 5 GB, whichever is larger, and holds under 1 GB", () => {
    const L = DEFAULT_DISK_LEVELS;
    expect(classify({ freeBytes: 60 * GB, totalBytes: 500 * GB }, L)).toBe("ok");
    expect(classify({ freeBytes: 49 * GB, totalBytes: 500 * GB }, L)).toBe("low"); // under 10%
    expect(classify({ freeBytes: 4 * GB, totalBytes: 20 * GB }, L)).toBe("low"); // under 5 GB, though 20%
    expect(classify({ freeBytes: 1.5 * GB, totalBytes: 20 * GB }, L)).toBe("low");
    expect(classify({ freeBytes: 900 * MB, totalBytes: 500 * GB }, L)).toBe("full");
  });
  it("reads the levels from env, ignoring junk, and 0 turns the hold off", () => {
    expect(levelsFromEnv({})).toEqual(DEFAULT_DISK_LEVELS);
    expect(levelsFromEnv({ BOSSMAN_DISK_WARN_PERCENT: "20", BOSSMAN_DISK_WARN_GB: "8", BOSSMAN_DISK_FLOOR_MB: "512" })).toEqual({ warnPercent: 0.2, warnBytes: 8 * GB, floorBytes: 512 * MB });
    expect(levelsFromEnv({ BOSSMAN_DISK_WARN_PERCENT: "lots", BOSSMAN_DISK_WARN_GB: "-1", BOSSMAN_DISK_FLOOR_MB: "" })).toEqual(DEFAULT_DISK_LEVELS);
    const off = levelsFromEnv({ BOSSMAN_DISK_FLOOR_MB: "0" });
    expect(classify({ freeBytes: 1, totalBytes: 500 * GB }, off)).toBe("low");
  });
});

describe("DiskGuard", () => {
  const guardWith = (free: { v: number }) => new DiskGuard("/x", DEFAULT_DISK_LEVELS, () => ({ freeBytes: free.v, totalBytes: 100 * GB }));

  it("gives the plain reason below the floor and nothing above", () => {
    const free = { v: 500 * MB };
    const g = guardWith(free);
    expect(g.hold()).toBe(holdReason(500 * MB));
    expect(g.hold()).toContain("Runner disk almost full: 500 MB free; free space and it restarts on its own");
    free.v = 3 * GB;
    expect(g.hold()).toBeNull();
  });

  it("a failed reading never holds work", () => {
    const g = new DiskGuard("/x", DEFAULT_DISK_LEVELS, () => {
      throw new Error("EIO");
    });
    expect(g.hold()).toBeNull();
  });

  it("waits while full and goes on its own once space is back; says why once per interval", async () => {
    const free = { v: 100 * MB };
    const g = guardWith(free);
    const reasons: string[] = [];
    const waiting = g.waitForRoom({ onHold: (r) => reasons.push(r), pollMs: 5 });
    await new Promise((r) => setTimeout(r, 40)); // test-lines-ok: lets a few polls pass; the assertion is on the result
    free.v = 5 * GB;
    expect(await waiting).toBe(true);
    expect(reasons).toHaveLength(1);
  });

  it("stops waiting when cancelled", async () => {
    const g = guardWith({ v: 100 * MB });
    expect(await g.waitForRoom({ onHold: () => {}, pollMs: 5, cancelled: () => true })).toBe(false);
  });
});

describe("a check job on a full disk", () => {
  it("is held with the reason as its progress, then runs when space returns, and is not started while held", async () => {
    const free = { v: 100 * MB };
    const guard = new DiskGuard("/x", DEFAULT_DISK_LEVELS, () => ({ freeBytes: free.v, totalBytes: 100 * GB }), 10);
    const sent: Array<{ type: string; tail?: string }> = [];
    let started = 0;
    const ws = {
      runCommitCheck: async () => {
        started++;
        return { output: "ok", exitCode: 0, timedOut: false };
      },
    };
    const jobs = new CheckJobs(ws as never, (m) => sent.push(m as never), () => {}, undefined, guard);
    jobs.run({ jobId: "j1", projectId: "p", commit: "c", command: "true" });
    // Held at once: progress carries the reason and nothing started; the job still counts as running.
    expect(started).toBe(0);
    expect(jobs.running()).toEqual(["j1"]);
    expect(sent[0]).toMatchObject({ type: "check.progress", tail: expect.stringContaining("Runner disk almost full: 100 MB free") });
    free.v = 5 * GB;
    const deadline = Date.now() + 20_000;
    while (!sent.some((m) => m.type === "check.done") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1);
  }, 30_000);
});
