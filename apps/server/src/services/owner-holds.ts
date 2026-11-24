// DR-076 A (BOS-2554): an owner ask holds what contradicts it. After a server or runner update fails, half-finishes or
// is switched back, the next card for that update is not put on the owner's queue while the failure is diagnosed, so
// the owner never gets "Deploy (recommended)" beside an agent's card asking for the deploy log. Boss Man opens the hold
// itself in self-deploy's finished(); every offer path asks heldFor(). The CEO, or the assignee of the ticket the CEO
// linked to it (link_hold), releases it with one call (the deploy tool's release_hold); if nobody does within the hold time it is released as "unknown": the card then says the cause
// isn't confirmed and recommends Not now, and the CEO is woken.
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ownerHolds, settings, tickets } from "../db/schema.js";
import { atWords } from "./closed-notice.js";

export type HoldSubject = "server_deploy" | "runner_update";
export type HoldOutcome = "retry_safe" | "do_not_retry" | "unknown";
export type OwnerHold = typeof ownerHolds.$inferSelect;

/**
 * The hold time, in minutes, kept in `settings` so it can be changed without a release. Two hours by default
 * (DR-076): the CEO is woken at once, so a diagnosis normally starts within the hour, and a hold nobody picks up
 * delays a good retry by two hours at most.
 */
export const HOLD_MINUTES_KEY = "owner_hold_minutes";
export const HOLD_DEFAULT_MINUTES = 120;

const short = (sha: string) => sha.slice(0, 8);

export async function holdMinutes(db: Db): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, HOLD_MINUTES_KEY));
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 5 && n <= 24 * 60 ? n : HOLD_DEFAULT_MINUTES;
}

/** The subject's current hold (not ended), released or not. */
export async function currentHold(db: Db, subject: HoldSubject): Promise<OwnerHold | null> {
  const [row] = await db.select().from(ownerHolds).where(and(eq(ownerHolds.subject, subject), isNull(ownerHolds.endedAt))).orderBy(desc(ownerHolds.createdAt)).limit(1);
  return row ?? null;
}

/** Opens a hold after a failed update. A newer failure replaces the current hold (one current hold per subject). */
export async function openHold(db: Db, h: { subject: HoldSubject; commit: string; result: string; reason: string; now?: Date }): Promise<OwnerHold> {
  const now = h.now ?? new Date();
  const releaseBy = new Date(now.getTime() + (await holdMinutes(db)) * 60_000);
  return db.transaction(async (tx) => {
    await tx.update(ownerHolds).set({ endedAt: now }).where(and(eq(ownerHolds.subject, h.subject), isNull(ownerHolds.endedAt)));
    const [row] = await tx.insert(ownerHolds).values({ subject: h.subject, commit: h.commit, result: h.result, reason: h.reason.slice(0, 500), createdAt: now, releaseBy }).returning();
    return row!;
  });
}

/** A successful update of this subject ends its hold: the failure is behind us. */
export async function endHold(db: Db, subject: HoldSubject, now = new Date()) {
  await db.update(ownerHolds).set({ endedAt: now }).where(and(eq(ownerHolds.subject, subject), isNull(ownerHolds.endedAt)));
}

/**
 * The hold that stops an offer of `tip` now, or null. Unreleased: everything is held (past `releaseBy` too, until the
 * pass releases it as unknown). Released as do_not_retry: only the failed commit itself stays held; a newer one on
 * main is offered.
 */
export async function heldFor(db: Db, subject: HoldSubject, tip?: string | null): Promise<OwnerHold | null> {
  const h = await currentHold(db, subject);
  if (!h) return null;
  if (!h.releasedAt) return h;
  if (h.outcome === "do_not_retry" && (!tip || tip.toLowerCase() === h.commit.toLowerCase())) return h;
  return null;
}

/** Releases every current hold past its time as `unknown`. Returns the ones released, so the caller wakes the CEO. */
export async function timeOutHolds(db: Db, now = new Date()): Promise<OwnerHold[]> {
  return db
    .update(ownerHolds)
    .set({ releasedAt: now, releasedBy: "timeout", outcome: "unknown" })
    .where(and(isNull(ownerHolds.endedAt), isNull(ownerHolds.releasedAt), lte(ownerHolds.releaseBy, now)))
    .returning();
}

// A hold the timeout released as "unknown" can still be released (or linked) by the agent who found the cause.
const releasable = (h: OwnerHold | null): h is OwnerHold => !!h && (!h.releasedAt || h.outcome === "unknown");

/** The one hold a release or link acts on: `subject`, or the only one held. */
async function pickHold(db: Db, subject?: HoldSubject): Promise<{ ok: true; hold: OwnerHold } | { ok: false; text: string }> {
  const subjects: HoldSubject[] = subject ? [subject] : ["server_deploy", "runner_update"];
  const open = (await Promise.all(subjects.map((s) => currentHold(db, s)))).filter(releasable);
  if (!open.length) {
    const done = subject ? await currentHold(db, subject) : null;
    return { ok: false, text: done ? `That hold was already released by ${done.releasedBy} (${done.outcome}).` : "Nothing is held: no failed update is waiting for a diagnosis." };
  }
  if (open.length > 1) return { ok: false, text: "Both the server and the runner update are held. Name the one you mean: subject server_deploy or runner_update." };
  return { ok: true, hold: open[0]! };
}

