// What keeps a runner busy (BOS-1471): agent work runs plus running check jobs. One function for both readers: the
// runner drain (maintenance.ts: a swap waits for a company that is busy) and the quiet-host wait of a server update
// (deploy-wait.ts, BOS-420). A swap that only looked at agent runs killed merge checks that were still going.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkJobs, runs } from "../db/schema.js";

/**
 * Live agent runs per company. `workOnly` leaves out the owner's chat and the CEO's reply lane (BOS-349):
 * those never hold a runner swap, and they are what the banner's "N agents" counts.
 */
export async function runsByCompany(db: Db, workOnly = false): Promise<Map<string, number>> {
  const live = isNull(runs.endedAt);
  const rows = await db
    .select({ companyId: runs.companyId, n: sql<number>`count(*)::int` })
    .from(runs)
    .where(workOnly ? and(live, sql`${runs.purpose} is distinct from 'chat'`, sql`${runs.purpose} is distinct from 'reply'`) : live)
    .groupBy(runs.companyId);
  return new Map(rows.map((r) => [r.companyId, r.n]));
}

/**
 * BOS-1877: live owner-chat and CEO-reply runs per company that started at or after `since` (the hold's start). They
 * are short and never held the banner's counts, but the swap waits for one that started during the drain (chat is let
 * through while checks run), so it is never killed. A chat already going when the hold began keeps BOS-349's rule.
 */
export async function chatRunsByCompany(db: Db, since: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({ companyId: runs.companyId, n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(isNull(runs.endedAt), sql`(${runs.purpose} = 'chat' or ${runs.purpose} = 'reply')`, sql`${runs.startedAt} >= ${since}`))
    .groupBy(runs.companyId);
  return new Map(rows.map((r) => [r.companyId, r.n]));
}

/**
 * Check jobs the server has handed to a machine and not seen end, per company. `onRunnerOnly` leaves out jobs on a
 * separate check worker (BOS-1435): swapping a runner does not touch that container, so those never hold a swap.
 */
export async function checkJobsByCompany(db: Db, onRunnerOnly = false): Promise<Map<string, number>> {
  const rows = await db
    .select({ companyId: checkJobs.companyId, n: sql<number>`count(*)::int` })
    .from(checkJobs)
    .where(onRunnerOnly ? and(eq(checkJobs.state, "running"), isNull(checkJobs.workerId)) : eq(checkJobs.state, "running"))
    .groupBy(checkJobs.companyId);
  return new Map(rows.map((r) => [r.companyId, r.n]));
}

export type RunnerBusy = { runs: Map<string, number>; checks: Map<string, number>; byCompany: Map<string, number>; runsTotal: number; checksTotal: number };

/**
 * Agent work runs and running check jobs, per company and in total. `onRunnerOnly` counts only checks on a runner
 * (what the runner swap waits on); the default counts every running check (the server update's quiet-host wait).
 */
export async function runnerBusy(db: Db, onRunnerOnly = false): Promise<RunnerBusy> {
  const [r, c] = await Promise.all([runsByCompany(db, true), checkJobsByCompany(db, onRunnerOnly)]);
  const byCompany = new Map(r);
  for (const [id, n] of c) byCompany.set(id, (byCompany.get(id) ?? 0) + n);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return { runs: r, checks: c, byCompany, runsTotal: sum(r), checksTotal: sum(c) };
}

export type RunnerCheck = { companyId: string; ticket: string | null; kind: string; scope: string; startedAt: string | null; runningForMinutes: number; usuallyMinutes: number | null };

/**
 * The checks a runner swap waits on, for the banner (BOS-1600): which ticket, what kind, since when, and how long the
 * same kind and scope usually takes (the mean of the last five that passed; null with none). Only checks on a runner.
 */
export async function runnerChecks(db: Db, at: Date): Promise<RunnerCheck[]> {
  const live = await db
    .select({
      companyId: checkJobs.companyId,
      kind: checkJobs.kind,
      scope: checkJobs.scope,
      startedAt: checkJobs.startedAt,
      ticket: sql<string | null>`(select case when t."number" is null then null else coalesce(nullif(c."ticket_prefix", ''), 'T') || '-' || t."number"::text end from "tickets" t left join "companies" c on c."id" = t."company_id" where t."id" = ${checkJobs.ticketId})`,
    })
    .from(checkJobs)
    .where(and(eq(checkJobs.state, "running"), isNull(checkJobs.workerId)))
    .orderBy(checkJobs.startedAt);
  // lost on restart, harmless because it is a per-call cache local to this function, rebuilt on every call
  const usual = new Map<string, number | null>();
  const out: RunnerCheck[] = [];
  for (const j of live) {
    const key = `${j.kind}/${j.scope}`;
    if (!usual.has(key)) {
      const done = await db
        .select({ secs: sql<number>`extract(epoch from (${checkJobs.endedAt} - ${checkJobs.startedAt}))::float8` })
        .from(checkJobs)
        .where(and(eq(checkJobs.state, "passed"), eq(checkJobs.kind, j.kind), eq(checkJobs.scope, j.scope), sql`${checkJobs.startedAt} is not null`, sql`${checkJobs.endedAt} is not null`))
        .orderBy(sql`${checkJobs.endedAt} desc`)
        .limit(5);
      usual.set(key, done.length ? Math.max(1, Math.round(done.reduce((a, d) => a + d.secs, 0) / done.length / 60)) : null);
    }
    out.push({ companyId: j.companyId, ticket: j.ticket, kind: j.kind, scope: j.scope, startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null, runningForMinutes: j.startedAt ? Math.max(0, Math.round((at.getTime() - new Date(j.startedAt).getTime()) / 60_000)) : 0, usuallyMinutes: usual.get(key) ?? null });
  }
  return out;
}
