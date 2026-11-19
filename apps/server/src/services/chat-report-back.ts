// R52 (BOS-1911): a ticket asked for in an owner chat is reported back in that chat when it closes or hands out follow-ups.
// Before this the ticket did not know it came from chat, so the CEO's "I'll bring you the recommendation" was kept only
// by memory: BOS-1905 closed and nobody went back to the chat. Now:
//   1. a chat run that creates or changes a ticket marks it (reportInChatAgentId, reportInChatAt);
//   2. when a marked ticket goes done, or to review with follow-ups opened, it is due (chatReportDueAt) and that chat's
//      agent gets one ordinary chat wake: its next chat run's prompt carries the ticket's facts and says to answer in the chat;
//   3. when that chat run ends, a reply naming the ticket's reference (BOS-n) keeps the promise; if there is none,
//      Boss Man posts a line in the chat itself from the facts. The promise never depends on a run going well.
// The wake is an ordinary owner_chat wake (same class, same merge into a waiting wake, same recovery after a restart),
// so a wake queued across a runner swap still fires; the due list is on the ticket row, not in memory.
import { and, asc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, ownerChatMessages, runs, tickets, wikiPages } from "../db/schema.js";

const clock = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;
const REPORTS_MAX = 5;

/** A chat run changed this ticket: it is to be reported back in that run's agent's chat. The first chat run to touch it keeps the mark. */
export async function markReportInChat(db: Db, runId: string, ticketId: string, now: Date = new Date()): Promise<void> {
  const [r] = await db.select({ companyId: runs.companyId, agentId: runs.agentId, purpose: runs.purpose, duty: agents.duty }).from(runs).innerJoin(agents, eq(agents.id, runs.agentId)).where(eq(runs.id, runId));
  // A PA's chat is read-only and escalates to the CEO, whose own run marks what it creates.
  if (r?.purpose !== "chat" || !r.agentId || r.duty === "assistant") return;
  const [t] = await db.select({ at: tickets.reportInChatAt }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, r.companyId)));
  if (!t || t.at) return;
  await db.update(tickets).set({ reportInChatAgentId: r.agentId, reportInChatAt: now }).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, r.companyId)));
}

/** The CEO sets or clears the mark with update_ticket (reportInChat). */
export async function setReportInChat(db: Db, companyId: string, ticketId: string, on: boolean, agentId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(tickets)
    .set(on ? { reportInChatAgentId: agentId, reportInChatAt: now } : { reportInChatAgentId: null, reportInChatAt: null, chatReportDueAt: null })
    .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)))
    .returning({ id: tickets.id });
  return rows.length > 0;
}

/**
 * A marked ticket closed or handed out follow-ups: its chat is owed a report. Returns the agent to wake, or null when the
 * ticket did not come from chat. An agent that has since been retired is replaced by the CEO, so the report still goes to a chat.
 */
export async function dueChatReport(db: Db, ticketId: string, now: Date = new Date(), byRunId?: string | null): Promise<{ agentId: string } | null> {
  const [t] = await db.select({ companyId: tickets.companyId, agentId: tickets.reportInChatAgentId, due: tickets.chatReportDueAt, marked: tickets.reportInChatAt }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t?.marked || !t.agentId) return null;
  // The chat run that closes it is already talking to the owner: its own reply says so, and no second chat run is started for it.
  if (byRunId) {
    const [by] = await db.select({ purpose: runs.purpose, agentId: runs.agentId }).from(runs).where(eq(runs.id, byRunId));
    if (by?.purpose === "chat" && by.agentId === t.agentId) return null;
  }
  const team = await db.select({ id: agents.id, role: agents.role, retiredAt: agents.retiredAt }).from(agents).where(eq(agents.companyId, t.companyId));
  const mine = team.find((a) => a.id === t.agentId);
  const target = mine && !mine.retiredAt ? mine.id : team.find((a) => a.role === "ceo" && !a.retiredAt)?.id;
  if (!target) return null;
  await db.update(tickets).set({ reportInChatAgentId: target, chatReportDueAt: t.due ?? now }).where(eq(tickets.id, ticketId));
  return { agentId: target };
}

type Due = typeof tickets.$inferSelect & { ref: string };

/** The tickets this chat is owed a report on that fell due before `before` (the run's start, so the prompt and the end-of-run check agree). */
async function dueFor(db: Db, companyId: string, agentId: string, before: Date): Promise<Due[]> {
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), eq(tickets.reportInChatAgentId, agentId), isNotNull(tickets.chatReportDueAt), lte(tickets.chatReportDueAt, before)))
    .orderBy(asc(tickets.chatReportDueAt));
  return rows.map((t) => ({ ...t, ref: ticketRef(c?.prefix, t.number) ?? t.id.slice(0, 8) }));
}

