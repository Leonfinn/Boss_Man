import { describe, expect, it } from "vitest";
import { recordedAgo, screenChanged } from "../src/devices-match";

describe("recordedAgo", () => {
  const now = new Date(2026, 10, 24, 9, 0, 0);
  it("says today, yesterday and N days ago", () => {
    expect(recordedAgo(new Date(2026, 10, 24, 1, 0).toISOString(), now)).toBe("Recorded today");
    expect(recordedAgo(new Date(2026, 10, 23, 23, 0).toISOString(), now)).toBe("Recorded yesterday");
    expect(recordedAgo(new Date(2026, 10, 17, 12, 0).toISOString(), now)).toBe("Recorded 7 days ago");
  });
  it("is empty for a bad date", () => {
    expect(recordedAgo("nope", now)).toBe("");
  });
});

describe("screenChanged", () => {
  const stored = { width: 800, height: 1000, pixelRatio: 2 };
  it("ignores a small height change", () => {
    expect(screenChanged({ ...stored, height: 920 }, stored)).toBe(false);
  });
  it("flags width, ratio or a big height change", () => {
    expect(screenChanged({ ...stored, width: 801 }, stored)).toBe(true);
    expect(screenChanged({ ...stored, pixelRatio: 3 }, stored)).toBe(true);
    expect(screenChanged({ ...stored, height: 880 }, stored)).toBe(true);
  });
});
