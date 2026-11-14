// BOS-1348: the retro's number words: minutes, hours, days, n/a and dollars.
import { describe, expect, it } from "vitest";
import { hrs, usd } from "../src/services/retro.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("hrs", () => {
  it("says n/a for a missing value", () => {
    expect(hrs(null)).toBe("n/a");
  });

  it("writes zero as 0 min", () => {
    expect(hrs(0)).toBe("0 min");
  });

  it("rounds 89 seconds to 1 min", () => {
    expect(hrs(89_000)).toBe("1 min");
  });

  it("keeps 59 minutes in minutes", () => {
    expect(hrs(59 * MIN)).toBe("59 min");
  });

  it("switches to hours at exactly 1 hour", () => {
    expect(hrs(HOUR)).toBe("1.0 h");
  });

  it("writes 47.9 hours in hours", () => {
    expect(hrs(47.9 * HOUR)).toBe("47.9 h");
  });

  it("switches to days at exactly 48 hours", () => {
    expect(hrs(48 * HOUR)).toBe("2.0 days");
  });

  it("writes 10 days in days", () => {
    expect(hrs(10 * DAY)).toBe("10.0 days");
  });
});

describe("usd", () => {
  it("says n/a for a missing value", () => {
    expect(usd(null)).toBe("n/a");
  });

  it("writes zero as $0.00", () => {
    expect(usd(0)).toBe("$0.00");
  });

  it("writes 1_250_000 micros as $1.25", () => {
    expect(usd(1_250_000)).toBe("$1.25");
  });

  it("rounds 4_999 micros down to $0.00", () => {
    expect(usd(4_999)).toBe("$0.00");
  });

  it("rounds 5_000 micros up to $0.01", () => {
    expect(usd(5_000)).toBe("$0.01");
  });
});
