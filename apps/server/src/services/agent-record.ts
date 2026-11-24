// One agent's record over the last 30 days (BOS-2389): what it finished, how often review passed first time,
// send-backs, median time to merge and cost per finished ticket. Read only; no model calls. The Workflow report
// has the same kind of figures per role (services/workflow.ts); this is per agent.
import { and, eq, gte, inArray, isNull, ne, or, sql, desc } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { resultWhere } from "./runs.js";
import { agents, companies, costEvents, runs, ticketReviews, ticketTransitions, tickets } from "../db/schema.js";

const DAY = 86_400_000;
export const RECORD_DAYS = 30;
const RECENT = 10;

export type AgentRecordTicket = { id: string; ref: string | null; title: string; size: number | null; finishedAt: string; sendBacks: number; costMicros: number };
export type AgentRecord = {
  days: number;
  finished: number;
  /** Runs started in the window, and how many of them failed (outcome starts with "error", the Runs page rule). */
  runs: number;
  failedRuns: number;
  /** Finished tickets that had a review and no changes requested. */
  passedFirstTime: number;
  sendBacks: number;
  /** Median time from first In progress to merged (done); null when no finished ticket has a start recorded. */
  medianMergeMs: number | null;
  costPerFinishedMicros: number | null;
  recent: AgentRecordTicket[];
};

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export class AgentRecordError extends Error {}

export function agentRecordService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const svc = {
    /** BOS-2504: every non-retired agent's record without the recent list, for the Agents page table. */
    async team(companyId: string): Promise<Array<Omit<AgentRecord, "recent"> & { agentId: string; name: string }>> {
      const list = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt))).orderBy(agents.name);
      const out = [];
      for (const a of list) {
        const { recent: _recent, ...rest } = await svc.record(a.id);
        out.push({ agentId: a.id, name: a.name, ...rest });
      }
      return out;
    },
    async record(agentId: string): Promise<AgentRecord> {
      const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
      if (!agent) throw new AgentRecordError("No such agent.");
      const [company] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, agent.companyId));
      const since = new Date(now().getTime() - RECORD_DAYS * DAY);
      // Finished = done (merged tickets are done), not cancelled, finished in the window, assigned to this agent.
      const rows = await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, size: tickets.size, stateChangedAt: tickets.stateChangedAt, mergedAt: tickets.mergedAt })
        .from(tickets)
        .where(and(eq(tickets.assigneeAgentId, agentId), eq(tickets.systemState, "done"), or(sql`${tickets.outcome} is null`, ne(tickets.outcome, "cancelled")), gte(tickets.stateChangedAt, since)))
        .orderBy(desc(tickets.stateChangedAt));
      const ids = rows.map((r) => r.id);
      const reviews = ids.length ? await db.select({ ticketId: ticketReviews.ticketId, verdict: ticketReviews.verdict }).from(ticketReviews).where(inArray(ticketReviews.ticketId, ids)) : [];
      const sendBacks = new Map<string, number>();
      const reviewed = new Set<string>();
      for (const r of reviews) {
        reviewed.add(r.ticketId);
        if (r.verdict === "changes_requested") sendBacks.set(r.ticketId, (sendBacks.get(r.ticketId) ?? 0) + 1);
      }
      const moves = ids.length ? await db.select({ ticketId: ticketTransitions.ticketId, at: ticketTransitions.at }).from(ticketTransitions).where(and(inArray(ticketTransitions.ticketId, ids), eq(ticketTransitions.toState, "in_progress"))) : [];
      const startAt = new Map<string, number>();
      for (const m of moves) if (m.at.getTime() < (startAt.get(m.ticketId) ?? Infinity)) startAt.set(m.ticketId, m.at.getTime());
      const costs = ids.length
        ? await db.select({ ticketId: runs.ticketId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8` }).from(costEvents).innerJoin(runs, eq(runs.id, costEvents.runId)).where(and(inArray(runs.ticketId, ids), eq(runs.agentId, agentId))).groupBy(runs.ticketId)
        : [];
      const costOf = new Map(costs.map((c) => [c.ticketId, Number(c.micros)]));
      const finishedAt = (r: (typeof rows)[number]) => r.mergedAt ?? r.stateChangedAt;
      const cycles = rows.flatMap((r) => {
        const s = startAt.get(r.id);
        return s === undefined ? [] : [Math.max(0, finishedAt(r).getTime() - s)];
      });
      // Runs started in the window; failed uses the Runs page rule.
      const [runCount] = await db
        .select({ runs: sql<number>`count(*)::int`, failed: sql<number>`(count(*) filter (where ${resultWhere("failed")}))::int` })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), gte(runs.startedAt, since)));
      const total = rows.reduce((a, r) => a + (costOf.get(r.id) ?? 0), 0);
      return {
        days: RECORD_DAYS,
        finished: rows.length,
        runs: runCount?.runs ?? 0,
        failedRuns: runCount?.failed ?? 0,
        passedFirstTime: rows.filter((r) => reviewed.has(r.id) && !sendBacks.has(r.id)).length,
        sendBacks: [...sendBacks.values()].reduce((a, b) => a + b, 0),
        medianMergeMs: median(cycles),
        costPerFinishedMicros: rows.length ? total / rows.length : null,
        recent: rows.slice(0, RECENT).map((r) => ({ id: r.id, ref: ticketRef(company?.prefix, r.number), title: r.title, size: r.size, finishedAt: finishedAt(r).toISOString(), sendBacks: sendBacks.get(r.id) ?? 0, costMicros: costOf.get(r.id) ?? 0 })),
      };
    },
  };
  return svc;
}
