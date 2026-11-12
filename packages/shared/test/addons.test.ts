import { describe, expect, it } from "vitest";
import { AddonReport, RUNNER_ADDONS, addonById, missingAddons } from "../src/addons.js";

// Runner add-ons (docs/12): the catalogue a skill can require, and the rule that decides what a
// run is missing. The runner-side checks and the Dockerfile pin live in apps/runner/test.

describe("missingAddons", () => {
  it("gives nothing for no requirements, null or empty", () => {
    expect(missingAddons(null, null)).toEqual([]);
    expect(missingAddons(undefined, undefined)).toEqual([]);
    expect(missingAddons([], [{ id: "agent-browser", version: "0.39.0", ok: false }])).toEqual([]);
  });

  it("treats a runner that reported nothing as missing every requirement", () => {
    expect(missingAddons(["agent-browser", "webkit"], null)).toEqual(["agent-browser", "webkit"]);
    expect(missingAddons(["webkit"], undefined)).toEqual(["webkit"]);
  });

  it("counts an add-on reported not ok as missing", () => {
    const report: AddonReport[] = [{ id: "agent-browser", version: "0.39.0", ok: false }];
    expect(missingAddons(["agent-browser"], report)).toEqual(["agent-browser"]);
  });

  it("ignores a healthy add-on that the skill does not require", () => {
    const report: AddonReport[] = [
      { id: "agent-browser", version: "0.39.0", ok: true },
      { id: "webkit", version: "1.64.1", ok: true },
    ];
    expect(missingAddons(["webkit"], report)).toEqual([]);
    expect(missingAddons([], report)).toEqual([]);
  });

  it("keeps the order the skill lists its requirements in", () => {
    const report: AddonReport[] = [{ id: "webkit", version: "1.64.1", ok: false }];
    expect(missingAddons(["webkit", "agent-browser", "webkit"], report)).toEqual(["webkit", "agent-browser", "webkit"]);
    expect(missingAddons(["webkit", "agent-browser"], report)).toEqual(["webkit", "agent-browser"]);
  });
});

describe("addonById", () => {
  it("finds a known add-on", () => {
    expect(addonById("agent-browser")?.id).toBe("agent-browser");
  });

  it("gives undefined for an unknown id", () => {
    expect(addonById("not-an-addon")).toBeUndefined();
  });
});

describe("RUNNER_ADDONS", () => {
  it("gives every add-on a unique id", () => {
    const ids = RUNNER_ADDONS.map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.trim()).not.toBe("");
  });

  it("pins every add-on to an exact version, digits and dots only", () => {
    for (const addon of RUNNER_ADDONS) {
      expect(addon.version, addon.id).toMatch(/^\d+(\.\d+)*$/);
      expect(addon.version, addon.id).not.toMatch(/[\^~]/);
    }
  });

  it("gives every add-on a non-empty check command", () => {
    for (const addon of RUNNER_ADDONS) {
      expect(addon.check.length, addon.id).toBeGreaterThan(0);
      for (const part of addon.check) expect(part.trim(), addon.id).not.toBe("");
    }
  });

  it("gives every add-on at least one canary command", () => {
    for (const addon of RUNNER_ADDONS) {
      expect(addon.canary.length, addon.id).toBeGreaterThan(0);
      for (const command of addon.canary) {
        expect(command.length, addon.id).toBeGreaterThan(0);
        for (const part of command) expect(part.trim(), addon.id).not.toBe("");
      }
    }
  });
});

describe("AddonReport", () => {
  const report = (id: string) => ({ id, version: "0.39.0", ok: true });

  it("accepts an id of exactly 40 characters", () => {
    expect(AddonReport.safeParse(report("x".repeat(40))).success).toBe(true);
  });

  it("refuses an id over 40 characters", () => {
    expect(AddonReport.safeParse(report("x".repeat(41))).success).toBe(false);
  });
});
