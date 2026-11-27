// BOS-993: "Checks at once" in Settings sizes the runner's slots and memory; .env values are only upper bounds.
// BOS-1498: with the agents number from "Agents at once" it is 2 GB + 1 GB an agent + 3 GB a check. Until that number arrives
// the old base (13 GB plus 3 GB a slot) stands in, so the tests below without requestedAgents still hold.
import { describe, expect, it } from "vitest";
import { containerSpec, planChecks, type LauncherConfig } from "../src/spec.js";

const GIB = 1024 ** 3;
const base: LauncherConfig = { dataRoot: "/mnt/data", network: "boss-man_default", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 4 * GIB, pidsLimit: 4096 };

describe("planChecks from Agents at once (BOS-1498)", () => {
  it("is 2 GB plus 1 GB an agent plus 3 GB a check, and says so with the machine's size", () => {
    // The defaults: 4 in a company + 2 background = 6 agents, 1 check.
    expect(planChecks({ ...base, requestedSlots: 1, requestedAgents: 6, hostMemoryBytes: 32 * GIB })).toEqual({ requested: 1, slots: 1, memoryBytes: 11 * GIB, reason: null, agents: 6, why: "11 GB: 6 agents at once and 1 check, on a 32 GB machine.", ceilingBytes: 30 * GIB });
    expect(planChecks({ ...base, requestedSlots: 2, requestedAgents: 1 })).toMatchObject({ memoryBytes: 9 * GIB, why: "9 GB: 1 agent at once and 2 checks." });
  });
  it("is cut to the machine's memory less 2 GB, and says what it would have needed", () => {
    const p = planChecks({ ...base, requestedSlots: 1, requestedAgents: 6, hostMemoryBytes: 8 * GIB });
    expect(p).toMatchObject({ slots: 1, memoryBytes: 6 * GIB, reason: null });
    expect(p.why).toBe("6 GB: 6 agents at once and 1 check would need 11 GB; this 8 GB machine keeps 2 GB for the server and database.");
    expect(p.ceilingBytes).toBe(6 * GIB); // BOS-2802: the server turns this into "this machine can run 4 agents"
  });
  it("on a small machine the machine's limit wins over the 4 GB floor, and the line says so", () => {
    const p = planChecks({ ...base, requestedSlots: 1, requestedAgents: 2, hostMemoryBytes: 5 * GIB });
    expect(p).toMatchObject({ slots: 1, memoryBytes: 3 * GIB });
    expect(p.why).toBe(
      "3 GB: 2 agents at once and 1 check would need 7 GB; this 5 GB machine keeps 2 GB for the server and database. That is under the 4 GB a runner should have, so expect slow or failed runs: lower Agents at once or use a bigger machine.",
    );
    // A host under 3 GB still gets a usable number, never zero or less.
    expect(planChecks({ ...base, requestedSlots: 1, requestedAgents: 0, hostMemoryBytes: 2 * GIB }).memoryBytes).toBe(GIB);
  });
  it("uses a size the owner set in .env as it is, above or below the formula", () => {
    const low = planChecks({ ...base, requestedSlots: 1, requestedAgents: 6, envMemoryCap: 8 * GIB, hostMemoryBytes: 64 * GIB });
    expect(low.memoryBytes).toBe(8 * GIB);
    expect(low.why).toBe("8 GB: set by BOSSMAN_RUNNER_MEMORY in the host's .env (6 agents at once and 1 check would need 11 GB).");
    // Above the formula and above the machine's limit: still the owner's number.
    expect(planChecks({ ...base, requestedSlots: 1, requestedAgents: 2, envMemoryCap: 20 * GIB, hostMemoryBytes: 16 * GIB }).memoryBytes).toBe(20 * GIB);
    // It also wins over a kept size.
    expect(planChecks({ ...base, requestedSlots: 1, requestedAgents: 6, envMemoryCap: 12 * GIB, kept: { bytes: 16 * GIB, slots: 1, agents: 6 } }).memoryBytes).toBe(12 * GIB);
    // The slots still fit inside it, with the .env named as the reason.
    expect(planChecks({ ...base, requestedSlots: 4, requestedAgents: 2, envMemoryCap: 10 * GIB })).toMatchObject({ slots: 2, reason: "The host's .env caps runner memory at 10 GB (BOSSMAN_RUNNER_MEMORY), which fits 2." });
  });
  it("our own install (16 GB runners today) gets no less after the upgrade, at its settings or higher ones", () => {
    // What the launcher records on the first push when runners exist (launcher.test.ts covers the recording): the runners' 16 GB.
    const kept = { bytes: 16 * GIB, slots: 1, agents: 6 };
    const ours = (slots: number, agents: number) => planChecks({ ...base, requestedSlots: slots, requestedAgents: agents, kept, hostMemoryBytes: 64 * GIB }).memoryBytes;
    const before = planChecks({ ...base, requestedSlots: 1, hostMemoryBytes: 64 * GIB }).memoryBytes; // the old formula
    expect(before).toBe(16 * GIB);
    for (const [s, a] of [[1, 6], [1, 7], [2, 6], [3, 12], [4, 20]] as const) expect(ours(s, a), `${s} checks, ${a} agents`).toBeGreaterThanOrEqual(before);
  });
  it("fits slots around the agents' share, not the old 13 GB", () => {
    // 24 GB host: 22 GB for the runner, 2 + 4 = 6 GB for the agents, so 5 checks fit (6 + 15 = 21).
    const p = planChecks({ ...base, requestedSlots: 8, requestedAgents: 4, hostMemoryBytes: 24 * GIB });
    expect(p).toMatchObject({ slots: 5, memoryBytes: 21 * GIB });
    expect(p.reason).toMatch(/Not enough free memory for 8/);
  });
  it("keeps the memory runners had at the upgrade while neither setting is lower, and only adds when one is raised", () => {
    const kept = { bytes: 16 * GIB, slots: 1, agents: 6 };
    const at = (slots: number, agents: number) => planChecks({ ...base, requestedSlots: slots, requestedAgents: agents, kept, hostMemoryBytes: 64 * GIB });
    expect(at(1, 6)).toMatchObject({ memoryBytes: 16 * GIB, why: "16 GB: kept from before (6 agents at once and 1 check need 11 GB). Lower Agents at once or Checks at once to use the smaller size." });
    expect(at(2, 6).memoryBytes).toBe(16 * GIB);
    expect(at(3, 8).memoryBytes).toBe(19 * GIB); // the formula passes it: 2 + 8 + 9
    expect(at(1, 5).memoryBytes).toBe(10 * GIB); // lowered: the formula
    expect(at(1, 5).why).toBe("10 GB: 5 agents at once and 1 check, on a 64 GB machine.");
  });
  it("uses the old size until the agents number arrives, and says so", () => {
    expect(planChecks({ ...base, requestedSlots: 1, kept: { bytes: 30 * GIB, slots: 1, agents: 1 } })).toMatchObject({ memoryBytes: 16 * GIB, agents: null, why: expect.stringMatching(/^16 GB: the earlier fixed size for 1 check at once .*until Boss Man sends your Agents at once\.$/) });
  });
  it("goes into the runner's container", () => {
    expect(containerSpec({ ...base, requestedSlots: 1, requestedAgents: 2 }, "app-co").HostConfig).toMatchObject({ Memory: 7 * GIB, MemorySwap: 7 * GIB });
  });
});

describe("planChecks", () => {
  it("keeps the .env values until the server has sent the setting", () => {
    expect(planChecks({ ...base, checkSlots: 2, memoryBytes: 8 * GIB })).toEqual({ requested: null, slots: 2, memoryBytes: 8 * GIB, reason: null, agents: null, why: "8 GB: the starting size, until Boss Man sends your settings.", ceilingBytes: null });
    expect(planChecks({ ...base, memoryBytes: 8 * GIB, envMemoryCap: 8 * GIB }).why).toBe("8 GB: set by BOSSMAN_RUNNER_MEMORY in the host's .env.");
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
