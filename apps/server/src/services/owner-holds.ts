// DR-076 A (BOS-2554): an owner ask holds what contradicts it. After a server or runner update fails, half-finishes or
// is switched back, the next card for that update is not put on the owner's queue while the failure is diagnosed, so
// the owner never gets "Deploy (recommended)" beside an agent's card asking for the deploy log. Boss Man opens the hold
// itself in self-deploy's finished(); every offer path asks heldFor(). The CEO, or the assignee of the ticket the CEO
// linked to it (link_hold), releases it with one call (the deploy tool's release_hold); if nobody does within the hold time it is released as "unknown": the card then says the cause
// isn't confirmed and recommends Not now, and the CEO is woken.
// BOS-2609: "while the failure is diagnosed" is made true. self-deploy opens an urgent diagnosis ticket itself, assigns
// it, links it here and wakes the assignee on a reason no update or wrap-up holds; the words on screen say who is on it
// only once their run has started (pickupWords), and the CEO is woken again after 15 minutes with no run.
import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, ownerHolds, runs, settings, tickets } from "../db/schema.js";
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

/**
 * Opens a hold after a failed update. A newer failure replaces the current hold (one current hold per subject). BOS-2609:
 * the new hold keeps the replaced one's diagnosis ticket while that ticket is still open, so a repeat failure adds to the
 * diagnosis under way instead of opening a second ticket.
 */
export async function openHold(db: Db, h: { subject: HoldSubject; commit: string; result: string; reason: string; now?: Date }): Promise<OwnerHold> {
  const now = h.now ?? new Date();
  const releaseBy = new Date(now.getTime() + (await holdMinutes(db)) * 60_000);
  return db.transaction(async (tx) => {
    const [was] = await tx
      .select({ ticketId: ownerHolds.ticketId })
      .from(ownerHolds)
      .innerJoin(tickets, eq(tickets.id, ownerHolds.ticketId))
      .where(and(eq(ownerHolds.subject, h.subject), isNull(ownerHolds.endedAt), ne(tickets.systemState, "done")));
    await tx.update(ownerHolds).set({ endedAt: now }).where(and(eq(ownerHolds.subject, h.subject), isNull(ownerHolds.endedAt)));
    const [row] = await tx.insert(ownerHolds).values({ subject: h.subject, commit: h.commit, result: h.result, reason: h.reason.slice(0, 500), createdAt: now, releaseBy, ticketId: was?.ticketId ?? null }).returning();
    return row!;
  });
}

/** BOS-2609: the wake about a failed update, for the diagnosis ticket's assignee and the CEO. It passes every update and wrap-up hold (wake-classes.ts). */
export const FAILED_UPDATE_REASON = "failed update";
/** BOS-2609: a hold whose diagnosis has not started this long after the wake wakes the CEO again, once. */
export const PICKUP_CHASE_MS = 15 * 60_000;

/** BOS-2609: records that Boss Man woke someone about this hold (the clock for the CEO's chase starts again). */
export async function markWoken(db: Db, holdId: string, at = new Date()) {
  await db.update(ownerHolds).set({ wokenAt: at, chasedAt: null }).where(eq(ownerHolds.id, holdId));
}

/** BOS-2609: links the hold to a diagnosis ticket Boss Man opened itself; unlike linkHold it never moves an existing link. */
export async function linkNewDiagnosis(db: Db, holdId: string, ticketId: string): Promise<boolean> {
  const [row] = await db.update(ownerHolds).set({ ticketId }).where(and(eq(ownerHolds.id, holdId), isNull(ownerHolds.ticketId), isNull(ownerHolds.endedAt))).returning({ id: ownerHolds.id });
  return !!row;
}

/** Who is diagnosing a hold, read from live state (R59): the linked ticket, its assignee, and their first run on it since the hold began. */
export type Pickup = { ticketId: string | null; ref: string | null; agent: string | null; startedAt: Date | null; wokenAt: Date | null };

