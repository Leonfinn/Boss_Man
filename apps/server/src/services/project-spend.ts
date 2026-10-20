import { and, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { costEvents, fundingSources, runs, tickets } from "../db/schema.js";

/** The UTC calendar month containing `t`: the period "this month" and the monthly project cap use. */
export const monthStartUtc = (t: Date) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));

/** Money a project has cost (subscription use excluded, as on the dashboard), optionally since a date. Engagement charge-back counts for the charged project. */
export async function projectSpendMicros(db: Db, projectId: string, since?: Date): Promise<number> {
  const mine = and(sql`coalesce(${costEvents.chargedProjectId}, ${costEvents.projectId}, ${tickets.projectId}) = ${projectId}`, ne(fundingSources.kind, "subscription"));
  const [r] = await db
    .select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
    .from(costEvents)
    .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
    .leftJoin(runs, eq(runs.id, costEvents.runId))
    .leftJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(since ? and(mine, gte(costEvents.occurredAt, since)) : mine);
  return Number(r!.micros);
}
