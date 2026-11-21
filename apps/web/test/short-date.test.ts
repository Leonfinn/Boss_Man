import { afterEach, describe, expect, it } from "vitest";
import { dayOf } from "../src/short-date";

// dayOf turns a date-only string ("2026-12-01") into the UTC milliseconds of that day's start.
// It reads no clock and no time zone: the same string gives the same number everywhere.

const realTz = process.env.TZ;
afterEach(() => {
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

describe("dayOf", () => {
  it("gives midnight UTC at the start of a month", () => {
    expect(dayOf("2026-12-01")).toBe(Date.UTC(2026, 11, 1));
  });

  it("gives midnight UTC at the end of a month and across a year boundary", () => {
    expect(dayOf("2026-12-31")).toBe(Date.UTC(2026, 11, 31));
    expect(dayOf("2027-01-01")).toBe(Date.UTC(2027, 0, 1));
    expect(dayOf("2027-01-01") - dayOf("2026-12-31")).toBe(86_400_000);
  });

  it("handles a leap day and the day after a non-leap February", () => {
    expect(dayOf("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
    expect(dayOf("2027-03-01") - dayOf("2027-02-28")).toBe(86_400_000);
  });

  it("does not depend on the viewer's time zone", () => {
    const utc = dayOf("2026-12-01");
    for (const tz of ["America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      // Guard: the zone really changed, so the test would catch a local-time parse.
      expect(new Date("2026-12-01T12:00:00").getTimezoneOffset() === 0).toBe(false);
      expect(dayOf("2026-12-01")).toBe(utc);
    }
  });
});
