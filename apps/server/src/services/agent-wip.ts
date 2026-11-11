// The work-in-progress limit per agent (BOS-1029): an agent finishes before it starts more.
// One counting rule decides what counts as WIP, for a board column and for an agent alike:
// tickets whose state is in_progress (a ticket that only waits on a queued check still counts;
// review, blocked and done don't). moveTicket asks `agentWipHold` on every move into in_progress.
import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity, agents, settings, tickets } from "../db/schema.js";

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
export const cantMoveSql = sql`(
  exists (select 1 from ticket_dependencies d join tickets b on b.id = d.blocker_ticket_id
          where d.blocked_ticket_id = ${tickets.id} and b.system_state <> 'done' and not (d.until = 'merged' and b.merge_commit is not null))
  or (${tickets.planFirst} and ${tickets.planApprovedAt} is null and ${tickets.plan} is not null)
  or (${tickets.mergedAt} is not null and ${tickets.goLiveWait} is not null)
)`;

export const countInProgress = (db: Db, where: SQL | undefined, exceptId?: string) => countWip(db, and(eq(tickets.systemState, "in_progress"), sql`not ${cantMoveSql}`, where), exceptId);

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

/** The note a held ticket carries (see agentWipHold); the free-slot start finds held tickets by it. */
export const isWipHeldNote = (note: string | null | undefined) => !!note && /^Waiting: .* is at the limit of \d+ in-progress tickets?; starts when one finishes\.$/.test(note);

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
    const n = await countInProgress(db, eq(tickets.companyId, t.companyId), t.id);
    if (n >= limits.company) hold = { limit: limits.company, scope: "company", reason: `Waiting: the company is at the limit of ${limits.company} in-progress tickets; starts when one finishes.` };
  }
  if (hold && t.urgent) return { hold: null, urgentOver: true };
  return { hold, urgentOver: false };
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

/**
 * When a ticket leaves in_progress, the agent's oldest Ready ticket that the limit held may start.
 * Returns its id for the caller to wake the agent on, or null. Held tickets carry the "Waiting:" state note.
 */
export async function nextHeldTicket(db: Db, agentId: string): Promise<string | null> {
  const rows = await db
    .select({ id: tickets.id, note: tickets.stateNote })
    .from(tickets)
    .where(and(eq(tickets.assigneeAgentId, agentId), eq(tickets.systemState, "ready"), sql`${tickets.stateNote} like 'Waiting: %'`))
    .orderBy(asc(tickets.createdAt));
  return rows.find((r) => isWipHeldNote(r.note))?.id ?? null;
}
