import { describe, expect, it } from "vitest";
import { forecastQuota, FORECAST_WINDOW_MS } from "../src/forecast.js";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 17, h, m));
const reset = at(15);
const hours = (n: number, from = at(0)) => new Date(from.getTime() + n * 3_600_000);

describe("quota forecast (R78)", () => {
  it("projects when a window runs out at the recent rate, and whether that's before it resets", () => {
    // 30% to 50% in an hour: 20% an hour, so 50% left lasts 2.5 hours, to 13:30; it resets at 15:00.
    const f = forecastQuota(
      [
        { utilization: 0.3, resetsAt: reset, observedAt: at(10) },
        { utilization: 0.4, resetsAt: reset, observedAt: at(10, 30) },
        { utilization: 0.5, resetsAt: reset, observedAt: at(11) },
      ],
      at(11),
    )!;
    expect(f.perHour).toBeCloseTo(0.2);
    expect(f.runsOutPerHour).toBeCloseTo(0.2);
    expect(f.runsOutAt).toEqual(at(13, 30));
    expect(f.beforeReset).toBe(true);
  });

  it("says it won't run out when the rate wouldn't reach 100% before the reset", () => {
    const f = forecastQuota(
      [
        { utilization: 0.1, resetsAt: reset, observedAt: at(10) },
        { utilization: 0.15, resetsAt: reset, observedAt: at(11) },
      ],
      at(11),
    )!;
    expect(f.beforeReset).toBe(false);
    expect(f.runsOutAt!.getTime()).toBeGreaterThanOrEqual(reset.getTime());
  });

  it("gives no estimate from one reading, readings too close together, a falling or flat rate, or an old window", () => {
    expect(forecastQuota([], at(11))).toBeNull();
    expect(
      forecastQuota(
        [{ utilization: 0.5, resetsAt: reset, observedAt: at(11) }],
        at(11),
      ),
    ).toMatchObject({ perHour: null, runsOutAt: null });
    expect(
      forecastQuota(
        [
          { utilization: 0.4, resetsAt: reset, observedAt: at(11) },
          { utilization: 0.5, resetsAt: reset, observedAt: at(11, 2) },
        ],
        at(11, 2),
      ),
    ).toMatchObject({ perHour: null });
    expect(
      forecastQuota(
        [
          { utilization: 0.5, resetsAt: reset, observedAt: at(10) },
          { utilization: 0.5, resetsAt: reset, observedAt: at(11) },
        ],
        at(11),
      ),
    ).toMatchObject({ perHour: 0, runsOutAt: null });
    // Readings from the previous window don't count towards this one's rate.
    expect(
      forecastQuota(
        [
          { utilization: 0.9, resetsAt: at(10), observedAt: at(9) },
          { utilization: 0.05, resetsAt: reset, observedAt: at(11) },
        ],
        at(11),
      ),
    ).toMatchObject({ perHour: null });
    // Once the reset time has passed, the window is fresh.
    expect(
      forecastQuota(
        [{ utilization: 0.9, resetsAt: at(10), observedAt: at(9) }],
        at(11),
      ),
    ).toMatchObject({ utilization: 0, runsOutAt: null });
  });
});

// BOS-1012: the owner's Funding page said Claude Max 2 runs out on Thu 12 Nov from a two-hour
// burst, when the week's own pace reached Saturday's reset at about half used.
describe("quota forecast over the whole window (BOS-1012)", () => {
  // The week began Sat 7 Nov 22:00 and resets Sat 14 Nov 22:00; now is Mon 9 Nov at 18:30, 44.5 h in.
  const weekStart = new Date(Date.UTC(2026, 10, 7, 22));
  const weekReset = new Date(Date.UTC(2026, 10, 14, 22));
  const now = new Date(weekStart.getTime() + 44.5 * 3_600_000);
  const readings: Array<{ utilization: number; resetsAt: Date; observedAt: Date }> = [];
  for (let h = 0; h <= 44.5; h++) readings.push({ utilization: (0.14 * h) / 44.5, resetsAt: weekReset, observedAt: new Date(weekStart.getTime() + h * 3_600_000) });

  it("says today's week (14% used 44.5 h in) won't run out before Saturday's reset", () => {
    const f = forecastQuota(readings, now)!;
    expect(f.utilization).toBeCloseTo(0.14 * (44 / 44.5), 5);
    expect(f.perHour).toBeCloseTo(0.14 / 44.5, 5);
    expect(f.beforeReset).toBe(false);
    expect(f.runsOutAt!.getTime()).toBeGreaterThanOrEqual(weekReset.getTime());
  });

  it("a short burst doesn't swing the headline: 3% in the last hour after a quiet day", () => {
    // A quiet day at 0.1%/h, then 3% in the last hour. The old two-hour average read ~2%/h.
    const quiet = Array.from({ length: 25 }, (_, i) => ({ utilization: 0.14 - 0.03 + 0.001 * (24 - i), resetsAt: weekReset, observedAt: new Date(now.getTime() - (25 - i) * 3_600_000) }));
    const burst = [...quiet, { utilization: 0.14, resetsAt: weekReset, observedAt: now }];
    const f = forecastQuota(burst, now)!;
    // ~14% over 44.5 h; the burst only nudges it.
    expect(f.perHour).toBeLessThan(0.01);
    expect(f.beforeReset).toBe(false);
  });

  it("doesn't look back further than a day on a long window once the day is quieter than the window", () => {
    // A week-long window reset long ago: an old heavy first day, then a quiet one. Only the quiet day
    // counts, so its 1%/h still lands before the reset.
    const weekAgo = new Date(now.getTime() - 6 * 86_400_000);
    const f = forecastQuota(
      [
        { utilization: 0.1, resetsAt: weekReset, observedAt: weekAgo },
        { utilization: 0.5, resetsAt: weekReset, observedAt: new Date(now.getTime() - 86_400_000) },
        { utilization: 0.74, resetsAt: weekReset, observedAt: now },
      ],
      now,
    )!;
    expect(f.perHour).toBeCloseTo(0.01, 5);
    expect(f.beforeReset).toBe(true);
  });

  it("the rate it reports for the date is the rate the date is made from", () => {
    // A near-flat average would put the date days past the reset; the date stops at the reset and the
    // rate beside it is the one that made it.
    const f = forecastQuota(
      [
        { utilization: 0.1, resetsAt: reset, observedAt: hours(10) },
        { utilization: 0.10001, resetsAt: reset, observedAt: hours(11) },
      ],
      hours(11),
    )!;
    expect(f.perHour).toBeGreaterThan(0);
    expect(f.runsOutPerHour!).toBeGreaterThan(f.perHour!);
    const fromRate = hours(11).getTime() + ((1 - f.utilization) / f.runsOutPerHour!) * 3_600_000;
    expect(f.runsOutAt!.getTime()).toBeCloseTo(fromRate, -3);
    expect(f.runsOutAt).toEqual(reset);
    expect(f.beforeReset).toBe(false);
  });

  it("uses a day of readings on a window that has been running longer", () => {
    expect(FORECAST_WINDOW_MS).toBe(24 * 3_600_000);
  });
});
