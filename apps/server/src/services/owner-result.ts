// BOS-2555: a card that asks the owner for information (a pasted log, a screenshot, a value) must come back to them with
// the result and the next step, where they are: a flag in their feed and a line in their chat. On 24 Nov the owner pasted a
// deploy log into a card; the cause was found within minutes and written only on the ticket's conversation, which the owner
// doesn't watch, so they had to ask in the chat what happened.
//
// Who tells them: the agent that raised the card, not a guess by Boss Man. The contract is enforced here, at the one place
// every answer goes through:
//   1. the card's own words make it an information request (`infoAskOf`), accepted only on a plain question card;
//   2. answering it puts a line and a flag in the owner's chat and feed at once ("your answer is with X; a result follows"),
//      and wakes the raiser with a note that says how to report back (BOS-2291: only the raiser, not every assignee);
//   3. the raiser's status-only reply on the card's ticket is accepted (`ticket_reply` with notAnAsk on that ticket), and the
//      reply is posted into the owner's chat too, so the result arrives even if no run starts;
//   4. if nothing has reached the owner 30 minutes after the answer, the CEO is woken to post the result, and the owner gets
//      a line and a flag saying who is on it. The sweep reads the card's own row, so a restart loses nothing.
import { and, desc, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, ownerChatMessages, tickets } from "../db/schema.js";
import type { NotifyInput } from "./notifications.js";

/** How long the raiser has to report back before the CEO is asked to (BOS-2555, the ticket's "e.g. 30 minutes"). */
export const INFO_ASK_MINUTES = 30;

/** Why a run started when the result never arrived is told to report back (a wake class of its own). */
export const INFO_RESULT_REASON = "a result for the owner";

type Decision = typeof decisions.$inferSelect;

/**
 * The words a card uses when its purpose is to get information from the owner. Deliberately narrow: an approval, a
 * choice between options or a to-do for the owner is not this, and neither is a card that merely asks a yes/no question.
 */
const ASK_INFO = [
  /\b(?:paste|send|share|attach|upload|forward|include|give|show)\b[^.;:\n]{0,40}\b(?:log|logs|output|error|errors|message|messages|trace|stack|screenshot|screen shot|picture|photo|image|file|csv|json|number|value|code|token|key|contents?|text)\b/i,
  /\b(?:reply|come back|get back|follow up|respond)\b[^.;:\n]{0,20}\bwith\b[^.;:\n]{1,60}/i,
  /\bwhat (?:does|did) [^.;:\n?]{1,60}\b(?:say|show)\b/i,
  /\b(?:let me know|tell me)\b[^.;:\n]{0,40}\b(?:what|how|which|when|where|who|whether)\b/i,
  /\b(?:can|could|would) you (?:paste|send|share|attach|upload|forward)\b/i,
];

/**
 * The sentence that marks a card as an information request, or null. Only a plain question card qualifies: a permission,
 * a sign-off, a deploy or a to-do is never turned into one, whatever its text says.
 */
export function infoAskOf(d: Pick<Decision, "kind" | "question" | "context">): string | null {
  if (d.kind !== "question") return null;
  const ctx = (d.context ?? {}) as { type?: string; plan?: boolean; steps?: string[]; ownerMustDo?: boolean; clearWhen?: unknown };
  if (ctx.type !== "question" || ctx.plan || ctx.ownerMustDo || (ctx.steps?.length ?? 0) > 0 || ctx.clearWhen) return null;
  const question = d.question.replace(/\s+/g, " ").trim();
  // The first paragraph is the ask; the rest is detail (triedFirst, a link, a bigger job's steps).
  const ask = question.split(/\n\n/)[0]!;
  const hit = ASK_INFO.map((r) => r.exec(ask)).find(Boolean);
  if (!hit) return null;
  return hit[0].replace(/\s+/g, " ").trim().slice(0, 120);
}

const short = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** What the owner reads the moment their answer goes in: who has it, and that a result follows. */
export function answerReceivedLine(raiser: string, question: string, ticketId: string | null): string {
  return `Boss Man: your answer to "${short(question, 120)}" is in. ${raiser} is looking at it, and the result and the next step will come to you here, without you asking.${ticketId ? ` Ticket: #/tickets/${ticketId}` : ""}`;
}

/** The owner's feed flag at the same moment. */
export function answerReceivedFlag(raiser: string, question: string, ticketId: string | null): { title: string; body: string; link: string } {
  return {
    title: `Your answer is with ${raiser}`,
    body: `You sent what "${short(question, 120)}" needed. ${raiser} is looking at it, and the result and the next step will come to you here, without you asking.`,
    link: ticketId ? `#/tickets/${ticketId}` : "#/notifications",
  };
}

