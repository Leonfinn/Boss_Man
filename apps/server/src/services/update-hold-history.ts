// BOS-2408: an append-only record of each update hold, kept after the hold's `settings` row is deleted, so a past wait
// (why it ran long, which swap tries failed, how it ended) can be audited after a server restart. Every write is
// best-effort: a failed audit write is logged and never stalls an update. One leader runs the drain, so a plain
// read-then-write of the row's lists is safe.
import { desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { updateHolds } from "../db/schema.js";

export const EVENTS_CAP = 200;
export const KEEP_ROWS = 200;
export const KEEP_DAYS = 90;
const TEXT_MAX = 300;
export const LOST_TITLE = "Ended without a record of how (the server restarted, or the hold was removed another way)";

type HoldLike = {
  kind?: string;
  reason: string;
  since: string;
  deadline: string;
  minutes: number;
  force?: boolean;
  swapWhenDone?: boolean;
  ignoreChecks?: boolean;
  capNotified?: boolean;
  ceoWokenAt?: string;
  wentAheadAt?: string;
  launcherDownSince?: string;
  wrapSince?: string;
};
export type HoldRecord = typeof updateHolds.$inferSelect;
type Ev = { at: string; text: string };

/** A hold's flags, in the words the owner uses: each is recorded once, the first time a save carries it. */
const FLAG_EVENTS: { flag: (h: HoldLike) => string | undefined; text: string }[] = [
  { flag: (h) => (h.force ? "x" : undefined), text: "Stop-and-update-now chosen: runs still going are stopped" },
  { flag: (h) => (h.swapWhenDone ? "x" : undefined), text: "\"Swap as soon as these finish\" chosen" },
  { flag: (h) => (h.ignoreChecks ? "x" : undefined), text: "\"Stop the checks and update now\" chosen: checks are no longer waited for" },
  { flag: (h) => (h.capNotified ? "x" : undefined), text: "Hard cap passed with work still going: new work is no longer held" },
  { flag: (h) => h.ceoWokenAt, text: "CEO woken: the swap waited past its expected finish" },
  { flag: (h) => h.wentAheadAt, text: "Drain reached its own end and went ahead by itself" },
  { flag: (h) => h.launcherDownSince, text: "The launcher stopped answering" },
  { flag: (h) => h.wrapSince, text: "Wrap-up asked" },
];

export function updateHoldHistory(db: Db, now: () => Date, log?: (m: string) => void) {
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      log?.(`update hold record (${what}) failed: ${(err as Error).message}`);
    }
  };
  const rowOf = async (since: string) => (await db.select().from(updateHolds).where(eq(updateHolds.startedAt, new Date(since))))[0];
  /** Adds events not yet on the row (matched by text, so each is recorded once). */
  const addEvents = async (since: string, texts: string[], at = now()) => {
    const row = await rowOf(since);
    if (!row || row.endedAt) return;
    const have = new Set(row.events.map((e) => e.text));
    const fresh: Ev[] = texts.filter((t) => !have.has(t.slice(0, TEXT_MAX))).map((t) => ({ at: at.toISOString(), text: t.slice(0, TEXT_MAX) }));
    if (!fresh.length) return;
    await db.update(updateHolds).set({ events: [...row.events, ...fresh].slice(-EVENTS_CAP) }).where(eq(updateHolds.id, row.id));
  };
  return {
    /** Called on every save of the hold: creates the row on the first save, refreshes its facts, and notes new flags. */
    upsert: (h: HoldLike) =>
      safe("save", async () => {
        const vals = { startedAt: new Date(h.since), kind: h.kind ?? "update", reason: h.reason, deadline: new Date(h.deadline), minutes: h.minutes };
        await db.insert(updateHolds).values(vals).onConflictDoUpdate({ target: updateHolds.startedAt, set: { kind: vals.kind, reason: vals.reason, deadline: vals.deadline, minutes: vals.minutes } });
        await addEvents(h.since, FLAG_EVENTS.filter((f) => f.flag(h)).map((f) => f.text));
      }),
    /** A notable moment, recorded once per text. */
    event: (since: string, text: string) => safe("event", () => addEvents(since, [text])),
    swapTry: (since: string, t: { slug: string; n: number; outcome: string; error?: string }) =>
      safe("swap try", async () => {
        const row = await rowOf(since);
        if (!row || row.endedAt) return;
        const item = { ...t, at: now().toISOString(), ...(t.error ? { error: t.error.slice(0, TEXT_MAX) } : {}) };
        await db.update(updateHolds).set({ swapTries: [...row.swapTries, item].slice(-EVENTS_CAP) }).where(eq(updateHolds.id, row.id));
      }),
    /** The hold's end: stamped, with the final swapped/failed maps, then old rows pruned. */
    close: (since: string, how: { ok: boolean; title: string; body: string; swapped?: Record<string, string>; failed?: Record<string, string> }) =>
      safe("end", async () => {
        const set = { endedAt: now(), endOk: how.ok, endTitle: how.title, endBody: how.body.slice(0, 1000), finalState: { swapped: how.swapped, failed: how.failed } };
        await db.insert(updateHolds).values({ startedAt: new Date(since), kind: "update", reason: "", ...set }).onConflictDoUpdate({ target: updateHolds.startedAt, set });
        await db.delete(updateHolds).where(lt(updateHolds.startedAt, new Date(now().getTime() - KEEP_DAYS * 86_400_000)));
        await db.delete(updateHolds).where(sql`${updateHolds.id} in (select id from update_holds order by started_at desc offset ${KEEP_ROWS})`);
      }),
    /** With no live hold, a row still open belongs to a hold that went without an end (a restart): close it. */
    closeOrphans: () =>
      safe("orphans", async () => {
        await db.update(updateHolds).set({ endedAt: now(), endOk: false, endTitle: LOST_TITLE }).where(isNull(updateHolds.endedAt));
      }),
    list: (limit = 20): Promise<HoldRecord[]> => db.select().from(updateHolds).orderBy(desc(updateHolds.startedAt)).limit(Math.min(Math.max(limit, 1), 100)),
  };
}
export type UpdateHoldHistory = ReturnType<typeof updateHoldHistory>;
