// Merge history (BOS-2379): every finished merge attempt of the last 14 days, read from the merge line's own timeline
// rows (activity kind "merge_line") and the check jobs they name. Read-only. One row per attempt: it starts at the
// first "attempt" or "check_queued" and ends at "merged" (landed), "attempt_failed" (bounced) or "left" (cancelled).
// An attempt still open is not listed: it is on the Merge line page.
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { firstFailingLine, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, checkJobs, companies, tickets } from "../db/schema.js";
import { MERGE_LINE_KIND } from "./merge-line.js";

export const MERGE_HISTORY_DAYS = 14;

export type MergeResult = "landed" | "bounced" | "cancelled";
export type MergeHistoryRow = {
  ticketId: string;
  ref: string | null;
  title: string;
  result: MergeResult;
  queuedAt: string;
  endedAt: string;
  /** Queued to landed, in ms (landed only). */
  totalMs: number | null;
  /** Wait for a check slot, ms; null when no check started (a reused pass) or unknown. */
  slotWaitMs: number | null;
  checkMs: number | null;
  ranOn: string | null;
  ciWaitMs: number | null;
  /** For a bounce: why (reason word) and the first failing line. */
  bounceReason: string | null;
  firstFailingLine: string | null;
  /** How many times this ticket bounced in the window. */
  bounces: number;
};
export type MergeHistoryDay = { day: string; landed: number; bounced: number; medianMs: number | null };
export type MergeHistory = { days: number; rows: MergeHistoryRow[]; perDay: MergeHistoryDay[] };

export type Ev = { ticketId: string | null; at: Date; detail: Record<string, unknown> | null };
type Episode = {
  ticketId: string;
  queuedAt: Date;
  checkQueuedAt: Date | null;
  startedAt: Date | null;
  checkEndedAt: Date | null;
  ranOn: string | null;
  ciWaitMs: number | null;
};
export type RawAttempt = Episode & { result: MergeResult; endedAt: Date; reason: string | null; note: string | null; jobId: string | null };

const EVENTS = ["attempt", "check_queued", "check_started", "check_ended", "ci_wait_ended", "merged", "attempt_failed", "left"];

/** Pure: turn each ticket's timeline rows (oldest first) into finished attempts. */
export function attemptsOf(events: Ev[]): RawAttempt[] {
  const out: RawAttempt[] = [];
  // not state: a local of one call, gone when the function returns
  const open = new Map<string, Episode>();
  for (const e of events) {
    const id = e.ticketId;
    const d = e.detail ?? {};
    const kind = typeof d.event === "string" ? d.event : "";
    if (!id) continue;
    let cur = open.get(id);
    if (!cur && (kind === "attempt" || kind === "check_queued")) {
      cur = { ticketId: id, queuedAt: e.at, checkQueuedAt: null, startedAt: null, checkEndedAt: null, ranOn: null, ciWaitMs: null };
      open.set(id, cur);
    }
    if (!cur) continue;
    if (kind === "check_queued") cur.checkQueuedAt ??= e.at;
    else if (kind === "check_started") {
      cur.startedAt ??= e.at;
      if (typeof d.ranOn === "string") cur.ranOn = d.ranOn;
    } else if (kind === "check_ended") cur.checkEndedAt = e.at;
    else if (kind === "ci_wait_ended") cur.ciWaitMs = (cur.ciWaitMs ?? 0) + (typeof d.waitedMs === "number" ? d.waitedMs : 0);
    else if (kind === "merged" || kind === "attempt_failed" || kind === "left") {
      const result: MergeResult = kind === "merged" ? "landed" : kind === "attempt_failed" ? "bounced" : "cancelled";
      out.push({
        ...cur,
        result,
        endedAt: e.at,
        reason: kind === "attempt_failed" && typeof d.reason === "string" ? d.reason : null,
        note: kind === "attempt_failed" && typeof d.note === "string" ? d.note : null,
        jobId: kind === "attempt_failed" && typeof d.jobId === "string" ? d.jobId : null,
      });
      open.delete(id);
    }
  }
  return out;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Pure: one line per day (UTC), newest first. */
export function perDay(rows: Array<Pick<MergeHistoryRow, "result" | "endedAt" | "totalMs">>): MergeHistoryDay[] {
  // not state: a local of one call, gone when the function returns
  const by = new Map<string, { landed: number; bounced: number; ms: number[] }>();
  for (const r of rows) {
    if (r.result === "cancelled") continue;
    const day = r.endedAt.slice(0, 10);
    const d = by.get(day) ?? { landed: 0, bounced: 0, ms: [] };
    if (r.result === "landed") {
      d.landed++;
      if (r.totalMs !== null) d.ms.push(r.totalMs);
    } else d.bounced++;
    by.set(day, d);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, d]) => ({ day, landed: d.landed, bounced: d.bounced, medianMs: median(d.ms) }));
}

