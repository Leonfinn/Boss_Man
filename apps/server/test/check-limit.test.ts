// BOS-1152: the runners follow "Checks at once" after a launcher restart, and a lower limit always says why.
import { describe, expect, it } from "vitest";
import { checkLimitReconciler, limitReason } from "../src/services/check-limit.js";
import type { LauncherChecks } from "../src/services/launcher.js";

const GB = 1024 ** 3;
const lc = (o: Partial<LauncherChecks> = {}): LauncherChecks => ({ requested: 3, slots: 3, memoryBytes: 22 * GB, reason: null, runners: [{ slug: "a", slots: 3, memoryBytes: 22 * GB }], ...o });

describe("limitReason", () => {
  it("has no reason when the limit is the setting", () => expect(limitReason(3, lc())).toBeNull());
  it("keeps the launcher's own reason", () => expect(limitReason(3, lc({ slots: 2, reason: "Not enough free memory." }))).toBe("Not enough free memory."));
  it("explains a launcher that was never sent the setting (the 1-at-once case)", () => {
    const r = limitReason(3, lc({ requested: 1, slots: 1, reason: null }));
    expect(r).toMatch(/not been given your setting of 3/);
  });
  it("never leaves a lower limit without a reason, for every combination", () => {
    for (const setting of [1, 2, 3, 8])
      for (const slots of [1, 2, 3, 8])
        for (const requested of [null, 1, setting])
          for (const reason of [null, "because"]) {
            const r = limitReason(setting, lc({ requested, slots, reason }));
            if (slots < setting) expect(r, `${setting}/${slots}/${requested}/${reason}`).toBeTruthy();
            else expect(r).toBeNull();
          }
  });
});

describe("checkLimitReconciler", () => {
  function setup(first: LauncherChecks, afterPush: LauncherChecks, hold = false) {
    let current = first;
    const calls: string[] = [];
    let t = 0;
    const rec = checkLimitReconciler({
      slots: async () => 3,
      launch: { enabled: true, setChecks: async (n) => { calls.push(`set ${n}`); current = afterPush; }, checks: async () => current },
      holdActive: async () => hold,
      startDrain: async () => { calls.push("drain"); },
      now: () => t,
    });
    return { rec, calls, tick: (ms: number) => (t += ms) };
  }

  it("sends the setting again to a launcher that fell back to 1, then drains the runner", async () => {
    const { rec, calls } = setup(lc({ requested: 1, slots: 1, runners: [{ slug: "a", slots: 1, memoryBytes: 16 * GB }] }), lc({ runners: [{ slug: "a", slots: 1, memoryBytes: 16 * GB }] }));
    expect(await rec.step()).toBe("draining");
    expect(calls).toEqual(["set 3", "drain"]);
  });

  it("does nothing when the launcher and runners already follow the setting", async () => {
    const { rec, calls } = setup(lc(), lc());
    expect(await rec.step()).toBe("ok");
    expect(calls).toEqual([]);
  });

  it("does not start a second drain while a hold is on, or inside the cool-down", async () => {
    const off = lc({ runners: [{ slug: "a", slots: 1, memoryBytes: 16 * GB }] });
    const held = setup(off, off, true);
    expect(await held.rec.step()).toBe("waiting");
    expect(held.calls).toEqual([]);
    const s = setup(off, off);
    expect(await s.rec.step()).toBe("draining");
    expect(await s.rec.step()).toBe("waiting");
    s.tick(11 * 60_000);
    expect(await s.rec.step()).toBe("draining");
  });

  it("skips quietly when the launcher is off or too old", async () => {
    const rec = checkLimitReconciler({ slots: async () => 3, launch: { enabled: true, setChecks: async () => {}, checks: async () => null }, holdActive: async () => false, startDrain: async () => {} });
    expect(await rec.step()).toBe("off");
  });
});
