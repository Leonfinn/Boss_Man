import { and, eq, gte, ne, sql } from "drizzle-orm";
import { dateIn } from "@boss-man/shared";
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

export type PlanUse = { provider: string; monthRuns: number; totalRuns: number; monthMicros: number; totalMicros: number };

/**
 * What a project used on subscription (plan) funding sources: runs, and the list-price estimate of the cost events
 * the agent tool reported for them. A provider with runs but no estimate means its tool reported no price, which the
 * page says rather than showing $0 (BOS-1563). Grouped by the source's provider.
 */
export async function projectPlanUse(db: Db, projectId: string, monthStart: Date): Promise<PlanUse[]> {
  const runRows = await db
    .select({
      provider: fundingSources.provider,
      monthRuns: sql<string>`count(*) filter (where ${runs.startedAt} >= ${monthStart})`,
      totalRuns: sql<string>`count(*)`,
    })
    .from(runs)
    .innerJoin(fundingSources, eq(fundingSources.id, runs.fundingSourceId))
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(and(eq(tickets.projectId, projectId), eq(fundingSources.kind, "subscription")))
    .groupBy(fundingSources.provider);
  const costRows = await db
    .select({
      provider: fundingSources.provider,
      monthMicros: sql<string>`coalesce(sum(${costEvents.costMicros}) filter (where ${costEvents.occurredAt} >= ${monthStart}), 0)`,
      totalMicros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)`,
    })
    .from(costEvents)
    .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
    .leftJoin(runs, eq(runs.id, costEvents.runId))
    .leftJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(and(sql`coalesce(${costEvents.chargedProjectId}, ${costEvents.projectId}, ${tickets.projectId}) = ${projectId}`, eq(fundingSources.kind, "subscription")))
    .groupBy(fundingSources.provider);
  const by: Record<string, PlanUse> = {};
  const row = (p: string) => (by[p] ??= { provider: p, monthRuns: 0, totalRuns: 0, monthMicros: 0, totalMicros: 0 });
  for (const r of runRows) Object.assign(row(r.provider), { monthRuns: Number(r.monthRuns), totalRuns: Number(r.totalRuns) });
  for (const c of costRows) Object.assign(row(c.provider), { monthMicros: Number(c.monthMicros), totalMicros: Number(c.totalMicros) });
  return Object.values(by).sort((a, b) => b.totalRuns - a.totalRuns || a.provider.localeCompare(b.provider));
}

export type ProjectMonth = { month: string; paygMicros: number; planMicros: number; runs: number };

/**
 * The last `count` calendar months (in `timeZone`, oldest first) of a project's spend: pay-as-you-go money, the plan
 * (subscription) list-price estimate, and runs started (BOS-2369). Grouped in code, since the zone can't be done in one cheap query.
 */
export async function projectMonthlyTrend(db: Db, projectId: string, opts: { timeZone: string; now: Date; count?: number }): Promise<ProjectMonth[]> {
  const count = opts.count ?? 6;
  const [y, m] = dateIn(opts.now, opts.timeZone).split("-").map(Number) as [number, number];
  const keys = Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const out = new Map<string, ProjectMonth>(keys.map((k) => [k, { month: k, paygMicros: 0, planMicros: 0, runs: 0 }]));
  const [fy, fm] = keys[0]!.split("-").map(Number) as [number, number];
  // A day or two of slack either side of the zone offset; rows outside the listed months are dropped below.
  const since = new Date(Date.UTC(fy, fm - 1, 1) - 2 * 86_400_000);
  const events = await db
    .select({ at: costEvents.occurredAt, micros: costEvents.costMicros, kind: fundingSources.kind })
    .from(costEvents)
    .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
    .leftJoin(runs, eq(runs.id, costEvents.runId))
    .leftJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(and(sql`coalesce(${costEvents.chargedProjectId}, ${costEvents.projectId}, ${tickets.projectId}) = ${projectId}`, gte(costEvents.occurredAt, since)));
  for (const e of events) {
    const row = out.get(dateIn(e.at, opts.timeZone).slice(0, 7));
    if (!row) continue;
    if (e.kind === "subscription") row.planMicros += Number(e.micros);
    else row.paygMicros += Number(e.micros);
  }
  const runRows = await db
    .select({ at: runs.startedAt })
    .from(runs)
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .where(and(eq(tickets.projectId, projectId), gte(runs.startedAt, since)));
  for (const r of runRows) {
    const row = r.at ? out.get(dateIn(r.at, opts.timeZone).slice(0, 7)) : undefined;
    if (row) row.runs += 1;
  }
  return keys.map((k) => out.get(k)!);
}
