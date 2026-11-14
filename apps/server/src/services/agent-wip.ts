// The work-in-progress limit per agent (BOS-1029): an agent finishes before it starts more.
// One counting rule decides what counts as WIP, for a board column and for an agent alike:
// tickets whose state is in_progress (a ticket that only waits on a queued check still counts;
// review, blocked and done don't). moveTicket asks `agentWipHold` on every move into in_progress.
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { openBlockers } from "./ticket-links.js";
import { activity, agents, decisions, engagements, runs, settings, ticketDependencies, tickets, wakes } from "../db/schema.js";

/** Default tickets in progress per agent: one being worked, one waiting on its check. */
export const DEFAULT_AGENT_WIP_LIMIT = 2;

export type WipLimits = { agent: number | null; company: number | null };

/** The owner's limits from Settings; absent means the default per agent and no company-wide cap. `null` is "No limit". */
export async function readWipLimits(db: Db): Promise<WipLimits> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "wip_limits"));
  const v = row?.value as { agent?: number | null; company?: number | null } | undefined;
  return { agent: v && "agent" in v ? (v.agent ?? null) : DEFAULT_AGENT_WIP_LIMIT, company: v?.company ?? null };
}

/** The one WIP counting rule: tickets matching `where` (a board column's tickets of its state, or an agent's in-progress ones), not counting `exceptId`. */
export async function countWip(db: Db, where: SQL | undefined, exceptId?: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(where, exceptId ? ne(tickets.id, exceptId) : undefined));
  return r?.n ?? 0;
}

/**
 * In-progress tickets that can't move don't count towards a limit (BOS-1172): one with an open waits-on link to an
 * unfinished ticket, a plan-first one whose plan waits on the owner, and a merged one that only waits for its
 * after-merge (go-live) check. A ticket with only a schedule_check booked still counts: nobody visibly holds it.
 */
/** The tickets table or an alias of it (a subquery's `doing`, `mine`): only the columns the rule reads. */
type TicketsOrAlias = Record<"id" | "planFirst" | "planApprovedAt" | "plan" | "mergedAt" | "goLiveWait", SQLWrapper>;
export const cantMoveFor = (t: TicketsOrAlias) => sql`(
  exists (select 1 from ticket_dependencies d join tickets b on b.id = d.blocker_ticket_id
          where d.blocked_ticket_id = ${t.id} and b.system_state <> 'done' and not (d.until = 'merged' and b.merge_commit is not null))
  or (${t.planFirst} and ${t.planApprovedAt} is null and ${t.plan} is not null)
  or (${t.mergedAt} is not null and ${t.goLiveWait} is not null)
)`;
export const cantMoveSql = cantMoveFor(tickets);

/**
 * The ticket's request_check job is queued or running (BOS-1479): it has nothing to do but wait for the check line,
 * which can be 30 deep. Such a ticket is freed from the COMPANY limit only (`cantMoveForCompany`); it still counts toward
 * its agent's own limit, so one agent can't keep starting work and adding checks to a long queue. A merge job doesn't count:
 * a merging ticket is in review, not in progress.
 */
export const waitsOnCheckFor = (t: Pick<TicketsOrAlias, "id">) => sql`exists (select 1 from check_jobs cj where cj.ticket_id = ${t.id} and cj.kind = 'pre_review' and cj.state in ('queued', 'running'))`;
export const cantMoveForCompany = (t: TicketsOrAlias) => sql`(${cantMoveFor(t)} or ${waitsOnCheckFor(t)})`;

/** `scope: "company"` also frees tickets that only wait on a queued or running check (BOS-1479). */
export const countInProgress = (db: Db, where: SQL | undefined, exceptId?: string, scope: "agent" | "company" = "agent") =>
  countWip(db, and(eq(tickets.systemState, "in_progress"), sql`not ${scope === "company" ? cantMoveForCompany(tickets) : cantMoveSql}`, where), exceptId);

export type WipExempt = "waits" | "plan" | "live";

/** Why an in-progress ticket doesn't count towards the limit (same rule as cantMoveSql); null when it counts. `openWaits`: it has an open waits-on link to an unfinished ticket. */
export function wipExemptKind(t: { planFirst: boolean; planApprovedAt: Date | null; plan: string | null; mergedAt: Date | null; goLiveWait: string | null }, openWaits: boolean): WipExempt | null {
  if (openWaits) return "waits";
  if (t.planFirst && !t.planApprovedAt && t.plan) return "plan";
  if (t.mergedAt && t.goLiveWait) return "live";
  return null;
}

export const agentWipCount = (db: Db, agentId: string, exceptId?: string) => countInProgress(db, eq(tickets.assigneeAgentId, agentId), exceptId);

/** True when the ticket was in progress before: coming back to it is finishing, never a new start. */
export async function wasStarted(db: Db, ticketId: string): Promise<boolean> {
  const [r] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, "state"), sql`${activity.summary} like '% -> in_progress%'`)).limit(1);
  return !!r;
}

