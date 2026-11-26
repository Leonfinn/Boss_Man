// BOS-1361: a ticket that closes by handing work to someone must open that work. Two parts:
// the follow-ups an agent lists on set_ticket_state (opened as linked tickets), and the plain
// wording check that refuses "done" when the summary or last reply hands work on and no follow-up
// or reason was given. The wording check is deliberately simple and listed here, in one place: a
// false positive is cleared with noFollowUpReason, so it never blocks for good. Boss Man never
// guesses a follow-up from text and opens it itself.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { carriedCriteria, criteriaText, criterionText, readCriteria, readVerdicts, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, ticketMessages, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { openLongWatchChecks } from "./after-merge-check-tickets.js";
import type { workService } from "./work.js";

type Work = ReturnType<typeof workService>;

/** The wording that reads as "someone else will do the next bit". Edit this list only; the tests sample it against ordinary summaries. */
const SUBJECT_NOT_A_NAME = "(?:It|This|That|They|There|We|I|The|These|Those|He|She|You|Tests|All|Nothing|Everything)";
const HAND_ON_VERBS = "(?:attach|create|open|file|add|write|pick up|follow up|take over|take it|handle|finish|build|do the|do it|decide|fix|schedule|raise|wire)";
export const HAND_OFF_WORDING: readonly { label: string; re: RegExp }[] = [
  { label: '"the CEO will / should / needs to"', re: /\bceo (?:will|should|needs to|must)\b/i },
  { label: '"for <someone> to <do something>"', re: new RegExp(`\\bfor (?:the )?[\\w-]+ to ${HAND_ON_VERBS}\\b`, "i") },
  { label: '"hand(ed) (off/over) to"', re: /\bhand(?:ed|s|ing)?\s+(?:it |this |that |them |the work |the rest )?(?:off |over )?to\b/i },
  { label: '"next: <someone>"', re: /\bnext:\s*\S/i },
  { label: '"<Name> will <do something>"', re: new RegExp(`\\b(?!${SUBJECT_NOT_A_NAME}\\b)[A-Z][\\w-]+ will ${HAND_ON_VERBS}\\b`) },
];

