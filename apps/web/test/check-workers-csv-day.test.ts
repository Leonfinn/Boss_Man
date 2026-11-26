import { describe, expect, it } from "vitest";
import { csvDay } from "../src/pages/settings/CheckWorkers";

// BOS-2644: the day in a Check workers CSV file name is the UTC day (CheckWorkers.tsx csvDay).
// Every test passes an instant in; none reads the real clock.
describe("csvDay", () => {
  it("gives the YYYY-MM-DD day of a fixed instant", () => {
    expect(csvDay(new Date("2026-11-23T09:15:42.000Z"))).toBe("2026-11-23");
  });

  it("uses the UTC day just before midnight UTC, not the local one", () => {
    // 23:59:59.999 UTC is still 23 Nov in UTC, even where the local clock has moved on.
    expect(csvDay(new Date("2026-11-23T23:59:59.999Z"))).toBe("2026-11-23");
  });

  it("rolls to the next UTC day at midnight UTC", () => {
    expect(csvDay(new Date("2026-11-24T00:00:00.000Z"))).toBe("2026-11-24");
  });

  it("names the UTC day for an instant written with a local offset", () => {
    // 01:30 on 24 Nov at +05:00 is 20:30 on 23 Nov in UTC.
    expect(csvDay(new Date("2026-11-24T01:30:00+05:00"))).toBe("2026-11-23");
  });
});
