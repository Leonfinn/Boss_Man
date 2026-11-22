import { describe, expect, it } from "vitest";
import { inWorkingHours, localToInstant, nextWorkingStart, startLabel, waitingText, workingHoursProblem, type WorkingHours } from "../src/workingHours.js";

const at = (iso: string) => new Date(iso);
const weekdays: WorkingHours = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", timeZone: "Europe/London" };

describe("working hours: ordinary windows", () => {
  it("is always open when off", () => {
    expect(inWorkingHours(at("2027-01-02T03:00:00Z"), null)).toBe(true);
    expect(nextWorkingStart(at("2027-01-02T03:00:00Z"), null)).toBeNull();
  });

  it("is open inside the window and closed at its end", () => {
    expect(inWorkingHours(at("2027-01-04T08:00:00Z"), weekdays)).toBe(true); // Mon
    expect(inWorkingHours(at("2027-01-04T16:59:00Z"), weekdays)).toBe(true);
    expect(inWorkingHours(at("2027-01-04T17:00:00Z"), weekdays)).toBe(false);
    expect(inWorkingHours(at("2027-01-04T07:59:00Z"), weekdays)).toBe(false);
  });

  it("skips days that aren't chosen", () => {
    expect(inWorkingHours(at("2027-01-02T12:00:00Z"), weekdays)).toBe(false); // Sat
    expect(nextWorkingStart(at("2027-01-02T12:00:00Z"), weekdays)?.toISOString()).toBe("2027-01-04T08:00:00.000Z");
  });

  it("gives the next start the same day when it is early", () => {
    expect(nextWorkingStart(at("2027-01-05T03:00:00Z"), weekdays)?.toISOString()).toBe("2027-01-05T08:00:00.000Z");
  });

  it("reads the window in its own zone", () => {
    const ny: WorkingHours = { ...weekdays, timeZone: "America/New_York" };
    expect(inWorkingHours(at("2027-01-04T13:00:00Z"), ny)).toBe(true); // 08:00 EST
    expect(inWorkingHours(at("2027-01-04T12:59:00Z"), ny)).toBe(false);
  });

  it("labels the start for the Agents page and the ticket card", () => {
    expect(startLabel(at("2027-01-04T08:00:00Z"), "Europe/London")).toBe("Mon 08:00");
    expect(waitingText("Dylan", at("2027-01-04T00:00:00Z"), at("2027-01-03T22:00:00Z"), "Europe/London")).toBe("Waiting for Dylan's working hours, from Mon 00:00");
    expect(waitingText("Dylan", at("2027-01-04T00:00:00Z"), at("2027-01-03T23:30:00Z"), "UTC")).toBe("Waiting for Dylan's working hours, from Mon 00:00");
    expect(waitingText("Dylan", at("2027-01-04T08:00:00Z"), at("2027-01-04T03:00:00Z"), "UTC")).toBe("Waiting for Dylan's working hours, from 08:00");
  });
});

describe("working hours: a window that crosses midnight", () => {
  const night: WorkingHours = { days: [1], start: "22:00", end: "07:00", timeZone: "UTC" };
  it("belongs to the day it starts on", () => {
    expect(inWorkingHours(at("2027-01-04T22:00:00Z"), night)).toBe(true); // Mon 22:00
    expect(inWorkingHours(at("2027-01-05T03:00:00Z"), night)).toBe(true); // Tue 03:00, the same window
    expect(inWorkingHours(at("2027-01-05T07:00:00Z"), night)).toBe(false);
    expect(inWorkingHours(at("2027-01-04T03:00:00Z"), night)).toBe(false); // Mon 03:00 belongs to Sunday's window
    expect(inWorkingHours(at("2027-01-05T22:30:00Z"), night)).toBe(false); // Tue 22:30, Tuesday isn't chosen
  });
  it("finds the next start", () => {
    expect(nextWorkingStart(at("2027-01-05T08:00:00Z"), night)?.toISOString()).toBe("2027-01-11T22:00:00.000Z");
  });
});

