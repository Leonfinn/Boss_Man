// BOS-993: "Checks at once" in Settings sizes the runner's slots and memory; .env values are only upper bounds.
// A runner carries every agent the company runs, so its memory starts at 13 GB (16 GB with one slot, as live) and grows 3 GB a slot.
import { describe, expect, it } from "vitest";
import { containerSpec, planChecks, type LauncherConfig } from "../src/spec.js";

const GIB = 1024 ** 3;
const base: LauncherConfig = { dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * GIB, pidsLimit: 4096 };

describe("planChecks", () => {
  it("keeps the .env values until the server has sent the setting", () => {
    expect(planChecks({ ...base, checkSlots: 2, memoryBytes: 8 * GIB })).toEqual({ requested: null, slots: 2, memoryBytes: 8 * GIB, reason: null });
  });
  it("follows the setting with no .env lines: 13 GB plus 3 GB a slot, so one slot is today's 16 GB", () => {
    expect(planChecks({ ...base, requestedSlots: 1 })).toMatchObject({ slots: 1, memoryBytes: 16 * GIB, reason: null });
    expect(planChecks({ ...base, requestedSlots: 2 })).toMatchObject({ slots: 2, memoryBytes: 19 * GIB, reason: null });
    expect(planChecks({ ...base, requestedSlots: 3 })).toMatchObject({ slots: 3, memoryBytes: 22 * GIB, reason: null });
  });
  it("two checks on a large host never get less than the agents' 16 GB", () => {
    const p = planChecks({ ...base, requestedSlots: 2, hostMemoryBytes: 64 * GIB });
    expect(p.slots).toBe(2);
    expect(p.memoryBytes).toBeGreaterThanOrEqual(16 * GIB);
  });
  it("says when the host's .env caps the slots", () => {
    const p = planChecks({ ...base, requestedSlots: 3, envSlotsCap: 1 });
    expect(p.slots).toBe(1);
    expect(p.reason).toMatch(/\.env caps it at 1/);
  });
  it("says when the host's .env caps the memory (an old 16g line allows one slot)", () => {
    const p = planChecks({ ...base, requestedSlots: 3, envMemoryCap: 16 * GIB });
    expect(p).toMatchObject({ slots: 1, memoryBytes: 16 * GIB });
    expect(p.reason).toMatch(/BOSSMAN_RUNNER_MEMORY/);
  });
  it("limits the slots to what the host's memory fits", () => {
    const p = planChecks({ ...base, requestedSlots: 4, hostMemoryBytes: 24 * GIB });
    expect(p.slots).toBe(3); // 24 GB - 2 GB kept for the server = 22 GB = 13 + 3 x 3
    expect(p.memoryBytes).toBe(22 * GIB);
    expect(p.reason).toMatch(/Not enough free memory for 4/);
  });
  it("never goes below one slot, and gives a small host what it has", () => {
    expect(planChecks({ ...base, requestedSlots: 2, hostMemoryBytes: 8 * GIB })).toMatchObject({ slots: 1, memoryBytes: 6 * GIB });
    expect(planChecks({ ...base, requestedSlots: 2, hostMemoryBytes: 4 * GIB })).toMatchObject({ slots: 1, memoryBytes: 4 * GIB });
  });
  it("puts the plan into the runner's container", () => {
    const spec = containerSpec({ ...base, requestedSlots: 3 }, "app-co");
    expect(spec.Env).toContain("BOSSMAN_CHECK_SLOTS=3");
    expect(spec.HostConfig).toMatchObject({ Memory: 22 * GIB, MemorySwap: 22 * GIB });
  });
});
