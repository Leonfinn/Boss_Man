// The dashboard (R74): what a company's agents are doing, the headline numbers, the last
// 14 days of runs and tickets, and what happened recently. One read, for the home screen.
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, costEvents, decisions, fundingSources, notifications, runs, tickets } from "../db/schema.js";
import { liveRuns, runOriginQuery } from "./runs.js";
import { passedReviewTickets } from "./review-kinds.js";

export const DAYS = 14;

/** How a run ended, for the charts: it finished its turn, it failed, or something else (stopped, interrupted). */
export function runResult(outcome: string | null): "succeeded" | "failed" | "other" {
  if (outcome === "end_turn") return "succeeded";
  if (outcome?.startsWith("error")) return "failed";
  return "other";
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function dashboardService(db: Db, deps: { now?: () => Date; decisions?: { queueTally: (opts: { companyId: string }) => Promise<{ open: number; waiting: number }> } } = {}) {
  const now = deps.now ?? (() => new Date());
  /**
   * Each agent's latest run, and why it started (BOS-407). The latest run is picked first, on the
   * runs table alone, and the origin subqueries run only on those rows: doing it the other way
   * round computed a nudge lookup for every run the company ever had, then threw them all away.
   * One `limit 1` per agent on runs_agent_started (BOS-672): DISTINCT ON read and sorted every run
   * of every agent (38 ms at 20k runs) to keep one row each. "nulls last" must match the index's
   * order or Postgres sorts the agent's runs instead of reading one (started_at is never null).
   */
  const latestRunPerAgent = (agentIds: string[]) => {
    const latest = db.select().from(runs).where(eq(runs.agentId, agents.id)).orderBy(sql`${runs.startedAt} desc nulls last`).limit(1).as("latest");
    return db
      .select({ agentId: latest.agentId, id: latest.id, ticketId: latest.ticketId, ticket: tickets.title, purpose: latest.purpose, startedAt: latest.startedAt, endedAt: latest.endedAt, outcome: latest.outcome, ...runOriginQuery("latest") })
      .from(agents)
      .innerJoinLateral(latest, sql`true`)
      .leftJoin(tickets, eq(tickets.id, latest.ticketId))
      .where(inArray(agents.id, agentIds));
  };
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
      const latest = team.length ? await latestRunPerAgent(team.map((a) => a.id)) : [];
      const byAgent = new Map(latest.map((r) => [r.agentId, r]));
      const rank = { ceo: 0, manager: 1, worker: 2 } as const;
      const agentCards = team
        .map((a) => {
          const r = byAgent.get(a.id);
          return { id: a.id, name: a.name, role: a.role, paused: a.paused, duty: a.duty, run: r ? { id: r.id, ticketId: r.ticketId, ticket: r.ticket, purpose: r.purpose, origin: r.origin, originFrom: r.originFrom, originNote: r.originNote, wakeNote: r.wakeNote, runTicketId: r.runTicketId, startedAt: r.startedAt, endedAt: r.endedAt, result: r.endedAt ? runResult(r.outcome) : ("running" as const) } : null };
        })
        .sort((x, y) => Number(!!y.run && !y.run.endedAt) - Number(!!x.run && !x.run.endedAt) || rank[x.role] - rank[y.role] || x.name.localeCompare(y.name));

      const states = await db
        .select({ state: tickets.systemState, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(eq(tickets.companyId, companyId))
        .groupBy(tickets.systemState);
      const count = (s: string) => states.find((x) => x.state === s)?.n ?? 0;
      // Of the tickets in review, those every reviewer has approved: only the merge (or the owner's sign-off) is left (BOS-667).
      const inReviewIds = count("review") ? (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "review")))).map((r) => r.id) : [];
      const approved = (await passedReviewTickets(db, inReviewIds)).size;
      const [waiting] = deps.decisions
        ? []
        : await db
            .select({ n: sql<number>`count(*)::int` })
            .from(decisions)
            .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), eq(decisions.tier, "owner")));
      // "Need your answer" is the Decisions menu's own figure (BOS-969): the cards the owner can act
      // on now, from the same function that count comes from, so the home screen can't disagree with it.
      // Without that function (a test of this screen alone), the plain open owner-tier count stands in.
      const decisionsWaiting = deps.decisions ? (await deps.decisions.queueTally({ companyId })).open : (waiting?.n ?? 0);

      // Money is what API credit and pay-as-you-go cost. Subscription use isn't money spent, so
      // it's counted in tokens instead (R67), even though its cost events carry a list price.
      const [spent] = await db
        .select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
        .from(costEvents)
        .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart), ne(fundingSources.kind, "subscription")));
      // A run was on the subscription if its costs went there, or its agent is paid that way.
      // Only this month's runs are counted, so only cost events from then on can name one (BOS-672: the
      // unbounded lookup read every cost event ever). The day of slack covers a runner clock behind the server's.
      const costsFrom = new Date(monthStart.getTime() - 86_400_000);
      const onSubscription = sql`(${runs.id} in (select ${costEvents.runId} from ${costEvents} inner join ${fundingSources} on ${fundingSources.id} = ${costEvents.fundingSourceId} where ${fundingSources.kind} = 'subscription' and ${costEvents.runId} is not null and ${costEvents.occurredAt} >= ${costsFrom}) or ${agents.fundingSourceId} in (select ${fundingSources.id} from ${fundingSources} where ${fundingSources.kind} = 'subscription'))`;
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
      const live = await liveRuns(db, companyId);

      // The last 14 days, one entry per day, oldest first.
      const days = Array.from({ length: DAYS }, (_, i) => day(new Date(since.getTime() + i * 86_400_000)));
      // Counted by UTC day in the database (BOS-672): reading every row and filtering it once per day
      // was O(rows x days) in JS, the dateIn freeze pattern (BOS-643). Same day key as day() above.
      const utcDay = (c: typeof runs.endedAt | typeof tickets.createdAt) => sql<string>`to_char(${c} at time zone 'UTC', 'YYYY-MM-DD')`;
      const ended = await db
        .select({ day: utcDay(runs.endedAt), outcome: runs.outcome, n: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(eq(runs.companyId, companyId), gte(runs.endedAt, since)))
        .groupBy(sql`1`, runs.outcome);
      const made = await db
        .select({ day: utcDay(tickets.createdAt), state: tickets.systemState, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), gte(tickets.createdAt, since)))
        .groupBy(sql`1`, tickets.systemState);
      const runTally = new Map(days.map((d) => [d, { succeeded: 0, failed: 0, other: 0 }]));
      for (const r of ended) {
        const tally = runTally.get(r.day);
        if (tally) tally[runResult(r.outcome)] += r.n;
      }
      const ticketTally = new Map(days.map((d) => [d, {} as Record<string, number>]));
      for (const x of made) {
        const tally = ticketTally.get(x.day);
        if (tally) tally[x.state] = (tally[x.state] ?? 0) + x.n;
      }
      const runsByDay = days.map((d) => ({ day: d, ...runTally.get(d)! }));
      const ticketsByDay = days.map((d) => ({ day: d, ...ticketTally.get(d)! }));

      const recentTickets = await db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, assignee: agents.name, lastActivityAt: tickets.lastActivityAt })
        .from(tickets)
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(eq(tickets.companyId, companyId))
        .orderBy(desc(tickets.lastActivityAt))
        .limit(10);
      const recentActivity = await db
        .select({ id: notifications.id, title: notifications.title, body: notifications.body, link: notifications.link, level: notifications.level, agent: agents.name, createdAt: notifications.createdAt })
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
          // inReview split in two, so the owner sees whether reviewers or the merge line hold work up.
          awaitingReview: count("review") - approved,
          approvedToMerge: approved,
          open: states.reduce((n, s) => n + (s.state === "done" ? 0 : s.n), 0),
          blocked: count("blocked"),
          decisionsWaiting,
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
