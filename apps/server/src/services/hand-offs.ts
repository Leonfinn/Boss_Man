// BOS-1361: a ticket that closes by handing work to someone must open that work. Two parts:
// the follow-ups an agent lists on set_ticket_state (opened as linked tickets), and the plain
// wording check that refuses "done" when the summary or last reply hands work on and no follow-up
// or reason was given. The wording check is deliberately simple and listed here, in one place: a
// false positive is cleared with noFollowUpReason, so it never blocks for good. Boss Man never
// guesses a follow-up from text and opens it itself.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, ticketMessages, tickets } from "../db/schema.js";
import { record } from "./activity.js";
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

export const FOLLOW_UP_HELP = "followUps: work you are handing on, one entry each {title, assignee (an agent's name, or \"CEO\"), why}. Boss Man opens each as a ticket in the same project (and feature), linked to this one, and wakes the assignee. Use it whenever the summary or a reply says someone else will do something next. noFollowUpReason: when nothing is handed on although the wording sounds like it (up to 240 characters).";

export const followUpsSchema = z.array(z.object({ title: z.string().trim().min(1).max(200), assignee: z.string().trim().min(1).max(100), why: z.string().trim().min(1).max(1500) })).max(20);
export type FollowUpInput = z.infer<typeof followUpsSchema>[number];

/** The refusal for a move to done that hands work on with no follow-up and no reason; null when fine. */
export async function handOffRefusal(db: Db, ticketId: string, summary: string | undefined, given: { followUps?: unknown[]; noFollowUpReason?: string }): Promise<string | null> {
  if (given.followUps?.length || given.noFollowUpReason?.trim()) return null;
  const [last] = await db.select({ text: ticketMessages.text }).from(ticketMessages).where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.author, "agent"))).orderBy(desc(ticketMessages.createdAt)).limit(1);
  const hit = handOffPhrase(summary, last?.text);
  if (!hit) return null;
  return `The summary or the last reply hands work to someone else ("${hit.quote}", matched ${hit.label}), but nothing puts that work on their queue, so it would be lost when this closes. Pass followUps on set_ticket_state: [{title, assignee, why}] and Boss Man opens each as a linked ticket. If nothing is handed on and this wording is a false alarm, pass noFollowUpReason (one line) instead.`;
}

/** Looks the assignees up before the move, so a wrong name refuses early. Returns agent ids in order, or an error. */
export async function resolveFollowUpAssignees(db: Db, companyId: string, followUps: FollowUpInput[]): Promise<{ ids: string[] } | { error: string }> {
  const team = await db.select({ id: agents.id, name: agents.name, role: agents.role, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), sql`${agents.duty} is distinct from 'assistant'`));
  const ids: string[] = [];
  for (const f of followUps) {
    const a = /^ceo$/i.test(f.assignee) ? team.find((x) => x.role === "ceo") : team.find((x) => x.name.toLowerCase() === f.assignee.toLowerCase());
    if (!a) return { error: `No active agent called ${f.assignee} in your company (use "CEO" for the CEO). Valid names: ${team.map((x) => x.name).join(", ")}.` };
    if (a.paused) return { error: `${a.name} is paused, so they would not pick up "${f.title}". Pick someone else.` };
    ids.push(a.id);
  }
  return { ids };
}

/** Opens each follow-up as a ready ticket in the closing ticket's project and feature, with a link each way. */
export async function openFollowUps(db: Db, work: Work, ticketId: string, followUps: FollowUpInput[], assigneeIds: string[], byAgentId: string | null) {
  const [row] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, ticketId));
  if (!row) return [];
  const { t, prefix } = row;
  const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
  const opened: { id: string; ref: string; title: string; assignee: string }[] = [];
  for (const [i, f] of followUps.entries()) {
    const body = [`**Why:** ${f.why}`, "", `Handed on by ${ref} ("${t.title}") when it closed: [${ref}](#/tickets/${t.id}).`, "", "Opened by Boss Man from the closing ticket's followUps (BOS-1361)."].join("\n");
    const made = await work.createTicket(t.projectId, { title: f.title, body, risk: t.risk ?? "medium", state: "ready", overLimit: true, assigneeAgentId: assigneeIds[i]!, featureId: t.featureId, createdByAgentId: byAgentId });
    const [numbered] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, made.id));
    const newRef = ticketRef(prefix, numbered?.number) ?? `"${made.title}"`;
    const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeIds[i]!));
    const link = `Follow-up: ${newRef} (#/tickets/${made.id}) for ${who?.name ?? "someone"}.`;
    const [now] = await db.select({ note: tickets.stateNote }).from(tickets).where(eq(tickets.id, t.id));
    await db.update(tickets).set({ stateNote: `${(now?.note ?? "").trim()}${now?.note?.trim() ? " " : ""}${link}`.slice(0, 4000) }).where(eq(tickets.id, t.id));
    await record(db, { companyId: t.companyId, ticketId: t.id, agentId: byAgentId, kind: "follow_up", summary: link, detail: { followUpTicketId: made.id } });
    opened.push({ id: made.id, ref: newRef, title: made.title, assignee: who?.name ?? "someone" });
  }
  return opened;
}
