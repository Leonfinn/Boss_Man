// The owner's messages on tickets, answered (BOS-425). An owner message either goes into a live
// run, becomes a new run, or (with no assignee) reaches nobody; until this, nothing tracked whether
// anyone replied. An open row in ownerReplies is the awaiting-reply marker: an agent's ticket_reply
// on that ticket clears every open row it can answer.
//
// If nobody answers: a run that received it live and ended without a reply re-wakes its agent at
// top priority (once); at five minutes a target with no live run on the ticket is woken again in
// the owner's wake class; at ten minutes the CEO is asked to answer on the target's behalf (the
// Scrum Master when the CEO is the target). The message is never dropped, and nothing goes to the
// owner: the ticket shows the message's state under it.
import { ageWords, formatDate } from "@boss-man/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, ownerReplies, runs, ticketMessages, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import { SCRUM_MASTER_DUTY } from "./watchdog.js";

/** How long before the re-wake and the stand-in; tests move a clock through them. */
export type OwnerReplyLimits = { sweepAfterMs: number; standInAfterMs: number };
export const DEFAULT_OWNER_REPLY_LIMITS: OwnerReplyLimits = { sweepAfterMs: 5 * 60_000, standInAfterMs: 10 * 60_000 };

/** A time in plain words, in UTC like the rest of the server's notes: "today at 14:05", "tomorrow at 09:00", "on 6 Nov at 09:00". */
const plainWhen = (d: Date, now: Date) => {
  const hhmm = d.toISOString().slice(11, 16);
  const day = (x: Date) => x.toISOString().slice(0, 10);
  if (day(d) === day(now)) return `today at ${hhmm}`;
  if (day(d) === day(new Date(now.getTime() + 86_400_000))) return `tomorrow at ${hhmm}`;
  return `on ${formatDate("en-GB", d, { day: "numeric", month: "short", timeZone: "UTC" })} at ${hhmm}`;
};

const ago = (ms: number) => ageWords(ms);

