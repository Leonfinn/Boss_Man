import { describe, expect, it } from "vitest";
import { minutesOf, quietHoursEnd } from "../src/notify.js";

describe("minutesOf", () => {
  it("reads a HH:MM time as minutes since midnight", () => {
    expect(minutesOf("00:00")).toBe(0);
    expect(minutesOf("23:59")).toBe(1439);
    expect(minutesOf("07:30")).toBe(450);
  });

  it("gives null for anything that isn't a HH:MM time", () => {
    expect(minutesOf("24:00")).toBeNull();
    expect(minutesOf("7:30")).toBeNull();
    expect(minutesOf("12:60")).toBeNull();
    expect(minutesOf("")).toBeNull();
    expect(minutesOf("noon")).toBeNull();
  });
});

describe("quietHoursEnd (R86)", () => {
  const overnight = { start: "22:00", end: "07:00", timeZone: "Europe/London" };
  const daytime = { start: "13:00", end: "15:00", timeZone: "Europe/London" };

  it("gives null with no quiet hours", () => {
    expect(quietHoursEnd(new Date("2026-10-16T12:00:00Z"), null)).toBeNull();
    expect(quietHoursEnd(new Date("2026-10-16T12:00:00Z"), undefined)).toBeNull();
  });

  it("gives null outside the quiet hours", () => {
    // 16 Oct 2026 is BST (UTC+1): 19:00 UTC is 20:00 in London, before 22:00.
    expect(quietHoursEnd(new Date("2026-10-16T19:00:00Z"), overnight)).toBeNull();
    // 11:00 UTC is 12:00 in London, before the daytime window at 13:00.
    expect(quietHoursEnd(new Date("2026-10-16T11:00:00Z"), daytime)).toBeNull();
    // 15:00 is the end, not inside it.
    expect(quietHoursEnd(new Date("2026-10-16T14:00:00Z"), daytime)).toBeNull();
  });

  it("gives today's end for a same-day window", () => {
    // 13:30 in London (12:30 UTC) ends at 15:00 London (14:00 UTC).
    expect(quietHoursEnd(new Date("2026-10-16T12:30:00Z"), daytime)).toEqual(new Date("2026-10-16T14:00:00Z"));
  });

  it("gives the next 07:00 for an overnight window, before and after midnight", () => {
    // 23:30 London (22:30 UTC) ends at 07:00 London next morning (06:00 UTC on 17 Oct).
    expect(quietHoursEnd(new Date("2026-10-16T22:30:00Z"), overnight)).toEqual(new Date("2026-10-17T06:00:00Z"));
    // 03:00 London (02:00 UTC on 17 Oct) ends at 07:00 London same morning (06:00 UTC).
    expect(quietHoursEnd(new Date("2026-10-17T02:00:00Z"), overnight)).toEqual(new Date("2026-10-17T06:00:00Z"));
  });

  it("returns a result on a whole minute", () => {
    const end = quietHoursEnd(new Date("2026-10-16T22:30:37.512Z"), overnight)!;
    expect(end.getTime() % 60_000).toBe(0);
    expect(end).toEqual(new Date("2026-10-17T06:00:00Z"));
  });

  it("reads the same instant in each zone's own clock", () => {
    const at = new Date("2026-10-16T23:30:00Z");
    // London is BST (UTC+1) on 16 Oct: 00:30 local, inside 22:00–07:00, ends 07:00 local (06:00 UTC) on 17 Oct.
    expect(quietHoursEnd(at, { ...overnight, timeZone: "Europe/London" })).toEqual(new Date("2026-10-17T06:00:00Z"));
    // New York is EDT (UTC-4) on 16 Oct: 19:30 local, before 22:00, so not in quiet hours.
    expect(quietHoursEnd(at, { ...overnight, timeZone: "America/New_York" })).toBeNull();
    // 02:30 UTC on 17 Oct is 22:30 EDT on 16 Oct in New York: inside, ends 07:00 EDT (11:00 UTC) on 17 Oct.
    expect(quietHoursEnd(new Date("2026-10-17T02:30:00Z"), { ...overnight, timeZone: "America/New_York" })).toEqual(
      new Date("2026-10-17T11:00:00Z"),
    );
  });

  it("handles the London clock change either side of it", () => {
    // 25 Oct 2026: BST ends at 02:00 local (01:00 UTC). 00:30 local is 23:30 UTC on 24 Oct, inside 22:00–07:00.
    // The end is a fixed wall-clock time later, and it lands 06:00 UTC because the clock went back on the way.
    expect(quietHoursEnd(new Date("2026-10-24T23:30:00Z"), overnight)).toEqual(new Date("2026-10-25T06:00:00Z"));
    // 1 Nov 2026 is GMT (UTC+0). 03:00 local is 03:00 UTC, inside 22:00–07:00; ends 07:00 local.
    expect(quietHoursEnd(new Date("2026-11-01T03:00:00Z"), overnight)).toEqual(new Date("2026-11-01T07:00:00Z"));
  });
});
