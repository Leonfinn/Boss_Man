// BOS-1794: a ticket split out to settle one after-merge criterion of another ticket (its "parent" here) reports back
// when it closes. Before this nothing linked the two: BOS-1622 passed and BOS-1600 sat Blocked with that criterion
// "not reported" for two days, until the CEO noticed. The result goes on the parent's state note as a numbered line
// (checkTicketLine), which readVerdicts and so the done gate read like an owner's card answer, and the parent's
// assignee is woken. Closing the parent stays a person's step (out of scope on the ticket).
// BOS-2417: a merged parent whose only unreported criteria are tied to open check tickets may close at go-live (the
// tie is not a reason to sit Blocked for a week); its watch moves to the check tickets, and the result still lands here.
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { checkTicketLine, criterionText, isAfterMerge, readCriteria, readVerdicts, ticketRef, unreportedAfterMerge } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, tickets } from "../db/schema.js";
import { record } from "./activity.js";

/** The wake reason; "waiting" class in wake-classes.ts, so it is never dropped. */
export const CHECK_REPORTED_REASON = "after-merge check reported";

/** What the check ticket's own verdicts say: any fail is a fail, all pass is a pass, anything else says nothing. */
export function checkTicketVerdict(t: { outcome: string | null; acceptanceCriteria: unknown; stateNote: string | null }): "pass" | "fail" | null {
  if (t.outcome === "cancelled") return null;
  const verdicts = readVerdicts(readCriteria(t.acceptanceCriteria), t.stateNote).map((r) => r.verdict);
  if (verdicts.includes("fail")) return "fail";
  return verdicts.length && verdicts.every((v) => v === "pass") ? "pass" : null;
}

/**
 * BOS-1867: the refusal for closing a check ticket done (outcome completed) while any of its own criteria has no
 * verdict, or null when every one has one. Without it QA's "Pass: 79 GitHub runs …" closed the check with its
 * criteria "not reported", so checkTicketVerdict read nothing and the parent got no result. readVerdicts stays as it
 * is (loosening it would change every ticket's done gate); the text shows the numbered form it does read.
 */
export function checkTicketDoneRefusal(criteriaRaw: unknown, note: string | null | undefined, checksCriterion: number): string | null {
  const criteria = readCriteria(criteriaRaw);
  const read = readVerdicts(criteria, note);
  const missing = read.filter((r) => r.verdict === null).map((r) => r.criterion);
  if (criteria.length && !missing.length) return null;
  const form = criteria.length ? criteria.map((_, i) => `${i + 1} pass: <what you saw>`).join("; ") : "1 pass: <what you saw>";
  const what = criteria.length
    ? `Not reported: ${missing.map((m) => `"${m}"`).join(", ")}.`
    : "This ticket has no criteria of its own, so there is nothing to read a result from: add them with update_ticket.";
  return `This ticket is the check for criterion ${checksCriterion} of another ticket. Boss Man copies its result there only from a numbered pass or fail for each of this ticket's own criteria, and closing it now would record nothing. ${what} Write the summary in this form, in criteria order: "${form}" (use "N fail: <why>" for a fail). A bare "Pass: …" is not read. To close it with no result, use outcome cancelled.`;
}

/** BOS-2417: a parent's check tickets still open, with the parent criterion each settles (1-based) and its watch. */
export type OpenCheck = { id: string; number: number | null; criterion: number; assigneeAgentId: string | null; watchingFor: string | null; watchTrigger: string | null };

/**
 * BOS-2417: the open check tickets that let a merged parent close with their criteria still unreported. Empty when the
 * parent hasn't merged: a tie only lets live work close, never work still in review.
 */
export async function closableChecks(db: Db, parentId: string): Promise<OpenCheck[]> {
  const [p] = await db.select({ mergeCommit: tickets.mergeCommit }).from(tickets).where(eq(tickets.id, parentId));
  if (!p?.mergeCommit) return [];
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, criterion: tickets.checksCriterion, assigneeAgentId: tickets.assigneeAgentId, watchingFor: tickets.watchingFor, watchTrigger: tickets.watchTrigger })
    .from(tickets)
    .where(and(eq(tickets.checksTicketId, parentId), ne(tickets.systemState, "done"), isNotNull(tickets.checksCriterion)));
  return rows.map((r) => ({ ...r, criterion: r.criterion! }));
}

