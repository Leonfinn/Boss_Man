// BOS-2375: the milestone forecast line on the Roadmap.
import { describe, expect, it } from "vitest";
import { forecastLines } from "../src/pages/Roadmap";

const f = (o: Partial<Parameters<typeof forecastLines>[0]> = {}) => ({ pointsDone: 21, pointsLeft: 13, unsized: 0, pace: 3, expectedFinish: "2026-12-02", daysLate: 0, ...o });

describe("forecastLines", () => {
  it("shows points done, left and the expected date", () => {
    const l = forecastLines(f());
    expect(l.text).toContain("21 of 34 points done · 13 left · at this pace about");
    expect(l.late).toBe(false);
  });
  it("marks a finish after the target", () => {
    const l = forecastLines(f({ daysLate: 5 }));
    expect(l.text).toContain("5 days after the target");
    expect(l.late).toBe(true);
  });
  it("reports unsized tickets and no pace", () => {
    expect(forecastLines(f({ unsized: 3 })).note).toBe("3 tickets have no size");
    expect(forecastLines(f({ expectedFinish: null })).text).toContain("No finished work in the last 4 weeks to estimate from.");
  });
});