/** What the raiser reads when its card is answered with information: how to report back, in the two places the owner looks. */
export function reportBackNote(input: { ownerVoice: string; question: string; ticketId: string; ref: string | null }): string {
  return [
    `${input.ownerVoice} answered your card with the information it asked for: "${short(input.question, 200)}". What they sent is posted on this ticket's conversation.`,
    `Now report back to them. They don't read ticket pages, so two things reach them:`,
    `- Post the result on this ticket as a short status-only reply: ticket_reply with notAnAsk set to true (it asks nothing of them, so the server lets it through; an ask is still held). Say in plain words what happened and what comes next: a step they press, or "nothing to do". It is posted into their chat for them.`,
    `- Also say one line in the owner chat (the CEO's chat): the same two things in a sentence or two, naming this ticket (${input.ref ?? input.ticketId}).`,
    `Never put a question back to them in either; if something else is needed from them, raise a new card for that.`,
    `If this needs work before an answer can be given, say so in the same line ("checking now, back shortly"); if you cannot report at all, the CEO is asked 30 minutes after their answer and will tell them for you.`,
  ].join("\n");
}

/** The owner's line when 30 minutes pass with no report: who is on it now. */
export function resultWaitingLine(raiser: string, ceo: string, question: string, ticketId: string | null): string {
  return `Boss Man: ${INFO_ASK_MINUTES} minutes on, ${raiser} hasn't reported the result of "${short(question, 120)}" yet, so I've asked ${ceo} to find out and tell you here.${ticketId ? ` Ticket: #/tickets/${ticketId}` : ""}`;
}

/** The owner's feed flag at that point. */
export function resultWaitingFlag(raiser: string, ceo: string, question: string, ticketId: string | null): { title: string; body: string; link: string } {
  return { title: `No result yet on "${short(question, 60)}"`, body: `${raiser} hasn't posted what your answer showed yet, so ${ceo} is asked to find out and tell you here.`, link: ticketId ? `#/tickets/${ticketId}` : "#/notifications" };
}

/** What the CEO reads when it is woken to post the result. */
export function ceoResultNote(input: { ownerVoice: string; raiser: string; question: string; answer: string; ticketId: string; ref: string | null; received: boolean }): string {
  return [
    `${input.ownerVoice} answered "${short(input.question, 200)}"${input.ref ? ` (${input.ref})` : ""} with the information the card asked for. ${INFO_ASK_MINUTES} minutes later nothing has reached them: ${input.raiser} didn't post a result, and the owner hasn't heard what their answer showed.`,
    `Their answer: ${short(input.answer, 300)}${input.received ? " (what they sent is on the ticket's conversation; read it there, pictures and files included)" : ""}`,
    `Post the result for the owner now: read what they sent on ticket #/tickets/${input.ticketId}, work out what it showed, and tell them in plain words in the owner chat: what happened, and the next step (what to press, or nothing to do). You may also reply on the ticket with notAnAsk. If it needs real work, open a ticket and say so in the same line.`,
  ].join("\n");
}

/** The tickets a card is about: its own, or the one it holds. */
async function aboutTickets(db: Db, d: Decision): Promise<string[]> {
  const ctx = (d.context ?? {}) as { ticketId?: unknown; blockedTicketId?: unknown };
  const own = typeof ctx.ticketId === "string" ? [ctx.ticketId] : [];
  const blocked = typeof ctx.blockedTicketId === "string" ? [ctx.blockedTicketId] : [];
  return [...new Set([...own, ...blocked])];
}

