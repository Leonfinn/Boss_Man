// Roadmap burn-up (BOS-2397): per milestone, 8 weekly points of "points done" and "total points"
// as of the end of each week, so the owner can see whether a milestone is closing or its scope keeps growing.
// Same rows as the forecast in planning.ts: sized tickets that sit on the milestone or on one of its features, cancelled left out.
// There is no per-ticket state history, so a finished ticket counts as done from its last state change (the same
// stand-in the weekly pace uses); a ticket that was reopened and finished again counts from the later date.

export const BURNUP_WEEKS = 8;
const dayMs = 86_400_000;

export type BurnupPoint = { weekEnd: string; done: number; total: number };
export type BurnupRow = { size: number | null; createdAt: Date; doneAt: Date | null };

/** Pure: the 8 weekly points, oldest first; the last week ends at the end of `today`. */
export function burnupWeeks(rows: BurnupRow[], today: string): BurnupPoint[] {
  const endOfToday = Date.parse(`${today}T00:00:00Z`) + dayMs;
  const points: BurnupPoint[] = [];
  for (let i = BURNUP_WEEKS - 1; i >= 0; i--) {
    const end = endOfToday - i * 7 * dayMs;
    let done = 0;
    let total = 0;
    for (const r of rows) {
      if (r.size == null || r.createdAt.getTime() >= end) continue;
      total += r.size;
      if (r.doneAt && r.doneAt.getTime() < end) done += r.size;
    }
    points.push({ weekEnd: new Date(end - dayMs).toISOString().slice(0, 10), done, total });
  }
  return points;
}

/**
 * A milestone's own pace, points a week: the points it finished in the last 4 weeks (done now minus done 4 weeks ago) over 4.
 * Read off the burn-up rows, so the chart and the forecast cannot disagree (BOS-2558).
 */
export function paceFromBurnup(b: BurnupPoint[]): number {
  if (b.length < BURNUP_WEEKS) return 0;
  return Math.max(0, b[BURNUP_WEEKS - 1]!.done - b[BURNUP_WEEKS - 5]!.done) / 4;
}