/** What the ticket produced and handed on, from the record: its wiki pages and the follow-ups opened on it. */
async function factsOf(db: Db, t: Due): Promise<{ pages: string[]; followUps: string[] }> {
  const pages = await db.select({ title: wikiPages.title, slug: wikiPages.slug }).from(wikiPages).where(and(eq(wikiPages.ticketId, t.id), eq(wikiPages.companyId, t.companyId))).limit(REPORTS_MAX);
  const ups = await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "follow_up")));
  const ids = ups.map((u) => (u.detail as { followUpTicketId?: string } | null)?.followUpTicketId).filter((x): x is string => !!x);
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
  const made = ids.length ? await db.select({ number: tickets.number, title: tickets.title }).from(tickets).where(and(inArray(tickets.id, ids), eq(tickets.companyId, t.companyId))) : [];
  return {
    pages: pages.map((p) => `"${p.title}" (page ${p.slug})`),
    followUps: made.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map((f) => `${ticketRef(c?.prefix, f.number) ?? "a ticket"} "${f.title}"`),
  };
}

const outcomeWords = (t: Due) => (t.systemState === "done" ? (t.outcome === "cancelled" ? "was cancelled" : "is done") : `went to ${t.systemState}`);

/** The chat prompt's section: what to report, and that the answer goes in this chat naming each reference. Empty when nothing is due. */
export async function reportBackSection(db: Db, companyId: string, agentId: string, before: Date): Promise<string[]> {
  const due = (await dueFor(db, companyId, agentId, before)).slice(0, REPORTS_MAX);
  if (!due.length) return [];
  const lines: string[] = [];
  for (const t of due) {
    const f = await factsOf(db, t);
    lines.push(`- ${t.ref} "${t.title}" ${outcomeWords(t)} (${clock(t.stateChangedAt)}).${t.stateNote ? ` Its note: ${t.stateNote.slice(0, 600)}` : ""}${f.pages.length ? ` Pages it wrote: ${f.pages.join(", ")}.` : ""}${f.followUps.length ? ` Follow-ups opened: ${f.followUps.join("; ")}.` : ""} Link: #/tickets/${t.id}`);
  }
  return [
    "",
    "## Report back to the owner now (Boss Man: you asked for these tickets in this chat)",
    "Tell the owner, in this chat, how each of these turned out, in plain words: what finished, where the result is, and what comes next. Name each ticket by its reference (for example BOS-12) so Boss Man knows you kept the promise. If you promised something in the conversation below (a recommendation, a page, a decision), bring it now. If you don't answer, Boss Man posts a short line from the facts itself.",
    ...lines,
  ];
}

/**
 * A chat run of this agent ended: each ticket it was owed a report on is kept when a reply of this agent since it fell due names its
 * reference; otherwise Boss Man posts a line in the chat from the facts. Either way the ticket is no longer due. Returns how many lines it posted.
 */
export async function settleReports(db: Db, companyId: string, agentId: string, startedAt: Date, runId: string | null): Promise<number> {
  const due = await dueFor(db, companyId, agentId, startedAt);
  let posted = 0;
  for (const t of due) {
    const replies = await db
      .select({ text: ownerChatMessages.text })
      .from(ownerChatMessages)
      .where(and(eq(ownerChatMessages.companyId, companyId), eq(ownerChatMessages.agentId, agentId), eq(ownerChatMessages.role, "assistant"), gt(ownerChatMessages.createdAt, t.chatReportDueAt!)));
    // The reference as a whole word, so BOS-19 is not kept by a reply that says BOS-190.
    const named = new RegExp(`(^|[^A-Za-z0-9-])${t.ref.replace(/[-]/g, "\\-")}(?![0-9])`, "i");
    // Cleared first: a second end-of-run pass, or a reply landing now, never posts it twice.
    const cleared = await db.update(tickets).set({ chatReportDueAt: null }).where(and(eq(tickets.id, t.id), eq(tickets.chatReportDueAt, t.chatReportDueAt!))).returning({ id: tickets.id });
    if (!cleared.length || replies.some((r) => named.test(r.text))) continue;
    const f = await factsOf(db, t);
    const parts = [`${t.ref} "${t.title}" ${outcomeWords(t)} at ${clock(t.stateChangedAt)}.`, ...(f.pages.length ? [`Pages: ${f.pages.join(", ")}.`] : []), ...(f.followUps.length ? [`Follow-ups: ${f.followUps.join("; ")}.`] : []), `Open it: #/tickets/${t.id}`];
    await db.insert(ownerChatMessages).values({ companyId, agentId, role: "system", text: `Boss Man: ${parts.join(" ")}`, runId });
    posted++;
  }
  return posted;
}