export async function pickupOf(db: Db, h: OwnerHold): Promise<Pickup> {
  if (!h.ticketId) return { ticketId: null, ref: null, agent: null, startedAt: null, wokenAt: h.wokenAt };
  const [t] = await db
    .select({ number: tickets.number, prefix: companies.ticketPrefix, agentId: tickets.assigneeAgentId, agent: agents.name })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
    .where(eq(tickets.id, h.ticketId));
  if (!t) return { ticketId: null, ref: null, agent: null, startedAt: null, wokenAt: h.wokenAt };
  // A chat about the ticket is not the diagnosis; a work or reply run by its assignee is.
  const [run] = t.agentId
    ? await db
        .select({ at: runs.startedAt })
        .from(runs)
        .where(and(eq(runs.ticketId, h.ticketId), eq(runs.agentId, t.agentId), gte(runs.startedAt, h.createdAt), sql`${runs.purpose} is distinct from 'chat'`))
        .orderBy(asc(runs.startedAt))
        .limit(1)
    : [];
  return { ticketId: h.ticketId, ref: ticketRef(t.prefix, t.number) ?? h.ticketId.slice(0, 8), agent: t.agent ?? null, startedAt: run?.at ?? null, wokenAt: h.wokenAt };
}

const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

/**
 * BOS-2609: one sentence on who is diagnosing the failure. It never says "being looked into" unless a run has started
 * on the linked ticket; otherwise it names who was woken and when, or that nobody is assigned. `live` is for screens
 * read now (the Updates panel); a card keeps its words once raised, so it gets the form that stays true (ticket and
 * agent, no claim that work is under way).
 */
export function pickupWords(p: Pickup, live = true): string {
  const woken = p.wokenAt ? ` woken at ${hhmm(p.wokenAt)}` : "";
  if (!p.ticketId || !p.agent) return `Not picked up yet: nobody is assigned to diagnose it${p.wokenAt ? `; the CEO was${woken}` : ""}.`;
  if (!live) return `The diagnosis is ${p.ref}, assigned to ${p.agent}.`;
  if (p.startedAt) return `Being looked into by ${p.agent} on ${p.ref} (started ${hhmm(p.startedAt)}).`;
  return `Not picked up yet: ${p.agent}${woken || " assigned"} (${p.ref}).`;
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
  // BOS-2609: a new ticket clears the wake time, so the next self-deploy pass wakes its assignee on the reason no hold stops.
  const moved = p.hold.ticketId !== r.ticketId ? { wokenAt: null, chasedAt: null } : {};
  const [row] = await db.update(ownerHolds).set({ ticketId: r.ticketId, ...moved }).where(and(eq(ownerHolds.id, p.hold.id), isNull(ownerHolds.endedAt))).returning();
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
  // BOS-2616: a runner retry is not promised here. The deploy tool offers it at once and adds what really happened
  // (self-deploy afterHoldRelease): on the owner's queue, waiting for something named, or not needed and why.
  const text =
    r.outcome === "retry_safe"
      ? h.subject === "runner_update"
        ? "Released. Boss Man offers the runner update again only if the runners still need it; read the Updates panel before telling the owner a card is waiting."
        : `Released. Within a minute Boss Man offers the owner the ${what} card with your words on it, and recommends going ahead.`
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
export function holdCardLead(h: OwnerHold, commit: string, who: string): { lead: string; notNow: boolean } {
  const failed = failedWords(h);
  // Only the owner's own button press raises a card for the very version an agent said not to retry.
  if (h.outcome === "do_not_retry" && commit.toLowerCase() === h.commit.toLowerCase())
    return { lead: `${failed}, and it should not be tried again. ${h.releasedBy}: ${h.ownerText} Not now is recommended; a newer version is offered once there is one.`, notNow: true };
  // BOS-2609: `who` (pickupWords) says who is diagnosing it; nothing here claims someone is unless they are.
  if (!h.releasedAt) return { lead: `Held: ${failed[0]!.toLowerCase()}${failed.slice(1)}. ${who} Trying again now may fail the same way, so Not now is recommended until we tell you a retry is safe. If a card asks you for the update's log, answer that one first.`, notNow: true };
  if (h.outcome === "unknown") return { lead: `${failed}. Nobody has confirmed the cause yet, so trying again may fail the same way. Not now is recommended. ${who}`, notNow: true };
  if (h.outcome === "do_not_retry") return { lead: `${failed}, and that version won't be offered again. ${h.releasedBy}: ${h.ownerText}`, notNow: false };
  return { lead: `${failed}. ${h.releasedBy} looked into it: ${h.ownerText}`, notNow: false };
}

/** A card's record of the hold it was raised under, so a card whose wording is out of date can be replaced. */
export const holdStamp = (h: OwnerHold | null) => (h ? `${h.id}:${h.releasedAt ? h.outcome : "held"}` : null);
