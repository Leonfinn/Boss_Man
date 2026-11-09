// BOS-993: "Checks at once" in Settings sizes the runner's slots and memory; .env values are only upper bounds.
import { describe, expect, it } from "vitest";
import { containerSpec, planChecks, type LauncherConfig } from "../src/spec.js";

const GIB = 1024 ** 3;
const base: LauncherConfig = { dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * GIB, pidsLimit: 4096 };

describe("planChecks", () => {
  it("keeps the .env values until the server has sent the setting", () => {
    expect(planChecks({ ...base, checkSlots: 2, memoryBytes: 8 * GIB })).toEqual({ requested: null, slots: 2, memoryBytes: 8 * GIB, reason: null });
  });
  it("follows the setting with no .env lines: 1 GB plus 3 GB a slot", () => {
    expect(planChecks({ ...base, requestedSlots: 1 })).toMatchObject({ slots: 1, memoryBytes: 4 * GIB, reason: null });
    expect(planChecks({ ...base, requestedSlots: 3 })).toMatchObject({ slots: 3, memoryBytes: 10 * GIB, reason: null });
  });
  it("says when the host's .env caps the slots", () => {
    const p = planChecks({ ...base, requestedSlots: 3, envSlotsCap: 1 });
    expect(p.slots).toBe(1);
    expect(p.reason).toMatch(/\.env caps it at 1/);
  });
  it("says when the host's .env caps the memory", () => {
    const p = planChecks({ ...base, requestedSlots: 3, envMemoryCap: 7 * GIB });
    expect(p).toMatchObject({ slots: 2, memoryBytes: 7 * GIB });
    expect(p.reason).toMatch(/BOSSMAN_RUNNER_MEMORY/);
  });
  it("limits the slots to what the host's memory fits", () => {
    const p = planChecks({ ...base, requestedSlots: 4, hostMemoryBytes: 12 * GIB });
    expect(p.slots).toBe(3); // 12 GB - 2 GB kept for the server = 10 GB = 1 + 3 x 3
    expect(p.memoryBytes).toBe(10 * GIB);
    expect(p.reason).toMatch(/Not enough free memory for 4/);
  });
  it("never goes below one slot, even on a small host", () => {
    expect(planChecks({ ...base, requestedSlots: 2, hostMemoryBytes: 4 * GIB })).toMatchObject({ slots: 1, memoryBytes: 4 * GIB });
  });
  it("puts the plan into the runner's container", () => {
    const spec = containerSpec({ ...base, requestedSlots: 3 }, "app-co");
    expect(spec.Env).toContain("BOSSMAN_CHECK_SLOTS=3");
    expect(spec.HostConfig).toMatchObject({ Memory: 10 * GIB, MemorySwap: 10 * GIB });
  });
});
