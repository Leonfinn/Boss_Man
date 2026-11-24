// The landing turn's timing (BOS-2359). Each landing waits for one GitHub run on its merge copy, about 20 to 25 minutes
// on 23 Nov. With nothing on screen saying that was normal, a turn held for 22 minutes (BOS-2337, 14:50 to 15:12) looked stuck.
// Here: the median of recent GitHub waits (the merge line's ci_wait_ended rows), the estimated land time of the holder and
// of each ticket in line behind it, and the one CEO alert when a turn has been held for more than twice that median.
// The alert closes itself (DR-016, clearWhen landingTurnEnded) once the turn it names has ended.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity, checkJobs } from "../db/schema.js";
import { MERGE_LINE_KIND } from "./merge-line.js";

/** Looked at: passed GitHub waits in the last 14 days, newest 30. */
export const CI_WAIT_WINDOW_MS = 14 * 24 * 3_600_000;
export const CI_WAIT_SAMPLES = 30;
/** Below this many samples there is no usual wait to speak of: no estimate and no alert. */
export const CI_WAIT_MIN_SAMPLES = 3;
/** The alert fires once a turn has been held for more than this many times the usual wait. */
export const TURN_ALERT_FACTOR = 2;

/** Median of a list of numbers (mean of the middle two when even); null for an empty list. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** The usual GitHub wait of a landing: the median of recent passed waits, with how many it rests on; null with too few. */
export async function usualCiWait(db: Db, companyId: string, now: Date): Promise<{ ms: number; samples: number } | null> {
  const rows = await db
    .select({ waited: sql<string>`${activity.detail}->>'waitedMs'` })
    .from(activity)
    .where(
      and(
        eq(activity.companyId, companyId),
        eq(activity.kind, MERGE_LINE_KIND),
        sql`${activity.detail}->>'event' = 'ci_wait_ended'`,
        sql`${activity.detail}->>'outcome' = 'passed'`,
        gte(activity.at, new Date(now.getTime() - CI_WAIT_WINDOW_MS)),
      ),
    )
    .orderBy(desc(activity.at))
    .limit(CI_WAIT_SAMPLES);
  const waits = rows.map((r) => Number(r.waited)).filter((n) => Number.isFinite(n) && n > 0);
  if (waits.length < CI_WAIT_MIN_SAMPLES) return null;
  return { ms: median(waits)!, samples: waits.length };
}

/** The usual length of a passed merge check: the median of recent passed merge jobs' run time; null with too few. */
export async function usualMergeCheck(db: Db, companyId: string, now: Date): Promise<{ ms: number; samples: number } | null> {
  const rows = await db
    .select({ started: checkJobs.startedAt, ended: checkJobs.endedAt })
    .from(checkJobs)
    .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "passed"), gte(checkJobs.endedAt, new Date(now.getTime() - CI_WAIT_WINDOW_MS))))
    .orderBy(desc(checkJobs.endedAt))
    .limit(CI_WAIT_SAMPLES);
  const runs = rows.flatMap((r) => (r.started && r.ended ? [r.ended.getTime() - r.started.getTime()] : [])).filter((n) => n > 0);
  if (runs.length < CI_WAIT_MIN_SAMPLES) return null;
  return { ms: median(runs)!, samples: runs.length };
}

/** A check never counts as finishing sooner than this from now, even when it has run past the usual time. */
const MIN_LEFT_MS = 60_000;

/**
 * BOS-2505: when the last ticket of the merge line is expected to land (epoch ms), the one estimate the banner and the Merge
 * queue page show. Pure, and it does not use landing turns (there are none while the merge train runs, BOS-2360).
 * In the train a ticket's merge check and its GitHub run go side by side from the moment it is seated, and landings follow
 * train order, so a ticket lands when both are done and not before the ticket ahead of it. That makes the last landing the
 * latest of the tickets' ready times, and tickets that finish together land together (counted once).
 *  - running check: ready when the usual check time has passed (at least a minute from now) and its GitHub run (usual wait
 *    from when it began, else from the check's start) is done;
 *  - ticket in its GitHub wait with no check left: one usual wait after the run began;
 *  - queued for a slot or a seat: takes the slot that frees first, then needs the longer of check and GitHub wait.
 * Null without a usual check time and a usual wait (nothing is guessed) or with an empty line.
 */