export function ownerRepliesService(
  db: Db,
  opts: {
    /** The same wake the ticket chat uses, so the owner class and priority are the scheduler's call. */
    notify: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
    /** Raises the CEO/SM ask on the ladder; its note carries who has the ticket and when they are expected. */
    alert: (input: { companyId: string; question: string; ticketId: string; about: string[]; from?: "scrum_master" | "ceo" | "owner"; /** A note on why the ask started where it did, kept on the ladder. */ why?: string; dedupeKey: string; context?: Record<string, unknown> }) => Promise<{ id: string } | null>;
    limits?: Partial<OwnerReplyLimits>;
    now?: () => Date;
  },
) {
  const limits = { ...DEFAULT_OWNER_REPLY_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  /** A run on the ticket that hasn't ended (chat runs aren't ticket work); the agent's own when given. */
  async function liveRun(ticketId: string, agentId?: string | null) {
    const [live] = await db
      .select({ id: runs.id, agentId: runs.agentId })
      .from(runs)
      .where(and(eq(runs.ticketId, ticketId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat")), agentId ? eq(runs.agentId, agentId) : undefined))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    return live ?? null;
  }

  async function agentName(agentId: string | null) {
    if (!agentId) return null;
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
    return a?.name ?? null;
  }

  /**
   * Records an open message: the row is the marker, and `delivery` says how the message reached
   * its target. A second message into the same live run shares that run's fate, so the older row
   * takes the newer delivery (the run carries both, and answering clears both).
   */
  async function opened(input: { companyId: string; ticketId: string; messageId: string; agentId: string | null; delivery: "live" | "woken" | "queued" | "unassigned"; runId?: string | null }) {
    if (input.delivery === "unassigned" || !input.agentId) return null;
    const runId = input.delivery === "live" ? (input.runId ?? null) : null;
    if (runId) {
      const same = await db.select({ id: ownerReplies.id }).from(ownerReplies).where(and(eq(ownerReplies.ticketId, input.ticketId), eq(ownerReplies.agentId, input.agentId), eq(ownerReplies.runId, runId), isNull(ownerReplies.clearedAt)));
      if (same.length) {
        await db.update(ownerReplies).set({ state: "delivered", reminders: 0 }).where(inArray(ownerReplies.id, same.map((r) => r.id)));
        return same[0]!;
      }
    }
    // The caller knows how it reached the target: into a live run, a new run now, or queued behind
    // the target's work on another ticket. Stored as given, so the ticket shows the truth.
    const [row] = await db
      .insert(ownerReplies)
      .values({ companyId: input.companyId, ticketId: input.ticketId, messageId: input.messageId, agentId: input.agentId, state: input.delivery === "queued" ? "queued" : "delivered", runId })
      .returning();
    return row ?? null;
  }

  /** The company's chief executive, or failing that whoever holds the Scrum Master's duty: who answers for someone else. */
  async function isStandIn(companyId: string, agentId: string) {
    const [a] = await db.select({ role: agents.role, duty: agents.duty }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.retiredAt)));
    return !!a && (a.role === "ceo" || a.duty === SCRUM_MASTER_DUTY);
  }

  /**
   * An agent posted on the ticket: every open message it can answer is answered. The one whose
   * target it is, always; the CEO's or the Scrum Master's answer counts for any of them, since
   * they stand in for the target when it can't answer.
   */
  async function clearOnReply(input: { ticketId: string; agentId: string | null }) {
    if (!input.agentId) return 0;
    const open = await db.select({ id: ownerReplies.id, agentId: ownerReplies.agentId, companyId: ownerReplies.companyId }).from(ownerReplies).where(and(eq(ownerReplies.ticketId, input.ticketId), isNull(ownerReplies.clearedAt)));
    if (!open.length) return 0;
    const mine = open.filter((r) => r.agentId === input.agentId);
    const others = open.filter((r) => r.agentId !== input.agentId);
    const standIn = others.length ? await isStandIn(open[0]!.companyId, input.agentId) : false;
    const ids = [...mine, ...(standIn ? others : [])].map((r) => r.id);
    if (!ids.length) return 0;
    await db.update(ownerReplies).set({ clearedAt: now(), clearedBy: standIn && !mine.length ? "stand_in" : "reply", ...(standIn ? { standInAgentId: input.agentId } : {}) }).where(inArray(ownerReplies.id, ids));
    return ids.length;
  }

  /** When a queued target is expected to get to it: what it is on now, or the next thing it was woken about. */
  async function expectedAt(agentId: string, t: Date) {
    const [live] = await db
      .select({ ticket: tickets.title, startedAt: runs.startedAt })
      .from(runs)
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .where(and(eq(runs.agentId, agentId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    if (live) return live.ticket ? `now, working on "${live.ticket}" (started ${ago(t.getTime() - live.startedAt.getTime())} ago), so after that finishes` : "now, on another task, so after that finishes";
    const [next] = await db
      .select({ at: wakes.notBefore })
      .from(wakes)
      .where(and(eq(wakes.agentId, agentId), inArray(wakes.status, ["queued", "deferred"]), gt(wakes.notBefore, t)))
      .orderBy(asc(wakes.notBefore))
      .limit(1);
    return next?.at ? `when their current work is done, about ${plainWhen(next.at, t)}` : "as soon as their other work is done";
  }

  /**
   * Which rung holds the stand-in ask, and who it may wake: the CEO, or the Scrum Master when the
   * CEO is the target. It is a message, not a watch problem, so the CEO is asked directly (the
   * ladder's CEO rung) however busy the Scrum Master is. The ladder's "about" list keeps the target
   * from being asked; and since a skip on the last rung would hand the card to the owner, an ask
   * about the CEO is "about" no agent at all (it is about the ticket), which the CEO rung takes.
   */
  async function standInFor(companyId: string, targetAgentId: string | null) {
    const [ceo] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (ceo && targetAgentId === ceo.id) return { from: "scrum_master" as const, about: [], why: "the CEO is the target", standIn: null as string | null };
    return { from: "ceo" as const, about: targetAgentId ? [targetAgentId] : [], why: undefined, standIn: ceo?.id ?? null };
  }

  /**
   * A run that received an owner message live and ended without a reply (a ticket_reply) re-wakes
   * its agent straight away, at top priority. Once per run: a second silent run is the sweep's
   * business.
   */
  async function afterRunEnded(runId: string) {
    const [run] = await db.select({ id: runs.id, ticketId: runs.ticketId, agentId: runs.agentId, endedAt: runs.endedAt }).from(runs).where(eq(runs.id, runId));
    if (!run?.ticketId || !run.endedAt || !run.agentId) return 0;
    const open = await db
      .select({ id: ownerReplies.id, companyId: ownerReplies.companyId })
      .from(ownerReplies)
      .where(and(eq(ownerReplies.ticketId, run.ticketId), eq(ownerReplies.agentId, run.agentId), eq(ownerReplies.runId, run.id), isNull(ownerReplies.clearedAt), eq(ownerReplies.reminders, 0)));
    if (!open.length) return 0;
    // The first to claim the rows wakes the agent; a run reported ended twice does nothing the second time.
    const claimed = await db.update(ownerReplies).set({ reminders: 1 }).where(and(inArray(ownerReplies.id, open.map((r) => r.id)), eq(ownerReplies.reminders, 0))).returning({ id: ownerReplies.id });
    if (!claimed.length) return 0;
    const name = await agentName(run.agentId);
    const [t] = await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, run.ticketId));
    await opts
      .notify(run.agentId, { ticketId: run.ticketId, reason: "message", priority: 4, note: "The owner wrote to you on this ticket and your run ended without an answer. Read the conversation and answer with ticket_reply before doing anything else." })
      .catch(() => undefined);
    await record(db, { companyId: open[0]!.companyId, agentId: null, ticketId: run.ticketId, kind: "message", summary: `The run on "${t?.title ?? "a ticket"}" ended without answering the owner, so ${name ?? "the agent"} was woken to answer.` });
    return claimed.length;
  }

  /** Asks the CEO (or the Scrum Master) to answer for the target, with who has the ticket and when. Marks the row. */
  async function standIn(row: typeof ownerReplies.$inferSelect, targetName: string | null, t: Date) {
    const [ticket] = await db.select({ title: tickets.title, state: tickets.systemState }).from(tickets).where(eq(tickets.id, row.ticketId));
    const when = await expectedAt(row.agentId!, t);
    const question = `The owner wrote on "${ticket?.title ?? "a ticket"}" ${ago(t.getTime() - row.createdAt.getTime())} ago and nobody has answered. ${targetName ?? "The agent it was sent to"} holds the ticket: ${when}. Read the message in the ticket's conversation and answer it with ticket_reply for them, saying who has the ticket and when they will get to it${ticket?.state === "done" ? "; the ticket is already done" : ""}.`;
    const where = await standInFor(row.companyId, row.agentId);
    const decision = await opts.alert({ companyId: row.companyId, ticketId: row.ticketId, question, about: where.about, from: where.from, ...(where.why ? { why: where.why } : {}), dedupeKey: `owner-reply:${row.id}`, context: { type: "question", ownerReplyId: row.id } });
    if (!decision) return false;
    // Claimed whatever the earlier steps did: 0 (never re-woken: a live run, a paused target, a
    // dropped wake) or 1 (re-woken once). Only the first claim raises the ask.
    const claimed = await db.update(ownerReplies).set({ reminders: 2, alertDecisionId: decision.id, standInAgentId: where.standIn }).where(and(eq(ownerReplies.id, row.id), lt(ownerReplies.reminders, 2))).returning({ id: ownerReplies.id });
    if (!claimed.length) return false;
    await record(db, { companyId: row.companyId, agentId: null, ticketId: row.ticketId, kind: "message", summary: `The owner's message on "${ticket?.title ?? "a ticket"}" was unanswered after 10 minutes, so the CEO (or the Scrum Master, when the CEO holds the ticket) was asked to answer for ${targetName ?? "the agent"}.` });
    return true;
  }

  /**
   * The sweep (BOS-425). Two steps, each with its own age check so an early step's guard never
   * blocks a later one: at five minutes, a target with no live run on the ticket (and not paused or
   * retired) is woken again in the owner's wake class; at ten, whatever the target is doing, the
   * CEO (or the Scrum Master when the CEO is the target) is asked to answer on its behalf. Nothing
   * is sent to the owner: the ticket shows the state under the message.
   */
  async function sweep(t: Date = now()) {
    const result = { rewoken: 0, standIns: 0 };
    const open = await db.select().from(ownerReplies).where(isNull(ownerReplies.clearedAt));
    for (const row of open) {
      // A message that reached nobody (no assignee) is a note; there is no one to chase.
      if (!row.agentId) continue;
      const age = t.getTime() - row.createdAt.getTime();
      const [target] = await db.select({ name: agents.name, paused: agents.paused, retiredAt: agents.retiredAt }).from(agents).where(eq(agents.id, row.agentId));
      const [ticket] = await db.select({ title: tickets.title, state: tickets.systemState }).from(tickets).where(eq(tickets.id, row.ticketId));

      // Five minutes: only when nothing runs for the target on this ticket, so a working run is
      // never interrupted. A paused or retired target is not woken (nothing would come of it); the
      // ten-minute stand-in below still covers it. A run that was re-woken after ending silently
      // (reminders 1) is not woken again here: that was the one retry (spec step 2).
      if (row.reminders < 1 && age >= limits.sweepAfterMs && target && !target.retiredAt && !target.paused && !(await liveRun(row.ticketId, row.agentId))) {
        const woke = await opts
          .notify(row.agentId, {
            ticketId: row.ticketId,
            reason: "woken by owner",
            priority: 3,
            note: `The owner wrote to you on "${ticket?.title ?? "this ticket"}" ${ago(age)} ago and nothing has answered. Read it in the conversation and answer with ticket_reply${ticket?.state === "done" ? "; the ticket is already done, so a short answer is enough" : ""}.`,
          })
          .then(
            (w) => (w as { outcome?: string } | null)?.outcome !== "dropped",
            () => false,
          );
        // A dropped wake is not a second chance spent (the 10-minute ask does not depend on it).
        if (woke) {
          const claimed = await db.update(ownerReplies).set({ reminders: 1 }).where(and(eq(ownerReplies.id, row.id), eq(ownerReplies.reminders, 0))).returning({ id: ownerReplies.id });
          if (claimed.length) {
            result.rewoken++;
            await record(db, { companyId: row.companyId, agentId: null, ticketId: row.ticketId, kind: "message", summary: `The owner's message on "${ticket?.title ?? "a ticket"}" was unanswered after ${ago(age)}, so ${target.name} was woken again.` });
          }
        }
      }

      // Ten minutes: the stand-in answers for the target. Unconditional on the 5-minute step: a
      // live silent run, a paused or retired target, or a dropped re-wake must all reach it.
      if (age >= limits.standInAfterMs && row.reminders < 2) {
        if (await standIn(row, target && !target.retiredAt ? target.name : null, t)) result.standIns++;
      }
    }
    return result;
  }

  return { limits, opened, clearOnReply, afterRunEnded, sweep };
}

export type OwnerRepliesService = ReturnType<typeof ownerRepliesService>;
