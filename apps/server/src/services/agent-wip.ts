// The work-in-progress limit per agent (BOS-1029): an agent finishes before it starts more.
// One counting rule decides what counts as WIP, for a board column and for an agent alike:
// tickets whose state is in_progress (a ticket that only waits on a queued check still counts;
// review, blocked and done don't). moveTicket asks `agentWipHold` on every move into in_progress.
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { figureText, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { openBlockers } from "./ticket-links.js";
import { ticketBlockerOpenSql } from "./blocker-sql.js";
import { activity, agents, companies, decisions, engagements, runs, settings, ticketDependencies, tickets, wakes } from "../db/schema.js";

/** Default tickets in progress per agent: one being worked, one waiting on its check. */
export const DEFAULT_AGENT_WIP_LIMIT = 2;

export type WipLimits = { agent: number | null; company: number | null };

/** The owner's limits from Settings; absent means the default per agent and no company-wide cap. `null` is "No limit". */
export async function readWipLimits(db: Db): Promise<WipLimits> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "wip_limits"));
  const v = row?.value as { agent?: number | null; company?: number | null } | undefined;
  return { agent: v && "agent" in v ? (v.agent ?? null) : DEFAULT_AGENT_WIP_LIMIT, company: v?.company ?? null };
}

/**
 * BOS-2875 / BOS-2911: for each ready ticket whose assignee already has `agentLimit` tickets counting toward their limit, the
 * refs of those tickets ("BOS-4", "BOS-9"): it is queued behind them. Tickets under their limit, or with no assignee, are left out.
 */
export async function queuedBehindByTicket(
  db: Db,
  ready: Array<{ id: string; assigneeAgentId: string | null }>,
  prefix: string | null | undefined,
  agentLimit: number | null,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const assignees = [...new Set(ready.map((r) => r.assigneeAgentId).filter((x): x is string => !!x))];
  if (agentLimit == null || !assignees.length) return out;
  const counting = await db
    .select({ assigneeAgentId: tickets.assigneeAgentId, number: tickets.number })
    .from(tickets)
    .where(and(inArray(tickets.assigneeAgentId, assignees), eq(tickets.systemState, "in_progress"), sql`not ${cantMoveSql}`))
    .orderBy(asc(tickets.number));
  const refsBy = new Map<string, string[]>();
  for (const w of counting) refsBy.set(w.assigneeAgentId!, [...(refsBy.get(w.assigneeAgentId!) ?? []), ticketRef(prefix, w.number) ?? `#${w.number}`]);
  for (const r of ready) {
    const refs = r.assigneeAgentId ? refsBy.get(r.assigneeAgentId) : undefined;
    if (refs && refs.length >= agentLimit) out.set(r.id, refs);
  }
  return out;
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
 * unfinished ticket, a plan-first one whose plan waits on the owner, and any merged one (BOS-1907: it only waits for its
 * after-merge check or watch, whether or not it is live yet). A ticket with only a schedule_check booked still counts: nobody visibly holds it.
 */
/** The tickets table or an alias of it (a subquery's `doing`, `mine`): only the columns the rule reads. */
type TicketsOrAlias = Record<"id" | "planFirst" | "planApprovedAt" | "plan" | "mergedAt" | "goLiveWait" | "assigneeAgentId", SQLWrapper>;
/**
 * BOS-1908: the assignee has a live run that isn't a chat on another ticket, so this one is parked behind it ("Agent busy on
 * BOS-N") and counts toward no limit until its agent is free. Same run rule as `isWorkingRun` and `agentBusy`. A run on a ticket still
 * waiting in Backlog or Ready (a start the limit held, woken to carry on with older work) is not "busy on" it: that agent is working its in-progress tickets.
 */
export const agentBusyElsewhereFor = (t: Pick<TicketsOrAlias, "id" | "assigneeAgentId">) => sql`exists (
  select 1 from runs br join tickets brt on brt.id = br.ticket_id
  where br.agent_id = ${t.assigneeAgentId} and br.ended_at is null and br.ticket_id <> ${t.id}
  and (br.purpose is null or br.purpose <> 'chat') and brt.system_state not in ('backlog', 'ready')
)`;
export const cantMoveFor = (t: TicketsOrAlias) => sql`(
  exists (select 1 from ticket_dependencies d join tickets b on b.id = d.blocker_ticket_id
          where d.blocked_ticket_id = ${t.id} and ${ticketBlockerOpenSql("d", "b")})
  or (${t.planFirst} and ${t.planApprovedAt} is null and ${t.plan} is not null)
  or ${t.mergedAt} is not null
  or ${agentBusyElsewhereFor(t)}
)`;
export const cantMoveSql = cantMoveFor(tickets);

/**
 * The SQL twin of the non-ticket half of `openBlockers`: an open decision or an engagement not signed off holds the
 * ticket (nothing will start it), so an agent whose only work is held that way is idle, not busy (DR-061 Q3). Kept out of
 * `cantMoveFor` so the WIP count, which only the ticket links and plan/go-live waits free, doesn't move.
 */
export const heldByCardFor = (t: Pick<TicketsOrAlias, "id">) => sql`exists (
  select 1 from ticket_dependencies hd
  left join decisions hdec on hdec.id = hd.blocker_decision_id
  left join engagements heng on heng.id = hd.blocker_engagement_id
  where hd.blocked_ticket_id = ${t.id} and (hdec.status = 'open' or (heng.id is not null and heng.status <> 'signed_off'))
)`;
/** Whether an in-progress or ready ticket is something nobody can work on now: it can't move, or a card or engagement holds it. */
export const nothingToDoFor = (t: TicketsOrAlias) => sql`(${cantMoveFor(t)} or ${heldByCardFor(t)})`;

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

export type WipExempt = "waits" | "plan" | "live" | "busy";

/** Why an in-progress ticket doesn't count towards the limit (same rule as cantMoveSql); null when it counts. `openWaits`: it has an open waits-on link to an unfinished ticket. `busyOn`: its agent is running this other ticket (BOS-1908). */
export function wipExemptKind(t: { planFirst: boolean; planApprovedAt: Date | null; plan: string | null; mergedAt: Date | null; goLiveWait: string | null }, openWaits: boolean, busyOn: string | null = null): WipExempt | null {
  if (openWaits) return "waits";
  if (t.planFirst && !t.planApprovedAt && t.plan) return "plan";
  if (t.mergedAt) return "live";
  if (busyOn) return "busy";
  return null;
}

export const agentWipCount = (db: Db, agentId: string, exceptId?: string) => countInProgress(db, eq(tickets.assigneeAgentId, agentId), exceptId);

/**
 * BOS-1906: tickets an agent has in "Being checked" (in review, held for a quick check). They count toward neither WIP limit
 * (they are not in progress), and since BOS-2385 they no longer hold the agent's next start either; only displays read this.
 */
export const beingCheckedCount = (db: Db, agentId: string, exceptId?: string) =>
  countWip(db, and(eq(tickets.systemState, "review"), isNotNull(tickets.checkHoldAt), eq(tickets.assigneeAgentId, agentId)), exceptId);

/** True when the ticket was in progress before: coming back to it is finishing, never a new start. */
export async function wasStarted(db: Db, ticketId: string): Promise<boolean> {
  const [r] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, "state"), sql`${activity.summary} like '% -> in_progress%'`)).limit(1);
  return !!r;
}

