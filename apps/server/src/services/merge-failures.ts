// Failed merge attempts (BOS-1461): recorded as `attempt_failed` rows on the merge line's timeline (merge-line.ts),
// counted by reason for server_status, and one CEO alert when the same reason repeats. The alert closes itself
// (DR-016) once no failure of that reason has been seen for the window (clearWhen mergeFailuresCalm).
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity } from "../db/schema.js";
import { FAIL_REASONS, FAIL_REASON_TEXT, MERGE_LINE_KIND, lineEvent, type FailReason } from "./merge-line.js";

export const FAILURE_WINDOW_MS = 30 * 60_000;
export const FAILURE_REPEAT = 3;
export const STATUS_WINDOW_MS = 60 * 60_000;

/** Counts of failed attempts per reason since `since` (reasons with none are left out). */
export async function failuresByReason(db: Db, companyId: string, since: Date): Promise<Partial<Record<FailReason, number>>> {
  const rows = await db
    .select({ reason: sql<string>`${activity.detail}->>'reason'`, n: sql<number>`count(*)::int` })
    .from(activity)
    .where(and(eq(activity.companyId, companyId), eq(activity.kind, MERGE_LINE_KIND), sql`${activity.detail}->>'event' = 'attempt_failed'`, gte(activity.at, since)))
    .groupBy(sql`${activity.detail}->>'reason'`);
  const out: Partial<Record<FailReason, number>> = {};
  for (const r of rows) if ((FAIL_REASONS as readonly string[]).includes(r.reason)) out[r.reason as FailReason] = Number(r.n);
  return out;
}

/** For server_status: failed attempts in the last hour, grouped by reason. */
export async function failuresForStatus(db: Db, companyId: string, now = new Date()) {
  const by = await failuresByReason(db, companyId, new Date(now.getTime() - STATUS_WINDOW_MS));
  return { lastHour: Object.values(by).reduce((a, n) => a + (n ?? 0), 0), byReason: by };
}

export type MergeFailureDeps = {
  /** Raises the CEO alert through the ladder (alerts.raise). Absent: failures are recorded but never alerted. */
  alert?: (input: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
};

/** Records one failed attempt and, when its reason has now happened 3 times in 30 minutes, raises one CEO alert. Never throws. */
export async function recordFailedAttempt(db: Db, deps: MergeFailureDeps, t: { id: string; companyId: string }, reason: FailReason, jobId?: string, note?: string): Promise<void> {
  try {
    const at = deps.now?.() ?? new Date();
    await lineEvent(db, t, { event: "attempt_failed", reason, ...(jobId ? { jobId } : {}), ...(note ? { note: note.slice(0, 200) } : {}) }, at);
    if (!deps.alert) return;
    const n = (await failuresByReason(db, t.companyId, new Date(at.getTime() - FAILURE_WINDOW_MS)))[reason] ?? 0;
    if (n < FAILURE_REPEAT) return;
    // One card per company and reason: the dedupe key folds later failures into it while it is open.
    await deps.alert({
      companyId: t.companyId,
      kind: "merge_failures",
      question: `Merges keep failing for the same reason: ${FAIL_REASON_TEXT[reason]} (${n} failed attempts in the last 30 minutes). Look at the merge line (server_status, mergeFailures) and the tickets it names. This closes by itself once 30 minutes pass with no more of these.`,
      from: "ceo",
      why: "repeated failed merges are the CEO's to chase",
      dedupeKey: `merge-failures:${t.companyId}:${reason}`,
      clearWhen: [{ kind: "mergeFailuresCalm", companyId: t.companyId, reason }],
      context: { type: "question", mergeFailures: { reason, count: n } },
    });
  } catch (err) {
    // Recording must never stop the merge line; say so in the server log so a broken alert doesn't vanish silently.
    console.warn(`merge failure record failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Whether a failed attempt of this reason happened in the company since `since`. */
export async function failedSince(db: Db, companyId: string, reason: string, since: Date): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(activity)
    .where(and(eq(activity.companyId, companyId), eq(activity.kind, MERGE_LINE_KIND), gte(activity.at, since), sql`${activity.detail}->>'event' = 'attempt_failed'`, sql`${activity.detail}->>'reason' = ${reason}`));
  return Number(r?.n ?? 0) > 0;
}
