// The dashboard (R74): what a company's agents are doing, the headline numbers, the last
// 14 days of runs and tickets, and what happened recently. One read, for the home screen.
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, costEvents, decisions, fundingSources, notifications, runs, tickets } from "../db/schema.js";

export const DAYS = 14;

/** How a run ended, for the charts: it finished its turn, it failed, or something else (stopped, interrupted). */
export function runResult(outcome: string | null): "succeeded" | "failed" | "other" {
  if (outcome === "end_turn") return "succeeded";
  if (outcome?.startsWith("error")) return "failed";
  return "other";
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function dashboardService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  return {
    async get(companyId: string) {
      const t = now();
      const since = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - (DAYS - 1)));
      const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));

      const team = await db
        .select({ id: agents.id, name: agents.name, role: agents.role, paused: agents.paused, duty: agents.duty, fundingKind: fundingSources.kind })
        .from(agents)
        .leftJoin(fundingSources, eq(fundingSources.id, agents.fundingSourceId))
        .where(eq(agents.companyId, companyId));
      // Each agent's latest run: the one going now, or the last one that ended.
      const latest = team.length
        ? await db
            .selectDistinctOn([runs.agentId], { agentId: runs.agentId, id: runs.id, ticketId: runs.ticketId, ticket: tickets.title, purpose: runs.purpose, startedAt: runs.startedAt, endedAt: runs.endedAt, outcome: runs.outcome })
            .from(runs)
            .leftJoin(tickets, eq(tickets.id, runs.ticketId))
            .where(inArray(runs.agentId, team.map((a) => a.id)))
            .orderBy(runs.agentId, desc(runs.startedAt))
        : [];
      const byAgent = new Map(latest.map((r) => [r.agentId, r]));
      const rank = { ceo: 0, manager: 1, worker: 2 } as const;
      const agentCards = team
        .map((a) => {
          const r = byAgent.get(a.id);
          return { id: a.id, name: a.name, role: a.role, paused: a.paused, duty: a.duty, run: r ? { id: r.id, ticketId: r.ticketId, ticket: r.ticket, purpose: r.purpose, startedAt: r.startedAt, endedAt: r.endedAt, result: r.endedAt ? runResult(r.outcome) : ("running" as const) } : null };
        })
        .sort((x, y) => Number(!!y.run && !y.run.endedAt) - Number(!!x.run && !x.run.endedAt) || rank[x.role] - rank[y.role] || x.name.localeCompare(y.name));

      const states = await db
        .select({ state: tickets.systemState, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(eq(tickets.companyId, companyId))
        .groupBy(tickets.systemState);
      const count = (s: string) => states.find((x) => x.state === s)?.n ?? 0;
      const [waiting] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), eq(decisions.tier, "owner")));
      // Money is what API credit and pay-as-you-go cost. Subscription use isn't money spent, so
      // it's counted in tokens instead (R67), even though its cost events carry a list price.
      const [spent] = await db
        .select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
        .from(costEvents)
        .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart), ne(fundingSources.kind, "subscription")));
      // A run was on the subscription if its costs went there, or its agent is paid that way.
      const onSubscription = sql`(${runs.id} in (select ${costEvents.runId} from ${costEvents} inner join ${fundingSources} on ${fundingSources.id} = ${costEvents.fundingSourceId} where ${fundingSources.kind} = 'subscription' and ${costEvents.runId} is not null) or ${agents.fundingSourceId} in (select ${fundingSources.id} from ${fundingSources} where ${fundingSources.kind} = 'subscription'))`;
      const [tokens] = await db
        .select({
          input: sql<string>`coalesce(sum(${runs.inputTokens}), 0)`,
          output: sql<string>`coalesce(sum(${runs.outputTokens}), 0)`,
          runs: sql<number>`count(*)::int`,
          unrecorded: sql<number>`count(*) filter (where ${runs.inputTokens} is null and ${runs.endedAt} is not null)::int`,
        })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(and(eq(runs.companyId, companyId), gte(runs.startedAt, monthStart), onSubscription));
      const live = await db.select({ agentId: runs.agentId }).from(runs).where(and(eq(runs.companyId, companyId), isNull(runs.endedAt)));

      // The last 14 days, one entry per day, oldest first.
      const days = Array.from({ length: DAYS }, (_, i) => day(new Date(since.getTime() + i * 86_400_000)));
      const ended = await db.select({ endedAt: runs.endedAt, outcome: runs.outcome }).from(runs).where(and(eq(runs.companyId, companyId), gte(runs.endedAt, since)));
      const made = await db.select({ createdAt: tickets.createdAt, state: tickets.systemState }).from(tickets).where(and(eq(tickets.companyId, companyId), gte(tickets.createdAt, since)));
      const runsByDay = days.map((d) => {
        const on = ended.filter((r) => r.endedAt && day(r.endedAt) === d);
        const tally = { succeeded: 0, failed: 0, other: 0 };
        for (const r of on) tally[runResult(r.outcome)]++;
        return { day: d, ...tally };
      });
      const ticketsByDay = days.map((d) => {
        const on = made.filter((x) => day(x.createdAt) === d);
        const tally: Record<string, number> = {};
        for (const x of on) tally[x.state] = (tally[x.state] ?? 0) + 1;
        return { day: d, ...tally };
      });

      const recentTickets = await db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, assignee: agents.name, lastActivityAt: tickets.lastActivityAt })
        .from(tickets)
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(eq(tickets.companyId, companyId))
        .orderBy(desc(tickets.lastActivityAt))
        .limit(10);
      const recentActivity = await db
        .select({ id: notifications.id, title: notifications.title, link: notifications.link, level: notifications.level, agent: agents.name, createdAt: notifications.createdAt })
        .from(notifications)
        .leftJoin(agents, eq(agents.id, notifications.agentId))
        .where(eq(notifications.companyId, companyId))
        .orderBy(desc(notifications.createdAt))
        .limit(10);

      return {
        agents: agentCards,
        stats: {
          agents: team.length,
          running: new Set(live.map((r) => r.agentId)).size,
          paused: team.filter((a) => a.paused).length,
          inProgress: count("in_progress"),
          inReview: count("review"),
          open: states.reduce((n, s) => n + (s.state === "done" ? 0 : s.n), 0),
          blocked: count("blocked"),
          decisionsWaiting: waiting?.n ?? 0,
          monthCostMicros: Number(spent?.micros ?? 0),
          monthSubscriptionTokens: { input: Number(tokens?.input ?? 0), output: Number(tokens?.output ?? 0) },
          // Subscription runs this month, and how many ended before tokens were recorded.
          monthSubscriptionRuns: tokens?.runs ?? 0,
          monthSubscriptionUnrecorded: tokens?.unrecorded ?? 0,
        },
        runsByDay,
        ticketsByDay,
        recentTickets,
        recentActivity,
      };
    },
  };
}
