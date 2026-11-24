// BOS-2436: the check line itself over the last 7 days, all machines together, from check_jobs: checks per day by kind,
// how long they waited from queued to started, how long they ran, the busiest hours, and what is waiting right now.
// Kinds as the owner knows them: a merge job is "merge"; an author's or reviewer's job is "quick" or "full" by its scope.
// Cancelled checks are counted apart and left out of every other figure (they never ran, or were stopped part-way);
// a check still waiting counts in "waiting now" and in its day, never in the medians (it has no wait yet).
import { and, gte, or, sql } from "drizzle-orm";
import { dateIn, formatDate } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs } from "../db/schema.js";
import { validZone } from "./spend-report.js";

export const LINE_DAYS = 7;
export const LINE_KINDS = ["quick", "full", "merge"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export type LineKindStats = {
  kind: LineKind;
  /** Checks queued in the 7 days, cancelled ones not counted. */
  total: number;
  cancelled: number;
  medianWaitSeconds: number | null;
  longestWaitSeconds: number | null;
  medianRunSeconds: number | null;
};
export type CheckLineStats = {
  /** Oldest first, the owner's local days ending today. */
  days: { date: string; quick: number; full: number; merge: number }[];
  kinds: LineKindStats[];
  /** Up to 3 local hours (0-23) with the most checks queued, busiest first; hours with none are left out. */
  busiestHours: { hour: number; checks: number }[];
  waitingNow: number;
  oldestWaitSeconds: number | null;
  timeZone: string;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const secs = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
export const lineKindOf = (kind: string, scope: string): LineKind => (kind === "merge" ? "merge" : scope === "full" ? "full" : "quick");

export async function checkLineStats(db: Db, opts: { now?: Date; companyId?: string; timeZone?: string } = {}): Promise<CheckLineStats> {
  const now = opts.now ?? new Date();
  const timeZone = validZone(opts.timeZone);
  const since = new Date(now.getTime() - LINE_DAYS * 86_400_000);
  // Grouping by the owner's local day and hour is done here, not in SQL (the zone can't be done in one cheap query, BOS-643).
  const rows = await db
    .select({ kind: checkJobs.kind, scope: checkJobs.scope, state: checkJobs.state, queuedAt: checkJobs.queuedAt, startedAt: checkJobs.startedAt, endedAt: checkJobs.endedAt })
    .from(checkJobs)
    .where(and(opts.companyId ? sql`${checkJobs.companyId} = ${opts.companyId}` : undefined, or(gte(checkJobs.queuedAt, since), sql`${checkJobs.state} = 'queued'`)));

  const [y, m, d] = dateIn(now, timeZone).split("-").map(Number) as [number, number, number];
  const dates = Array.from({ length: LINE_DAYS }, (_, i) => new Date(Date.UTC(y, m - 1, d - (LINE_DAYS - 1 - i))).toISOString().slice(0, 10));
  // per-call locals, rebuilt from the database on every request
  const days = new Map(dates.map((date) => [date, { date, quick: 0, full: 0, merge: 0 }]));
  const hours = Array.from({ length: 24 }, () => 0);
  const per = new Map(LINE_KINDS.map((k) => [k, { total: 0, cancelled: 0, waits: [] as number[], runs: [] as number[] }]));
  let waitingNow = 0;
  let oldest: Date | null = null;

  for (const r of rows) {
    if (r.state === "queued") {
      waitingNow++;
      if (!oldest || r.queuedAt < oldest) oldest = r.queuedAt;
    }
    if (r.queuedAt < since) continue; // an old job still waiting counts only in "waiting now"
    const kind = lineKindOf(r.kind, r.scope);
    const k = per.get(kind)!;
    if (r.state === "cancelled") {
      k.cancelled++;
      continue;
    }
    k.total++;
    const day = days.get(dateIn(r.queuedAt, timeZone));
    if (day) day[kind]++;
    hours[Number(formatDate("en-GB", r.queuedAt, { hour: "2-digit", hourCycle: "h23", timeZone })) % 24]!++;
    if (r.startedAt) k.waits.push(secs(r.queuedAt, r.startedAt));
    if (r.startedAt && r.endedAt) k.runs.push(secs(r.startedAt, r.endedAt));
  }

  return {
    days: [...days.values()],
    kinds: LINE_KINDS.map((kind) => {
      const k = per.get(kind)!;
      return { kind, total: k.total, cancelled: k.cancelled, medianWaitSeconds: median(k.waits), longestWaitSeconds: k.waits.length ? Math.max(...k.waits) : null, medianRunSeconds: median(k.runs) };
    }),
    busiestHours: hours
      .map((checks, hour) => ({ hour, checks }))
      .filter((h) => h.checks > 0)
      .sort((a, b) => b.checks - a.checks || a.hour - b.hour)
      .slice(0, 3),
    waitingNow,
    oldestWaitSeconds: oldest ? secs(oldest, now) : null,
    timeZone,
  };
}