async function refOf(db: Db, companyId: string, ticketId: string | null): Promise<string | null> {
  if (!ticketId) return null;
  const [row] = await db
    .select({ number: tickets.number, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
  return row ? ticketRef(row.prefix, row.number) : null;
}

async function ceoOf(db: Db, companyId: string): Promise<{ id: string; name: string } | null> {
  const team = await db.select({ id: agents.id, name: agents.name, role: agents.role, retiredAt: agents.retiredAt }).from(agents).where(eq(agents.companyId, companyId));
  const ceo = team.find((a) => a.role === "ceo" && !a.retiredAt);
  return ceo ? { id: ceo.id, name: ceo.name } : null;
}

/** The owner's chat line, if one exists for this company's CEO. */
async function postOwnerLine(db: Db, input: { companyId: string; cardId: string; agentId?: string; text: string }): Promise<boolean> {
  const [line] = await db.select({ id: ownerChatMessages.id }).from(ownerChatMessages).where(and(eq(ownerChatMessages.companyId, input.companyId), eq(ownerChatMessages.infoAskCardId, input.cardId)));
  if (line) return false;
  const agentId = input.agentId ?? (await ceoOf(db, input.companyId))?.id;
  if (!agentId) return false;
  await db.insert(ownerChatMessages).values({ companyId: input.companyId, agentId, role: "system", text: input.text, infoAskCardId: input.cardId });
  return true;
}

/** A further line after the first (the result, or who is on it): the chat marks one line per card, so this one carries no id. */
async function postFollowerLine(db: Db, input: { companyId: string; cardId: string; agentId?: string; text: string }): Promise<boolean> {
  const agentId = input.agentId ?? (await ceoOf(db, input.companyId))?.id;
  if (!agentId) return false;
  await db.insert(ownerChatMessages).values({ companyId: input.companyId, agentId, role: "system", text: input.text });
  return true;
}

/**
 * After a card is answered: mark it as one the owner must hear back about, and put the line and flag in front of them at once.
 * The answer path wakes the raiser itself, with `reportBackNote`. Never throws: the answer is already saved.
 */
export async function startedInfoAnswer(
  db: Db,
  d: Decision,
  why: string,
  deps: { notify: ((n: NotifyInput) => Promise<unknown>) | null; log: (m: string) => void; now: Date },
): Promise<void> {
  const due = new Date(deps.now.getTime() + INFO_ASK_MINUTES * 60_000);
  await db.update(decisions).set({ infoAskWhy: short(why, 200), infoAskDueAt: due }).where(eq(decisions.id, d.id));
  const [raiser] = d.raisedByAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, d.raisedByAgentId)) : [];
  const name = raiser?.name ?? "the team";
  const ticketId = (await aboutTickets(db, d))[0] ?? null;
  try {
    await postOwnerLine(db, { companyId: d.companyId, cardId: d.id, text: answerReceivedLine(name, d.question, ticketId) });
  } catch (err) {
    deps.log(`answering card ${d.id} was saved, but the owner's chat line failed: ${(err as Error).message}`);
  }
  if (!deps.notify) return;
  try {
    await deps.notify({ companyId: d.companyId, agentId: null, level: "flag", ...answerReceivedFlag(name, d.question, ticketId) });
  } catch (err) {
    deps.log(`answering card ${d.id} was saved, but the owner's "answer received" flag failed: ${(err as Error).message}`);
  }
}

/** Whether the raiser has reported the result: a later line in the owner's chat for this card, or a chat reply naming the ticket. */
export async function reportedSince(db: Db, d: Decision, since: Date): Promise<boolean> {
  const [line] = await db
    .select({ id: ownerChatMessages.id })
    .from(ownerChatMessages)
    .where(and(eq(ownerChatMessages.companyId, d.companyId), eq(ownerChatMessages.infoAskCardId, d.id), gt(ownerChatMessages.createdAt, since)))
    .limit(1);
  if (line) return true;
  const ticketId = (await aboutTickets(db, d))[0] ?? null;
  const ref = await refOf(db, d.companyId, ticketId);
  const replies = await db
    .select({ text: ownerChatMessages.text })
    .from(ownerChatMessages)
    .where(and(eq(ownerChatMessages.companyId, d.companyId), eq(ownerChatMessages.role, "assistant"), gt(ownerChatMessages.createdAt, since)))
    .orderBy(desc(ownerChatMessages.createdAt))
    .limit(20);
  if (ref && replies.some((r) => new RegExp(`(^|[^A-Za-z0-9-])${ref.replace(/[-]/g, "\\-")}(?![0-9])`, "i").test(r.text))) return true;
  // A reply that repeats the card's ask is taken as the report: the raiser answering in its own words.
  const words = short(d.question, 60);
  return words.length >= 24 && replies.some((r) => r.text.includes(words));
}

type SweepDeps = {
  /** Sends a flag to the owner's feed. */
  notify: (n: NotifyInput) => Promise<unknown>;
  /** Wakes an agent (the scheduler's notify). */
  wake: (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number }) => Promise<unknown>;
  log?: (m: string) => void;
};

/**
 * BOS-2555 step 3: an information card whose answer has had no outcome for INFO_ASK_MINUTES wakes the CEO to post it, and
 * puts a line and a flag in front of the owner saying so. Cleared before the wake, so a pass and a restart never double-post.
 */
export async function reportDueInfoAnswers(db: Db, now: Date, deps: SweepDeps): Promise<{ woken: number }> {
  const due = await db
    .select()
    .from(decisions)
    .where(and(isNotNull(decisions.infoAskDueAt), lte(decisions.infoAskDueAt, now), eq(decisions.status, "answered")))
    .limit(20);
  let woken = 0;
  for (const d of due) {
    const [claimed] = await db
      .update(decisions)
      .set({ infoAskDueAt: null })
      .where(and(eq(decisions.id, d.id), eq(decisions.infoAskDueAt, d.infoAskDueAt!)))
      .returning({ id: decisions.id });
    if (!claimed) continue;
    try {
      if (await escalateToCeo(db, d, now, deps)) woken++;
    } catch (err) {
      deps.log?.(`reporting the result of card ${d.id} failed: ${(err as Error).message}`);
      // Put the deadline back, an hour out, so a broken wake doesn't spin on every pass.
      await db.update(decisions).set({ infoAskDueAt: new Date(now.getTime() + 60 * 60_000) }).where(eq(decisions.id, d.id));
    }
  }
  return { woken };
}

