import { describe, expect, it } from "vitest";
import { dateIn, featureHorizon, layoutPlan, milestoneHorizon, milestoneStatus } from "../src/index.js";

describe("layoutPlan", () => {
  // design -> api -> ui, api -> docs; vendor (engagement) -> api; done "spec" -> design.
  const nodes = [
    { id: "spec", open: false },
    { id: "design", open: true },
    { id: "vendor", open: true },
    { id: "api", open: true },
    { id: "ui", open: true },
    { id: "docs", open: true },
    { id: "solo", open: true },
  ];
  const edges = [
    { from: "spec", to: "design" },
    { from: "design", to: "api" },
    { from: "vendor", to: "api" },
    { from: "api", to: "ui" },
    { from: "api", to: "docs" },
  ];

  it("lays nodes out by their longest chain of blockers", () => {
    const l = layoutPlan(nodes, edges);
    expect(l.layer).toMatchObject({ spec: 0, vendor: 0, solo: 0, design: 1, api: 2, ui: 3, docs: 3 });
    expect(l.columns.map((c) => c.length)).toEqual([3, 1, 1, 2]);
  });

  it("finds blocked chains, their causes and what each blocker holds up", () => {
    const l = layoutPlan(nodes, edges);
    expect([...l.blocked].sort()).toEqual(["api", "docs", "ui"]);
    // A done blocker doesn't block: design is free to start.
    expect(l.blocked.has("design")).toBe(false);
    expect(l.causes.ui).toEqual(["design", "vendor"]);
    expect(l.holdingUp).toMatchObject({ design: 3, vendor: 3, api: 2, ui: 0, solo: 0 });
  });

  it("survives a cycle and ignores edges to unknown nodes", () => {
    const l = layoutPlan([{ id: "a", open: true }, { id: "b", open: true }], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "x", to: "a" }]);
    expect(Object.keys(l.layer).sort()).toEqual(["a", "b"]);
  });
});

describe("milestoneStatus", () => {
  const today = "2026-10-16";
  it("works out a milestone's status from its tickets and date", () => {
    expect(milestoneStatus({ total: 0, done: 0, blocked: 0 }, "2026-09-01", today)).toBe("no_work");
    expect(milestoneStatus({ total: 3, done: 3, blocked: 0 }, "2026-09-01", today)).toBe("done");
    expect(milestoneStatus({ total: 3, done: 1, blocked: 0 }, "2026-10-15", today)).toBe("late");
    expect(milestoneStatus({ total: 3, done: 1, blocked: 0 }, null, today)).toBe("unscheduled");
    expect(milestoneStatus({ total: 4, done: 1, blocked: 0 }, "2026-10-30", today)).toBe("at_risk");
    expect(milestoneStatus({ total: 4, done: 3, blocked: 1 }, "2026-10-16", today)).toBe("at_risk");
    expect(milestoneStatus({ total: 4, done: 3, blocked: 0 }, "2026-10-30", today)).toBe("on_track");
    expect(milestoneStatus({ total: 4, done: 0, blocked: 2 }, "2026-12-01", today)).toBe("on_track");
  });
  it("reads today in the owner's time zone", () => {
    expect(dateIn(new Date("2026-10-16T23:30:00Z"), "Europe/London")).toBe("2026-10-17");
    expect(dateIn(new Date("2026-10-16T23:30:00Z"), "America/New_York")).toBe("2026-10-16");
  });
});

describe("milestoneHorizon", () => {
  const today = "2026-10-16";
  const m = (o: Partial<Parameters<typeof milestoneHorizon>[0]>) => milestoneHorizon({ total: 2, done: 0, blocked: 0, active: 0, targetDate: null, horizon: null, ...o }, today);
  it("puts work in progress, late and soon-due milestones in Now, the next 90 days in Next, the rest in Later", () => {
    expect(m({ active: 1, targetDate: "2027-06-01" })).toBe("now");
    expect(m({ blocked: 1 })).toBe("now");
    expect(m({ targetDate: "2026-09-30" })).toBe("now");
    expect(m({ targetDate: "2026-11-15" })).toBe("now");
    expect(m({ targetDate: "2026-11-16" })).toBe("next");
    expect(m({ targetDate: "2027-01-14" })).toBe("next");
    expect(m({ targetDate: "2027-01-15" })).toBe("later");
    expect(m({})).toBe("later");
  });
  it("lets the owner pin a milestone", () => {
    expect(m({ active: 3, horizon: "later" })).toBe("later");
    expect(m({ horizon: "next" })).toBe("next");
  });
});

describe("featureHorizon", () => {
  it("follows the feature's status until someone pins it", () => {
    expect(featureHorizon({ status: "in_progress", horizon: null })).toBe("now");
    expect(featureHorizon({ status: "planned", horizon: null })).toBe("next");
    expect(featureHorizon({ status: "considering", horizon: null })).toBe("later");
    expect(featureHorizon({ status: "idea", horizon: null })).toBe("later");
    expect(featureHorizon({ status: "planned", horizon: "now" })).toBe("now");
    expect(featureHorizon({ status: "in_progress", horizon: "later" })).toBe("later");
  });

  it("keeps released features out of the three columns", () => {
    expect(featureHorizon({ status: "released", horizon: null })).toBe("released");
    expect(featureHorizon({ status: "released", horizon: "now" })).toBe("released");
  });
});
