// Cost sanity check (BOS-1866). When a run ends, its recorded cost is compared with its own tokens at the
// model's list price (packages/shared/src/list-price.ts). A run far outside the band is marked on the run row
// (`runs.costCheck`), the cost panel warns beside figures that include it, and the CEO (not the owner) gets one
// alert per company that closes by itself (DR-016, clearWhen costBackInBand) once the recent checked runs are in band.
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { checkRunCost, COST_SKIP_TEXT } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { costEvents, runs } from "../db/schema.js";

/** How many of a company's latest checked runs must all be in band for its alert to close. */
export const BACK_IN_BAND_RUNS = 5;

export const costCheckKey = (companyId: string) => `cost-out-of-band:${companyId}`;

type Handle = Pick<Db, "select" | "update">;

/**
 * Checks one ended run and stores the result on it. Returns the alert to raise after the caller's transaction commits
 * (the ladder uses its own connection), or null when the run is in band or was skipped. Never throws: a failed check
 * leaves the run unchecked rather than stopping the run from ending.
 */
export async function checkEndedRun(tx: Handle, runId: string): Promise<{ companyId: string; question: string } | null> {
  try {
    const [run] = await tx
      .select({ companyId: runs.companyId, model: runs.model, input: runs.inputTokens, output: runs.outputTokens, cacheRead: runs.cachedReadTokens, cacheWrite: runs.cachedWriteTokens })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) return null;
    const [spent] = await tx.select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` }).from(costEvents).where(eq(costEvents.runId, runId));
    const result = checkRunCost(run.model, { input: run.input ?? 0, output: run.output ?? 0, cacheRead: run.cacheRead ?? 0, cacheWrite: run.cacheWrite ?? 0 }, Number(spent?.micros ?? 0));
    await tx.update(runs).set({ costCheck: result.status === "skipped" ? `skipped:${result.reason}` : result.status }).where(eq(runs.id, runId));
    if (result.status !== "out_of_band") return null;
    const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
    return {
      companyId: run.companyId,
      question: `A run's recorded cost does not match its tokens at list price: ${usd(result.recordedMicros)} recorded, ${usd(result.expectedLo)} to ${usd(result.expectedHi)} expected (model ${run.model ?? "unknown"}). The cost figures that include it are probably wrong. The cost panel shows a warning beside them. Look at the run's cost events in the runs history, then say what the cost counter did. No action is needed from the owner. This closes by itself once the latest ${BACK_IN_BAND_RUNS} checked runs are in band.`,
    };
  } catch (err) {
    console.warn(`cost check failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Why the company's alert can close, or null while it must stay: the latest checked runs are all in band, the newest after the card was raised. */
export async function backInBandReason(db: Db, companyId: string, cardCreatedAt: Date): Promise<string | null> {
  const latest = await db
    .select({ endedAt: runs.endedAt, costCheck: runs.costCheck })
    .from(runs)
    .where(and(eq(runs.companyId, companyId), inArray(runs.costCheck, ["ok", "out_of_band"])))
    .orderBy(desc(runs.endedAt))
    .limit(BACK_IN_BAND_RUNS);
  if (latest.length < BACK_IN_BAND_RUNS || latest.some((r) => r.costCheck !== "ok")) return null;
  if (!latest[0]?.endedAt || latest[0].endedAt <= cardCreatedAt) return null;
  return `the latest ${BACK_IN_BAND_RUNS} checked runs have costs in line with their tokens`;
}

export type CostCheckSummary = { outOfBand: number; checked: number; skipped: Array<{ model: string; reason: string; runs: number }> };

/** What the cost panel shows for a set of runs: how many are out of band, and which were skipped and why. */
export async function summarizeCostChecks(db: Db, where: ReturnType<typeof and>): Promise<CostCheckSummary> {
  const rows = await db
    .select({ model: runs.model, check: runs.costCheck, n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(where, gt(sql`length(coalesce(${runs.costCheck}, ''))`, 0)))
    .groupBy(runs.model, runs.costCheck);
  const out: CostCheckSummary = { outOfBand: 0, checked: 0, skipped: [] };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.check === "out_of_band") out.outOfBand += n;
    if (r.check === "ok" || r.check === "out_of_band") out.checked += n;
    else if (r.check?.startsWith("skipped:")) out.skipped.push({ model: r.model ?? "unknown model", reason: COST_SKIP_TEXT[r.check.slice(8)] ?? r.check.slice(8), runs: n });
  }
  return out;
}

/** Raises the one CEO alert for a company (raises with the same key fold into the open card; it closes itself, DR-016). */
export async function raiseCostAlert(raise: (input: Record<string, unknown>) => Promise<unknown>, a: { companyId: string; question: string }): Promise<void> {
  try {
    await raise({
      companyId: a.companyId,
      kind: "cost_out_of_band",
      question: a.question,
      from: "ceo",
      why: "a cost figure that disagrees with the run's tokens is the CEO's to chase, not the owner's",
      dedupeKey: costCheckKey(a.companyId),
      clearWhen: [{ kind: "costBackInBand", companyId: a.companyId }],
      context: { type: "question" },
    });
  } catch (err) {
    console.warn(`cost alert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
