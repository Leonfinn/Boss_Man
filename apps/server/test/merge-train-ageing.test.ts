// BOS-2214: the background-lane ageing rule the merge train and the check queue rank waits by (BOS-1803).
// Pure: it reads no clock, database or network, so nothing needed faking.
import { describe, expect, it } from "vitest";
import { agedTier } from "../src/services/merge-train.js";

// A made-up "background_lane_age_minutes" setting: one hour.
const AGE_MS = 60 * 60_000;

describe("agedTier: a background-lane wait ages into the ordinary tier", () => {
  it("keeps the urgent (0) and ordinary (1) tiers as they are, fresh or old", () => {
    expect(agedTier(0, 0, AGE_MS)).toBe(0);
    expect(agedTier(0, AGE_MS * 10, AGE_MS)).toBe(0);
    expect(agedTier(1, 0, AGE_MS)).toBe(1);
    expect(agedTier(1, AGE_MS * 10, AGE_MS)).toBe(1);
  });

  it("keeps a fresh background item (tier 2) waiting in the background lane", () => {
    expect(agedTier(2, 0, AGE_MS)).toBe(2);
    expect(agedTier(2, 1, AGE_MS)).toBe(2);
  });

  it("ages a background item to ordinary just under the age, at it, and over it", () => {
    expect(agedTier(2, AGE_MS - 1, AGE_MS)).toBe(2); // just under the boundary
    expect(agedTier(2, AGE_MS, AGE_MS)).toBe(1); // at it
    expect(agedTier(2, AGE_MS + 1, AGE_MS)).toBe(1); // over it
  });

  it("never ages anything when the setting is off (zero or negative)", () => {
    expect(agedTier(2, AGE_MS * 10, 0)).toBe(2);
    expect(agedTier(2, AGE_MS * 10, -1)).toBe(2);
  });
});
