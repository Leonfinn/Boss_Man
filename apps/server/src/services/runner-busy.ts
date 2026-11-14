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

/** Check jobs the server has handed to a runner and not seen end, per company. */
export async function checkJobsByCompany(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ companyId: checkJobs.companyId, n: sql<number>`count(*)::int` })
    .from(checkJobs)
    .where(eq(checkJobs.state, "running"))
    .groupBy(checkJobs.companyId);
  return new Map(rows.map((r) => [r.companyId, r.n]));
}

export type RunnerBusy = { runs: Map<string, number>; checks: Map<string, number>; byCompany: Map<string, number>; runsTotal: number; checksTotal: number };

/** Agent work runs and running check jobs, per company and in total. */
export async function runnerBusy(db: Db): Promise<RunnerBusy> {
  const [r, c] = await Promise.all([runsByCompany(db, true), checkJobsByCompany(db)]);
  const byCompany = new Map(r);
  for (const [id, n] of c) byCompany.set(id, (byCompany.get(id) ?? 0) + n);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return { runs: r, checks: c, byCompany, runsTotal: sum(r), checksTotal: sum(c) };
}
