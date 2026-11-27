// BOS-1794: a ticket split out to settle one after-merge criterion of another ticket (its "parent" here) reports back
// when it closes. Before this nothing linked the two: BOS-1622 passed and BOS-1600 sat Blocked with that criterion
// "not reported" for two days, until the CEO noticed. The result goes on the parent's state note as a numbered line
// (checkTicketLine), which readVerdicts and so the done gate read like an owner's card answer, and the parent's
// assignee is woken. Closing the parent stays a person's step (out of scope on the ticket).
// BOS-2417: a merged parent whose only unreported criteria are tied to open check tickets may close at go-live (the
// tie is not a reason to sit Blocked for a week); its watch moves to the check tickets, and the result still lands here.
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { EVENT_WATCH_DAYS, EVENT_WATCH_NOT_OBSERVED, eventWatchPhrase, checkTicketLine, criterionText, isAfterMerge, longWatchIndexes, longWatchPhrase, readCriteria, readVerdicts, ticketRef, unreportedAfterMerge, watchPhrase } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { systemMoveTicket } from "./ticket-transition.js";
import type { workService } from "./work.js";

type Work = ReturnType<typeof workService>;

/** BOS-2643: a check ticket Boss Man opened by itself for a build's long after-merge watch. */
export type LongWatchCheck = { id: string; ref: string; criterion: number; phrase: string };

/**
 * BOS-2643 (the CEO's approval condition): tickets open before this shipped are never changed, even when their
 * criteria are set again later (update_ticket). A fixed date (the day it was built) rather than a mark on each ticket:
 * the few tickets created between then and go-live are new work, opened after the decision, so splitting them is wanted.
 */
export const LONG_WATCH_FROM = new Date("2026-11-26T00:00:00Z");

const TITLE_MAX = 200;
const fitTitle = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 3).trimEnd()}...` : s);

/**
 * BOS-2643: opens each after-merge criterion of a build ticket that names a watch of a day or more (longWatchPhrase), or
 * since BOS-2797 a future event such as "the next beta release" or "one real install" (eventWatchPhrase), as
 * its own check ticket, tied with checksCriterion, so the build can close at go-live (BOS-2417) instead of sitting open
 * for the watch (BOS-2302, BOS-2298: merged in hours, open 3 days). Safe to repeat: a criterion with an open check
 * already gets none. Nothing for a no-code build (it never merges, so its check would never start), a build that is
 * itself a check ticket, one already merged or done (criteria split after merge are the assignee's call, as before), or
 * one created before LONG_WATCH_FROM.
 *
 * The link is one way on purpose: the check waits on the build until merged, and the build does NOT wait on the check,
 * unlike create_ticket checksCriterion on a merged ticket. On a build that hasn't started, "build waits on check until
 * done" plus "check waits on build until merged" would hold both forever: openBlockers stops the build starting and
 * holds its merge ("Passed, held"). Nothing needs that link: the report-back reads checksTicketId, the done gate reads
 * closableChecks, and reportCheckTicket wakes the build's assignee.
 *
 * The check is created unassigned and the assignee is written after it is Blocked, so the assignee isn't woken for a
 * ticket that can't start; the waits-on release wakes them when the build merges.
 */
export async function openLongWatchChecks(db: Db, work: Work, buildId: string, opts: { byAgentId: string | null; assigneeAgentId?: string | null; suggested?: string | null }): Promise<LongWatchCheck[]> {
  const [row] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, buildId));
  if (!row) return [];
  const { t, prefix } = row;
  if (t.noCode || t.checksTicketId || t.mergeCommit || t.systemState === "done" || t.createdAt < LONG_WATCH_FROM) return [];
  const criteria = readCriteria(t.acceptanceCriteria);
  const wanted = longWatchIndexes(criteria);
  if (!wanted.length) return [];
  const open = await db.select({ criterion: tickets.checksCriterion }).from(tickets).where(and(eq(tickets.checksTicketId, t.id), ne(tickets.systemState, "done")));
  const have = new Set(open.map((o) => o.criterion));
  const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
  const made: LongWatchCheck[] = [];
  for (const i of wanted) {
    const n = i + 1;
    if (have.has(n)) continue;
    const text = criterionText(criteria[i]!);
    const phrase = watchPhrase(text)!;
    const why = longWatchPhrase(text) ? "needs a watch of a day or more" : "waits on a future event";
    const body = [
      `**Why:** criterion ${n} of ${ref} ("${t.title}") ${why} ("${phrase}"), so Boss Man opened it as this check ticket when ${ref} was opened (BOS-2643, BOS-2797). ${ref} can then close once it is live, and this ticket keeps the watch.`,
      "",
      ...(opts.suggested ? [`**Suggested assignee:** ${opts.suggested} (named by the closing agent; the CEO decides).`, ""] : []),
      `**Done when:** ${text}`,
      "",
      `This ticket waits on ${ref}'s merge and starts by itself then. Once ${ref} is live, move this ticket to Blocked with blocked_until the end of the watch (for an event, when you expect it). When the watch is over or the event has happened, close it with a numbered result ("1 pass: <what you saw>" or "1 fail: <why>"): Boss Man writes it on criterion ${n} of ${ref} ([${ref}](#/tickets/${t.id})).`,
    ].join("\n");
    const c = await work.createTicket(t.projectId, { title: fitTitle(`Watch for ${ref} criterion ${n}: ${text}`), body, risk: t.risk ?? "medium", size: 1, state: "backlog", featureId: null, createdByAgentId: opts.byAgentId, noCode: true, acceptanceCriteria: [text] });
    await db.update(tickets).set({ checksTicketId: t.id, checksCriterion: n }).where(eq(tickets.id, c.id));
    await work.addDependency(c.id, { ticketId: t.id, until: "merged" }, opts.byAgentId);
    await systemMoveTicket(db, { ticketId: c.id, from: ["backlog"], to: "blocked", reason: `Boss Man: waits on ${ref}'s merge (BOS-2643)`, now: new Date() });
    if (opts.assigneeAgentId) await db.update(tickets).set({ assigneeAgentId: opts.assigneeAgentId }).where(eq(tickets.id, c.id));
    const [numbered] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, c.id));
    const checkRef = ticketRef(prefix, numbered?.number) ?? `"${c.title}"`;
    await record(db, { companyId: t.companyId, ticketId: t.id, agentId: opts.byAgentId, kind: "after_merge_check", summary: `Criterion ${n}'s watch ("${phrase}") is on its own check ticket ${checkRef}, so this ticket can close once it is live.`, detail: { checkTicketId: c.id, criterion: n } });
    made.push({ id: c.id, ref: checkRef, criterion: n, phrase });
  }
  return made;
}

