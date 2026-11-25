// The fence default's pure rules (BOS-2461): what Settings shows for each safety feature, whether a
// company's agent work waits for the fence, and the key the guard card is raised with. No database.
import { describe, expect, it } from "vitest";
import type { SandboxReport } from "@boss-man/shared";
import { FENCE_HELD, featureStates, fenceHold, guardUnavailableKey, type HoldCompany } from "../src/services/fence-default.js";

const PLATFORM = { kernel: "6.1.0-test", dockerVersion: "27.0.1", osType: "linux" };
const FINGERPRINT = "6.1.0-test|docker 27.0.1|linux";
const NOW = new Date("2026-11-25T10:00:00Z");

type ReportOptions = { level?: SandboxReport["level"]; guard?: "on" | "absent" | null; platform?: typeof PLATFORM | null };
const report = (o: ReportOptions = {}): SandboxReport => ({
  landlockAbi: 6,
  errno: null,
  level: o.level ?? "full",
  missing: [],
  userns: false,
  probe: true,
  ...(o.guard === null ? {} : { guard: { state: o.guard ?? "on", reason: o.guard === "absent" ? "connected to the gateway" : "refused at once", errno: null, ms: 3 } }),
  ...(o.platform === null ? {} : { platform: o.platform ?? PLATFORM }),
});

/** A company with every safety feature at its default: Watch, nothing chosen, no platform pin. */
const company = (o: Partial<HoldCompany> = {}): HoldCompany => ({
  fenceMode: "watch",
  fenceModeChosenAt: null,
  fenceOffFingerprint: null,
  guardOffChosenAt: null,
  guardOffFingerprint: null,
  ...o,
});

describe("featureStates (what Settings shows)", () => {
  it("a Watch company on a runner that can fence, with the guard on, is all proven", () => {
    expect(featureStates(company(), report())).toEqual({
      fingerprint: FINGERPRINT,
      fence: { proven: true, runWithout: false },
      guard: { proven: true, runWithout: false, reason: "refused at once" },
    });
    expect(featureStates(company(), report({ level: "partial" })).fence).toEqual({ proven: true, runWithout: false });
  });

  it("a fence that can't work is not proven, and nobody chose to run without it", () => {
    expect(featureStates(company(), report({ level: "unavailable" }))).toMatchObject({
      fence: { proven: false, runWithout: false },
    });
    // An Off nobody chose is not a choice, so it is still not "run without".
    expect(featureStates(company({ fenceMode: "off" }), report({ level: "unavailable" }))).toMatchObject({
      fence: { proven: false, runWithout: false },
    });
  });

  it("an Off chosen in Settings covers every platform, because it carries no fingerprint", () => {
    const chosen = company({ fenceMode: "off", fenceModeChosenAt: NOW });
    expect(featureStates(chosen, report({ level: "unavailable" })).fence).toEqual({ proven: false, runWithout: true });
    expect(featureStates(chosen, report({ level: "unavailable", platform: { ...PLATFORM, kernel: "6.8.0-new" } })).fence).toEqual({ proven: false, runWithout: true });
  });

  it("an Off chosen on one platform is kept for that platform only", () => {
    const chosen = company({ fenceMode: "off", fenceModeChosenAt: NOW, fenceOffFingerprint: FINGERPRINT });
    expect(featureStates(chosen, report({ level: "unavailable" })).fence).toEqual({ proven: false, runWithout: true });
    expect(featureStates(chosen, report({ level: "unavailable", platform: { ...PLATFORM, kernel: "6.8.0-new" } })).fence).toEqual({ proven: false, runWithout: false });
    // A runner that hasn't reported a platform can't match the pin.
    expect(featureStates(chosen, report({ level: "unavailable", platform: null })).fence).toEqual({ proven: false, runWithout: false });
  });

  it("the guard shows its own reason and is not proven when it is absent", () => {
    expect(featureStates(company(), report({ guard: "absent" }))).toMatchObject({
      guard: { proven: false, runWithout: false, reason: "connected to the gateway" },
    });
  });

  it("running without the guard is the owner's choice, kept on this platform only", () => {
    const chosen = company({ guardOffChosenAt: NOW, guardOffFingerprint: FINGERPRINT });
    expect(featureStates(chosen, report({ guard: "absent" })).guard).toMatchObject({ proven: false, runWithout: true });
    expect(featureStates(chosen, report({ guard: "absent", platform: { ...PLATFORM, osType: "windows" } })).guard).toMatchObject({ proven: false, runWithout: false });
    // A proven guard never counts as "running without" it, even when the owner once chose so.
    expect(featureStates(chosen, report({ guard: "on" })).guard).toMatchObject({ proven: true, runWithout: false });
  });

  it("a runner that has reported nothing proves nothing, and has no fingerprint or guard reason", () => {
    expect(featureStates(company(), null)).toEqual({
      fingerprint: null,
      fence: { proven: false, runWithout: false },
      guard: { proven: false, runWithout: false, reason: null },
    });
  });
});

describe("fenceHold (whether agent work waits for the fence)", () => {
  it("holds when the runner says it can't fence and the owner didn't choose Off", () => {
    expect(fenceHold(company(), "unavailable")).toBe(FENCE_HELD);
    // Choosing Watch is not a way around it: only Off is.
    expect(fenceHold(company({ fenceModeChosenAt: NOW }), "unavailable", FINGERPRINT)).toBe(FENCE_HELD);
  });

  it("doesn't hold a runner that can fence, or one that hasn't reported its level", () => {
    expect(fenceHold(company(), "full")).toBeNull();
    expect(fenceHold(company(), "partial")).toBeNull();
    expect(fenceHold(company(), undefined)).toBeNull();
    expect(fenceHold(company(), null)).toBeNull();
  });

  it("an Off nobody chose doesn't count, so work is held", () => {
    expect(fenceHold(company({ fenceMode: "off" }), "unavailable")).toBe(FENCE_HELD);
  });

  it("an Off chosen in Settings lets the work run on any platform", () => {
    const chosen = company({ fenceMode: "off", fenceModeChosenAt: NOW });
    expect(fenceHold(chosen, "unavailable")).toBeNull();
    expect(fenceHold(chosen, "unavailable", "anything|docker 1|linux")).toBeNull();
  });

  it("an Off pinned to a platform lets the work run only on that platform", () => {
    const chosen = company({ fenceMode: "off", fenceModeChosenAt: NOW, fenceOffFingerprint: FINGERPRINT });
    expect(fenceHold(chosen, "unavailable", FINGERPRINT)).toBeNull();
    expect(fenceHold(chosen, "unavailable", "6.8.0-new|docker 27.0.1|linux")).toBe(FENCE_HELD);
    // A runner that reported no platform can't match the pin.
    expect(fenceHold(chosen, "unavailable", null)).toBe(FENCE_HELD);
  });
});

describe("guardUnavailableKey", () => {
  it("names the guard episode by company, so two companies never share a card", () => {
    expect(guardUnavailableKey("company-a")).toBe("guard-unavailable:company-a");
    expect(guardUnavailableKey("company-b")).toBe("guard-unavailable:company-b");
    expect(guardUnavailableKey("company-a")).not.toBe(guardUnavailableKey("company-b"));
  });

  it("is the same every time for one company", () => {
    expect(guardUnavailableKey("company-a")).toBe(guardUnavailableKey("company-a"));
  });
});
