// BOS-1794: a ticket split out to settle one after-merge criterion of another ticket (its "parent" here) reports back
// when it closes. Before this nothing linked the two: BOS-1622 passed and BOS-1600 sat Blocked with that criterion
// "not reported" for two days, until the CEO noticed. The result goes on the parent's state note as a numbered line
// (checkTicketLine), which readVerdicts and so the done gate read like an owner's card answer, and the parent's
// assignee is woken. Closing the parent stays a person's step (out of scope on the ticket).
// BOS-2417: a merged parent whose only unreported criteria are tied to open check tickets may close at go-live (the
// tie is not a reason to sit Blocked for a week); its watch moves to the check tickets, and the result still lands here.
import { and, asc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { checkTicketLine, criterionText, eventKey, isAfterMerge, longWatchIndexes, longWatchPhrase, readCriteria, readVerdicts, ticketRef, unreportedAfterMerge, watchPhrase, type Criterion } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, checkTicketLinks, companies, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { systemMoveTicket } from "./ticket-transition.js";
import type { workService } from "./work.js";

type Work = ReturnType<typeof workService>;

/** BOS-2643: a check ticket Boss Man opened by itself for a build's long after-merge watch. */
export type LongWatchCheck = { id: string; ref: string; criterion: number; phrase: string; joined?: boolean };

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
  const have = new Set((await openTies(db, t.id)).map((o) => o.criterion));
  const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
  const made: LongWatchCheck[] = [];
  for (const i of wanted) {
    const n = i + 1;
    if (have.has(n)) continue;
    const text = criterionText(criteria[i]!);
    const phrase = watchPhrase(text)!;
    // BOS-2855: an open check for the same event takes this criterion too, so one reading isn't paid for twice.
    const key = eventKey(text);
    const joined = key ? await foldIntoEventCheck(db, work, { build: t, ref, criterion: n, text, key, byAgentId: opts.byAgentId }) : null;
    if (joined) {
      made.push({ id: joined.id, ref: joined.ref, criterion: n, phrase, joined: true });
      continue;
    }
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

/** The line a tool reply adds for the checks openLongWatchChecks opened or joined; empty when none. */
export const longWatchNote = (checks: readonly LongWatchCheck[]): string =>
  checks.length
    ? ` ${checks
        .map((c) =>
          c.joined
            ? `Criterion ${c.criterion} needs a watch ("${c.phrase}"), and open check ticket ${c.ref} (${c.id}) already waits on that event, so Boss Man added it there as one more criterion instead of opening another check (BOS-2855); it waits on this ticket's merge too, this ticket can close once it is live, and the check reports criterion ${c.criterion}'s own result here.`
            : `Criterion ${c.criterion} needs a watch ("${c.phrase}"), so Boss Man opened it as check ticket ${c.ref} (${c.id}), which waits on this ticket's merge; this ticket can close once it is live, and the check reports its result here.`,
        )
        .join(" ")}`
    : "";

/** BOS-2855: a build criterion's open tie to a check ticket: the check's own (checksTicketId) or a folded link. */
type Tie = { checkId: string; criterion: number };

/** BOS-2855: every open check ticket tie of a build's criteria, the check's own and the folded ones. */
async function openTies(db: Db, buildId: string): Promise<Tie[]> {
  const own = await db.select({ checkId: tickets.id, criterion: tickets.checksCriterion }).from(tickets).where(and(eq(tickets.checksTicketId, buildId), ne(tickets.systemState, "done"), isNotNull(tickets.checksCriterion)));
  const folded = await db
    .select({ checkId: checkTicketLinks.checkTicketId, criterion: checkTicketLinks.criterion })
    .from(checkTicketLinks)
    .innerJoin(tickets, eq(tickets.id, checkTicketLinks.checkTicketId))
    .where(and(eq(checkTicketLinks.ticketId, buildId), ne(tickets.systemState, "done")));
  return [...own.map((o) => ({ checkId: o.checkId, criterion: o.criterion! })), ...folded];
}

/** A criterion is at most 500 characters (acceptanceCriteriaSchema). */
const CRITERION_MAX = 500;

/**
 * BOS-2855 (criterion 5): check tickets opened before this was built are never folded into, so a check its assignee
 * already planned against keeps its criteria and report-back. A fixed date like LONG_WATCH_FROM (the day it was built);
 * the open duplicates from before stay a person's call (out of scope on the ticket).
 */
export const FOLD_FROM = new Date("2026-11-27T00:00:00Z");

/** BOS-2855: open check tickets of a project, oldest first, that can take one more criterion. */
async function openChecksOf(db: Db, projectId: string) {
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, criteria: tickets.acceptanceCriteria, companyId: tickets.companyId })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), isNotNull(tickets.checksTicketId), ne(tickets.systemState, "done"), gte(tickets.createdAt, FOLD_FROM)))
    .orderBy(asc(tickets.createdAt));
  return rows.map((r) => ({ ...r, criteria: readCriteria(r.criteria) })).filter((r) => r.criteria.length && r.criteria.length < 10);
}

/**
 * BOS-2855: adds a build's event criterion to the oldest open check ticket in its project that waits on the same event
 * (eventKey), instead of opening another (BOS-2778 and BOS-2779 each read the same 27 Nov wrap-up). The check gets it as
 * its own new criterion, a link back to the build's criterion (so the build gets that criterion's own pass or fail), and
 * a wait on the build's merge, since its reading only counts once this build is live too. Null when no check fits or
 * the wait can't be added (it would make two tickets wait on each other): the caller then opens a check as before.
 */
async function foldIntoEventCheck(db: Db, work: Work, x: { build: typeof tickets.$inferSelect; ref: string; criterion: number; text: string; key: string; byAgentId: string | null }): Promise<{ id: string; ref: string } | null> {
  const target = (await openChecksOf(db, x.build.projectId)).find((c) => c.criteria.some((k) => eventKey(criterionText(k)) === x.key));
  if (!target) return null;
  try {
    await work.addDependency(target.id, { ticketId: x.build.id, until: "merged" }, x.byAgentId);
  } catch {
    return null;
  }
  const head = `For ${x.ref} criterion ${x.criterion}, once ${x.ref} is live: `;
  const own = target.criteria.length + 1;
  await db.update(tickets).set({ acceptanceCriteria: [...target.criteria, `${head}${x.text}`.slice(0, CRITERION_MAX)] }).where(eq(tickets.id, target.id));
  await db.insert(checkTicketLinks).values({ checkTicketId: target.id, ownCriterion: own, ticketId: x.build.id, criterion: x.criterion, appended: true });
  const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, target.companyId));
  const checkRef = ticketRef(co?.prefix, target.number) ?? `"${target.title}"`;
  await record(db, { companyId: target.companyId, ticketId: x.build.id, agentId: x.byAgentId, kind: "after_merge_check", summary: `Criterion ${x.criterion} waits on the same event as open check ticket ${checkRef} ("${x.key}"), so it was added there as criterion ${own} instead of opening another check.`, detail: { checkTicketId: target.id, criterion: x.criterion, ownCriterion: own } });
  await record(db, { companyId: target.companyId, ticketId: target.id, agentId: x.byAgentId, kind: "after_merge_check", summary: `Criterion ${own} added: criterion ${x.criterion} of ${x.ref} waits on the same event ("${x.key}"). Its result is written on ${x.ref} when this closes; this ticket now also waits on ${x.ref}'s merge.`, detail: { buildTicketId: x.build.id, criterion: x.criterion, ownCriterion: own } });
  return { id: target.id, ref: checkRef };
}