/** BOS-2417: 0-based indexes of the after-merge criteria an open check ticket settles. */
export function tiedCriteria(criteriaRaw: unknown, open: readonly OpenCheck[]): Set<number> {
  const criteria = readCriteria(criteriaRaw);
  return new Set(open.map((o) => o.criterion - 1).filter((i) => criteria[i] && isAfterMerge(criteria[i]!)));
}

/** BOS-2417: the done gate's "not reported" list, leaving out the criteria tied to an open check ticket. */
export function unreportedUntied(criteriaRaw: unknown, note: string | null | undefined, tied: ReadonlySet<number>): string[] {
  const criteria = readCriteria(criteriaRaw);
  return readVerdicts(criteria, note)
    .filter((r, i) => isAfterMerge(criteria[i]!) && r.verdict === null && !tied.has(i))
    .map((r) => r.criterion);
}

/**
 * BOS-2417: the closing parent's watch goes to its open check tickets, so an event (gate_ci_failed...) wakes whoever
 * still does the check instead of the finished ticket's assignee. A check ticket that already watches keeps its own.
 * The parent's trigger is cleared (it is done, so it would wake nobody anyway); its watchingFor stays as history.
 * Returns the check tickets that took the watch.
 */
export async function moveWatchToChecks(db: Db, parentId: string, open: readonly OpenCheck[]): Promise<OpenCheck[]> {
  const [p] = await db.select({ watchingFor: tickets.watchingFor, watchUntil: tickets.watchUntil, watchTrigger: tickets.watchTrigger }).from(tickets).where(eq(tickets.id, parentId));
  if (!p?.watchingFor && !p?.watchTrigger) return [];
  const took = open.filter((o) => !o.watchingFor && !o.watchTrigger);
  for (const o of took) await db.update(tickets).set({ watchingFor: p.watchingFor, watchUntil: p.watchUntil, watchTrigger: p.watchTrigger }).where(eq(tickets.id, o.id));
  if (took.length) await db.update(tickets).set({ watchTrigger: null }).where(eq(tickets.id, parentId));
  return took;
}

/** The note can hold 4000 characters: the old note gives way from the front, so the new line is never cut. */
const NOTE_MAX = 4000;
export const appendLine = (note: string | null, line: string): string => {
  const old = (note ?? "").trim();
  if (!old) return line.slice(0, NOTE_MAX);
  const room = NOTE_MAX - line.length - 2;
  return `${room > 0 ? old.slice(Math.max(0, old.length - room)) : ""}. ${line}`.slice(-NOTE_MAX);
};

/**
 * After a ticket is done: when it checks a criterion of another ticket, write the result there and say whom to wake.
 * Once per close: keyed on the check ticket's close time, so a second done hook for the same move writes nothing,
 * while a ticket reopened and closed again reports again. Returns null when there is nothing to tell.
 */
