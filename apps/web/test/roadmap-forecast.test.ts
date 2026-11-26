// BOS-2375, rewritten for BOS-2560: the words on a milestone row (meta lines, summary line, chart sentence).
import { describe, expect, it } from "vitest";
import type { RoadmapMilestone } from "../src/api";
import { burnupLabel, metaLines, summaryLine } from "../src/pages/RoadmapRows";

const now = "2026-11-24";
const m = (o: Partial<RoadmapMilestone> = {}, f: Partial<RoadmapMilestone["forecast"]> = {}): RoadmapMilestone => ({
  id: "m", title: "Beta", targetDate: "2026-12-04", total: 4, done: 2, blocked: 0, active: 1, status: "on_track", horizon: "now", pinned: null,
  forecast: { pointsDone: 21, pointsLeft: 13, unsized: 0, pace: 3, expectedFinish: "2026-12-02", daysLate: 0, ...f },
  ...o,
});

describe("metaLines", () => {
  it("says due date, percent done (rounded down) and points left, then the finish at its pace", () => {
    const l = metaLines(m(), now);
    expect(l.line1).toMatch(/^Due \w+ .*4.* · 61% done · 13 points left$/);
    expect(l.line2).toMatch(/^At its pace about /);
    expect(l.warn).toBe(false);
  });
  it("never shows 100% while work is left", () => {
    expect(metaLines(m({}, { pointsDone: 996, pointsLeft: 4 }), now).line1).toContain("99% done");
  });
  it("says how many days after its date, in the warning colour", () => {
    const l = metaLines(m({ status: "at_risk" }, { daysLate: 5 }), now);
    expect(l.line2).toContain("5 days after its date");
    expect(l.warn).toBe(true);
  });
  it("names blocked and unsized tickets", () => {
    const l = metaLines(m({ blocked: 2, status: "at_risk" }, { unsized: 1 }), now);
    expect(l.line2).toContain("2 tickets blocked");
    expect(l.line2).toContain("1 ticket has no size yet, so it isn't counted (the CEO sizes it)");
    expect(l.warn).toBe(true);
  });
  it("says so when nothing was finished in 4 weeks, and when it is past its date", () => {
    expect(metaLines(m({}, { expectedFinish: null }), now).line2).toBe("Nothing finished in the last 4 weeks, so no estimate yet");
    const late = metaLines(m({ status: "late", targetDate: "2026-11-20" }), now);
    expect(late.line2).toMatch(/^4 days past its date · at its pace about /);
    expect(late.warn).toBe(true);
  });
  it("a milestone with no tickets and one with no date read as the design says", () => {
    expect(metaLines(m({ status: "no_work", total: 0 }), now).line2).toBe("Add tickets or features to it to get a forecast.");
    expect(metaLines(m({ status: "no_date", targetDate: null }), now).line2).toContain("give it a date to get a status");
  });
});

describe("summaryLine", () => {
  const s = (...status: RoadmapMilestone["status"][]) => status.map((x, i) => m({ id: `m${i}`, status: x }));
  it("counts worst first and leaves out zeros", () => {
    expect(summaryLine(s("on_track", "late", "at_risk", "at_risk", "done", "no_work", "no_date"))).toBe("1 late · 2 at risk · 1 on track · 1 no date · 1 with no tickets · 1 done");
  });
  it("says All n on track, and No open milestones", () => {
    expect(summaryLine(s("on_track", "on_track"))).toBe("All 2 on track");
    expect(summaryLine(s("done", "done", "done"))).toBe("No open milestones · 3 done");
  });
});

describe("burnupLabel", () => {
  const w = (done: number, total: number) => ({ weekEnd: "2026-11-24", done, total });
  it("says it in words, with the finish and the due date", () => {
    expect(burnupLabel([w(2, 60), w(163, 178)], m())).toMatch(/^Points done rose from 2 to 163 over 2 weeks; planned rose from 60 to 178\. At its pace it finishes about .*; due /);
  });
  it("a flat line reads as stayed", () => {
    expect(burnupLabel([w(0, 8), w(0, 8)])).toBe("Points done stayed at 0 over 2 weeks; planned stayed at 8.");
  });
});
