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
import { FENCE_OFF_CONSEQUENCE, platformFingerprint, type SandboxReport } from "@boss-man/shared";
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
export function fenceHold(c: { fenceMode: string; fenceModeChosenAt: Date | null; fenceOffFingerprint?: string | null }, level: string | null | undefined, fingerprint: string | null = null): string | null {
  // An Off the owner chose on the fence card is kept with the platform it was chosen on; a different one asks again (DR-049 point 1).
  if (c.fenceMode === "off" && c.fenceModeChosenAt && (c.fenceOffFingerprint == null || c.fenceOffFingerprint === fingerprint)) return null;
  return level === "unavailable" ? FENCE_HELD : null;
}

/** A wake's waiting status while the network guard isn't proven on (DR-049 point 1). */
export const GUARD_HELD = "held: this runner can't keep agents off your home network, and the owner hasn't chosen to run them without the network guard";
/** ... while the runner hasn't sent (or has stopped sending) its safety report, so nothing is proven. */
export const UNPROVEN_HELD = "held: this runner hasn't proven its safety features (fence and network guard) yet";
/** The runner re-reports every 5 minutes; a report older than this is no longer proof. */
export const REPORT_STALE_MS = 15 * 60_000;

export type HoldCompany = {
  fenceMode: string;
  fenceModeChosenAt: Date | null;
  fenceOffFingerprint: string | null;
  guardOffChosenAt: Date | null;
  guardOffFingerprint: string | null;
};

/**
 * The one gate for every agent run (DR-049 point 1, BOS-938; it grew out of BOS-373's fence hold): why a company's agent
 * work must wait, or null. A run starts only when the runner's latest report proves the fence works (partial or full,
 * unless the owner chose Off for this platform) and the network guard is on (unless the owner chose to run without it
 * for this platform). requireProof is off only in tests that don't build a runner report; the server's main.ts turns it on.
 */
export function agentHold(c: HoldCompany, sandbox: SandboxReport | null, checkedAt: Date | null, o: { requireProof: boolean; now: Date }): string | null {
  const fingerprint = platformFingerprint(sandbox?.platform);
  const fence = fenceHold(c, sandbox?.level, fingerprint);
  if (fence) return fence;
  if (!o.requireProof) return null;
  if (!sandbox || !checkedAt || o.now.getTime() - checkedAt.getTime() > REPORT_STALE_MS) return UNPROVEN_HELD;
  if (sandbox.guard?.state === "on") return null;
  return c.guardOffChosenAt && c.guardOffFingerprint === fingerprint ? null : GUARD_HELD;
}

const canFence = sql`${runners.sandbox}->>'level' in ('full', 'partial')`;
/** The runner's platform as one string, the same as platformFingerprint(); null when the runner reported none. */
const runnerFingerprint = sql<string | null>`(${runners.sandbox}->'platform'->>'kernel') || '|docker ' || (${runners.sandbox}->'platform'->>'dockerVersion') || '|' || (${runners.sandbox}->'platform'->>'osType')`;
const chosenOff = and(eq(companies.fenceMode, "off"), sql`${companies.fenceModeChosenAt} is not null`, sql`(${companies.fenceOffFingerprint} is null or ${companies.fenceOffFingerprint} = ${runnerFingerprint})`);

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
  await db.update(companies).set({ fenceMode: "off", fenceModeChosenAt: now, fenceOffFingerprint: await currentFingerprint(db, companyId) }).where(eq(companies.id, companyId));
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

// ---------- The network guard and the owner's choices (DR-049 point 1, BOS-938) ----------

export const GUARD_RUN_WITHOUT = "Run agents without the network guard";
export const GUARD_KEEP_STOPPED = "Keep agents stopped";
/** One card per episode of a runner whose network guard isn't proven on; the key is let go when the episode ends. */
export const guardUnavailableKey = (companyId: string) => `guard-unavailable:${companyId}`;

/** The company's runner's platform fingerprint now, or null (no runner, or one that reports none). */
export async function currentFingerprint(db: Db, companyId: string): Promise<string | null> {
  const [r] = await db.select({ sandbox: runners.sandbox }).from(runners).where(eq(runners.companyId, companyId));
  return platformFingerprint(r?.sandbox?.platform);
}