/** The status reason a wake carries when its launch was refused by a WIP limit: such a wake doesn't use up the day's idle-slot allowance (BOS-1180). */
export const WIP_REFUSED_REASON = "held by the WIP limit";

/** `next_up` (BOS-1908): the agent is running another ticket. `second`: it already has a Next up, so this one waits unmarked behind it. */
export type WipHold = { reason: string; limit: number; scope: "agent" | "company" | "queue" | "next_up"; second?: boolean };

/** How long a Next up may wait before the CEO is asked (BOS-1908). */
export const NEXT_UP_STALE_MS = 24 * 3_600_000;

/** The ticket a live, non-chat run of the agent is on, other than `exceptTicketId`: why a new start has to wait. Null when the agent isn't running another ticket. */
export async function runningOtherTicket(db: Db, agentId: string, exceptTicketId: string): Promise<{ id: string; ref: string } | null> {
  const [r] = await db
    .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix })
    .from(runs)
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(eq(runs.agentId, agentId), isNull(runs.endedAt), workingRunSql, ne(runs.ticketId, exceptTicketId)))
    .orderBy(asc(runs.startedAt))
    .limit(1);
  return r ? { id: r.id, ref: ticketRef(r.prefix, r.number) ?? "another ticket" } : null;
}

/**
 * BOS-1908: a start for an agent that is running another ticket waits in Ready as that agent's one "Next up"; a second start for
 * the same busy agent waits unmarked behind it (and says so). Null when the agent isn't running another ticket.
 */
async function nextUpHold(db: Db, t: typeof tickets.$inferSelect): Promise<WipHold | null> {
  if (!t.assigneeAgentId) return null;
  const other = await runningOtherTicket(db, t.assigneeAgentId, t.id);
  if (!other) return null;
  const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId));
  const name = a?.name ?? "the agent";
  const [taken] = await db
    .select({ number: tickets.number, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(eq(tickets.assigneeAgentId, t.assigneeAgentId), eq(tickets.systemState, "ready"), isNotNull(tickets.nextUpAt), ne(tickets.id, t.id)))
    .orderBy(asc(tickets.nextUpAt))
    .limit(1);
  if (taken) return { scope: "next_up", limit: 1, second: true, reason: `Waiting: ${name} is busy on ${other.ref} and already has ${ticketRef(taken.prefix, taken.number) ?? "another ticket"} as Next up; this one starts after it.` };
  return { scope: "next_up", limit: 1, reason: `Next up for ${name}: starts when ${name} finishes ${other.ref}.` };
}

