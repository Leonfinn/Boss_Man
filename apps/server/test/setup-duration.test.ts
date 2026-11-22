// BOS-2231: the setup wizard's "First ticket merged: …, <duration> after setup started" line (R56).
import { describe, expect, it } from "vitest";
import { formatSetupDuration } from "../src/services/setup.js";

describe("formatSetupDuration", () => {
  it("words an ordinary setup in hours and minutes", () => {
    expect(formatSetupDuration(160)).toBe("2 h 40 min");
    expect(formatSetupDuration(35)).toBe("35 min");
    expect(formatSetupDuration(180)).toBe("3 h");
    expect(formatSetupDuration(3120)).toBe("2 d 4 h");
  });

  it("rounds to the nearest minute and never goes below zero", () => {
    // The first merge is measured from the owner account's creation, which can land a moment after it.
    expect(formatSetupDuration(-5)).toBe("0 min");
    expect(formatSetupDuration(-0.4)).toBe("0 min");
    expect(formatSetupDuration(0.4)).toBe("0 min");
    expect(formatSetupDuration(1.5)).toBe("2 min");
    expect(formatSetupDuration(59.6)).toBe("1 h");
  });

  it("changes unit at each boundary and leaves out an empty smaller unit", () => {
    expect(formatSetupDuration(59)).toBe("59 min");
    expect(formatSetupDuration(60)).toBe("1 h");
    expect(formatSetupDuration(61)).toBe("1 h 1 min");
    expect(formatSetupDuration(1439)).toBe("23 h 59 min");
    expect(formatSetupDuration(1440)).toBe("1 d");
    expect(formatSetupDuration(1500)).toBe("1 d 1 h");
    expect(formatSetupDuration(2880)).toBe("2 d");
  });
});
