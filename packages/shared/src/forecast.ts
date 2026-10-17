// When a subscription window runs out at the current rate (R78). Claude reports each window's
// use as a fraction (0 to 1) with when it resets; from readings in the current window, the
// burn rate gives a time it would reach 100%. It's an estimate: it assumes use goes on as it
// has over the last couple of hours of readings.

export type QuotaReading = {
  utilization: number;
  resetsAt: Date | null;
  observedAt: Date;
};
export type QuotaForecast = {
  utilization: number;
  resetsAt: Date | null;
  /** Fraction of the window used per hour, from recent readings; null if there aren't enough. */
  perHour: number | null;
  /** When it would reach 100% at that rate; null if it isn't rising. */
  runsOutAt: Date | null;
  /** True when that's before the window resets. */
  beforeReset: boolean;
};

/** Readings closer together than this, or fewer than two, give no rate. */
const MIN_SPAN_MS = 5 * 60_000;
/** Only the most recent readings count, so a quiet morning doesn't hide a busy afternoon. */
const LOOKBACK_MS = 2 * 3_600_000;

export function forecastQuota(
  readings: QuotaReading[],
  now: Date,
): QuotaForecast | null {
  if (!readings.length) return null;
  const sorted = [...readings].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );
  const latest = sorted.at(-1)!;
  // Only readings from the window that's running now (same reset time).
  const same = sorted.filter(
    (r) =>
      (r.resetsAt?.getTime() ?? 0) === (latest.resetsAt?.getTime() ?? 0) &&
      latest.observedAt.getTime() - r.observedAt.getTime() <= LOOKBACK_MS,
  );
  const first = same[0]!;
  const span = latest.observedAt.getTime() - first.observedAt.getTime();
  const base = { utilization: latest.utilization, resetsAt: latest.resetsAt };
  if (latest.resetsAt && latest.resetsAt.getTime() <= now.getTime())
    return {
      ...base,
      utilization: 0,
      perHour: null,
      runsOutAt: null,
      beforeReset: false,
    };
  if (same.length < 2 || span < MIN_SPAN_MS)
    return { ...base, perHour: null, runsOutAt: null, beforeReset: false };
  const perHour = ((latest.utilization - first.utilization) / span) * 3_600_000;
  if (perHour <= 0)
    return {
      ...base,
      perHour: Math.max(0, perHour),
      runsOutAt: null,
      beforeReset: false,
    };
  if (latest.utilization >= 1)
    return {
      ...base,
      perHour,
      runsOutAt: latest.observedAt,
      beforeReset: true,
    };
  const runsOutAt = new Date(
    latest.observedAt.getTime() +
      ((1 - latest.utilization) / perHour) * 3_600_000,
  );
  return {
    ...base,
    perHour,
    runsOutAt,
    beforeReset:
      !latest.resetsAt || runsOutAt.getTime() < latest.resetsAt.getTime(),
  };
}
