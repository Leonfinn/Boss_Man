import { describe, expect, it } from "vitest";
import { featuresToCsvRows, milestonesToCsvRows, roadmapFileName } from "../src/pages/Roadmap";

const feature = (id: string, title: string, column: string, extra: object = {}) => ({
  id,
  title,
  status: "planned",
  rank: null,
  horizon: null,
  column,
  priority: 1,
  releasedAt: null,
  objective: null,
  publicSummary: null,
  showPublicly: false,
  tickets: { total: 4, done: 1 },
  milestones: [],
  ...extra,
});

describe("roadmap CSV rows", () => {
  it("lists features by column with milestones joined and a formula-looking title left for csv.ts to guard", () => {
    const rows = featuresToCsvRows([
      {
        id: "c1",
        name: "App Co",
        features: [
          feature("f3", "Sign-in", "released", { releasedAt: "2026-11-01T10:00:00Z", showPublicly: true }),
          feature("f2", "Later thing", "later"),
          feature("f1", "=Dark mode", "now", {
            rank: 2,
            objective: { id: "o1", title: "Launch", priority: 1 },
            milestones: [
              { id: "m1", title: "Beta", targetDate: "2026-12-01", pinned: null },
              { id: "m2", title: "GA", targetDate: null, pinned: null },
            ],
          }),
        ],
      },
    ] as never);
    expect(rows.map((r) => [r[1], r[3]])).toEqual([["Now", "=Dark mode"], ["Later", "Later thing"], ["Released", "Sign-in"]]);
    expect(rows[0]).toEqual(["App Co", "Now", 2, "=Dark mode", expect.any(String), "Launch", "Beta (2026-12-01); GA", 1, 4, "", "no"]);
    expect(rows[2]![9]).toBe("2026-11-01");
    expect(rows[2]![10]).toBe("yes");
  });

  it("lists milestones with the page's status label and forecast", () => {
    const rows = milestonesToCsvRows([
      {
        id: "c1",
        name: "App Co",
        objectives: [
          {
            id: "o1",
            title: "Launch",
            milestones: [
              { id: "m1", title: "Beta", targetDate: "2026-11-01", status: "late", done: 3, total: 8, forecast: { pointsLeft: 13, expectedFinish: "2026-12-02", daysLate: 31 } },
              { id: "m2", title: "GA", targetDate: null, status: "unscheduled", done: 0, total: 0, forecast: { pointsLeft: 0, expectedFinish: null, daysLate: 0 } },
            ],
          },
        ],
      },
    ] as never);
    expect(rows).toEqual([
      ["App Co", "Launch", "Beta", "2026-11-01", "Late", 3, 8, 13, "2026-12-02", 31],
      ["App Co", "Launch", "GA", "", "No date", 0, 0, 0, "", 0],
    ]);
  });

  it("names files by kind and day", () => {
    expect(roadmapFileName("features", new Date("2026-11-24T10:00:00Z"))).toBe("roadmap-features-2026-11-24.csv");
    expect(roadmapFileName("milestones", new Date("2026-11-24T10:00:00Z"))).toBe("roadmap-milestones-2026-11-24.csv");
  });
});