/**
 * The counts the start hold reads (BOS-1489): approved merges waiting in the merge line (the Merge queue page's own
 * figure, `mergeQueue.waitingCount`) and quick checks queued in the check queue. BOS-2196 adds the cards that need the
 * owner (the Dashboard's Needs you figure, `queueTally().open`), read only when `want.owner` asks for it. app.ts registers
 * the source at start-up, so this module needs no second way to count; with none registered, nothing is held.
 */
export type StartHoldCounts = (companyId: string, want?: { owner?: boolean }) => Promise<{ merges: number; quickChecks: number; ownerWaiting?: number }>;
// shortcut: one source per server process, set once by app.ts at start-up; lost on restart, harmless because start-up registers it again.
let startHoldCounts: StartHoldCounts | null = null;
export function setStartHoldCounts(fn: StartHoldCounts | null): void {
  startHoldCounts = fn;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What passes every start limit of queueStartHold: merges waiting, quick checks queued and cards that need the owner
 * (BOS-2196, BOS-2201: one rule for all three, so they can't drift apart; don't add a per-limit exemption beside it).
 * An urgent ticket, one that fixes a live problem (`fixesLive`, as in BOS-2088: it must reach the next deploy, not wait
 * behind a merge jam), or one assigned to the CEO (mostly no-code trackers such as the merge shepherd, which add no
 * merges and are needed most when the line is jammed). Work already started (review fixes, owner replies) never reaches
 * a start hold at all (`wasStarted`).
 */
export async function startHoldExempt(db: Db, t: Pick<typeof tickets.$inferSelect, "urgent" | "fixesLive" | "assigneeAgentId">): Promise<boolean> {
  if (t.urgent || !!t.fixesLive?.trim()) return true;
  if (!t.assigneeAgentId) return false;
  const [a] = await db.select({ role: agents.role }).from(agents).where(eq(agents.id, t.assigneeAgentId));
  return a?.role === "ceo";
}

/**
 * "Held: 31 merges waiting (limit 20)" when the company's merge line is at or over its setting, and the same for queued
 * quick checks and for cards that need the owner ("6 need you (limit 5)", the Dashboard badge's own words, R43); every one
 * that applies is named. Null when no setting is on, every count is under its limit, or the ticket passes them all.
 */
export async function queueStartHold(db: Db, t: Pick<typeof tickets.$inferSelect, "companyId" | "urgent" | "fixesLive" | "assigneeAgentId">): Promise<WipHold | null> {
  if (!startHoldCounts) return null;
  const [c] = await db.select({ merges: companies.holdStartsMergesWaiting, checks: companies.holdStartsQuickChecksQueued, owner: companies.holdStartsOwnerWaiting }).from(companies).where(eq(companies.id, t.companyId));
  if (!c || (c.merges == null && c.checks == null && c.owner == null)) return null;
  // One exemption for all three limits (BOS-2201), read only when a limit is on.
  if (await startHoldExempt(db, t)) return null;
  const { merges, checks, owner } = c;
  const counts = await startHoldCounts(t.companyId, { owner: owner != null });
  const parts: string[] = [];
  let limit = 0;
  if (merges != null && counts.merges >= merges) { parts.push(`${plural(counts.merges, "merge", "merges")} waiting (limit ${merges})`); limit = merges; }
  if (checks != null && counts.quickChecks >= checks) { parts.push(`${plural(counts.quickChecks, "quick check", "quick checks")} queued (limit ${checks})`); limit ||= checks; }
  const ownerOver = owner != null && counts.ownerWaiting != null && counts.ownerWaiting >= owner;
  if (ownerOver) { parts.push(`${figureText("decisions.needYou", counts.ownerWaiting!)} (limit ${owner})`); limit ||= owner!; }
  if (!parts.length) return null;
  const when = ownerOver && parts.length === 1 ? "when fewer need you" : "when the line is shorter";
  return { scope: "queue", limit, reason: `Held: ${parts.join("; ")}. It starts by itself ${when}.` };
}

/**
 * Whether a move of `t` into in_progress is a new start that the limit holds. Only backlog or ready tickets
 * are held, and never one that was in progress before. An urgent ticket may start one over (the caller
 * says so on the ticket).
 */
export async function agentWipHold(db: Db, t: typeof tickets.$inferSelect, opts: { by?: string | null } = {}): Promise<{ hold: WipHold | null; urgentOver: boolean }> {
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
    // BOS-2385: tickets "Being checked" (in review, waiting on a queued quick check) no longer hold the next start: waiting for checks is not in progress.
  }
  if (!hold && limits.company != null) {
    const n = await countInProgress(db, eq(tickets.companyId, t.companyId), t.id, "company");
    if (n >= limits.company) hold = { limit: limits.company, scope: "company", reason: `Waiting: the company is at the limit of ${limits.company} in-progress tickets; starts when one finishes.` };
  }
  if (hold && t.urgent) return { hold: null, urgentOver: true };
  // The queue hold (BOS-1489) is checked first and named first: a long merge line is why nothing starts, whatever the agent's own room.
  // An urgent ticket carries on, as it does over a WIP limit; work already started never reaches here (wasStarted above).
  // BOS-2201: queueStartHold lets urgent, live-fix and CEO tickets past all three of its limits (startHoldExempt).
  const queue = await queueStartHold(db, t);
  if (queue) return { hold: queue, urgentOver: false };
  // BOS-1908: the agent is running another ticket, so a start for it waits as its Next up. A limit's own hold above wins; an urgent
  // ticket and the agent's own move of its own ticket start as before (parked in progress).
  if (!hold && !t.urgent && !(opts.by && opts.by === t.assigneeAgentId)) hold = await nextUpHold(db, t);
  return { hold, urgentOver: false };
}

