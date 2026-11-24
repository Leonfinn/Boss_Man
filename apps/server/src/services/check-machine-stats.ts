// BOS-2373: how each machine that runs checks has done over the last 7 days, read from check_jobs. The company runner
// (worker_id null) is one entry, "runner"; each check worker is its own entry keyed by its id.
import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, companies, tickets } from "../db/schema.js";

export const STATS_DAYS = 7;
export const RECENT_CHECKS = 10;

export type MachineCheck = { id: string; ticketId: string; ref: string | null; title: string; kind: string; scope: string; result: string; seconds: number | null; endedAt: string | null };
export type MachineStats = {
  machine: string; // "runner" or a check worker's id
  total: number;
  passed: number;
  failed: number;
  /** stuck or cancelled */
  stuck: number;
  medianSeconds: number | null;
  longestSeconds: number | null;
  recent: MachineCheck[];
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export async function checkMachineStats(db: Db, now = new Date(), companyId?: string): Promise<MachineStats[]> {
  const since = new Date(now.getTime() - STATS_DAYS * 86_400_000);
  const rows = await db
    .select({ job: checkJobs, number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix })
    .from(checkJobs)
    .innerJoin(tickets, sql`${tickets.id} = ${checkJobs.ticketId}`)
    .innerJoin(companies, sql`${companies.id} = ${checkJobs.companyId}`)
    .where(and(companyId ? sql`${checkJobs.companyId} = ${companyId}` : undefined, isNotNull(checkJobs.endedAt), gte(checkJobs.endedAt, since), sql`${checkJobs.state} in ('passed','failed','stuck','cancelled')`, sql`(${checkJobs.workerId} is not null or ${checkJobs.runnerId} is not null)`))
    .orderBy(desc(checkJobs.endedAt));
  // lost on restart, harmless because it is a per-call local, rebuilt from the database on every request
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.job.workerId ?? "runner";
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  return [...by.entries()].map(([machine, rs]) => {
    const secs = rs.flatMap((r) => (r.job.startedAt && r.job.endedAt ? [Math.max(0, Math.round((r.job.endedAt.getTime() - r.job.startedAt.getTime()) / 1000))] : []));
    return {
      machine,
      total: rs.length,
      passed: rs.filter((r) => r.job.state === "passed").length,
      failed: rs.filter((r) => r.job.state === "failed").length,
      stuck: rs.filter((r) => r.job.state === "stuck" || r.job.state === "cancelled").length,
      medianSeconds: median(secs),
      longestSeconds: secs.length ? Math.max(...secs) : null,
      recent: rs.slice(0, RECENT_CHECKS).map((r) => ({
        id: r.job.id,
        ticketId: r.job.ticketId,
        ref: ticketRef(r.prefix, r.number),
        title: r.title,
        kind: r.job.kind,
        scope: r.job.scope,
        result: r.job.state,
        seconds: r.job.startedAt && r.job.endedAt ? Math.max(0, Math.round((r.job.endedAt.getTime() - r.job.startedAt.getTime()) / 1000)) : null,
        endedAt: r.job.endedAt ? r.job.endedAt.toISOString() : null,
      })),
    };
  });
}
