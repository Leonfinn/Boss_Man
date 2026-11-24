// BOS-2459: how often a runner's connection dropped. One row per time its socket was up, kept 30 days; Settings → Runner
// reads the last 7 days from it. Rows are in the database, so a server restart keeps them (it closes the ones left open).
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runnerConnections } from "../db/schema.js";

export const CONNECTION_DAYS = 7;
export const KEEP_DAYS = 30;
/** A gap shorter than this is counted but not listed. */
export const SHORT_GAP_MS = 30_000;
export const LISTED_GAPS = 10;
const DAY_MS = 24 * 3_600_000;

export type EndedHow = "dropped" | "stopped" | "server restart";
export type ConnectionGap = { from: string; to: string | null; ms: number; how: EndedHow | null };
export type ConnectionSummary = {
  /** Start of the period measured: 7 days ago, or the first connection recorded if later. */
  since: string | null;
  percentConnected: number | null;
  drops: number;
  longestGapMs: number;
  /** The last gaps of 30 seconds or more, newest first; the open one (to: null) is the runner being away now. */
  gaps: ConnectionGap[];
  shortGaps: number;
};

/** Writes a row as the runner's socket comes up. A row still open for it (a socket that never closed) is ended first. Returns the new row's id. */
export async function openConnection(db: Db, runnerId: string, at: Date = new Date()): Promise<string> {
  await db.update(runnerConnections).set({ droppedAt: at, endedHow: "dropped" }).where(and(eq(runnerConnections.runnerId, runnerId), isNull(runnerConnections.droppedAt)));
  const [row] = await db.insert(runnerConnections).values({ runnerId, connectedAt: at }).returning({ id: runnerConnections.id });
  return row!.id;
}

/** Ends one connection row as the socket goes (a row already ended is left alone). */
export async function closeConnection(db: Db, id: string, at: Date = new Date(), how: EndedHow = "dropped") {
  await db.update(runnerConnections).set({ droppedAt: at, endedHow: how }).where(and(eq(runnerConnections.id, id), isNull(runnerConnections.droppedAt)));
}

/** The owner stopped the runner: the connection that ended since `since` (or is still open) was not a drop. */
export async function markStopped(db: Db, runnerId: string, since: Date) {
  await db
    .update(runnerConnections)
    .set({ endedHow: "stopped", droppedAt: sql`coalesce(${runnerConnections.droppedAt}, now())` })
    .where(and(eq(runnerConnections.runnerId, runnerId), or(isNull(runnerConnections.droppedAt), gte(runnerConnections.droppedAt, since))));
}

/** At server start: rows left open from before `startedAt` ended with the old process. */
export async function closeOpenOnStart(db: Db, startedAt: Date) {
  await db.update(runnerConnections).set({ droppedAt: startedAt, endedHow: "server restart" }).where(and(isNull(runnerConnections.droppedAt), lt(runnerConnections.connectedAt, startedAt)));
}

export async function pruneConnections(db: Db, now: Date = new Date()) {
  await db.delete(runnerConnections).where(lt(runnerConnections.connectedAt, new Date(now.getTime() - KEEP_DAYS * DAY_MS)));
}

/** The last 7 days of one runner's connection history. */
export async function connectionSummary(db: Db, runnerId: string, now: Date = new Date()): Promise<ConnectionSummary> {
  const windowStart = new Date(now.getTime() - CONNECTION_DAYS * DAY_MS);
  const rows = await db
    .select()
    .from(runnerConnections)
    .where(and(eq(runnerConnections.runnerId, runnerId), or(isNull(runnerConnections.droppedAt), gte(runnerConnections.droppedAt, windowStart))))
    .orderBy(asc(runnerConnections.connectedAt));
  if (!rows.length) return { since: null, percentConnected: null, drops: 0, longestGapMs: 0, gaps: [], shortGaps: 0 };

  const start = Math.max(windowStart.getTime(), rows[0]!.connectedAt.getTime());
  let connectedMs = 0;
  for (const r of rows) {
    const from = Math.max(start, r.connectedAt.getTime());
    const to = Math.min(now.getTime(), (r.droppedAt ?? now).getTime());
    if (to > from) connectedMs += to - from;
  }
  const gaps: ConnectionGap[] = [];
  rows.forEach((r, i) => {
    if (!r.droppedAt || r.droppedAt.getTime() < start) return;
    const next = rows[i + 1];
    const to = next ? next.connectedAt : null;
    gaps.push({ from: r.droppedAt.toISOString(), to: to?.toISOString() ?? null, ms: Math.max(0, (to ?? now).getTime() - r.droppedAt.getTime()), how: (r.endedHow as EndedHow | null) ?? "dropped" });
  });
  const counted = gaps.filter((g) => g.how !== "stopped");
  const span = now.getTime() - start;
  return {
    since: new Date(start).toISOString(),
    percentConnected: span > 0 ? Math.min(100, Math.round((connectedMs / span) * 1000) / 10) : 100,
    drops: counted.filter((g) => g.how === "dropped").length,
    longestGapMs: counted.reduce((m, g) => Math.max(m, g.ms), 0),
    gaps: gaps.filter((g) => g.ms >= SHORT_GAP_MS).reverse().slice(0, LISTED_GAPS),
    shortGaps: gaps.filter((g) => g.ms < SHORT_GAP_MS).length,
  };
}