export function lineClearAt(p: {
  nowMs: number;
  usualCheckMs: number | null;
  usualCiMs: number | null;
  slots: number;
  /** Checks running now; ciSinceMs is when its GitHub run began (null: not known, taken as the check's start). */
  running: Array<{ startedMs: number; ciSinceMs: number | null }>;
  /** Landings whose check has ended and whose GitHub run is still open (they hold no slot): when each run began. */
  ciOnlySinceMs: number[];
  /** Tickets waiting for a check slot or a train seat. */
  queued: number;
}): number | null {
  if (p.usualCheckMs === null || p.usualCiMs === null) return null;
  const check = p.usualCheckMs;
  const ci = p.usualCiMs;
  const soonest = p.nowMs + MIN_LEFT_MS;
  const ends = p.running.map((r) => Math.max(soonest, r.startedMs + check));
  const ready = p.running.map((r, i) => Math.max(ends[i]!, Math.max(soonest, (r.ciSinceMs ?? r.startedMs) + ci)));
  for (const since of p.ciOnlySinceMs) ready.push(Math.max(soonest, since + ci));
  // Queued tickets take the slots as they free; each then needs the longer of its check and its GitHub run.
  const free = [...ends, ...Array<number>(Math.max(0, p.slots - p.running.length)).fill(p.nowMs)].sort((a, b) => a - b);
  for (let i = 0; i < p.queued; i++) {
    const at = free.length ? free.shift()! : p.nowMs;
    ready.push(at + Math.max(check, ci));
    free.push(at + check);
    free.sort((a, b) => a - b);
  }
  return ready.length ? Math.max(...ready) : null;
}

/**
 * The estimated land time of the turn's holder and of each ticket in its line, in line order. The holder lands one usual
 * wait after its GitHub run began (`ciSinceMs`), or after it took the turn when no run is open; never earlier than now.
 * Each ticket behind it needs its own run after the one before lands. Without a usual wait: nothing is guessed.
 */
export function landingEtas(p: { holderSinceMs: number; ciSinceMs: number | null; lineIds: string[]; usualMs: number | null; nowMs: number }): { holder: number | null; line: Map<string, number> } {
  const line = new Map<string, number>(); // lost on restart, harmless because it is built fresh on every call
  if (p.usualMs === null) return { holder: null, line };
  const holder = Math.max(p.nowMs, (p.ciSinceMs ?? p.holderSinceMs) + p.usualMs);
  p.lineIds.forEach((id, i) => line.set(id, holder + (i + 1) * p.usualMs!));
  return { holder, line };
}

/** Whether a turn held since `sinceMs` has passed twice the usual wait (false without a usual wait). */
export function turnOverdue(sinceMs: number, usualMs: number | null, nowMs: number): boolean {
  return usualMs !== null && nowMs - sinceMs > TURN_ALERT_FACTOR * usualMs;
}

export const landingTurnAlertKey = (companyId: string, ticketId: string) => `landing-turn-late:${companyId}:${ticketId}`;

export type HeldTurn = { projectId: string; ticketId: string; ref: string | null; title: string | null; sinceMs: number; waitingFor: string };

/**
 * One pass of the alert: for each held turn of the company that is past twice the usual wait, one CEO alert naming the
 * ticket and what it waits for. One card per ticket's turn (the dedupe key), closed by itself once that ticket's turn ends.
 */
export function landingTurnAlertSweep(deps: {
  companies: () => Promise<string[]>;
  held: (companyId: string) => Promise<HeldTurn[]>;
  usual: (companyId: string) => Promise<{ ms: number; samples: number } | null>;
  alert: (input: Record<string, unknown>) => Promise<unknown>;
  now: () => Date;
}) {
  return {
    run: async (): Promise<{ raised: number }> => {
      const t = deps.now().getTime();
      let raised = 0;
      for (const companyId of await deps.companies()) {
        const turns = await deps.held(companyId);
        if (!turns.length) continue;
        const usual = await deps.usual(companyId);
        for (const h of turns) {
          if (!usual || !turnOverdue(h.sinceMs, usual.ms, t)) continue;
          const heldMin = Math.round((t - h.sinceMs) / 60_000);
          const usualMin = Math.round(usual.ms / 60_000);
          const who = h.ref ?? (h.title ? `"${h.title}"` : "A ticket");
          await deps.alert({
            companyId,
            kind: "landing_turn_late",
            question: `${who} has held the landing turn for ${heldMin} minutes; a landing usually waits about ${usualMin} minutes. It is waiting for ${h.waitingFor}. Look at the Merge queue page and the ticket before anything is retried: a GitHub run can simply be slow. This closes by itself when the turn ends.`,
            from: "ceo",
            why: "a landing turn held far past its usual wait is the CEO's to look at, not the owner's",
            dedupeKey: landingTurnAlertKey(companyId, h.ticketId),
            clearWhen: [{ kind: "landingTurnEnded", companyId, ticketId: h.ticketId }],
            about: [],
            context: { type: "question", landingTurn: { ticketId: h.ticketId, heldMin, usualMin } },
          });
          raised++;
        }
      }
      return { raised };
    },
  };
}
