// Roadmap burn-up (BOS-2397): per milestone, 8 weekly points of "points done" and "total points"
// as of the end of each week, so the owner can see whether a milestone is closing or its scope keeps growing.
// Same rows as the forecast in planning.ts: sized tickets that sit on the milestone or on one of its features, cancelled left out.
// There is no per-ticket state history, so a finished ticket counts as done from its last state change (the same
// stand-in the weekly pace uses); a ticket that was reopened and finished again counts from the later date.
import { and, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { features, tickets } from "../db/schema.js";

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

/** Burn-up per milestone id; every id asked for gets 8 points (all zero when it has no sized work). */
export async function roadmapBurnup(db: Db, milestoneIds: string[], today: string): Promise<Map<string, BurnupPoint[]>> {
  if (!milestoneIds.length) return new Map(milestoneIds.map((id): [string, BurnupPoint[]] => [id, []]));
  const feats = await db.select({ id: features.id, milestoneId: features.milestoneId }).from(features).where(inArray(features.milestoneId, milestoneIds));
  const msOfFeature = new Map(feats.map((f) => [f.id, f.milestoneId!]));
  const rows = await db
    .select({ milestoneId: tickets.milestoneId, featureId: tickets.featureId, size: tickets.size, createdAt: tickets.createdAt, state: tickets.systemState, changedAt: tickets.stateChangedAt })
    .from(tickets)
    .where(and(sql`${tickets.outcome} is distinct from 'cancelled'`, or(inArray(tickets.milestoneId, milestoneIds), feats.length ? inArray(tickets.featureId, feats.map((f) => f.id)) : undefined)));
  const msIdOf = (r: (typeof rows)[number]) => (r.milestoneId && milestoneIds.includes(r.milestoneId) ? r.milestoneId : r.featureId ? msOfFeature.get(r.featureId) : undefined);
  return new Map(
    milestoneIds.map((id): [string, BurnupPoint[]] => [
      id,
      burnupWeeks(
        rows.filter((r) => msIdOf(r) === id).map((r) => ({ size: r.size, createdAt: r.createdAt, doneAt: r.state === "done" ? r.changedAt : null })),
        today,
      ),
    ]),
  );
}