async function escalateToCeo(db: Db, d: Decision, now: Date, deps: SweepDeps): Promise<boolean> {
  const ceo = await ceoOf(db, d.companyId);
  if (!ceo) return false;
  const [raiser] = d.raisedByAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, d.raisedByAgentId)) : [];
  const name = raiser?.name ?? "the team";
  const ticketId = (await aboutTickets(db, d))[0] ?? null;
  const ref = await refOf(db, d.companyId, ticketId);
  // Written before the wake, so the owner hears from the facts even if no run starts; one line per card.
  try {
    await postFollowerLine(db, { companyId: d.companyId, cardId: d.id, text: resultWaitingLine(name, ceo.name, d.question, ticketId) });
  } catch (err) {
    deps.log?.(`telling the owner no result arrived on card ${d.id} failed: ${(err as Error).message}`);
  }
  const flag = resultWaitingFlag(name, ceo.name, d.question, ticketId);
  await deps.notify({ companyId: d.companyId, agentId: null, level: "flag", ...flag });
  // The CEO is woken on the ticket, so its run opens with the conversation (what the owner sent) in front of it.
  await deps.wake({ agentId: ceo.id, reason: INFO_RESULT_REASON, ticketId, priority: 4, note: ceoResultNote({ ownerVoice: "The owner", raiser: name, question: d.question, answer: d.answer ?? "", ticketId: ticketId ?? "", ref, received: true }) });
  return true;
}

/**
 * BOS-2555: the result of an information card, in the owner's chat (a line from the facts) and their feed. The first line for
 * the card is the raiser's, in their own thread; later lines go to the CEO chat, where the owner was already told it was with
 * someone. Never throws: the ticket reply itself is already saved.
 */
export async function noteResultReported(db: Db, input: { companyId: string; ticketId: string; agentId: string; text: string }, deps: { notify: (n: NotifyInput) => Promise<unknown>; log?: (m: string) => void }): Promise<boolean> {
  try {
    const cards = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.companyId, input.companyId), eq(decisions.raisedByAgentId, input.agentId), eq(decisions.status, "answered"), isNotNull(decisions.infoAskWhy)))
      .orderBy(desc(decisions.answeredAt))
      .limit(10);
    const about = await Promise.all(cards.map(async (c) => ({ card: c, tickets: await aboutTickets(db, c) })));
    const card = about.find((x) => x.tickets.includes(input.ticketId));
    if (!card) return false;
    // Cleared first, conditional on the deadline: a second reply, or the 30-minute sweep, never posts a second result.
    const [claimed] = await db
      .update(decisions)
      .set({ infoAskDueAt: null })
      .where(and(eq(decisions.id, card.card.id), isNotNull(decisions.infoAskDueAt)))
      .returning({ id: decisions.id });
    if (!claimed) return false;
    const [raiser] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, input.agentId));
    const name = raiser?.name ?? "The team";
    const ref = await refOf(db, input.companyId, input.ticketId);
    const text = short(input.text, 600);
    const [line] = await db.select({ id: ownerChatMessages.id, agentId: ownerChatMessages.agentId }).from(ownerChatMessages).where(and(eq(ownerChatMessages.companyId, input.companyId), eq(ownerChatMessages.infoAskCardId, card.card.id)));
    const body = `${name} checked what you sent. Result: ${text}${ref ? ` Ticket: #/tickets/${input.ticketId}` : ""}`;
    if (line) {
      // In the thread the owner was told it was in (the CEO chat): a message there, so it reads as the answer, not a note.
      await db.insert(ownerChatMessages).values({ companyId: input.companyId, agentId: line.agentId, role: "assistant", text: body });
    } else {
      // A card with no line to the owner (answered before this existed, or a company with no CEO chat): their own thread gets it.
      await postOwnerLine(db, { companyId: input.companyId, cardId: card.card.id, agentId: input.agentId, text: body });
    }
    await deps.notify({ companyId: input.companyId, agentId: null, level: "flag", title: `Result on "${short(card.card.question, 60)}"`, body: `${name} reported back${ref ? ` on ${ref}` : ""}: ${short(text, 400)}`, link: `#/tickets/${input.ticketId}` });
    return true;
  } catch (err) {
    deps.log?.(`posting the result of a card answer in the owner's chat failed: ${(err as Error).message}`);
    return false;
  }
}

