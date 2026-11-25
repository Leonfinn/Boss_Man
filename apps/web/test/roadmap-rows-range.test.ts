// BOS-2612 (Background lane): the shared date range behind every milestone strip on the Timeline tab.
import { describe, expect, it } from "vitest";
import type { MilestoneForecast, RoadmapCompany, RoadmapMilestone } from "../src/api";
import { rangeOf } from "../src/pages/RoadmapRows";

const now = "2026-11-24";
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);

const ms = (o: Partial<RoadmapMilestone> = {}, f: Partial<MilestoneForecast> = {}): RoadmapMilestone => ({
  id: "m",
  title: "Beta",
  targetDate: null,
  total: 0,
  done: 0,
  blocked: 0,
  active: 0,
  status: "on_track",
  horizon: "now",
  pinned: null,
  forecast: { pointsDone: 0, pointsLeft: 0, unsized: 0, pace: 0, expectedFinish: null, daysLate: 0, ...f },
  ...o,
});

const company = (...milestones: RoadmapMilestone[]): RoadmapCompany => ({
  id: "c1",
  name: "App Co",
  objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: [], milestones }],
});

describe("rangeOf", () => {
  it("spans a week before now to nine weeks after when nothing is open", () => {
    const expected = { start: day("2026-11-17"), end: day("2027-01-26") };
    expect(rangeOf([], now)).toEqual(expected);
    expect(rangeOf([company(ms({ status: "done" }))], now)).toEqual(expected);
  });

  it("pushes the end to a week past a due date further out", () => {
    const r = rangeOf([company(ms({ targetDate: "2027-03-01" }))], now);
    expect(r.end).toBe(day("2027-03-08"));
  });

  it("pushes the end to a week past an expected finish further out", () => {
    const r = rangeOf([company(ms({}, { expectedFinish: "2027-02-10" }))], now);
    expect(r.end).toBe(day("2027-02-17"));
  });

  it("pulls the start to a week before an earlier due date", () => {
    const r = rangeOf([company(ms({ targetDate: "2026-11-01" }))], now);
    expect(r.start).toBe(day("2026-10-25"));
  });

  it("ignores done milestones and a no-work milestone's expected finish", () => {
    const done = ms({ status: "done", targetDate: "2027-06-01" }, { expectedFinish: "2027-05-01" });
    const noWork = ms({ status: "no_work" }, { expectedFinish: "2027-07-01" });
    expect(rangeOf([company(done, noWork)], now)).toEqual({ start: day("2026-11-17"), end: day("2027-01-26") });
  });
});