/** The same criterion in two places: case, spacing and the fold's "For X criterion N, once X is live:" head don't count. */
const sameCriterion = (checkText: string, carried: string): boolean => {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const k = norm(carried);
  return !!k && norm(checkText.replace(/^For \S+ criterion \d+, once \S+ is live: /, "")) === k;
};

/**
 * BOS-2855: a follow-up whose every carried criterion is already a criterion of one open check ticket in the project is
 * not opened: each after-merge one of the closing ticket is linked to that check's criterion (so its own pass or fail
 * still comes back here), and the caller says which ticket it joined. BOS-2847 was opened while the same live check
 * was already held. Null when no single check holds them all.
 */
export async function foldFollowUpIntoCheck(db: Db, closing: { id: string; projectId: string; criteria: readonly Criterion[] }, carried: readonly Criterion[], byAgentId: string | null): Promise<{ id: string; ref: string } | null> {
  if (!carried.length) return null;
  for (const target of await openChecksOf(db, closing.projectId)) {
    const at = carried.map((c) => target.criteria.findIndex((k) => sameCriterion(criterionText(k), criterionText(c))));
    if (at.some((i) => i < 0)) continue;
    const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, target.companyId));
    const checkRef = ticketRef(co?.prefix, target.number) ?? `"${target.title}"`;
    const ties = await openTies(db, closing.id);
    for (const [j, c] of carried.entries()) {
      const n = closing.criteria.findIndex((k) => criterionText(k) === criterionText(c)) + 1;
      if (n < 1 || !isAfterMerge(closing.criteria[n - 1]!) || ties.some((t) => t.checkId === target.id && t.criterion === n)) continue;
      await db.insert(checkTicketLinks).values({ checkTicketId: target.id, ownCriterion: at[j]! + 1, ticketId: closing.id, criterion: n, appended: false }).onConflictDoNothing();
    }
    await record(db, { companyId: target.companyId, ticketId: closing.id, agentId: byAgentId, kind: "after_merge_check", summary: `A follow-up carrying ${carried.length > 1 ? "these criteria" : "this criterion"} was not opened: open check ticket ${checkRef} already holds ${carried.length > 1 ? "them" : "it"}, and reports ${carried.length > 1 ? "their" : "its"} result here.`, detail: { checkTicketId: target.id } });
    return { id: target.id, ref: checkRef };
  }
  return null;
}

