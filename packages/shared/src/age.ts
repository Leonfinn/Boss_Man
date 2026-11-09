// How long ago something happened, in plain words (BOS-887). One place for every server message and
// agent note that says an age, so the same wait reads the same wherever it appears: minutes under
// two hours, hours under two days, then days, floored, and singular when the count is one. The short
// form ("1 min", "2 h", "3 days") is for notes that want it terse; it keeps the same cut-offs.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** One hour in milliseconds, for a rolling hourly cap (BOS-894). */
export const HOUR_MS = HOUR;

/**
 * The earliest moment inside the last `n` hours before `now`: a cap counts rows with `at > this`
 * (BOS-894). One place for every "since an hour ago" cut-off, so how a cap counts is changed once.
 */
export function sinceHours(now: Date, n = 1): Date {
  return new Date(now.getTime() - n * HOUR);
}

export type AgeWordsOptions = {
  /** "1 min", "2 h", "3 days" instead of "1 minute", "2 hours", "3 days". */
  short?: boolean;
};

function count(ms: number, unit: number) {
  return Math.max(1, Math.floor(ms / unit));
}

/** A duration in plain words: "1 minute", "N minutes", "N hours", "N days". A clock slightly ahead of now reads as a minute. */
export function ageWords(ms: number, opts: AgeWordsOptions = {}): string {
  const short = opts.short === true;
  if (ms >= 2 * DAY) {
    const n = count(ms, DAY);
    return `${n} ${n === 1 ? "day" : "days"}`;
  }
  if (ms >= 2 * HOUR) {
    const n = count(ms, HOUR);
    return short ? `${n} h` : `${n} ${n === 1 ? "hour" : "hours"}`;
  }
  const n = count(ms, MIN);
  if (short) return `${n} min`;
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}
