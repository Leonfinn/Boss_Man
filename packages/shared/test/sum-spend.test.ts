import { describe, expect, it } from "vitest";
import { sumSpend, type Bounds, type SpendEvent } from "../src/billing.js";

const d = (s: string) => new Date(s);

const event = (at: string, costMicros: number): SpendEvent => ({ occurredAt: d(at), costMicros });

describe("sumSpend", () => {
  it("returns 0 with no events", () => {
    expect(sumSpend([], { start: null, end: null })).toBe(0);
  });

  it("counts an event exactly at start and leaves out one exactly at end", () => {
    const bounds: Bounds = { start: d("2026-11-01T00:00:00Z"), end: d("2026-12-01T00:00:00Z") };
    const events = [
      event("2026-10-31T23:59:59.999Z", 100),
      event("2026-11-01T00:00:00.000Z", 200),
      event("2026-11-15T12:00:00.000Z", 300),
      event("2026-12-01T00:00:00.000Z", 400),
    ];
    expect(sumSpend(events, bounds)).toBe(500);
  });

  it("leaves out an event one millisecond before start", () => {
    const bounds: Bounds = { start: d("2026-11-01T00:00:00Z"), end: null };
    expect(sumSpend([event("2026-10-31T23:59:59.999Z", 700)], bounds)).toBe(0);
    expect(sumSpend([event("2026-11-01T00:00:00.000Z", 700)], bounds)).toBe(700);
  });

  it("counts everything before end when there is no start", () => {
    const bounds: Bounds = { start: null, end: d("2026-12-01T00:00:00Z") };
    const events = [
      event("2020-01-01T00:00:00Z", 1),
      event("2026-11-30T23:59:59.999Z", 2),
      event("2026-12-01T00:00:00.000Z", 4),
    ];
    expect(sumSpend(events, bounds)).toBe(3);
  });

  it("counts everything from start when there is no end", () => {
    const bounds: Bounds = { start: d("2026-11-01T00:00:00Z"), end: null };
    const events = [
      event("2026-10-31T23:59:59.999Z", 1),
      event("2026-11-01T00:00:00.000Z", 2),
      event("2030-06-01T00:00:00Z", 4),
    ];
    expect(sumSpend(events, bounds)).toBe(6);
  });

  it("counts every event when there are no bounds", () => {
    const events = [event("1999-01-01T00:00:00Z", 10), event("2026-11-15T00:00:00Z", 20)];
    expect(sumSpend(events, { start: null, end: null })).toBe(30);
  });

  it("works on any iterable, not just an array", () => {
    function* spendLines(): Generator<SpendEvent> {
      yield event("2026-11-02T00:00:00Z", 11);
      yield event("2026-11-03T00:00:00Z", 13);
      yield event("2026-12-02T00:00:00Z", 17);
    }
    const bounds: Bounds = { start: d("2026-11-01T00:00:00Z"), end: d("2026-12-01T00:00:00Z") };
    expect(sumSpend(spendLines(), bounds)).toBe(24);
  });

  it("keeps totals whole micro-dollars", () => {
    const total = sumSpend(
      [event("2026-11-01T00:00:00Z", 1), event("2026-11-01T00:00:01Z", 2), event("2026-11-01T00:00:02Z", 4)],
      { start: null, end: null },
    );
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(7);
  });
});
