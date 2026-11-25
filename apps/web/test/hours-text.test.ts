// @vitest-environment jsdom
// BOS-2364: the Agents page's working-hours line ("Mon, Tue, 09:00 to 17:00 (Europe/London)").
import { describe, expect, it } from "vitest";
import { hoursText } from "../src/pages/Agents";

describe("hoursText", () => {
  it("lists the days, then the start and end times with the time zone", () => {
    expect(hoursText({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: "Europe/London" })).toBe(
      "Mon, Tue, Wed, Thu, Fri, 09:00 to 17:00 (Europe/London)",
    );
  });

  it("one day is just that day", () => {
    expect(hoursText({ days: [0], start: "08:30", end: "12:00", timeZone: "UTC" })).toBe("Sun, 08:30 to 12:00 (UTC)");
    expect(hoursText({ days: [6], start: "10:00", end: "18:00", timeZone: "America/New_York" })).toBe("Sat, 10:00 to 18:00 (America/New_York)");
  });

  it("keeps the days in the order it is given, not Sunday-first", () => {
    expect(hoursText({ days: [5, 1, 3], start: "09:00", end: "17:00", timeZone: "UTC" })).toBe("Fri, Mon, Wed, 09:00 to 17:00 (UTC)");
  });
});