/** Ready tickets whose start a WIP limit has refused (`wip_held_at` set), with the limit that refuses each one now (BOS-1479). */
export async function heldReadyTickets(db: Db, companyId: string): Promise<{ ticket: typeof tickets.$inferSelect; scope: WipHold["scope"] | null }[]> {
  const rows = await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "ready"), sql`${tickets.wipHeldAt} is not null`));
  const out: { ticket: typeof tickets.$inferSelect; scope: WipHold["scope"] | null }[] = [];
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
  if (hold?.scope === "queue" || hold?.scope === "next_up") return ` Queued in Ready, not started. ${hold.reason}`;
  return hold ? ` Queued in Ready: the agent is at its WIP limit (${hold.limit} in-progress ticket${hold.limit === 1 ? "" : "s"}), so this has not started; it starts when one of their tickets finishes.` : "";
}

/**
 * The agent's oldest in-progress ticket that can move (not cantMoveSql: waiting on an unfinished ticket, a plan, a
 * go-live check): the one a held start tells it to carry on with. Never names a ticket nobody can work on (DR-061 Q3).
 */
export async function oldestMovableInProgress(db: Db, agentId: string): Promise<string | null> {
  const [r] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.assigneeAgentId, agentId), eq(tickets.systemState, "in_progress"), sql`not ${cantMoveSql}`)).orderBy(asc(tickets.createdAt)).limit(1);
  return r?.id ?? null;
}

/** A run that makes an agent busy: a live run that isn't a chat. The one definition (SQL, JS and the sets below agree). */
export const isWorkingRun = (r: { purpose: string | null }): boolean => r.purpose !== "chat";
const workingRunSql = or(isNull(runs.purpose), sql`${runs.purpose} <> 'chat'`);

/**
 * Whether the agent is busy (DR-061 Q3): a live run that isn't a chat, or any queued or deferred wake. `ticketId`
 * also counts a live run on that ticket by another agent. Every "is this agent idle?" question asks this one answer.
 */
export async function agentBusy(db: Db, agentId: string, ticketId?: string): Promise<boolean> {
  const [live] = await db.select({ id: runs.id }).from(runs).where(and(isNull(runs.endedAt), ticketId ? or(eq(runs.agentId, agentId), eq(runs.ticketId, ticketId)) : eq(runs.agentId, agentId), workingRunSql)).limit(1);
  if (live) return true;
  const [queued] = await db.select({ id: wakes.id }).from(wakes).where(and(eq(wakes.agentId, agentId), inArray(wakes.status, ["queued", "deferred"]))).limit(1);
  return !!queued;
}

/** Every busy agent at once (the same rule as `agentBusy`), for sweeps that look at many agents. A deferred wake not due yet uses no slot (BOS-2358), so it doesn't count. */
export async function busyAgentIds(db: Db, now: Date = new Date()): Promise<Set<string | null>> {
  const ids = [
    ...(await db.select({ id: runs.agentId }).from(runs).where(and(isNull(runs.endedAt), workingRunSql))).map((r) => r.id),
    ...(await db.select({ id: wakes.agentId }).from(wakes).where(or(eq(wakes.status, "queued"), and(eq(wakes.status, "deferred"), or(isNull(wakes.notBefore), lte(wakes.notBefore, now)))))).map((w) => w.id),
  ];
  return new Set(ids.filter((id): id is string => !!id));
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
  if (await agentBusy(db, t.assigneeAgentId, t.id)) return false;
  if ((await agentWipHold(db, t)).hold) return false;
  return !(await ticketIsBlocked(db, t.id));
}
