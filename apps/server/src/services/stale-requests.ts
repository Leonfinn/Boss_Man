// Stale "waiting on you" requests (BOS-123): when the owner acts, open cards and state
// notes about the same ticket (or anything waiting on it) are marked possibly out of date,
// and the agent that wrote them is woken once to confirm or withdraw. A request the owner
// has already answered is refused, quoting the earlier answer.
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions, deploys, runs, ticketDependencies, ticketMessages, tickets } from "../db/schema.js";

type DecisionRow = typeof decisions.$inferSelect;

/** Wakes an agent; the scheduler's notify matches this shape. */
export type WakeFn = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number }) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tickets a decision is about: what it holds up, plus a ticket named in its context. */
export async function decisionTicketIds(db: Db, d: Pick<DecisionRow, "id" | "context">): Promise<string[]> {
  const c = d.context as { type?: string; ticketId?: unknown; runId?: string; deployId?: string; blockedTicketId?: string; engagementId?: string };
  const own = typeof c.ticketId === "string" ? [c.ticketId] : [];
  switch (c.type) {
    case "permission":
    case "stalled_run": {
      const [r] = c.runId && UUID.test(c.runId) ? await db.select({ ticketId: runs.ticketId }).from(runs).where(eq(runs.id, c.runId)) : [];
      return [...new Set([...own, ...(r?.ticketId ? [r.ticketId] : [])])];
    }
    case "deploy": {
      const [r] = c.deployId && UUID.test(c.deployId) ? await db.select({ ticketId: deploys.ticketId }).from(deploys).where(eq(deploys.id, c.deployId)) : [];
      return r?.ticketId ? [r.ticketId] : own;
    }
    case "stale_blocker":
      return [...new Set([...(c.blockedTicketId ? [c.blockedTicketId] : []), ...own])];
    case "engagement": {
      const rows = c.engagementId
        ? await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerEngagementId, c.engagementId))
        : [];
      return [...new Set([...rows.map((r) => r.id), ...own])];
    }
    default: {
      const rows = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
      return [...new Set([...rows.map((r) => r.id), ...own])];
    }
  }
}

/** Every ticket that (transitively) waits on this one, nearest first. */
export async function dependentsOf(db: Db, ticketId: string): Promise<string[]> {
  // not state: built per call and thrown away.
  const seen = new Set<string>();
  let frontier = [ticketId];
  for (let depth = 0; frontier.length && depth < 10; depth++) {
    const rows = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(inArray(ticketDependencies.blockerTicketId, frontier));
    const next = rows.map((r) => r.id).filter((id) => !seen.has(id));
    for (const id of next) seen.add(id);
    frontier = next;
  }
  return [...seen];
}

type ActedResult = { flaggedDecisions: string[]; flaggedTickets: string[]; woken: string[] };

/**
 * The owner did something on these tickets: mark open cards about them (and everything that
 * waits on them) "may be out of date", mark their state notes stale, and wake each author
 * once to confirm or withdraw. Anything already flagged is left alone, so one action is one wake.
 */
