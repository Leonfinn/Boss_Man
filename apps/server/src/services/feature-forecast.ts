// A feature's points done and left, its unsized open tasks and an expected finish at the company's
// last 4 weeks' pace (BOS-2396). Reuses the milestone forecast and pace from planning.ts.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tickets } from "../db/schema.js";
import { forecastMilestone, paceByCompany, type MilestoneForecast } from "./planning.js";

export type FeatureForecast = Omit<MilestoneForecast, "daysLate">;

/** Forecast for each of the given features of one company (cancelled tasks excluded). */
export async function featureForecasts(db: Db, companyId: string, featureIds: string[], today: string): Promise<Map<string, FeatureForecast>> {
  // lost on restart, harmless because it is built per call from the database and returned, never kept
  const out = new Map<string, FeatureForecast>();
  if (!featureIds.length) return out;
  const rows = await db
    .select({ featureId: tickets.featureId, size: tickets.size, done: sql<boolean>`${tickets.systemState} = 'done'` })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), inArray(tickets.featureId, featureIds), sql`${tickets.outcome} is distinct from 'cancelled'`));
  const pace = (await paceByCompany(db, today)).get(companyId) ?? 0;
  // lost on restart, harmless because it is a per-call local grouping of the rows just read
  const of = new Map<string, Array<{ size: number | null; done: boolean }>>();
  for (const r of rows) of.set(r.featureId!, [...(of.get(r.featureId!) ?? []), { size: r.size, done: r.done }]);
  for (const id of featureIds) {
    const { daysLate: _daysLate, ...f } = forecastMilestone(of.get(id) ?? [], pace, null, today);
    out.set(id, f);
  }
  return out;
}