const diff = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, b.getTime() - a.getTime()) : null);

export async function mergeHistory(db: Db, companyId: string, now = new Date()): Promise<MergeHistory> {
  const since = new Date(now.getTime() - MERGE_HISTORY_DAYS * 86_400_000);
  const evs = await db
    .select({ ticketId: activity.ticketId, at: activity.at, detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.companyId, companyId), eq(activity.kind, MERGE_LINE_KIND), gte(activity.at, since), inArray(sql`${activity.detail}->>'event'`, EVENTS)))
    .orderBy(asc(activity.at));
  const attempts = attemptsOf(evs as Ev[]);
  if (!attempts.length) return { days: MERGE_HISTORY_DAYS, rows: [], perDay: [] };

  const ids = [...new Set(attempts.map((a) => a.ticketId))];
  const info = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title }).from(tickets).where(and(eq(tickets.companyId, companyId), inArray(tickets.id, ids)));
  const infoOf = new Map(info.map((t) => [t.id, t]));
  const prefix = (await db.select({ p: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId)))[0]?.p ?? null;
  const jobIds = [...new Set(attempts.map((a) => a.jobId).filter((j): j is string => !!j))];
  const jobs = jobIds.length ? await db.select({ id: checkJobs.id, logTail: checkJobs.logTail }).from(checkJobs).where(and(eq(checkJobs.companyId, companyId), inArray(checkJobs.id, jobIds))) : [];
  const tailOf = new Map(jobs.map((j) => [j.id, j.logTail]));

  // not state: a local of one call, gone when the function returns
  const bounceCount = new Map<string, number>();
  for (const a of attempts) if (a.result === "bounced") bounceCount.set(a.ticketId, (bounceCount.get(a.ticketId) ?? 0) + 1);

  const rows: MergeHistoryRow[] = attempts
    .filter((a) => infoOf.has(a.ticketId))
    .map((a) => {
      const t = infoOf.get(a.ticketId)!;
      const tail = a.jobId ? tailOf.get(a.jobId) : null;
      return {
        ticketId: a.ticketId,
        ref: ticketRef(prefix, t.number),
        title: t.title,
        result: a.result,
        queuedAt: a.queuedAt.toISOString(),
        endedAt: a.endedAt.toISOString(),
        totalMs: a.result === "landed" ? diff(a.queuedAt, a.endedAt) : null,
        slotWaitMs: diff(a.checkQueuedAt, a.startedAt),
        checkMs: diff(a.startedAt, a.checkEndedAt),
        ranOn: a.ranOn,
        ciWaitMs: a.ciWaitMs,
        bounceReason: a.reason,
        firstFailingLine: a.result === "bounced" ? ((tail ? firstFailingLine(tail) : null) ?? a.note ?? null) : null,
        bounces: bounceCount.get(a.ticketId) ?? 0,
      };
    })
    .sort((x, y) => (x.queuedAt < y.queuedAt ? 1 : -1));
  return { days: MERGE_HISTORY_DAYS, rows, perDay: perDay(rows) };
}