/** The wake reason; "waiting" class in wake-classes.ts, so it is never dropped. */
export const CHECK_REPORTED_REASON = "after-merge check reported";

/** What the check ticket's own verdicts say: any fail is a fail, all pass is a pass, anything else says nothing. */
export function checkTicketVerdict(t: { outcome: string | null; acceptanceCriteria: unknown; stateNote: string | null }, only?: (index: number) => boolean): "pass" | "fail" | null {
  if (t.outcome === "cancelled") return null;
  // BOS-2855: `only` picks the criteria one tie reads (0-based); a folded criterion settles its own build only.
  const verdicts = readVerdicts(readCriteria(t.acceptanceCriteria), t.stateNote)
    .map((r) => r.verdict)
    .filter((_, i) => !only || only(i));
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
  const ties = await openTies(db, parentId);
  if (!ties.length) return [];
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, assigneeAgentId: tickets.assigneeAgentId, watchingFor: tickets.watchingFor, watchTrigger: tickets.watchTrigger })
    .from(tickets)
    .where(inArray(tickets.id, [...new Set(ties.map((t) => t.checkId))]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ties.flatMap((t) => (byId.has(t.checkId) ? [{ ...byId.get(t.checkId)!, criterion: t.criterion }] : []));
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
  if (!rows.length && (await openTies(db, ticket.id)).length) return false;
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
 * BOS-2855: criteria folded in for another build (appended) are left out of this verdict; reportFoldedChecks sends those.
 */
export async function reportCheckTicket(db: Db, ticketId: string, now: Date = new Date()): Promise<{ agentId: string; ticketId: string; note: string } | null> {
  const c = await closedCheck(db, ticketId);
  if (!c?.t.checksTicketId || !c.t.checksCriterion) return null;
  const appended = new Set((await db.select({ own: checkTicketLinks.ownCriterion }).from(checkTicketLinks).where(and(eq(checkTicketLinks.checkTicketId, ticketId), eq(checkTicketLinks.appended, true)))).map((l) => l.own - 1));
  const verdict = checkTicketVerdict(c.t, (i) => !appended.has(i));
  return reportOne(db, c, { parentId: c.t.checksTicketId, n: c.t.checksCriterion, verdict, key: `check-reported:${c.t.id}:${c.t.stateChangedAt.toISOString()}` }, now);
}

/** BOS-2855: after a check ticket is done, each folded build's criterion gets the verdict of the check's own criterion for it. */
export async function reportFoldedChecks(db: Db, ticketId: string, now: Date = new Date()): Promise<{ agentId: string; ticketId: string; note: string }[]> {
  const c = await closedCheck(db, ticketId);
  if (!c) return [];
  const links = await db.select().from(checkTicketLinks).where(eq(checkTicketLinks.checkTicketId, ticketId)).orderBy(asc(checkTicketLinks.createdAt));
  const out: { agentId: string; ticketId: string; note: string }[] = [];
  for (const l of links) {
    const verdict = checkTicketVerdict(c.t, (i) => i === l.ownCriterion - 1);
    // Keyed per build criterion as well, since two criteria of one build can be folded into the same check.
    const wake = await reportOne(db, c, { parentId: l.ticketId, n: l.criterion, verdict, key: `check-reported:${c.t.id}:${c.t.stateChangedAt.toISOString()}:${l.criterion}` }, now);
    if (wake) out.push(wake);
  }
  return out;
}

async function closedCheck(db: Db, ticketId: string) {
  const [c] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, ticketId));
  return c && c.t.systemState === "done" ? c : null;
}

async function reportOne(db: Db, c: { t: typeof tickets.$inferSelect; prefix: string | null }, x: { parentId: string; n: number; verdict: "pass" | "fail" | null; key: string }, now: Date): Promise<{ agentId: string; ticketId: string; note: string } | null> {
  const check = c.t;
  const [parent] = await db.select().from(tickets).where(and(eq(tickets.id, x.parentId), eq(tickets.companyId, check.companyId)));
  if (!parent) return null;
  const key = x.key;
  const [told] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, parent.id), eq(activity.kind, "after_merge_check"), sql`${activity.detail}->>'key' = ${key}`)).limit(1);
  if (told) return null;

  const ref = ticketRef(c.prefix, check.number) ?? check.id.slice(0, 8);
  const criteria = readCriteria(parent.acceptanceCriteria);
  const n = x.n;
  const criterion = criteria[n - 1];
  const verdict = x.verdict;
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