export async function ownerActed(db: Db, input: { ticketIds: string[]; reason: string; wake?: WakeFn | null; now?: Date; /** Agents already being woken for this action, so they get one note, not two. */ skipAgents?: Array<string | null> }): Promise<ActedResult> {
  const now = input.now ?? new Date();
  const roots = [...new Set(input.ticketIds.filter((id): id is string => !!id))];
  if (!roots.length) return { flaggedDecisions: [], flaggedTickets: [], woken: [] };
  const dependents = (await Promise.all(roots.map((id) => dependentsOf(db, id)))).flat();
  const scope = [...new Set([...roots, ...dependents])];

  // A finished ticket's own note no longer matters; the ones that wait on it do.
  const noted = await db
    .select({ id: tickets.id, assigneeAgentId: tickets.assigneeAgentId, state: tickets.systemState })
    .from(tickets)
    .where(and(inArray(tickets.id, scope), isNull(tickets.stateNoteStaleAt), sql`${tickets.stateNote} is not null`, ne(tickets.systemState, "done")));
  const flaggedTickets = noted.map((n) => n.id);
  if (flaggedTickets.length) await db.update(tickets).set({ stateNoteStaleAt: now }).where(inArray(tickets.id, flaggedTickets));

  const open = await db.select({ id: decisions.id, raisedByAgentId: decisions.raisedByAgentId, context: decisions.context }).from(decisions).where(and(eq(decisions.status, "open"), isNull(decisions.staleAt)));
  const flagged: typeof open = [];
  for (const d of open) {
    const ids = await decisionTicketIds(db, d);
    if (ids.some((id) => scope.includes(id))) flagged.push(d);
  }
  const flaggedDecisions = flagged.map((d) => d.id);
  if (flaggedDecisions.length) await db.update(decisions).set({ staleAt: now, staleReason: input.reason }).where(inArray(decisions.id, flaggedDecisions));

  // One wake per agent, naming what changed and what to do about it.
  const skip = new Set(input.skipAgents?.filter((id): id is string => !!id) ?? []);
  // not state: built per call and thrown away.
  const targets = new Map<string, { ticketId: string | null }>();
  for (const d of flagged) if (d.raisedByAgentId && !skip.has(d.raisedByAgentId) && !targets.has(d.raisedByAgentId)) targets.set(d.raisedByAgentId, { ticketId: null });
  for (const n of noted) if (n.assigneeAgentId && !skip.has(n.assigneeAgentId) && !targets.has(n.assigneeAgentId)) targets.set(n.assigneeAgentId, { ticketId: n.id });
  const woken: string[] = [];
  if (input.wake) {
    for (const [agentId, target] of targets) {
      const w = await input.wake({
        agentId,
        ticketId: target.ticketId,
        reason: "stale request",
        note: [
          `The owner acted (${input.reason}), so a decision card or the state note you left may now be out of date.`,
          "Check the live state before you repeat anything to them: their latest answers, what's deployed, and whether the tickets involved are done.",
          "If what you asked for is done, take the card back with withdraw_decision and update the ticket's state note in this run. If it still needs them, say so plainly and don't repeat an old \"waiting on you\" note.",
        ].join("\n"),
      });
      if (!w || (typeof w === "object" && "status" in w && (w as { status?: string }).status === "dropped")) continue;
      woken.push(agentId);
    }
  }
  return { flaggedDecisions, flaggedTickets, woken };
}

export type OwnerAnswer = { kind: "decision" | "message"; question: string | null; answer: string; at: Date };

/** The latest thing the owner said or answered on these tickets recently, for the duplicate check. */
export async function recentOwnerAnswer(db: Db, input: { companyId: string; ticketIds: string[]; since?: Date; /** Count what the owner wrote on the ticket as well as answered decisions; off for the duplicate-ask check. */ includeMessages?: boolean }): Promise<OwnerAnswer | null> {
  const ids = [...new Set(input.ticketIds.filter((id): id is string => !!id))];
  if (!ids.length) return null;
  const since = input.since ?? new Date(Date.now() - 7 * 86_400_000);
  const found: OwnerAnswer[] = [];

  const answered = await db
    .select({ id: decisions.id, context: decisions.context, question: decisions.question, answer: decisions.answer, answeredAt: decisions.answeredAt })
    .from(decisions)
    .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "answered"), gt(decisions.answeredAt, since)))
    .orderBy(desc(decisions.answeredAt));
  for (const d of answered) {
    if (!d.answer || !d.answeredAt) continue;
    const about = await decisionTicketIds(db, d);
    if (about.some((id) => ids.includes(id))) found.push({ kind: "decision", question: d.question, answer: d.answer, at: d.answeredAt });
  }

  if (input.includeMessages !== false) {
    const said = await db
      .select({ text: ticketMessages.text, at: ticketMessages.createdAt })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.companyId, input.companyId), eq(ticketMessages.author, "owner"), inArray(ticketMessages.ticketId, ids), gt(ticketMessages.createdAt, since)))
      .orderBy(desc(ticketMessages.createdAt));
    for (const m of said) found.push({ kind: "message", question: null, answer: m.text, at: m.at });
  }

  return found.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
}

/** A short quoted reading of an earlier owner answer, for a refusal or a card. */
export function quotedAnswer(a: OwnerAnswer, at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ")): string {
  const what = a.kind === "decision" && a.question ? `your question "${a.question}"` : "this ticket";
  return `The owner already answered ${what} on ${at(a.at)} UTC: "${a.answer}"`;
}
