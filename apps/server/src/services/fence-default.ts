// The agent fence stops being off by unspoken default (DR-049 point 3, BOS-940).
//
// A company's fence mode is either the default (companies.fence_mode_chosen_at is null) or the owner's
// choice (Settings, or the card below). Boss Man only ever acts on a default:
//  - a new company starts at Watch (the column default). If its runner then reports it can't fence,
//    Watch would do nothing, so the mode is set to Off and Settings says why;
//  - a company at an unchosen Off whose runner can fence gets one owner card: switch to Watch, or keep Off.
//    The mode doesn't change until the owner answers (DR-041: no silent migration). Companies made before
//    BOS-940 are all here, unless they had already picked Watch (the migration marks those chosen).
// The sweep runs with the others (about once a minute), so it covers a boot as well as each runner report.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { FENCE_OFF_CONSEQUENCE } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, notifications, runners } from "../db/schema.js";
import { record } from "./activity.js";

export const FENCE_TO_WATCH = "Switch to Watch";
export const FENCE_KEEP_OFF = "Keep Off";

/** One card per company, ever: an answered or withdrawn card keeps its key, so it is never raised again. */
export const fenceCardKey = (companyId: string) => `fence-default:${companyId}`;

const canFence = sql`${runners.sandbox}->>'level' in ('full', 'partial')`;

export async function fenceDefaultSweep(db: Db, now: Date): Promise<{ turnedOff: number; raised: number }> {
  // An unchosen Watch on a host that reported it can't fence: Off, with the reason in Settings. A runner that
  // hasn't reported yet is left alone (the scheduler only fences where the runner says it can).
  const off = await db
    .update(companies)
    .set({ fenceMode: "off" })
    .where(
      and(
        eq(companies.fenceMode, "watch"),
        isNull(companies.fenceModeChosenAt),
        inArray(companies.id, db.select({ id: runners.companyId }).from(runners).where(sql`${runners.sandbox}->>'level' = 'unavailable'`)),
      ),
    )
    .returning({ id: companies.id });
  for (const c of off)
    await record(db, { companyId: c.id, kind: "settings", summary: "Agent fence set to Off: this company's runner can't fence agents, so Watch would do nothing", detail: { fenceMode: "off", reason: "runner_cannot_fence" }, at: now });

  const due = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .innerJoin(runners, eq(runners.companyId, companies.id))
    .where(and(eq(companies.fenceMode, "off"), isNull(companies.fenceModeChosenAt), canFence));
  let raised = 0;
  for (const c of due) {
    const rows = await db
      .insert(decisions)
      .values({
        companyId: c.id,
        kind: "question",
        tier: "owner",
        question:
          `${c.name}'s agent fence is Off, but nobody chose that: Off was Boss Man's old default. ${FENCE_OFF_CONSEQUENCE}` +
          ` This company's runner can fence agents. Switch it to Watch (recommended): agents run inside the fence, every refusal is written to the permission log, and nothing new is asked of you. Or keep it Off.` +
          ` Nothing changes until you answer. You can change it later in Settings → Agent fence.`,
        options: [FENCE_TO_WATCH, FENCE_KEEP_OFF],
        recommendedOption: FENCE_TO_WATCH,
        dedupeKey: fenceCardKey(c.id),
        context: { type: "fence_default" },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id });
    raised += rows.length;
  }
  return { turnedOff: off.length, raised };
}

/** Refuses Watch on a runner that can no longer fence, before the card is closed (the same rule as Settings). */
export async function checkFenceAnswer(db: Db, companyId: string, answer: string): Promise<string | null> {
  if (answer !== FENCE_TO_WATCH) return null;
  const [r] = await db.select({ level: sql<string | null>`${runners.sandbox}->>'level'` }).from(runners).where(eq(runners.companyId, companyId));
  return r?.level === "full" || r?.level === "partial" ? null : "This company's runner can't fence agents right now, so Watch would do nothing. Keep Off for now, or fix the host (Settings → Agent fence → Setting up a host) and answer again.";
}

/** Applies the owner's answer. Either answer is a choice, so the card's company is never asked or changed again. */
export async function applyFenceAnswer(db: Db, companyId: string, answer: string, now: Date) {
  const fenceMode = answer === FENCE_TO_WATCH ? "watch" : "off";
  // Only a mode still unchosen: a choice made in Settings meanwhile stands.
  const [c] = await db.update(companies).set({ fenceMode, fenceModeChosenAt: now }).where(and(eq(companies.id, companyId), isNull(companies.fenceModeChosenAt))).returning({ id: companies.id });
  if (c) await record(db, { companyId, kind: "settings", summary: fenceMode === "watch" ? "Owner switched the agent fence to Watch" : "Owner chose to keep the agent fence Off", detail: { fenceMode, from: "fence card" }, at: now });
}

/**
 * A choice made in Settings answers the question, so its open card goes. The key stays on the row, so the
 * card is never raised again. (decisions.ts imports this file, so the notification is marked read here
 * rather than through its helper.)
 */
export async function closeFenceCard(db: Db, companyId: string, now: Date) {
  const withdrawn = { by: "system", note: "The owner chose the fence mode in Settings.", at: now.toISOString() };
  const rows = await db
    .update(decisions)
    .set({ status: "withdrawn", answeredAt: now, context: sql`${decisions.context} || ${JSON.stringify({ withdrawn })}::jsonb` })
    .where(and(eq(decisions.dedupeKey, fenceCardKey(companyId)), eq(decisions.status, "open")))
    .returning({ id: decisions.id });
  for (const r of rows) await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.decisionId, r.id), isNull(notifications.readAt)));
}
