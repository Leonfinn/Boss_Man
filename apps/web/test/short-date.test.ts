import { afterEach, describe, expect, it, vi } from "vitest";
import { dayOf, short } from "../src/short-date";

// dayOf turns a date-only string ("2026-12-01") into the UTC milliseconds of that day's start.
// It reads no clock and no time zone: the same string gives the same number everywhere.

const realTz = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
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

// short is a calendar day as the owner reads it: the day number and the short month, always in UTC,
// with no year and no clock. English gives either "1 Dec" or "Dec 1" (the order the viewer's locale
// uses), so the tests accept both, as the Due-day test does.
const DAY_1_DEC = /^(1 Dec|Dec 1)$/;

describe("short", () => {
  it("gives the day and short month the owner reads", () => {
    expect(short("2026-12-01")).toMatch(DAY_1_DEC);
  });

  it("leaves the year out: the same day in another year reads the same", () => {
    expect(short("2027-12-01")).toBe(short("2026-12-01"));
  });

  it("reads another month and day, and two days differ", () => {
    expect(short("2025-01-15")).toMatch(/^(15 Jan|Jan 15)$/);
    expect(short("2026-12-02")).toMatch(/^(2 Dec|Dec 2)$/);
    expect(short("2026-12-02")).not.toBe(short("2026-12-01"));
  });

  it("pins UTC, so a day-only date never slips to the day before west of UTC", () => {
    const utc = short("2026-12-01");
    for (const tz of ["America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      // Guard: the zone really changed, so a missing time zone in short would show.
      expect(new Date("2026-12-01T12:00:00").getTimezoneOffset() === 0).toBe(false);
      expect(short("2026-12-01")).toBe(utc);
    }
  });

  it("reads no clock: the same date reads the same whatever today is", () => {
    const before = short("2026-12-01");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-06-09T23:30:00Z"));
    expect(short("2026-12-01")).toBe(before);
  });

  it("says Invalid Date for a value that is not a calendar day", () => {
    expect(short("")).toBe("Invalid Date");
    expect(short("not-a-date")).toBe("Invalid Date");
  });
});
