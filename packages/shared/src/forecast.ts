// When a subscription window runs out at its own pace (R78, BOS-1012). Claude reports each window's
// use as a fraction (0 to 1) with when it resets; from readings in the current window, the burn rate
// gives a time it would reach 100%. The rate is taken over the whole window so far, or the last
// FORECAST_WINDOW_MS when the window is older than that, whichever is longer: one busy hour must not
// be read as a busy week (BOS-1012 saw 1.5%/h from a two-hour burst against a real 0.31%/h).

export type QuotaReading = {
  utilization: number;
  resetsAt: Date | null;
  observedAt: Date;
};
export type QuotaForecast = {
  utilization: number;
  resetsAt: Date | null;
  /** Fraction of the window used per hour, from readings across the window; null if there aren't enough. */
  perHour: number | null;
  /**
   * The rate `runsOutAt` was computed from. It's a shade below `perHour` once a floor is applied (a
   * near-zero average would otherwise predict a run-out days after the reset), so a label made from
   * it agrees with the date shown.
   */
  runsOutPerHour: number | null;
  /** When it would reach 100% at that rate; null if it isn't rising. */
  runsOutAt: Date | null;
  /** True when that's before the window resets. */
  beforeReset: boolean;
};

/** Readings closer together than this, or fewer than two, give no rate. */
const MIN_SPAN_MS = 5 * 60_000;
/** The window a forecast looks back over, at least: a day of readings, not the last couple of hours. */
export const FORECAST_WINDOW_MS = 24 * 3_600_000;

/** Readings from the window that's running now (same reset time), oldest first. */
export function currentWindowReadings(
  readings: QuotaReading[],
  latest: QuotaReading,
): QuotaReading[] {
  const reset = latest.resetsAt?.getTime() ?? 0;
  return readings
    .filter((r) => (r.resetsAt?.getTime() ?? 0) === reset)
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

export function forecastQuota(
  readings: QuotaReading[],
  now: Date,
): QuotaForecast | null {
  if (!readings.length) return null;
  const sorted = [...readings].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );
  const latest = sorted.at(-1)!;
  const same = currentWindowReadings(sorted, latest);
  const base = { utilization: latest.utilization, resetsAt: latest.resetsAt };
  if (latest.resetsAt && latest.resetsAt.getTime() <= now.getTime())
    return {
      ...base,
      utilization: 0,
      perHour: null,
      runsOutPerHour: null,
      runsOutAt: null,
      beforeReset: false,
    };
  // The span to average over: the whole window so far, or the last day of it, whichever is longer.
  // `latest` is a reading, so the day runs back from when it was taken, not from now.
  const oldest = latest.observedAt.getTime() - FORECAST_WINDOW_MS;
  const since = latest.resetsAt
    ? Math.min(latest.resetsAt.getTime(), oldest)
    : oldest;
  const first = same.find((r) => r.observedAt.getTime() >= since) ?? same.at(-1)!;
  const span = latest.observedAt.getTime() - first.observedAt.getTime();
  const noRate = { ...base, perHour: null, runsOutPerHour: null, runsOutAt: null, beforeReset: false };
  if (same.length < 2 || span < MIN_SPAN_MS) return noRate;
  const perHour = ((latest.utilization - first.utilization) / span) * 3_600_000;
  if (perHour <= 0)
    return {
      ...noRate,
      perHour: Math.max(0, perHour),
    };
  if (latest.utilization >= 1)
    return {
      ...base,
      perHour,
      runsOutPerHour: perHour,
      runsOutAt: latest.observedAt,
      beforeReset: true,
    };
  // A near-flat average would put the run-out days past the reset, where the exact figure doesn't
  // matter but the date would look wrong; never let it fall later than the reset itself.
  const floor = latest.resetsAt
    ? (1 - latest.utilization) / ((latest.resetsAt.getTime() - latest.observedAt.getTime()) / 3_600_000)
    : 0;
  const runsOutPerHour = Math.max(perHour, floor);
  const runsOutAt = new Date(
    latest.observedAt.getTime() + ((1 - latest.utilization) / runsOutPerHour) * 3_600_000,
  );
  return {
    ...base,
    perHour,
    runsOutPerHour,
    runsOutAt,
    beforeReset:
      !latest.resetsAt || runsOutAt.getTime() < latest.resetsAt.getTime(),
  };
}
