import { describe, expect, it } from "vitest";
import { budgetForecast } from "../src/budget-forecast";

const start = "2026-11-01T00:00:00.000Z";
const at = (d: string) => new Date(d);

describe("budgetForecast", () => {
  it("is too early in the first 2 days", () => {
    expect(budgetForecast(5_000_000, start, null, at("2026-11-02T12:00:00Z"))).toEqual({ kind: "too-early" });
  });
  it("projects the month from the pace with no limit", () => {
    // 10 days, $10 spent: $1/day over 30 days
    const f = budgetForecast(10_000_000, start, null, at("2026-11-11T00:00:00Z"));
    expect(f).toMatchObject({ kind: "forecast", projectedMicros: 30_000_000, status: "no-limit" });
  });
  it("stays under the limit", () => {
    const f = budgetForecast(10_000_000, start, 50_000_000, at("2026-11-11T00:00:00Z"));
    expect(f).toMatchObject({ status: "under", reachDate: null });
  });
  it("names the day the limit is reached", () => {
    const f = budgetForecast(10_000_000, start, 26_000_000, at("2026-11-11T00:00:00Z"));
    expect(f).toMatchObject({ status: "reaches" });
    if (f.kind === "forecast") expect(f.reachDate?.toISOString().slice(0, 10)).toBe("2026-11-27");
  });
  it("says already over when spend has passed the limit", () => {
    expect(budgetForecast(10_000_000, start, 8_000_000, at("2026-11-11T00:00:00Z"))).toMatchObject({ status: "over" });
  });
  it("uses the real month length and a zone-shifted start", () => {
    const f = budgetForecast(10_000_000, "2026-01-31T23:00:00.000Z", null, at("2026-02-10T23:00:00Z"));
    expect(f).toMatchObject({ projectedMicros: 28_000_000 });
  });
});
