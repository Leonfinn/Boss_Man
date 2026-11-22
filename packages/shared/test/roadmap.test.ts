import { describe, expect, it } from "vitest";
import { dateIn, dateInCacheSize, milestoneHorizon, milestoneStatus, nextMidnightIn, timeZoneOr } from "../src/index.js";

// BOS-2188: "until midnight (server time)" for a timed permission rule.
describe("nextMidnightIn", () => {
  it("is the next local midnight, in UTC and in an offset zone", () => {
    expect(nextMidnightIn(new Date("2026-11-22T10:15:00Z"), "UTC").toISOString()).toBe("2026-11-23T00:00:00.000Z");
    // 10:15 UTC is 21:15 in Sydney (UTC+11 in November): midnight is 2h45 away.
    expect(nextMidnightIn(new Date("2026-11-22T10:15:00Z"), "Australia/Sydney").toISOString()).toBe("2026-11-22T13:00:00.000Z");
    // A half-hour zone.
    expect(nextMidnightIn(new Date("2026-11-22T10:15:00Z"), "Asia/Kolkata").toISOString()).toBe("2026-11-22T18:30:00.000Z");
  });
  it("never returns the moment it was given, even just after midnight or exactly at it", () => {
    expect(nextMidnightIn(new Date("2026-11-22T00:00:00Z"), "UTC").toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(nextMidnightIn(new Date("2026-11-22T23:59:59Z"), "UTC").toISOString()).toBe("2026-11-23T00:00:00.000Z");
  });
  it("is right on a 25-hour and a 23-hour daylight-saving day", () => {
    // London clocks go back on 25 Oct 2026: that day is 25 hours long (midnight BST = 23:00Z the day before).
    expect(nextMidnightIn(new Date("2026-10-25T00:30:00Z"), "Europe/London").toISOString()).toBe("2026-10-26T00:00:00.000Z");
    // London clocks go forward on 29 Mar 2026: the day is 23 hours long.
    expect(nextMidnightIn(new Date("2026-03-29T00:30:00Z"), "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });
});

const today = "2026-10-16";

// Most cases already pinned in plan-roadmap.test.ts (done wins over a past date, no work,
// unscheduled, the 14-day at-risk boundary, the Now/Next/Later day boundaries and a pinned
// horizon) are not repeated here. "late" is repeated on purpose so this file alone proves it.

describe("milestoneStatus", () => {
  it("marks a milestone late when its date has already passed", () => {
    expect(milestoneStatus({ total: 5, done: 2, blocked: 0 }, "2026-10-10", today)).toBe("late");
  });

  it("tracks a half-done milestone that is not blocked, even when it is due very soon", () => {
    expect(milestoneStatus({ total: 4, done: 2, blocked: 0 }, "2026-10-20", today)).toBe("on_track");
  });

  it("tracks a milestone due just past the two-week window with nothing done", () => {
    expect(milestoneStatus({ total: 4, done: 0, blocked: 0 }, "2026-10-31", today)).toBe("on_track");
  });

  it("flags a milestone due today as at risk when under half its tickets are done", () => {
    expect(milestoneStatus({ total: 4, done: 1, blocked: 0 }, "2026-10-16", today)).toBe("at_risk");
  });
});

describe("milestoneHorizon", () => {
  const m = (o: Partial<Parameters<typeof milestoneHorizon>[0]>) =>
    milestoneHorizon({ total: 2, done: 0, blocked: 0, active: 0, targetDate: null, horizon: null, ...o }, today);

  it("puts a milestone with active tickets in Now even when it has no date", () => {
    expect(m({ active: 1, targetDate: null })).toBe("now");
  });
});

describe("timeZoneOr", () => {
  it("falls back to Europe/London when no zone is given", () => {
    expect(timeZoneOr(null)).toBe("Europe/London");
    expect(timeZoneOr(undefined)).toBe("Europe/London");
    expect(timeZoneOr("")).toBe("Europe/London");
  });

  it("keeps a real zone and replaces a made-up one", () => {
    expect(timeZoneOr("America/New_York")).toBe("America/New_York");
    expect(timeZoneOr("Mars/Olympus")).toBe("Europe/London");
  });

  it("uses a custom fallback when asked", () => {
    expect(timeZoneOr(null, "UTC")).toBe("UTC");
    expect(timeZoneOr("Mars/Olympus", "UTC")).toBe("UTC");
    expect(timeZoneOr("Asia/Tokyo", "UTC")).toBe("Asia/Tokyo");
  });
});

describe("dateIn", () => {
  it("reads the same instant on different calendar days in London and UTC", () => {
    const at = new Date("2026-07-01T23:30:00Z");
    expect(dateIn(at, "Europe/London")).toBe("2026-07-02");
    expect(dateIn(at, "UTC")).toBe("2026-07-01");
  });

  it("keeps its formatter cache bounded across 300 spellings of real zones", () => {
    const at = new Date("2026-07-01T23:30:00Z");
    const bases = ["Europe/London", "America/New_York", "Asia/Tokyo", "Europe/Paris", "Africa/Cairo"];
    const spellings = new Set<string>();
    for (let k = 0; spellings.size < 300 && k < 4096; k++) {
      const base = bases[k % bases.length] ?? "Europe/London";
      spellings.add([...base].map((c, i) => ((k >> (i % 30)) & 1 ? c.toUpperCase() : c.toLowerCase())).join(""));
    }
    expect(spellings.size).toBe(300);
    for (const spelt of spellings) {
      expect(dateIn(at, spelt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dateInCacheSize()).toBeLessThanOrEqual(256);
    }
  });
});
