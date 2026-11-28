// BOS-2863: an after-merge check that waits on a rare future event ("the next real update", "one real install";
// eventWatchPhrase) has an end date: EVENT_WATCH_DAYS after the build went live. The assignee is woken once 24 hours
// before it, so a real reading can still be reported. When the date passes with the criterion unreported, Boss Man
// writes "not observed in 7 days; covered by the merged tests" as the check's result, closes the check as completed
// and the existing check-ticket report-back (reportCheckTicket) writes that line on the build ticket's criterion.
// This is not a fail: nothing reopens. A duration watch ("over 3 days live") is not touched: its assignee reports.
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { EVENT_WATCH_NOT_OBSERVED, EVENT_WATCH_WARN_HOURS, criterionText, eventWatchEndsAt, eventWatchPhrase, isAfterMerge, longWatchPhrase, readCriteria, readVerdicts, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, checkTicketLinks, companies, tickets } from "../db/schema.js";
import { record } from "./activity.js";

/** The wake reason; "waiting" class in wake-classes.ts, so it is never dropped. */
export const EVENT_CHECK_ENDING_REASON = "event check ending";

/** True when the parent's criterion waits on a future event and not on a duration (a duration keeps the assignee's own report). */
export function isEventCriterion(text: string): boolean {
  return !!eventWatchPhrase(text) && !longWatchPhrase(text);
}

/** Checks opened before this shipped keep today's behaviour (their assignee reports; nothing closes them). A fixed date, as LONG_WATCH_FROM. */
export const EVENT_CHECK_END_FROM = new Date("2026-11-27T18:00:00Z");

export type EventCheckDeps = {
  now?: () => Date;
  /** Wakes the check ticket's assignee (never dropped: the reason is in the waiting class). */
  notify: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
  /** Closes a ticket as completed (the done hook writes the result on the parent). */
  close: (ticketId: string) => Promise<unknown>;
};

/** One pass: warns the checks ending within a day, closes the ones past their end. Returns how many of each. */
export async function eventCheckEndSweep(db: Db, deps: EventCheckDeps): Promise<{ warned: number; closed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await db
    .select({ t: tickets, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(isNotNull(tickets.checksTicketId), isNotNull(tickets.checksCriterion), ne(tickets.systemState, "done")));
  let warned = 0;
  let closed = 0;
  for (const { t: check, prefix } of rows) {
    if (check.createdAt < EVENT_CHECK_END_FROM) continue;
    const [parent] = await db.select().from(tickets).where(and(eq(tickets.id, check.checksTicketId!), eq(tickets.companyId, check.companyId)));
    // The watch starts at go-live: a build not merged yet, or merged and still waiting for the update, has no end.
    if (!parent?.mergeCommit || (parent.goLiveWait && !parent.liveAt)) continue;
    const n = check.checksCriterion!;
    const criterion = readCriteria(parent.acceptanceCriteria)[n - 1];
    if (!criterion || !isAfterMerge(criterion) || !isEventCriterion(criterionText(criterion))) continue;
    let ends = eventWatchEndsAt({ watchUntil: check.watchUntil, liveAt: parent.liveAt, mergedAt: parent.mergedAt });
    // BOS-2855: a check other builds' criteria were folded into ends with the last of them, since each build's watch
    // starts at its own go-live; one not live yet means no end yet.
    const folded = await db
      .select({ t: tickets })
      .from(checkTicketLinks)
      .innerJoin(tickets, eq(tickets.id, checkTicketLinks.ticketId))
      .where(eq(checkTicketLinks.checkTicketId, check.id));
    for (const { t: b } of folded) {
      const e = b.mergeCommit && !(b.goLiveWait && !b.liveAt) ? eventWatchEndsAt({ watchUntil: null, liveAt: b.liveAt, mergedAt: b.mergedAt }) : null;
      ends = e && ends ? (e > ends ? e : ends) : null;
    }
    if (!ends) continue;
    if (ends.getTime() > now.getTime()) {
      if (ends.getTime() - now.getTime() > EVENT_WATCH_WARN_HOURS * 3_600_000 || !check.assigneeAgentId) continue;
      const key = `event-check-warned:${check.id}`;
      const [told] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, check.id), sql`${activity.detail}->>'key' = ${key}`)).limit(1);
      if (told) continue;
      const ref = ticketRef(prefix, check.number) ?? check.id.slice(0, 8);
      await record(db, { companyId: check.companyId, ticketId: check.id, kind: "after_merge_check", summary: `Told the assignee this event check ends at ${ends.toISOString()}.`, detail: { key }, at: now });
      await deps.notify(check.assigneeAgentId, { ticketId: check.id, reason: EVENT_CHECK_ENDING_REASON, priority: 2, note: `${ref} ends at ${ends.toISOString()} (${EVENT_WATCH_WARN_HOURS} hours from now or less). If the event has happened, report what you saw on criterion ${n} now ("${n} pass: <what you saw>" or "${n} fail: <why>") and close the ticket. If it has not, do nothing: Boss Man then closes it with "${EVENT_WATCH_NOT_OBSERVED}", which is not a fail and reopens nothing.` }).catch(() => null);
      warned++;
      continue;
    }
    // Past its end and still unreported: the line is the check's result (criterion 1 of the check ticket is the event's own).
    // A real reading the assignee already wrote on the check is kept and the check is left to them to close.
    const own = readCriteria(check.acceptanceCriteria);
    const reported = readVerdicts(own, check.stateNote).some((r) => r.verdict !== null);
    if (reported) continue;
    // BOS-2855: every criterion of the check (a folded one too) gets the line, so each build reads its own pass.
    const lines = (own.length ? own : [null]).map((_, i) => `${i + 1} pass: ${EVENT_WATCH_NOT_OBSERVED}`).join("\n");
    await db.update(tickets).set({ stateNote: lines, stateNoteAt: now }).where(eq(tickets.id, check.id));
    await record(db, { companyId: check.companyId, ticketId: check.id, kind: "after_merge_check", summary: `Event check ended: ${EVENT_WATCH_NOT_OBSERVED}.`, detail: { key: `event-check-ended:${check.id}` }, at: now });
    await deps.close(check.id);
    closed++;
  }
  return { warned, closed };
}
