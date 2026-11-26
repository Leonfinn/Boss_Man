import { describe, expect, it } from "vitest";
import { DeviceReport, isRenderableProfile, OwnerPreferences, OwnerPreferencesPatch, tallestReading, type DeviceMeasures } from "../src/devices.js";

// Device profiles (BOS-641): the shape a browser reports, and the two rules a layout test reads.

const reading = (over: Partial<DeviceMeasures> = {}): DeviceMeasures => ({
  width: 840,
  height: 900,
  pixelRatio: 2.6,
  coarsePointer: true,
  displayMode: "standalone",
  units: { vh: 900, dvh: 900, svh: 900, lvh: 900, visual: 900 },
  afterScroll: false,
  ...over,
});

describe("DeviceReport", () => {
  it("accepts a measured profile and rejects one with no readings or an unknown unit", () => {
    expect(DeviceReport.safeParse({ label: "Brave · 840px · touch", browser: "Brave", fingerprint: "f1", readings: [reading()] }).success).toBe(true);
    expect(DeviceReport.safeParse({ label: "x", browser: "Brave", fingerprint: "f1", readings: [] }).success).toBe(false);
    expect(DeviceReport.safeParse({ label: "x", browser: "Brave", fingerprint: "f1", readings: [{ ...reading(), units: { vh: -1, dvh: 1, svh: 1, lvh: 1, visual: 1 } }] }).success).toBe(false);
  });
});

describe("tallestReading", () => {
  it("picks the reading with the greatest height (the toolbar-hidden one on a phone)", () => {
    const p = { readings: [reading({ height: 800, afterScroll: false }), reading({ height: 900, afterScroll: true })] };
    expect(tallestReading(p).height).toBe(900);
  });
});

describe("isRenderableProfile", () => {
  it("is true when a reading was taken after a scroll, so the toolbar gap is measured, not guessed", () => {
    expect(isRenderableProfile({ readings: [reading({ height: 800 }), reading({ height: 900, afterScroll: true })] })).toBe(true);
  });

  it("is true for a flat profile where vh equals dvh (a desktop, or a standalone app with no toolbar)", () => {
    expect(isRenderableProfile({ readings: [reading()] })).toBe(true);
  });

  it("is false when no reading was after a scroll and the units disagree (a half report to trust nothing from)", () => {
    expect(isRenderableProfile({ readings: [reading({ units: { vh: 900, dvh: 800, svh: 800, lvh: 900, visual: 800 } })] })).toBe(false);
  });
});

describe("OwnerPreferences (BOS-2689, shared with BOS-2669)", () => {
  it("reads an empty answer as every default: single-letter keys on, no pinned pages", () => {
    expect(OwnerPreferences.parse({})).toEqual({ singleLetterKeys: true, pinnedPages: [] });
  });

  it("a change names only what it changes, so a pin save doesn't turn the keys back on and vice versa", () => {
    expect(OwnerPreferencesPatch.parse({ pinnedPages: ["updates"] })).toEqual({ pinnedPages: ["updates"] });
    expect(OwnerPreferencesPatch.parse({ singleLetterKeys: false })).toEqual({ singleLetterKeys: false });
  });

  it("refuses more than six pinned pages, and a key switch that isn't a yes or no", () => {
    expect(OwnerPreferencesPatch.safeParse({ pinnedPages: ["a", "b", "c", "d", "e", "f", "g"] }).success).toBe(false);
    expect(OwnerPreferencesPatch.safeParse({ singleLetterKeys: "off" }).success).toBe(false);
  });
});