/**
 * CEO only (the deploy tool's link_hold): names the ticket diagnosing a hold, so that ticket's assignee may release it.
 * The caller checks the ticket is in Boss Man's own company. Linking again moves it to the new ticket.
 */
export async function linkHold(db: Db, r: { subject?: HoldSubject; ticketId: string }): Promise<{ ok: true; hold: OwnerHold } | { ok: false; text: string }> {
  const p = await pickHold(db, r.subject);
  if (!p.ok) return p;
  const [row] = await db.update(ownerHolds).set({ ticketId: r.ticketId }).where(and(eq(ownerHolds.id, p.hold.id), isNull(ownerHolds.endedAt))).returning();
  return row ? { ok: true, hold: row } : { ok: false, text: "That hold ended a moment ago (a newer update finished). Nothing to link." };
}

/**
 * The one call that releases a hold (the deploy tool's release_hold). `subject` may be left out when only one is held.
 * Only the CEO, or the assignee of the ticket the CEO linked to the hold, may release it (Brains, DR-076 A): the
 * release puts a "go ahead" in the owner's queue under that agent's name, so it must come from whoever owns the
 * diagnosis, not any agent that happens to read the wake.
 */
export async function releaseHold(
  db: Db,
  r: { subject?: HoldSubject; by: string; agentId?: string | null; isCeo: boolean; outcome: "retry_safe" | "do_not_retry"; ownerText: string; now?: Date },
): Promise<{ ok: true; hold: OwnerHold; text: string } | { ok: false; text: string }> {
  const ownerText = r.ownerText.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!ownerText) return { ok: false, text: "Give ownerText: in plain words for the owner, what was wrong and why the next step is safe. It goes on their card." };
  const p = await pickHold(db, r.subject);
  if (!p.ok) return p;
  const h = p.hold;
  if (!r.isCeo) {
    const [t] = h.ticketId ? await db.select({ assignee: tickets.assigneeAgentId }).from(tickets).where(eq(tickets.id, h.ticketId)) : [];
    if (!t || !r.agentId || t.assignee !== r.agentId)
      return {
        ok: false,
        text: h.ticketId
          ? "Only the CEO or the assignee of the ticket diagnosing this failure may release it. Tell them what you found."
          : "Only the CEO may release this hold until it is linked to the ticket diagnosing the failure (the CEO's deploy link_hold). Tell the CEO what you found.",
      };
  }
  // Only a row still unreleased (or released by the timeout) is updated, so two releases at once can't both claim it.
  const [row] = await db
    .update(ownerHolds)
    .set({ releasedAt: r.now ?? new Date(), releasedBy: r.by, outcome: r.outcome, ownerText })
    .where(and(eq(ownerHolds.id, h.id), isNull(ownerHolds.endedAt), or(isNull(ownerHolds.outcome), eq(ownerHolds.outcome, "unknown"))))
    .returning();
  if (!row) return { ok: false, text: "Someone released it a moment ago. Nothing more to do." };
  const what = h.subject === "server_deploy" ? "server update" : "runner update";
  const text =
    r.outcome === "retry_safe"
      ? `Released. Within a minute Boss Man offers the owner the ${what} card with your words on it, and recommends going ahead.`
      : `Released. ${short(h.commit)} is never offered again; the next newer version on main is offered with your words on it, and recommends going ahead.`;
  return { ok: true, hold: row, text };
}

function failedWords(h: OwnerHold) {
  const what = h.subject === "server_deploy" ? `The last server update (to ${short(h.commit)})` : `The last runner update (built from ${short(h.commit)})`;
  const how = h.result === "rolled_back" ? "was switched back" : h.result === "partial" ? "only half finished" : "failed";
  return `${what} ${how} at ${atWords(h.createdAt)}`;
}

/**
 * The paragraph an update card raised under a hold opens with, and whether Not now is recommended. Held (only the
 * owner's own button press raises a card then) and timed out both recommend Not now: no card claims a retry is safe
 * unless an agent said so.
 */
export function holdCardLead(h: OwnerHold, commit: string): { lead: string; notNow: boolean } {
  const failed = failedWords(h);
  // Only the owner's own button press raises a card for the very version an agent said not to retry.
  if (h.outcome === "do_not_retry" && commit.toLowerCase() === h.commit.toLowerCase())
    return { lead: `${failed}, and it should not be tried again. ${h.releasedBy}: ${h.ownerText} Not now is recommended; a newer version is offered once there is one.`, notNow: true };
  if (!h.releasedAt) return { lead: `Held: ${failed[0]!.toLowerCase()}${failed.slice(1)} and is being looked into. Trying again now may fail the same way, so Not now is recommended until we tell you a retry is safe. If a card asks you for the update's log, answer that one first.`, notNow: true };
  if (h.outcome === "unknown") return { lead: `${failed}. Nobody has confirmed the cause yet, so trying again may fail the same way. Not now is recommended; we have been asked to look into it.`, notNow: true };
  if (h.outcome === "do_not_retry") return { lead: `${failed}, and that version won't be offered again. ${h.releasedBy}: ${h.ownerText}`, notNow: false };
  return { lead: `${failed}. ${h.releasedBy} looked into it: ${h.ownerText}`, notNow: false };
}

/** A card's record of the hold it was raised under, so a card whose wording is out of date can be replaced. */
export const holdStamp = (h: OwnerHold | null) => (h ? `${h.id}:${h.releasedAt ? h.outcome : "held"}` : null);
