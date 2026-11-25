import { describe, expect, it } from "vitest";
import { ceoPlanWake, CEO_RISK_STATUSES, dateIn, dateInCacheSize, milestoneHorizon, milestoneStatus, milestoneVerdict, needsCeoPlan, nextMidnightIn, timeZoneOr } from "../src/index.js";

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

describe("milestoneStatus (BOS-2558: one rule, every row of the design's table)", () => {
  const ok = { blocked: 0, daysLate: 0, noEstimate: false };

  it("marks a milestone late when its date has already passed", () => {
    expect(milestoneStatus({ total: 5, done: 2, ...ok }, "2026-10-10", today)).toBe("late");
  });

  it("tracks a half-done milestone that is not blocked, even when it is due very soon", () => {
    expect(milestoneStatus({ total: 4, done: 2, ...ok }, "2026-10-20", today)).toBe("on_track");
  });

  it("is at risk when its own pace finishes it after its date", () => {
    expect(milestoneStatus({ total: 4, done: 1, ...ok, daysLate: 5 }, "2026-10-16", today)).toBe("at_risk");
  });

  it("is at risk with no estimate only when due within 28 days", () => {
    expect(milestoneStatus({ total: 4, done: 0, ...ok, noEstimate: true }, "2026-11-13", today)).toBe("at_risk");
    expect(milestoneStatus({ total: 4, done: 0, ...ok, noEstimate: true }, "2026-11-14", today)).toBe("on_track");
  });

  it("puts done before no date, a past date before a blocked ticket, and no tickets before no date", () => {
    expect(milestoneStatus({ total: 2, done: 2, ...ok }, null, today)).toBe("done");
    expect(milestoneStatus({ total: 2, done: 1, ...ok, blocked: 1 }, "2026-10-01", today)).toBe("late");
    expect(milestoneStatus({ total: 0, done: 0, ...ok }, null, today)).toBe("no_work");
    expect(milestoneStatus({ total: 2, done: 1, ...ok }, null, today)).toBe("no_date");
  });
});

