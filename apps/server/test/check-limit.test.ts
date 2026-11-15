// BOS-1152: the runners follow "Checks at once" after a launcher restart, and a lower limit always says why.
import { describe, expect, it } from "vitest";
import { agentsAtOnce, checkLimitReconciler, limitReason, memoryLine } from "../src/services/check-limit.js";
import type { LauncherChecks } from "../src/services/launcher.js";

const GB = 1024 ** 3;
const lc = (o: Partial<LauncherChecks> = {}): LauncherChecks => ({ requested: 3, slots: 3, memoryBytes: 22 * GB, reason: null, runners: [{ slug: "a", slots: 3, memoryBytes: 22 * GB }], ...o });

describe("BOS-1498: agentsAtOnce and memoryLine", () => {
  it("counts the company limit (never above the all-companies one) plus the background slots", () => {
    expect(agentsAtOnce({ instance: 8, company: 4, background: 2 })).toBe(6);
    expect(agentsAtOnce({ instance: 2, company: 2, background: 0 })).toBe(2);
    expect(agentsAtOnce({ instance: 3, company: 5, background: 1 })).toBe(4);
  });
  it("shows the launcher's line, saying first when the runner still has another size", () => {
    const why = "11 GB: 6 agents at once and 1 check, on a 16 GB machine.";
    expect(memoryLine(null)).toBeNull();
    expect(memoryLine(lc())).toBeNull(); // an older launcher gives no line
    expect(memoryLine(lc({ memoryBytes: 11 * GB, why, runners: [{ slug: "a", slots: 1, memoryBytes: 11 * GB }] }))).toBe(why);
    const two = lc({ memoryBytes: 11 * GB, why, runners: [{ slug: "a", slots: 1, memoryBytes: 11 * GB }, { slug: "b", slots: 1, memoryBytes: 16 * GB }] });
    expect(memoryLine(two, "a")).toBe(why);
    expect(memoryLine(two, "b")).toBe(`Has 16 GB now; from its next restart, ${why}`);
    expect(memoryLine(two)).toBe(`Has 16 GB now; from its next restart, ${why}`);
    expect(memoryLine(two, "new-co")).toBe(why); // no runner yet: what it will be given
  });
});

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

  it("BOS-1498: pushes when Agents at once changed, and not again and again to a launcher too old to take it", async () => {
    const calls: string[] = [];
    let current = lc({ agents: 6 });
    const rec = checkLimitReconciler({
      slots: async () => 3,
      agents: async () => 4,
      launch: { enabled: true, setChecks: async (n, a) => { calls.push(`set ${n} ${a}`); current = lc({ agents: a }); }, checks: async () => current },
      holdActive: async () => false,
      startDrain: async () => { calls.push("drain"); },
    });
    expect(await rec.step()).toBe("pushed");
    expect(calls).toEqual(["set 3 4"]);
    // An older launcher reports no agents: only the slots are compared.
    const old: string[] = [];
    const recOld = checkLimitReconciler({ slots: async () => 3, agents: async () => 4, launch: { enabled: true, setChecks: async (n, a) => void old.push(`set ${n} ${a}`), checks: async () => lc() }, holdActive: async () => false, startDrain: async () => {} });
    expect(await recOld.step()).toBe("ok");
    expect(old).toEqual([]);
  });

  it("skips quietly when the launcher is off or too old", async () => {
    const rec = checkLimitReconciler({ slots: async () => 3, launch: { enabled: true, setChecks: async () => {}, checks: async () => null }, holdActive: async () => false, startDrain: async () => {} });
    expect(await rec.step()).toBe("off");
  });
});

describe("CHECK_MEMORY_CEILING_BYTES (BOS-1165)", () => {
  it("matches the default ceiling check-all.sh applies, so the panel shows the figure that is enforced", async () => {
    const { readFileSync } = await import("node:fs");
    const { CHECK_MEMORY_CEILING_BYTES } = await import("../src/services/check-limit.js");
    const script = readFileSync(new URL("../../../scripts/check-all.sh", import.meta.url), "utf8");
    const m = /BOSSMAN_CHECK_MEMORY_MB:-(\d+)/.exec(script);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * 1024 ** 2).toBe(CHECK_MEMORY_CEILING_BYTES);
  });
});
