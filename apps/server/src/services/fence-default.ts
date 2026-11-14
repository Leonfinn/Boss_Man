// The agent fence stops being off by unspoken default (DR-049 point 3, BOS-940), and an agent run never goes
// unfenced unless the owner chose it (BOS-373, DR-047).
//
// A company's fence mode is either the default (companies.fence_mode_chosen_at is null) or the owner's
// choice (Settings, or the cards below). Boss Man never changes a mode on its own:
//  - a new company starts at Watch (the column default);
//  - a company at an unchosen Off whose runner can fence gets one owner card: switch to Watch, or keep Off.
//    The mode doesn't change until the owner answers (DR-041: no silent migration). Companies made before
//    BOS-940 are all here, unless they had already picked Watch (the migration marks those chosen);
//  - a company whose runner can't fence holds its agent work (fenceHold, in the scheduler) unless the owner
//    chose Off, and gets one owner card per episode: run agents without the fence, or keep them stopped. It
//    goes by itself once the runner can fence again or the owner chooses Off in Settings. (Until BOS-373 an
//    unchosen Watch was set to Off here, which let agents run unfenced with nobody choosing it.)
// The sweep runs with the others (about once a minute), so it covers a boot as well as each runner report.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { FENCE_OFF_CONSEQUENCE } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, notifications, runners } from "../db/schema.js";
import { record } from "./activity.js";

export const FENCE_TO_WATCH = "Switch to Watch";
export const FENCE_KEEP_OFF = "Keep Off";
export const FENCE_RUN_UNFENCED = "Run agents without the fence";
export const FENCE_KEEP_STOPPED = "Keep agents stopped";

/** One card per company, ever: an answered or withdrawn card keeps its key, so it is never raised again. */
export const fenceCardKey = (companyId: string) => `fence-default:${companyId}`;
/** One card per episode of a runner that can't fence: the key is let go once the episode ends, so a later one asks again. */
export const fenceUnavailableKey = (companyId: string) => `fence-unavailable:${companyId}`;

/** A wake's waiting status while the fence holds its company's agent work (BOS-373). Not a wake reason. */
export const FENCE_HELD = "held: this runner can't fence agents, and the owner hasn't chosen to run them without the fence";

/**
 * Whether a company's agent runs must wait for the fence (BOS-373, DR-047): its runner's own self-test reported it
 * can't fence, and the owner didn't choose Off. A runner that hasn't reported yet isn't held here: a fenced run it
 * can't fence is refused by the runner itself, and holding unproven runners is DR-049's gate (BOS-938).
 * Board-tools-only runs (owner chat, the PA) are the caller's exception.
 */
export function fenceHold(c: { fenceMode: string; fenceModeChosenAt: Date | null }, level: string | null | undefined): string | null {
  if (c.fenceMode === "off" && c.fenceModeChosenAt) return null;
  return level === "unavailable" ? FENCE_HELD : null;
}

const canFence = sql`${runners.sandbox}->>'level' in ('full', 'partial')`;
const chosenOff = and(eq(companies.fenceMode, "off"), sql`${companies.fenceModeChosenAt} is not null`);