/** The first hand-off phrase found in the texts, or null. */
export function handOffPhrase(...texts: (string | null | undefined)[]): { label: string; quote: string } | null {
  for (const t of texts) {
    if (!t) continue;
    for (const { label, re } of HAND_OFF_WORDING) {
      const m = re.exec(t);
      if (m) return { label, quote: t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 30).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

/**
 * BOS-2679: wording that names a known edge case or limitation. Such a case needs a follow-up ticket, a ticket id in the
 * same sentence, or noFollowUpReason. Edit this list only; a false positive is cleared with noFollowUpReason.
 */
export const EDGE_CASE_WORDING: readonly { label: string; re: RegExp }[] = [
  { label: '"edge case"', re: /\bedge[- ]cases?\b/i },
  { label: '"known limitation / issue / gap"', re: /\bknown (?:limitations?|issues?|gaps?|caveats?|problems?)\b/i },
  { label: '"limitation(s)" or "caveat(s)"', re: /\b(?:limitations?|caveats?)\b/i },
  { label: '"not handled"', re: /\b(?:not|isn['’]t|aren['’]t|n['’]t|never) (?:yet )?handled\b|\bunhandled\b|\b(?:does not|doesn['’]t|do not|don['’]t|won['’]t|will not|can['’]t|cannot) (?:yet )?(?:handle|cover)\b/i },
  { label: '"may/can still hide or miss"', re: /\b(?:may|can|could|might) (?:still )?(?:hide|miss|show a stale)\b/i },
];
const TICKET_ID_IN_SENTENCE = /\b[A-Z]{2,6}-\d{1,6}\b/;

/** The first edge-case phrase found whose sentence names no ticket id, or null. */
export function edgeCasePhrase(...texts: (string | null | undefined)[]): { label: string; quote: string } | null {
  for (const t of texts) {
    if (!t) continue;
    for (const sentence of t.split(/(?<=[.!?;])\s+|\n+/)) {
      if (TICKET_ID_IN_SENTENCE.test(sentence)) continue;
      for (const { label, re } of EDGE_CASE_WORDING) {
        const m = re.exec(sentence);
        if (m) return { label, quote: sentence.replace(/\s+/g, " ").trim().slice(0, 120) };
      }
    }
  }
  return null;
}

/** The line in the reviewer's brief (BOS-2679). */
export const EDGE_CASE_REVIEW_LINE = "Known edge cases (BOS-2679): if the summary or the author's replies name an edge case, limitation, caveat or \"not handled\" case and no ticket id, followUps entry or noFollowUpReason covers it, request changes: it must be ticketed, not just mentioned.";

export const FOLLOW_UP_HELP = "followUps: work you are handing on, one entry each {title, assignee (an agent's name, or \"CEO\"), why, criterion?}. Boss Man opens each as a ticket in the same project (and feature), linked to this one, and wakes the assignee. When this ticket's criteria leave one failed or not reported, the follow-up gets that criterion's text, unchanged, as its own acceptance criterion (all of them when the entry names no criterion): the new ticket then has to show the outcome, not just do the task. criterion names one, by its number, to carry exactly that one. A carried after-merge criterion that needs a watch of a day or more (\"over 3 days live\", \"a week on\", \"for 48 hours\") is opened as its own check ticket, waiting on the follow-up's merge, so the follow-up can close once it is live. Only the CEO or a manager can assign a follow-up to a colleague; from anyone else a named colleague is kept as a suggested assignee and the ticket goes to the CEO. Opened only on a real change of state. Use it whenever the summary or a reply says someone else will do something next. noFollowUpReason: when nothing is handed on although the wording sounds like it (up to 240 characters).";

export const followUpsSchema = z.array(z.object({ title: z.string().trim().min(1).max(200), assignee: z.string().trim().min(1).max(100), why: z.string().trim().min(1).max(1500), criterion: z.number().int().min(1).max(10).optional().describe("The number (1-based) of this ticket's criterion to carry into the follow-up, when only one applies. Left out, every failed or not-yet-reported criterion is carried.") })).max(20);
export type FollowUpInput = z.infer<typeof followUpsSchema>[number];

/**
 * BOS-2599 (cock-ups G1): the refusal for a follow-up that names a criterion which can't be carried (no such criterion, or
 * already reported pass); null when fine. Checked before the move so a wrong number refuses early, like a wrong assignee.
 */
export function criterionCarryRefusal(criteriaRaw: unknown, note: string | null | undefined, followUps: readonly FollowUpInput[]): string | null {
  const criteria = readCriteria(criteriaRaw);
  for (const f of followUps) {
    if (f.criterion === undefined) continue;
    const c = criteria[f.criterion - 1];
    if (!c) return `follow-up "${f.title}" names criterion ${f.criterion}, but this ticket has ${criteria.length ? `only ${criteria.length}` : "no"} criteria. Number it from 1 in the order they are listed, or leave criterion out to carry every failed or not-yet-reported one.`;
    const verdict = readVerdicts(criteria, note)[f.criterion - 1]?.verdict;
    if (verdict === "pass") return `follow-up "${f.title}" names criterion ${f.criterion} ("${criterionText(c)}"), but it is already reported pass, so there is no lost outcome to carry. Drop the criterion, or name the one that failed or is not reported yet.`;
  }
  return null;
}

/** The refusal for a move to done that hands work on with no follow-up and no reason; null when fine. */
export async function handOffRefusal(db: Db, ticketId: string, summary: string | undefined, given: { followUps?: unknown[]; noFollowUpReason?: string }, edgeCaseOnly = false): Promise<string | null> {
  if (given.followUps?.length || given.noFollowUpReason?.trim()) return null;
  const [last] = await db.select({ text: ticketMessages.text }).from(ticketMessages).where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.author, "agent"))).orderBy(desc(ticketMessages.createdAt)).limit(1);
  const hit = edgeCaseOnly ? null : handOffPhrase(summary, last?.text);
  if (!hit) {
    const edge = edgeCasePhrase(summary, last?.text);
    if (!edge) return null;
    return `The summary or the last reply names a known edge case or limitation ("${edge.quote}", matched ${edge.label}), but no ticket covers it, so it would be forgotten when this closes. Pass followUps on set_ticket_state: [{title, assignee, why}] so Boss Man opens a ticket for it, or put its ticket id (like BOS-123) in the same sentence. If it is a false alarm or already handled, pass noFollowUpReason (one line) instead.`;
  }
  return `The summary or the last reply hands work to someone else ("${hit.quote}", matched ${hit.label}), but nothing puts that work on their queue, so it would be lost when this closes. Pass followUps on set_ticket_state: [{title, assignee, why}] and Boss Man opens each as a linked ticket. If nothing is handed on and this wording is a false alarm, pass noFollowUpReason (one line) instead.`;
}

/** Looks the assignees up before the move, so a wrong name refuses early. Returns agent ids in order, or an error. */
export async function resolveFollowUpAssignees(db: Db, companyId: string, followUps: FollowUpInput[], isManager: boolean): Promise<{ ids: string[]; suggested: (string | null)[] } | { error: string }> {
  const team = await db.select({ id: agents.id, name: agents.name, role: agents.role, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), sql`${agents.duty} is distinct from 'assistant'`));
  const ids: string[] = [];
  const suggested: (string | null)[] = [];
  const ceo = team.find((x) => x.role === "ceo");
  for (const f of followUps) {
    const a = /^ceo$/i.test(f.assignee) ? ceo : team.find((x) => x.name.toLowerCase() === f.assignee.toLowerCase());
    if (!a) return { error: `No active agent called ${f.assignee} in your company (use "CEO" for the CEO). Valid names: ${team.map((x) => x.name).join(", ")}.` };
    if (a.paused) return { error: `${a.name} is paused, so they would not pick up "${f.title}". Pick someone else.` };
    // Same rule as create_ticket (delegateTarget): only the CEO or a manager assigns work to a colleague. Anyone else's
    // follow-up goes to the CEO to triage, with the named colleague kept as a suggestion (BOS-1361 security review).
    if (!isManager && a.role !== "ceo") {
      if (!ceo) return { error: "Your company has no CEO to triage this follow-up." };
      ids.push(ceo.id);
      suggested.push(a.name);
    } else {
      ids.push(a.id);
      suggested.push(null);
    }
  }
  return { ids, suggested };
}

/** Opens each follow-up as a ready ticket in the closing ticket's project and feature, with a link each way. */
export async function openFollowUps(db: Db, work: Work, ticketId: string, followUps: FollowUpInput[], assigneeIds: string[], byAgentId: string | null, opts: { isManager: boolean; suggested: (string | null)[] }) {
  const [row] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, ticketId));
  if (!row) return [];
  const { t, prefix } = row;
  const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
  // BOS-2599 (cock-ups G1): the criterion the hand-on came from goes with it, so the follow-up has to show the outcome
  // and not just do the task. Read here, after the move, so the note is the one this close stored.
  const [fresh] = await db.select({ criteria: tickets.acceptanceCriteria, note: tickets.stateNote }).from(tickets).where(eq(tickets.id, ticketId));
  const opened: { id: string; ref: string; title: string; assignee: string; carried: string[]; checks: string[] }[] = [];
  for (const [i, f] of followUps.entries()) {
    const suggestion = opts.suggested[i] ? [`**Suggested assignee:** ${opts.suggested[i]} (named by the closing agent; the CEO decides).`, ""] : [];
    const carry = fresh ? carriedCriteria(readCriteria(fresh.criteria), fresh.note, f.criterion !== undefined ? [f.criterion] : undefined) ?? [] : [];
    const carried = carry.length
      ? [`**Done when** (carried from ${ref}, which left ${carry.length > 1 ? "these criteria" : "this criterion"} failed or not reported):`, ...carry.map((c) => `- ${criterionText(c)}`), "Not reported: say pass or fail for each before moving this ticket to review.", ""]
      : [];
    const body = [`**Why:** ${f.why}`, "", ...suggestion, ...carried, `Handed on by ${ref} ("${t.title}") when it closed: [${ref}](#/tickets/${t.id}).`, "", "Opened by Boss Man from the closing ticket's followUps (BOS-1361)."].join("\n");
    const made = await work.createTicket(t.projectId, { title: f.title, body, risk: t.risk ?? "medium", state: "ready", overLimit: opts.isManager, assigneeAgentId: assigneeIds[i]!, featureId: t.featureId, createdByAgentId: byAgentId, ...(carry.length ? { acceptanceCriteria: carry } : {}) });
    const [numbered] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, made.id));
    const newRef = ticketRef(prefix, numbered?.number) ?? `"${made.title}"`;
    const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeIds[i]!));
    // BOS-2643: a carried watch of a day or more goes to its own check ticket, with the follow-up's assignee, so the
    // follow-up can close at go-live instead of sitting open for the watch (BOS-2302, BOS-2298).
    const checks = await openLongWatchChecks(db, work, made.id, { byAgentId, assigneeAgentId: assigneeIds[i]!, suggested: opts.suggested[i] ?? null });
    const link = `Follow-up: ${newRef} (#/tickets/${made.id}) for ${who?.name ?? "someone"}${checks.length ? `, with check ticket${checks.length > 1 ? "s" : ""} ${checks.map((c) => c.ref).join(", ")} for its long watch` : ""}.`;
    const [now] = await db.select({ note: tickets.stateNote }).from(tickets).where(eq(tickets.id, t.id));
    await db.update(tickets).set({ stateNote: `${(now?.note ?? "").trim()}${now?.note?.trim() ? " " : ""}${link}`.slice(0, 4000) }).where(eq(tickets.id, t.id));
    await record(db, { companyId: t.companyId, ticketId: t.id, agentId: byAgentId, kind: "follow_up", summary: link, detail: { followUpTicketId: made.id } });
    opened.push({ id: made.id, ref: newRef, title: made.title, assignee: who?.name ?? "someone", carried: criteriaText(carry), checks: checks.map((c) => c.ref) });
  }
  return opened;
}