/** BOS-2863: true when a watch phrase names a future event and no duration (those keep the assignee's own report). */
const isEventPhrase = (phrase: string) => !!eventWatchPhrase(phrase) && !longWatchPhrase(phrase);

/** The line a tool reply adds for the checks openLongWatchChecks opened; empty when none. */
export const longWatchNote = (checks: readonly LongWatchCheck[]): string =>
  checks.length ? ` ${checks.map((c) => `Criterion ${c.criterion} needs a watch ("${c.phrase}"), so Boss Man opened it as check ticket ${c.ref} (${c.id}), which waits on this ticket's merge; this ticket can close once it is live, and the check reports its result here.${isEventPhrase(c.phrase) ? ` It ends ${EVENT_WATCH_DAYS} days after go-live: if the event hasn't happened by then, Boss Man closes it as "${EVENT_WATCH_NOT_OBSERVED}" (a pass, not a fail).` : ""}`).join(" ")}` : "";

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

/**
 * BOS-2599 (cock-ups G1, the BOS-2069 path): the done gate reads a criterion as an after-merge check when the criterion
 * itself says so, or when a check ticket is tied to it. On a ticket with no criteria that is never, so the trap those
 * clauses guard against can't apply: the work exists only once a branch has changed the repo. On a merged ticket, and on
 * one whose branch has changes waiting to merge, every not-reported criterion is still held. On a ticket with no branch
 * and no changes of its own (BOS-2069: no criteria at all; BOS-2073: no criteria and no branch) every criterion is held:
 * no live check can have been made, so closing it records nothing and the follow-up for it carries the criterion.
 */
export async function holdableUnreported(db: Db, ticket: { id: string; mergeCommit: string | null; criteria: unknown; note: string | null | undefined }, hasOwnChanges: boolean): Promise<boolean> {
  if (ticket.mergeCommit || hasOwnChanges) return false;
  const rows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(or(eq(tickets.checksTicketId, ticket.id), and(eq(tickets.id, ticket.id), isNotNull(tickets.checksCriterion))), ne(tickets.systemState, "done"), isNotNull(tickets.checksCriterion)))
    .limit(1);
  return rows.length === 0 && readVerdicts(readCriteria(ticket.criteria), ticket.note).some((r) => r.verdict === null);
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
    // BOS-2863: an event check that ended unobserved says so on the build's criterion (a pass, not a fail).
    const unobserved = verdict === "pass" && (check.stateNote ?? "").includes(EVENT_WATCH_NOT_OBSERVED);
    const line = `${checkTicketLine(ref, n, verdict, criterionText(criterion), check.title)}${unobserved ? ` — ${EVENT_WATCH_NOT_OBSERVED}` : ""}`;
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
