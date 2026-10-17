import { describe, expect, it } from "vitest";
import { forecastQuota } from "../src/forecast.js";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 17, h, m));
const reset = at(15);

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
    expect(f.runsOutAt!.getTime()).toBeGreaterThan(reset.getTime());
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