export async function reportCheckTicket(db: Db, ticketId: string, now: Date = new Date()): Promise<{ agentId: string; ticketId: string; note: string } | null> {
  const [c] = await db
    .select({ t: tickets, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(eq(tickets.id, ticketId));
  if (!c || c.t.systemState !== "done" || !c.t.checksTicketId || !c.t.checksCriterion) return null;
  const check = c.t;
  const [parent] = await db.select().from(tickets).where(and(eq(tickets.id, check.checksTicketId!), eq(tickets.companyId, check.companyId)));
  if (!parent) return null;
  const key = `check-reported:${check.id}:${check.stateChangedAt.toISOString()}`;
  const [told] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, parent.id), eq(activity.kind, "after_merge_check"), sql`${activity.detail}->>'key' = ${key}`)).limit(1);
  if (told) return null;

  const ref = ticketRef(c.prefix, check.number) ?? check.id.slice(0, 8);
  const criteria = readCriteria(parent.acceptanceCriteria);
  const n = check.checksCriterion!;
  const criterion = criteria[n - 1];
  const verdict = checkTicketVerdict(check);
  const named = `${ref} "${check.title}"`;
  let note: string;
  let summary: string;
  if (!criterion || !isAfterMerge(criterion)) {
    // The parent's criteria were changed after the split: nothing safe to write, so the assignee decides.
    summary = `${ref} closed, but criterion ${n} is no longer an after-merge check on this ticket, so nothing was recorded.`;
    note = `${named}, the check for criterion ${n} of this ticket, is done. This ticket's criteria have changed since, so criterion ${n} is no longer the after-merge check it was split out for and Boss Man recorded nothing. Read ${ref} and report the criterion it covers yourself.`;
  } else if (!verdict) {
    summary = `${ref} closed without a pass or fail${check.outcome === "cancelled" ? " (cancelled)" : ""}, so criterion ${n} is still not reported.`;
    note = `${named}, the check for criterion ${n} of this ticket ("${criterionText(criterion)}"), was ${check.outcome === "cancelled" ? "cancelled" : "closed without a pass or fail on its own criteria"}, so Boss Man recorded nothing. Criterion ${n} is still not reported: read ${ref}, then report it or split out a new check.`;
  } else {
    const line = checkTicketLine(ref, n, verdict, criterionText(criterion), check.title);
    const nextNote = appendLine(parent.stateNote, line);
    await db.update(tickets).set({ stateNote: nextNote, stateNoteAt: now }).where(eq(tickets.id, parent.id));
    const left = parent.mergeCommit ? unreportedAfterMerge(criteria, nextNote) : null;
    summary = `${ref} reported criterion ${n}: ${verdict}. Recorded on the state note.`;
    const status =
      left === null
        ? "This ticket hasn't merged yet, so it still goes through review and merge as usual."
        : left.length
          ? `Still not reported: ${left.map((t) => `"${t}"`).join(", ")}.`
          : `Every criterion on this ticket is now reported: you can close it now (set_ticket_state done).${verdict === "fail" ? " Criterion " + n + " failed, so closing it opens the follow-up for the failed check." : ""}`;
    note = `${named}, the check for criterion ${n} of this ticket ("${criterionText(criterion)}"), is done and reported ${verdict}. Boss Man wrote "${n} ${verdict}" on this ticket's state note, naming ${ref}. ${status}`;
  }
  await record(db, { companyId: parent.companyId, ticketId: parent.id, kind: "after_merge_check", summary, detail: { key, checkTicketId: check.id, criterion: n, verdict }, at: now });
  // BOS-2417: a parent closed at go-live with this check left open. A pass only needs recording, so nobody is woken
  // for a run with nothing to do; anything else (a fail, no result, a changed criterion) wakes the CEO, since the
  // parent's assignee has moved on and Boss Man can't open the failed check's follow-up on a ticket already closed.
  if (parent.systemState === "done") {
    if (verdict === "pass" && criterion && isAfterMerge(criterion)) return null;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, parent.companyId), eq(agents.role, "ceo")));
    if (!ceo) return null;
    const parentRef = ticketRef(c.prefix, parent.number) ?? parent.id.slice(0, 8);
    const what =
      verdict === "fail" && criterion && isAfterMerge(criterion)
        ? `reported fail on criterion ${n} ("${criterionText(criterion)}"). Boss Man wrote "${n} fail" on ${parentRef}'s state note. Open the follow-up for the failed check (create_ticket, naming ${parentRef}) and assign it.`
        : `closed without a result Boss Man could record for criterion ${n}: ${summary} Decide whether the check still needs doing, and if so open a ticket for it.`;
    return { agentId: ceo.id, ticketId: parent.id, note: `${named}, the check left open when ${parentRef} "${parent.title}" was closed at go-live, ${what}` };
  }
  return parent.assigneeAgentId ? { agentId: parent.assigneeAgentId, ticketId: parent.id, note } : null;
}
