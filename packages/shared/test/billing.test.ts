import { describe, expect, it } from "vitest";
import { addMonthsClamped, billingCycle, boundsAsEpoch, budgetStatus, creditStatus, usdToMicros, windowBounds } from "../src/billing.js";

const d = (s: string) => new Date(s);

describe("addMonthsClamped", () => {
  it("clamps the 31st to the end of shorter months", () => {
    expect(addMonthsClamped(d("2026-01-31T08:00:00Z"), 1).toISOString()).toBe("2026-02-28T08:00:00.000Z");
    expect(addMonthsClamped(d("2028-01-31T08:00:00Z"), 1).toISOString()).toBe("2028-02-29T08:00:00.000Z");
    expect(addMonthsClamped(d("2026-01-31T08:00:00Z"), 3).toISOString()).toBe("2026-04-30T08:00:00.000Z");
  });
  it("goes backwards across a year", () => {
    expect(addMonthsClamped(d("2026-01-15T00:00:00Z"), -2).toISOString()).toBe("2025-11-15T00:00:00.000Z");
  });
});

describe("billingCycle", () => {
  const anchor = d("2026-06-05T07:59:00Z");
  it("finds the cycle containing now", () => {
    const c = billingCycle(anchor, d("2026-10-16T15:00:00Z"));
    expect(c.start.toISOString()).toBe("2026-10-05T07:59:00.000Z");
    expect(c.end.toISOString()).toBe("2026-11-05T07:59:00.000Z");
  });
  it("treats the reset instant as the start of the new cycle", () => {
    const c = billingCycle(anchor, d("2026-11-05T07:59:00Z"));
    expect(c.start.toISOString()).toBe("2026-11-05T07:59:00.000Z");
  });
  it("works with an anchor in the future", () => {
    const c = billingCycle(d("2027-03-05T00:00:00Z"), d("2026-10-16T00:00:00Z"));
    expect(c.start.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });
  it("handles a 31st anchor in February", () => {
    const c = billingCycle(d("2026-01-31T00:00:00Z"), d("2026-03-10T00:00:00Z"));
    expect(c.start.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(c.end.toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });
});

describe("creditStatus", () => {
  it("counts only this cycle's spend against the grant", () => {
    const events = [
      { occurredAt: d("2026-10-04T23:00:00Z"), costMicros: usdToMicros(50) }, // previous cycle
      { occurredAt: d("2026-10-06T10:00:00Z"), costMicros: usdToMicros(80) },
      { occurredAt: d("2026-10-16T10:00:00Z"), costMicros: usdToMicros(2.4) },
    ];
    const s = creditStatus({ grantMicros: usdToMicros(200), anchor: d("2026-10-05T00:00:00Z") }, events, d("2026-10-16T12:00:00Z"));
    expect(s.spentMicros).toBe(usdToMicros(82.4));
    expect(s.remainingMicros).toBe(usdToMicros(117.6));
    expect(s.fractionUsed).toBeCloseTo(0.412);
  });
  it("reports overspend as negative remaining", () => {
    const s = creditStatus(
      { grantMicros: usdToMicros(10), anchor: d("2026-10-05T00:00:00Z") },
      [{ occurredAt: d("2026-10-10T00:00:00Z"), costMicros: usdToMicros(12) }],
      d("2026-10-16T00:00:00Z"),
    );
    expect(s.remainingMicros).toBe(usdToMicros(-2));
  });
});

describe("budgetStatus", () => {
  const now = d("2026-10-16T12:00:00Z");
  const anchor = d("2026-10-05T00:00:00Z");
  const spend = (usd: number) => [{ occurredAt: d("2026-10-10T00:00:00Z"), costMicros: usdToMicros(usd) }];

  it("is ok below the warning line", () => {
    const s = budgetStatus({ limitMicros: usdToMicros(60), window: { kind: "billing_cycle", anchor }, onLimit: "ask" }, spend(30), now);
    expect(s.state).toBe("ok");
    expect(s.action).toBeNull();
  });
  it("warns at 90% by default", () => {
    const s = budgetStatus({ limitMicros: usdToMicros(60), window: { kind: "billing_cycle", anchor }, onLimit: "ask" }, spend(55.2), now);
    expect(s.state).toBe("warning");
  });
  it("asks or pauses once exceeded", () => {
    const ask = budgetStatus({ limitMicros: usdToMicros(60), window: { kind: "billing_cycle", anchor }, onLimit: "ask" }, spend(60), now);
    expect(ask).toMatchObject({ state: "exceeded", action: "ask" });
    const pause = budgetStatus({ limitMicros: usdToMicros(10), window: { kind: "lifetime" }, onLimit: "pause" }, spend(11), now);
    expect(pause).toMatchObject({ state: "exceeded", action: "pause" });
  });
  it("treats a zero limit with spend as exceeded", () => {
    const s = budgetStatus({ limitMicros: 0, window: { kind: "lifetime" }, onLimit: "pause" }, spend(0.01), now);
    expect(s.state).toBe("exceeded");
  });
});

describe("windowBounds", () => {
  it("rolling windows look back from now", () => {
    const b = windowBounds({ kind: "rolling_days", days: 7 }, d("2026-10-16T00:00:00Z"));
    expect(b.start?.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(b.end).toBeNull();
  });
  it("calendar months are UTC", () => {
    const b = windowBounds({ kind: "calendar_month" }, d("2026-10-16T00:00:00Z"));
    expect(b.start?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(b.end?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("boundsAsEpoch", () => {
  it("gives the epoch milliseconds SQL compares, with a closed start and open end", () => {
    const bounds = windowBounds({ kind: "billing_cycle", anchor: d("2026-10-05T00:00:00Z") }, d("2026-10-16T12:00:00Z"));
    expect(boundsAsEpoch(bounds)).toEqual({ after: d("2026-10-05T00:00:00Z").getTime(), before: d("2026-11-05T00:00:00Z").getTime() });
  });
  it("keeps a missing bound null so unbounded windows sum everything", () => {
    expect(boundsAsEpoch({ start: null, end: null })).toEqual({ after: null, before: null });
    expect(boundsAsEpoch({ start: d("2026-10-09T00:00:00Z"), end: null })).toEqual({ after: d("2026-10-09T00:00:00Z").getTime(), before: null });
  });
});

describe("SQL-shaped totals", () => {
  it("creditStatus uses the handed-in cycle total instead of walking the events", () => {
    const now = d("2026-10-16T12:00:00Z");
    const anchor = d("2026-10-05T00:00:00Z");
    // The events would sum to 30; the pre-summed SQL total is what the caller measured.
    const s = creditStatus({ grantMicros: usdToMicros(200), anchor }, [{ occurredAt: d("2026-10-10T00:00:00Z"), costMicros: usdToMicros(30) }], now, usdToMicros(82.4));
    expect(s.spentMicros).toBe(usdToMicros(82.4));
    expect(s.remainingMicros).toBe(usdToMicros(117.6));
  });
  it("budgetStatus uses the handed-in window total instead of walking the events", () => {
    const now = d("2026-10-16T12:00:00Z");
    const anchor = d("2026-10-05T00:00:00Z");
    const s = budgetStatus({ limitMicros: usdToMicros(60), window: { kind: "billing_cycle", anchor }, onLimit: "ask" }, [], now, usdToMicros(55.2));
    expect(s).toMatchObject({ usedMicros: usdToMicros(55.2), state: "warning" });
  });
});