describe("milestoneVerdict (BOS-2579: badge and reason from one function)", () => {
  const base = { blocked: 0, daysLate: 0, noEstimate: false };
  const t = (ref: string, why: "owner" | "stuck") => ({ ref, id: `id-${ref}`, why });
  const check = (ref: string, quietDays: number | null) => ({ ref, id: `id-${ref}`, assignee: "Zippy", quietDays });

  it("counts merged, live tickets as delivered: a milestone whose only open tickets are final checks is Live, being checked, never At risk or Late", () => {
    const v = milestoneVerdict({ total: 5, done: 2, delivered: 3, ...base, blocked: 3, daysLate: 9, checks: [check("BOS-1", null), check("BOS-2", null), check("BOS-3", null)], lastCheckEnds: "2026-10-20" }, "2026-10-10", today);
    expect(v.status).toBe("live_checked");
    expect(v.reason).toContain("3 final checks running");
    expect(v.reason).toContain("last check ends Tue 20 Oct");
  });

  it("names the quiet checks, and only those, in the reason", () => {
    const v = milestoneVerdict({ total: 2, done: 0, delivered: 2, ...base, checks: [check("BOS-1703", 7), check("BOS-1964", null)] }, "2026-10-30", today);
    expect(v.reason).toContain("1 has gone quiet: BOS-1703");
    expect(v.reason).not.toContain("BOS-1964");
    expect(v.tickets.map((x) => x.ref)).toEqual(["BOS-1703"]);
  });

  it("a blocked ticket alone is on track; one waiting on the owner's card is at risk and named", () => {
    expect(milestoneVerdict({ total: 3, done: 1, ...base, blocked: 2 }, "2026-11-30", today)).toMatchObject({ status: "on_track", reason: null });
    const v = milestoneVerdict({ total: 3, done: 1, ...base, blocked: 1, needsAction: [t("BOS-2541", "owner")] }, "2026-11-30", today);
    expect(v.status).toBe("at_risk");
    expect(v.reason).toBe("At risk: BOS-2541 waits on your card.");
    expect(v.tickets.map((x) => x.ref)).toEqual(["BOS-2541"]);
  });

  it("puts the worst reason first: owner card, then the date, then stuck", () => {
    const stuck = t("BOS-9", "stuck");
    expect(milestoneVerdict({ total: 3, done: 1, ...base, daysLate: 4, needsAction: [stuck] }, "2026-11-30", today).reason).toContain("4 days after its date");
    expect(milestoneVerdict({ total: 3, done: 1, ...base, needsAction: [stuck] }, "2026-11-30", today).reason).toBe("At risk: BOS-9 looks stuck.");
  });

  it("is Late with a reason when unbuilt work is left past the date, and has no reason when done or on track", () => {
    expect(milestoneVerdict({ total: 3, done: 1, delivered: 1, ...base }, "2026-10-10", today).reason).toMatch(/^Late: its date passed 6 days ago and 1 ticket is not built/);
    expect(milestoneVerdict({ total: 2, done: 2, ...base }, "2026-10-10", today)).toMatchObject({ status: "done", reason: null });
  });

  it("the owner's five 25 Nov milestones (22 blocked tickets, every one merged and live) read Live, being checked or On track, never At risk or Late", () => {
    // Shape from the BOS-2573 design page: 5 milestones, 22 "blocked" tickets that are all built and live, with the
    // pace estimate saying they run past their dates. Figures per milestone are made up to that shape.
    const fiveMilestones = [
      { done: 5, delivered: 4, date: "2026-11-30" },
      { done: 2, delivered: 4, date: "2026-12-05" },
      { done: 2, delivered: 6, date: "2026-12-12" },
      { done: 1, delivered: 5, date: "2026-12-20" },
      { done: 3, delivered: 3, date: "2026-12-31" },
    ];
    expect(fiveMilestones.reduce((n, m) => n + m.delivered, 0)).toBe(22);
    for (const { date, ...m } of fiveMilestones) {
      const total = m.done + m.delivered; // every unfinished ticket is built and live
      const checks = Array.from({ length: m.delivered }, (_, i) => check(`BOS-${100 + i}`, null));
      const v = milestoneVerdict({ ...base, ...m, total, blocked: m.delivered, daysLate: 12, checks }, date, today);
      expect(["live_checked", "on_track"]).toContain(v.status);
      expect(v.reason ?? "").not.toMatch(/^(At risk|Late)/);
    }
  });

  it("the badge and the reason line always agree: the reason opens with the words of its badge, and only a badge with something to say has one", () => {
    const opening: Record<string, RegExp | null> = { at_risk: /^At risk: /, late: /^Late: /, live_checked: /^All built and live\./, done: null, on_track: null, no_work: null, no_date: null };
    const dates = [null, "2026-10-01", "2026-10-10", "2026-11-30"];
    for (const date of dates) for (const done of [0, 2, 4]) for (const delivered of [0, 2]) for (const daysLate of [0, 5]) for (const owner of [false, true]) {
      const total = 4 + (done === 4 ? 0 : delivered);
      const needsAction = owner ? [t("BOS-7", "owner")] : [];
      const input = { ...base, total, done, delivered: Math.min(delivered, total - done), daysLate, needsAction, checks: [] };
      const v = milestoneVerdict(input, date, today);
      expect(v.status).toBe(milestoneStatus(input, date, today));
      const re = opening[v.status];
      if (re) expect(v.reason ?? "").toMatch(re);
      else expect(v.reason).toBeNull();
    }
  });

  it("gives every status the same badge milestoneStatus does", () => {
    const input = { total: 3, done: 1, ...base, needsAction: [t("BOS-5", "owner")] };
    expect(milestoneStatus(input, "2026-11-30", today)).toBe(milestoneVerdict(input, "2026-11-30", today).status);
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

describe("milestone in the CEO's hands (BOS-2581)", () => {
  it("At risk and Late are the two statuses that need a plan", () => {
    expect(CEO_RISK_STATUSES).toEqual(["at_risk", "late"]);
    expect(needsCeoPlan("at_risk")).toBe(true);
    expect(needsCeoPlan("late")).toBe(true);
    for (const s of ["done", "on_track", "live_checked", "no_work", "no_date"] as const) expect(needsCeoPlan(s), s).toBe(false);
  });

  it("wakes on entering At risk or Late only, not while it stays there, and a move between them is the same state", () => {
    expect(ceoPlanWake({ managed: true, wasManaged: false, status: "at_risk", lastWoken: null })).toBe(true);
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "at_risk", lastWoken: "at_risk" })).toBe(false);
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "late", lastWoken: "at_risk" })).toBe(false);
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "late", lastWoken: "late" })).toBe(false);
    // On track in between: a return to At risk or Late is a new wake.
    expect(ceoPlanWake({ managed: true, wasManaged: true, status: "at_risk", lastWoken: "on_track" })).toBe(true);
    // Switched off, never a wake.
    expect(ceoPlanWake({ managed: false, wasManaged: false, status: "late", lastWoken: null })).toBe(false);
    expect(ceoPlanWake({ managed: false, wasManaged: true, status: "at_risk", lastWoken: "at_risk" })).toBe(false);
  });
});