describe("working hours: daylight saving", () => {
  it("spring forward in London: Monday 08:00 is 07:00 UTC, not 08:00", () => {
    // The clocks went forward on Sunday 28 March 2027.
    expect(nextWorkingStart(at("2027-03-27T12:00:00Z"), weekdays)?.toISOString()).toBe("2027-03-29T07:00:00.000Z");
    expect(inWorkingHours(at("2027-03-29T07:00:00Z"), weekdays)).toBe(true);
    expect(inWorkingHours(at("2027-03-29T06:59:00Z"), weekdays)).toBe(false);
  });

  it("fall back in London: Monday 08:00 is 08:00 UTC again", () => {
    expect(nextWorkingStart(at("2027-10-30T12:00:00Z"), weekdays)?.toISOString()).toBe("2027-11-01T08:00:00.000Z");
  });

  it("a window starting in the skipped hour starts when the clocks jump, and runs once", () => {
    const sunday: WorkingHours = { days: [0], start: "01:30", end: "05:00", timeZone: "Europe/London" };
    expect(inWorkingHours(at("2027-03-28T00:59:00Z"), sunday)).toBe(false);
    expect(inWorkingHours(at("2027-03-28T01:00:00Z"), sunday)).toBe(true); // 02:00 BST, the first valid minute
    expect(nextWorkingStart(at("2027-03-27T12:00:00Z"), sunday)?.toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(inWorkingHours(at("2027-03-28T03:59:00Z"), sunday)).toBe(true);
    expect(inWorkingHours(at("2027-03-28T04:00:00Z"), sunday)).toBe(false); // 05:00 BST
  });

  it("a window starting in the repeated hour starts at the first 01:30 and isn't doubled", () => {
    const sunday: WorkingHours = { days: [0], start: "01:30", end: "03:00", timeZone: "Europe/London" };
    // Clocks went back at 02:00 BST (01:00 UTC) on Sunday 31 October 2027, so 01:30 happened at 00:30 UTC and again at 01:30 UTC.
    expect(nextWorkingStart(at("2027-10-30T12:00:00Z"), sunday)?.toISOString()).toBe("2027-10-31T00:30:00.000Z");
    expect(inWorkingHours(at("2027-10-31T00:29:00Z"), sunday)).toBe(false);
    expect(inWorkingHours(at("2027-10-31T00:30:00Z"), sunday)).toBe(true);
    expect(inWorkingHours(at("2027-10-31T01:45:00Z"), sunday)).toBe(true); // 01:45 the second time: still the same window
    expect(inWorkingHours(at("2027-10-31T03:00:00Z"), sunday)).toBe(false);
    // The next start is the following Sunday, once.
    expect(nextWorkingStart(at("2027-10-31T12:00:00Z"), sunday)?.toISOString()).toBe("2027-11-07T01:30:00.000Z");
  });

  it("an overnight window across fall back ends at 07:00 local, an hour longer in elapsed time", () => {
    const night: WorkingHours = { days: [6], start: "22:00", end: "07:00", timeZone: "Europe/London" };
    expect(inWorkingHours(at("2027-10-30T21:00:00Z"), night)).toBe(true); // 22:00 BST
    expect(inWorkingHours(at("2027-10-31T06:59:00Z"), night)).toBe(true);
    expect(inWorkingHours(at("2027-10-31T07:00:00Z"), night)).toBe(false);
  });

  it("an overnight window across spring forward ends at 07:00 local, an hour shorter in elapsed time", () => {
    const night: WorkingHours = { days: [6], start: "22:00", end: "07:00", timeZone: "Europe/London" };
    expect(inWorkingHours(at("2027-03-27T22:00:00Z"), night)).toBe(true);
    expect(inWorkingHours(at("2027-03-28T05:59:00Z"), night)).toBe(true);
    expect(inWorkingHours(at("2027-03-28T06:00:00Z"), night)).toBe(false); // 07:00 BST
  });

  it("New York spring forward (14 March 2027) and fall back (7 November 2027)", () => {
    const ny: WorkingHours = { days: [0, 1], start: "08:00", end: "17:00", timeZone: "America/New_York" };
    expect(nextWorkingStart(at("2027-03-13T12:00:00Z"), ny)?.toISOString()).toBe("2027-03-14T12:00:00.000Z"); // 08:00 EDT
    expect(nextWorkingStart(at("2027-11-06T12:00:00Z"), ny)?.toISOString()).toBe("2027-11-07T13:00:00.000Z"); // 08:00 EST
  });

  it("localToInstant maps a normal, a skipped and a repeated time", () => {
    expect(localToInstant(2027, 7, 1, 12 * 60, "Europe/London").toISOString()).toBe("2027-07-01T11:00:00.000Z");
    expect(localToInstant(2027, 3, 14, 2 * 60 + 30, "America/New_York").toISOString()).toBe("2027-03-14T07:00:00.000Z"); // 02:30 doesn't exist; the jump is 07:00 UTC
    expect(localToInstant(2027, 11, 7, 60 + 30, "America/New_York").toISOString()).toBe("2027-11-07T05:30:00.000Z"); // first 01:30 EDT
  });
});

describe("workingHoursProblem", () => {
  it("accepts good hours and says what is wrong with bad ones", () => {
    expect(workingHoursProblem(weekdays)).toBeNull();
    expect(workingHoursProblem({ ...weekdays, days: [] })).toMatch(/day/);
    expect(workingHoursProblem({ ...weekdays, days: [7] })).toMatch(/day/);
    expect(workingHoursProblem({ ...weekdays, start: "8:00" })).toMatch(/HH:MM/);
    expect(workingHoursProblem({ ...weekdays, end: "08:00" })).toMatch(/same/);
    expect(workingHoursProblem({ ...weekdays, timeZone: "Mars/Base" })).toMatch(/time zone/);
  });
});