/** The status reason a wake carries when its launch was refused by a WIP limit: such a wake doesn't use up the day's idle-slot allowance (BOS-1180). */
export const WIP_REFUSED_REASON = "held by the WIP limit";

export type WipHold = { reason: string; limit: number; scope: "agent" | "company" };

/**
 * Whether a move of `t` into in_progress is a new start that the limit holds. Only backlog or ready tickets
 * are held, and never one that was in progress before. An urgent ticket may start one over (the caller
 * says so on the ticket).
 */
export async function agentWipHold(db: Db, t: typeof tickets.$inferSelect): Promise<{ hold: WipHold | null; urgentOver: boolean }> {
  const none = { hold: null, urgentOver: false };
  if (!t.assigneeAgentId || (t.systemState !== "backlog" && t.systemState !== "ready")) return none;
  if (await wasStarted(db, t.id)) return none;
  const limits = await readWipLimits(db);
  let hold: WipHold | null = null;
  if (limits.agent != null) {
    const n = await agentWipCount(db, t.assigneeAgentId, t.id);
    if (n >= limits.agent) {
      const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId));
      hold = { limit: limits.agent, scope: "agent", reason: `Waiting: ${a?.name ?? "the agent"} is at the limit of ${limits.agent} in-progress ticket${limits.agent === 1 ? "" : "s"}; starts when one finishes.` };
    }
  }
  if (!hold && limits.company != null) {
    const n = await countInProgress(db, eq(tickets.companyId, t.companyId), t.id, "company");
    if (n >= limits.company) hold = { limit: limits.company, scope: "company", reason: `Waiting: the company is at the limit of ${limits.company} in-progress tickets; starts when one finishes.` };
  }
  if (hold && t.urgent) return { hold: null, urgentOver: true };
  return { hold, urgentOver: false };
}

/** Ready tickets whose start a WIP limit has refused (`wip_held_at` set), with the limit that refuses each one now (BOS-1479). */
export async function heldReadyTickets(db: Db, companyId: string): Promise<{ ticket: typeof tickets.$inferSelect; scope: "agent" | "company" | null }[]> {
  const rows = await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "ready"), sql`${tickets.wipHeldAt} is not null`));
  const out: { ticket: typeof tickets.$inferSelect; scope: "agent" | "company" | null }[] = [];
  for (const ticket of rows) out.push({ ticket, scope: (await agentWipHold(db, ticket)).hold?.scope ?? null });
  return out;
}

/**
 * What a tool tells its caller about a ticket it has just assigned, created or nudged on: when the assignee is at its limit,
 * the ticket waits in Ready and has not started, so nobody should think it did (BOS-1029). Empty when it isn't held.
 */
export async function wipQueuedNote(db: Db, ticketId: string | null | undefined): Promise<string> {
  if (!ticketId) return "";
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return "";
  const { hold } = await agentWipHold(db, t);
  return hold ? ` Queued in Ready: the agent is at its WIP limit (${hold.limit} in-progress ticket${hold.limit === 1 ? "" : "s"}), so this has not started; it starts when one of their tickets finishes.` : "";
}

/** The agent's oldest unfinished in-progress ticket: the one a held start wakes it on instead. */
export async function oldestInProgress(db: Db, agentId: string): Promise<string | null> {
  const [r] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.assigneeAgentId, agentId), eq(tickets.systemState, "in_progress"))).orderBy(asc(tickets.createdAt)).limit(1);
  return r?.id ?? null;
}

/** Whether the ticket has an unresolved dependency: a ticket not done, an engagement not signed off, or an open decision. */
export async function ticketIsBlocked(db: Db, ticketId: string): Promise<boolean> {
  return (await openBlockers(db, ticketId)).length > 0;
}

/**
 * The one "can this Ready ticket start now?" test every start path uses (BOS-1180): the agent has no live run and no
 * queued wake, the WIP limit has room (`agentWipHold`), the ticket isn't blocked, and its plan isn't waiting for approval.
 * Whether the agent is paused or the company is paused is the sweeps' filter, not the ticket's.
 */
export async function canStartNow(db: Db, t: typeof tickets.$inferSelect): Promise<boolean> {
  if (t.systemState !== "ready" || !t.assigneeAgentId) return false;
  if (t.planFirst && !t.planApprovedAt) return false;
  const [live] = await db.select({ id: runs.id }).from(runs).where(and(isNull(runs.endedAt), or(eq(runs.agentId, t.assigneeAgentId), eq(runs.ticketId, t.id)), or(isNull(runs.purpose), sql`${runs.purpose} <> 'chat'`))).limit(1);
  if (live) return false;
  const [queued] = await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.agentId, t.assigneeAgentId), inArray(wakes.status, ["queued", "deferred"]))).limit(1);
  if (queued) return false;
  if ((await agentWipHold(db, t)).hold) return false;
  return !(await ticketIsBlocked(db, t.id));
}