export async function fenceDefaultSweep(db: Db, now: Date): Promise<{ raised: number; heldCards: number; released: number }> {
  // A runner that reported it can't fence, in a company that didn't choose Off: its agent work is held, so the owner
  // gets one card with the two ways out. A runner that hasn't reported yet gets no card (its runs wait, and the board says why).
  const held = await db
    .select({ id: companies.id, name: companies.name, fenceMode: companies.fenceMode })
    .from(companies)
    .innerJoin(runners, eq(runners.companyId, companies.id))
    .where(and(sql`${runners.sandbox}->>'level' = 'unavailable'`, sql`not (${chosenOff})`));
  let heldCards = 0;
  for (const c of held) {
    const rows = await db
      .insert(decisions)
      .values({
        companyId: c.id,
        kind: "question",
        tier: "owner",
        question:
          `${c.name}'s agent work is held: its fence setting is ${c.fenceMode === "off" ? "Off by Boss Man's old default, which nobody chose" : "on"}, but its runner can't fence agents (the host's kernel has no usable Landlock, or the container blocks it). Chat with the CEO still works.` +
          ` Either fix the host (Settings → Permissions → Agent fence → Setting up a host) and restart the runner; work starts again by itself once the runner can fence, and this card goes.` +
          ` Or run agents without the fence. ${FENCE_OFF_CONSEQUENCE} Agent runs can also read each other's memory and start-up keys.`,
        options: [FENCE_KEEP_STOPPED, FENCE_RUN_UNFENCED],
        recommendedOption: FENCE_KEEP_STOPPED,
        dedupeKey: fenceUnavailableKey(c.id),
        context: { type: "fence_unavailable" },
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id });
    heldCards += rows.length;
  }
  // The episode is over once the runner can fence again or the owner chose Off: an open card goes, and the key is let go.
  const over = await db
    .select({ id: companies.id })
    .from(companies)
    .leftJoin(runners, eq(runners.companyId, companies.id))
    .where(and(sql`(${canFence}) or (${chosenOff})`, sql`exists (select 1 from ${decisions} where ${decisions.dedupeKey} = 'fence-unavailable:' || ${companies.id}::text)`));
  let released = 0;
  for (const c of over) released += await closeFenceUnavailableCard(db, c.id, now, "The runner can fence agents again, or the owner chose Off.");

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
          ` Nothing changes until you answer. You can change it later in Settings → Permissions → Agent fence.`,
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
  return { raised, heldCards, released };
}

/**
 * Ends a fence-unavailable episode: withdraws its open card and lets the key go, so a later episode asks again.
 * Returns how many open cards it withdrew.
 */
export async function closeFenceUnavailableCard(db: Db, companyId: string, now: Date, note: string): Promise<number> {
  const key = fenceUnavailableKey(companyId);
  const withdrawn = { by: "system", note, at: now.toISOString() };
  const open = await db
    .update(decisions)
    .set({ status: "withdrawn", answeredAt: now, dedupeKey: null, context: sql`${decisions.context} || ${JSON.stringify({ withdrawn })}::jsonb` })
    .where(and(eq(decisions.dedupeKey, key), eq(decisions.status, "open")))
    .returning({ id: decisions.id });
  for (const r of open) await db.update(notifications).set({ readAt: now }).where(and(eq(notifications.decisionId, r.id), isNull(notifications.readAt)));
  await db.update(decisions).set({ dedupeKey: null }).where(eq(decisions.dedupeKey, key));
  return open.length;
}

/** The owner's answer on a fence-unavailable card: running without the fence is their choice of Off, recorded as such. */
export async function applyFenceUnavailableAnswer(db: Db, companyId: string, answer: string, now: Date) {
  if (answer !== FENCE_RUN_UNFENCED) return;
  await db.update(companies).set({ fenceMode: "off", fenceModeChosenAt: now }).where(eq(companies.id, companyId));
  await record(db, { companyId, kind: "settings", summary: "Owner chose to run agents without the fence: this company's runner can't fence agents", detail: { fenceMode: "off", from: "fence-unavailable card" }, at: now });
  await closeFenceCard(db, companyId, now);
}

/** Refuses Watch on a runner that can no longer fence, before the card is closed (the same rule as Settings). */
export async function checkFenceAnswer(db: Db, companyId: string, answer: string): Promise<string | null> {
  if (answer !== FENCE_TO_WATCH) return null;
  const [r] = await db.select({ level: sql<string | null>`${runners.sandbox}->>'level'` }).from(runners).where(eq(runners.companyId, companyId));
  return r?.level === "full" || r?.level === "partial" ? null : "This company's runner can't fence agents right now, so Watch would do nothing. Keep Off for now, or fix the host (Settings → Permissions → Agent fence → Setting up a host) and answer again.";
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