/** What Settings shows for each safety feature: whether it is proven, and whether the owner chose to run without it here. */
export function featureStates(c: HoldCompany, sandbox: SandboxReport | null) {
  const fingerprint = platformFingerprint(sandbox?.platform);
  const fenceProven = sandbox?.level === "full" || sandbox?.level === "partial";
  const fenceOff = c.fenceMode === "off" && !!c.fenceModeChosenAt && (c.fenceOffFingerprint == null || c.fenceOffFingerprint === fingerprint);
  const guardProven = sandbox?.guard?.state === "on";
  const guardOff = !!c.guardOffChosenAt && c.guardOffFingerprint === fingerprint;
  return {
    fingerprint,
    fence: { proven: fenceProven, runWithout: !fenceProven && fenceOff },
    guard: { proven: guardProven, runWithout: !guardProven && guardOff, reason: sandbox?.guard?.reason ?? null },
  };
}

/** The owner's choice about running without the network guard: it is kept with this runner's platform, so a different host or kernel asks again. */
export async function chooseGuard(db: Db, companyId: string, runWithout: boolean, now: Date) {
  const fingerprint = await currentFingerprint(db, companyId);
  await db.update(companies).set(runWithout ? { guardOffChosenAt: now, guardOffFingerprint: fingerprint } : { guardOffChosenAt: null, guardOffFingerprint: null }).where(eq(companies.id, companyId));
  await record(db, { companyId, kind: "settings", summary: runWithout ? "Owner chose to run agents without the network guard on this runner" : "Owner chose to keep agents stopped until the network guard is proven", detail: { feature: "guard", runWithout }, at: now });
  if (runWithout) await closeGuardCard(db, companyId, now, "The owner chose to run agents without the network guard.");
}

/** Settings' two buttons for the fence. Keeping agents stopped puts the mode back to Watch, which the gate holds while the runner can't fence. */
export async function chooseFence(db: Db, companyId: string, runWithout: boolean, now: Date) {
  if (runWithout) {
    await applyFenceUnavailableAnswer(db, companyId, FENCE_RUN_UNFENCED, now);
    await closeFenceUnavailableCard(db, companyId, now, "The owner chose to run agents without the fence in Settings.");
    return;
  }
  await db.update(companies).set({ fenceMode: "watch", fenceModeChosenAt: now, fenceOffFingerprint: null }).where(eq(companies.id, companyId));
  await record(db, { companyId, kind: "settings", summary: "Owner chose to keep agents stopped until the fence works", detail: { fenceMode: "watch", from: "settings card" }, at: now });
}

export async function applyGuardAnswer(db: Db, companyId: string, answer: string, now: Date) {
  if (answer === GUARD_RUN_WITHOUT) await chooseGuard(db, companyId, true, now);
}

/** Ends a guard episode: withdraws its open card and lets the key go. Returns how many open cards it withdrew. */
export async function closeGuardCard(db: Db, companyId: string, now: Date, note: string): Promise<number> {
  const key = guardUnavailableKey(companyId);
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

/**
 * One owner card per episode of a runner that reported its network guard isn't on, in a company whose owner hasn't
 * chosen to run without it on this platform; the card goes by itself once the guard is proven or the choice is made.
 * (A runner that has reported nothing gets no card: its runs wait and the board says why.)
 */
export async function guardHoldSweep(db: Db, now: Date): Promise<{ raised: number; released: number }> {
  const rows = await db
    .select({ id: companies.id, name: companies.name, guardOffChosenAt: companies.guardOffChosenAt, guardOffFingerprint: companies.guardOffFingerprint, sandbox: runners.sandbox })
    .from(companies)
    .innerJoin(runners, eq(runners.companyId, companies.id));
  let raised = 0;
  let released = 0;
  for (const c of rows) {
    const state = c.sandbox?.guard?.state;
    const fingerprint = platformFingerprint(c.sandbox?.platform);
    const chosen = !!c.guardOffChosenAt && c.guardOffFingerprint === fingerprint;
    if (state === "absent" && !chosen) {
      const r = await db
        .insert(decisions)
        .values({
          companyId: c.id,
          kind: "question",
          tier: "owner",
          question:
            `${c.name}'s agent work is held: its runner can't keep agents off your home network (the network guard isn't on: ${c.sandbox?.guard?.reason ?? "no reason given"}). Chat with the CEO still works.` +
            ` Either fix the host (Settings → Server and runner) and restart the runner; work starts again by itself once the guard is proven, and this card goes.` +
            ` Or run agents without the network guard: they could then reach other devices on your network. The choice is kept for this host and kernel only; a new one asks again.`,
          options: [GUARD_KEEP_STOPPED, GUARD_RUN_WITHOUT],
          recommendedOption: GUARD_KEEP_STOPPED,
          dedupeKey: guardUnavailableKey(c.id),
          context: { type: "guard_unavailable" },
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      raised += r.length;
    } else if (state === "on" || chosen) {
      released += await closeGuardCard(db, c.id, now, "The network guard is proven on, or the owner chose to run without it.");
    }
  }
  return { raised, released };
}
