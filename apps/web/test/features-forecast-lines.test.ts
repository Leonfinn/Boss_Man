// BOS-2396: the feature page's forecast lines in plain words.
import { describe, expect, it } from "vitest";
import { forecastLines } from "../src/pages/Features";

describe("forecastLines", () => {
  it("says points done, left and the expected finish", () => {
    expect(forecastLines({ pointsDone: 21, pointsLeft: 13, unsized: 0, pace: 3, expectedFinish: "2026-12-02" })).toEqual(["21 of 34 points done · 13 left · at this pace about 2 Dec"]);
  });
  it("names unsized tasks", () => {
    expect(forecastLines({ pointsDone: 1, pointsLeft: 0, unsized: 3, pace: 1, expectedFinish: "2026-11-23" })).toEqual(["1 of 1 points done · 0 left", "3 tasks have no size"]);
  });
  it("says there is nothing to estimate from when pace is 0", () => {
    expect(forecastLines({ pointsDone: 0, pointsLeft: 5, unsized: 0, pace: 0, expectedFinish: null })).toEqual(["0 of 5 points done · 5 left", "No finished work in the last 4 weeks to estimate from."]);
  });
});
