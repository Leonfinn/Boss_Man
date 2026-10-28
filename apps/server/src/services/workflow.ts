// The workflow scorecard (docs/19-workflow-retros.md, parts 1 and 5): read-only numbers from tickets, transitions,
// reviews, runs and costs. No model calls. Ticket history before ticket_transitions existed is missing, so those
// tickets have no cycle time.
import { and, asc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, costEvents, decisions, features, reviewRequests, runs, ticketDependencies, ticketReviews, ticketTransitions, tickets, watchdogFlags } from "../db/schema.js";

const DAY = 86_400_000;
/** Durations for the critical path and the tail flag come from this window, whatever the scorecard's window is. */
const HISTORY_DAYS = 90;
/** Fewer done tickets than this and a role's own times are too thin to use. */
const MIN_SAMPLES = 10;
const TAIL_FROM = 0.75;
const TAIL_FLAG_TIMES = 2;

/** Linear-interpolated percentile (p from 0 to 1); null for no values. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const at = (v.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return v[lo]! + (v[hi]! - v[lo]!) * (at - lo);
}
export const median = (values: number[]) => percentile(values, 0.5);
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/**
 * The heaviest chain through a dependency graph (edges are [blocker, blocked]). A back edge that would close
 * a loop is ignored, so a cycle in the data can't hang or crash it. Ties go to the earlier node.
 */
export function longestPath(nodes: { id: string; weight: number }[], edges: [string, string][]): string[] {
  const weight = new Map(nodes.map((n) => [n.id, n.weight]));
  // lost on restart, harmless because it is per-call scratch.
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) if (weight.has(a) && weight.has(b) && a !== b) next.set(a, [...(next.get(a) ?? []), b]);
  // lost on restart, harmless because it is per-call scratch.
  const best = new Map<string, { total: number; chain: string[] }>();
  const onStack = new Set<string>();
  const walk = (id: string): { total: number; chain: string[] } => {
    const done = best.get(id);
    if (done) return done;
    onStack.add(id);
    let tail = { total: 0, chain: [] as string[] };
    for (const n of next.get(id) ?? []) {
      if (onStack.has(n)) continue;
      const r = walk(n);
      if (r.total > tail.total) tail = r;
    }
    onStack.delete(id);
    const r = { total: weight.get(id)! + tail.total, chain: [id, ...tail.chain] };
    best.set(id, r);
    return r;
  };
  let top: { total: number; chain: string[] } | null = null;
  for (const n of nodes) {
    const r = walk(n.id);
    if (!top || r.total > top.total) top = r;
  }
  return top?.chain ?? [];
}

type Cycles = { p50: number | null; p85: number | null; samples: number };
const spread = (ms: number[]): Cycles => ({ p50: median(ms), p85: percentile(ms, 0.85), samples: ms.length });

export type Stats = { done: number; firstPassRate: number | null; meanRework: number | null; medianCycleMs: number | null; costPerDoneMicros: number | null; watchdogFlags: number; overrideShare: number | null; answered: number };
type Done = { agentId: string; cycleMs: number | null; rework: number; reviewed: boolean; costMicros: number };

function stats(rows: Done[], flags: number, answered: number, overridden: number): Stats {
  const reviewed = rows.filter((r) => r.reviewed);
  return {
    done: rows.length,
    firstPassRate: reviewed.length ? reviewed.filter((r) => r.rework === 0).length / reviewed.length : null,
    meanRework: mean(rows.map((r) => r.rework)),
    medianCycleMs: median(rows.flatMap((r) => (r.cycleMs === null ? [] : [r.cycleMs]))),
    costPerDoneMicros: rows.length ? rows.reduce((a, r) => a + r.costMicros, 0) / rows.length : null,
    watchdogFlags: flags,
    overrideShare: answered ? overridden / answered : null,
    answered,
  };
}

export function workflowService(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  return {
    async scorecard(companyId: string, days: number) {
      const t = now();
      const since = new Date(t.getTime() - days * DAY);
      const since90 = new Date(t.getTime() - HISTORY_DAYS * DAY);
      const [company] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
      const team = await db.select({ id: agents.id, name: agents.name, title: agents.title, role: agents.role, template: agents.template }).from(agents).where(eq(agents.companyId, companyId));
      const agentById = new Map(team.map((a) => [a.id, a]));
      const roleOf = (agentId: string | null | undefined) => {
        const a = agentId ? agentById.get(agentId) : undefined;
        return a ? (a.template ?? a.role) : null;
      };

      // Done tickets (cancelled ones never finished) and their start and finish, from the transitions.
      const doneRows = await db
        .select({ id: tickets.id, assigneeAgentId: tickets.assigneeAgentId, stateChangedAt: tickets.stateChangedAt })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), or(sql`${tickets.outcome} is null`, ne(tickets.outcome, "cancelled")), gte(tickets.stateChangedAt, since90)));
      const ids = doneRows.map((r) => r.id);
      const moves = ids.length ? await db.select().from(ticketTransitions).where(inArray(ticketTransitions.ticketId, ids)) : [];
      const startAt = new Map<string, number>();
      for (const m of moves) if (m.toState === "in_progress" && m.at.getTime() < (startAt.get(m.ticketId) ?? Infinity)) startAt.set(m.ticketId, m.at.getTime());
      const cycleOf = new Map<string, number>();
      for (const r of doneRows) {
        const s = startAt.get(r.id);
        if (s !== undefined) cycleOf.set(r.id, Math.max(0, r.stateChangedAt.getTime() - s));
      }

      // Cycle times by role over the long window: the durations for the tail flag and the critical path.
      const cyclesByRole = new Map<string, number[]>();
      const allCycles: number[] = [];
      for (const r of doneRows) {
        const c = cycleOf.get(r.id);
        if (c === undefined) continue;
        allCycles.push(c);
        const role = roleOf(r.assigneeAgentId);
        if (role) cyclesByRole.set(role, [...(cyclesByRole.get(role) ?? []), c]);
      }
      const company90 = spread(allCycles);
      const trusted = company90.samples >= MIN_SAMPLES;
      const roleCycles = (role: string | null): Cycles => {
        const own = role ? spread(cyclesByRole.get(role) ?? []) : null;
        return own && own.samples >= MIN_SAMPLES ? own : trusted ? company90 : { p50: null, p85: null, samples: company90.samples };
      };

      // ----- Roles and agents -----
      const inWindow = doneRows.filter((r) => r.assigneeAgentId && r.stateChangedAt >= since);
      const windowIds = inWindow.map((r) => r.id);
      const reviews = windowIds.length ? await db.select({ ticketId: ticketReviews.ticketId, verdict: ticketReviews.verdict }).from(ticketReviews).where(inArray(ticketReviews.ticketId, windowIds)) : [];
      const rework = new Map<string, number>();
      const reviewed = new Set<string>();
      for (const r of reviews) {
        reviewed.add(r.ticketId);
        if (r.verdict === "changes_requested") rework.set(r.ticketId, (rework.get(r.ticketId) ?? 0) + 1);
      }
      const costs = windowIds.length
        ? await db.select({ ticketId: runs.ticketId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8` }).from(costEvents).innerJoin(runs, eq(runs.id, costEvents.runId)).where(inArray(runs.ticketId, windowIds)).groupBy(runs.ticketId)
        : [];
      const costOf = new Map(costs.map((c) => [c.ticketId, Number(c.micros)]));
      const done: Done[] = inWindow.map((r) => ({ agentId: r.assigneeAgentId!, cycleMs: cycleOf.get(r.id) ?? null, rework: rework.get(r.id) ?? 0, reviewed: reviewed.has(r.id), costMicros: costOf.get(r.id) ?? 0 }));

      const flagRows = await db
        .select({ agentId: tickets.assigneeAgentId })
        .from(watchdogFlags)
        .innerJoin(tickets, eq(tickets.id, watchdogFlags.ticketId))
        .where(and(eq(watchdogFlags.companyId, companyId), gte(watchdogFlags.openedAt, since)));
      const answeredRows = await db
        .select({ agentId: decisions.raisedByAgentId, answer: decisions.answer, recommended: decisions.recommendedOption })
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "answered"), isNotNull(decisions.raisedByAgentId), gte(decisions.answeredAt, since)));

      const rowFor = (key: (agentId: string) => string | null) => {
        const keys = new Set<string>();
        const bucket = <T extends { agentId: string | null }>(rows: T[]) => {
          const m = new Map<string, T[]>();
          for (const r of rows) {
            const k = r.agentId ? key(r.agentId) : null;
            if (!k) continue;
            keys.add(k);
            m.set(k, [...(m.get(k) ?? []), r]);
          }
          return m;
        };
        const d = bucket(done), f = bucket(flagRows), a = bucket(answeredRows);
        return [...keys].map((k) => {
          const ans = a.get(k) ?? [];
          return { key: k, ...stats(d.get(k) ?? [], (f.get(k) ?? []).length, ans.length, ans.filter((x) => x.answer !== x.recommended).length) };
        });
      };
      const byRole = rowFor(roleOf).map(({ key, ...s }) => ({ role: key, agents: team.filter((a) => roleOf(a.id) === key).length, ...s })).sort((x, y) => y.done - x.done || x.role.localeCompare(y.role));
      const byAgent = rowFor((id) => (agentById.has(id) ? id : null))
        .map(({ key, ...s }) => ({ agentId: key, name: agentById.get(key)!.name, title: agentById.get(key)!.title, role: roleOf(key)!, ...s }))
        .sort((x, y) => y.done - x.done || x.name.localeCompare(y.name));

      // ----- Handoffs -----
      const waits = new Map<string, { from: string; to: string; kind: "assign" | "review"; waits: number[]; bounced: number }>();
      const add = (from: string, to: string, kind: "assign" | "review", wait: number, bounced = false) => {
        const k = `${kind}|${from}|${to}`;
        const g = waits.get(k) ?? { from, to, kind, waits: [], bounced: 0 };
        g.waits.push(wait);
        if (bounced) g.bounced++;
        waits.set(k, g);
      };
      // The assigner is whoever the activity row names; the service records none for the owner or Boss Man.
      const assigned = await db.select({ ticketId: activity.ticketId, agentId: activity.agentId, at: activity.at }).from(activity).where(and(eq(activity.companyId, companyId), eq(activity.kind, "assigned"), isNotNull(activity.ticketId), gte(activity.at, since))).orderBy(asc(activity.at));
      const ticketIds = [...new Set(assigned.map((a) => a.ticketId!))];
      const allAssigned = ticketIds.length ? await db.select({ ticketId: activity.ticketId, at: activity.at }).from(activity).where(and(inArray(activity.ticketId, ticketIds), eq(activity.kind, "assigned"))).orderBy(asc(activity.at)) : [];
      const ticketRuns = ticketIds.length ? await db.select({ ticketId: runs.ticketId, agentId: runs.agentId, startedAt: runs.startedAt }).from(runs).where(inArray(runs.ticketId, ticketIds)).orderBy(asc(runs.startedAt)) : [];
      for (const a of assigned) {
        // The assignee's first run after the assignment and before the next one.
        const end = allAssigned.find((x) => x.ticketId === a.ticketId && x.at > a.at)?.at;
        const run = ticketRuns.find((r) => r.ticketId === a.ticketId && r.startedAt >= a.at && (!end || r.startedAt < end));
        const to = roleOf(run?.agentId);
        if (run && to) add(roleOf(a.agentId) ?? "owner", to, "assign", run.startedAt.getTime() - a.at.getTime());
      }
      const decided = await db
        .select({ created: reviewRequests.createdAt, decidedAt: reviewRequests.decidedAt, status: reviewRequests.status, reviewer: reviewRequests.reviewerAgentId, author: tickets.assigneeAgentId })
        .from(reviewRequests)
        .innerJoin(tickets, eq(tickets.id, reviewRequests.ticketId))
        .where(and(eq(tickets.companyId, companyId), inArray(reviewRequests.status, ["approved", "changes_requested"]), gte(reviewRequests.decidedAt, since)));
      for (const r of decided) {
        const from = roleOf(r.author), to = roleOf(r.reviewer);
        if (from && to) add(from, to, "review", r.decidedAt!.getTime() - r.created.getTime(), r.status === "changes_requested");
      }
      const handoffs = [...waits.values()]
        .map((g) => ({ from: g.from, to: g.to, kind: g.kind, count: g.waits.length, medianWaitMs: median(g.waits), bounceRate: g.kind === "review" ? g.bounced / g.waits.length : null }))
        .sort((x, y) => y.count - x.count || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));

      // ----- Features and their critical paths -----
      const feats = await db
        .select()
        .from(features)
        .where(and(eq(features.companyId, companyId), or(and(ne(features.status, "released"), ne(features.status, "declined")), and(eq(features.status, "released"), gte(features.releasedAt, since)))));
      const tasks = feats.length
        ? await db
            .select({ id: tickets.id, featureId: tickets.featureId, number: tickets.number, title: tickets.title, state: tickets.systemState, assigneeAgentId: tickets.assigneeAgentId, stateChangedAt: tickets.stateChangedAt, createdAt: tickets.createdAt })
            .from(tickets)
            .where(and(inArray(tickets.featureId, feats.map((f) => f.id)), or(sql`${tickets.outcome} is null`, ne(tickets.outcome, "cancelled"))))
        : [];
      const taskIds = tasks.map((x) => x.id);
      const started = taskIds.length ? await db.select({ ticketId: ticketTransitions.ticketId, at: sql<Date>`min(${ticketTransitions.at})` }).from(ticketTransitions).where(and(inArray(ticketTransitions.ticketId, taskIds), eq(ticketTransitions.toState, "in_progress"))).groupBy(ticketTransitions.ticketId) : [];
      const startedAt = new Map(started.map((s) => [s.ticketId, new Date(s.at).getTime()]));
      const deps_ = taskIds.length ? await db.select({ blocker: ticketDependencies.blockerTicketId, blocked: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(and(inArray(ticketDependencies.blockedTicketId, taskIds), isNotNull(ticketDependencies.blockerTicketId))) : [];
      const ageOf = (x: (typeof tasks)[number]) => t.getTime() - (startedAt.get(x.id) ?? x.createdAt.getTime());
      const brief = (x: (typeof tasks)[number]) => ({ id: x.id, ref: ticketRef(company?.prefix, x.number), title: x.title, state: x.state, assignee: x.assigneeAgentId ? (agentById.get(x.assigneeAgentId)?.name ?? null) : null, ageMs: ageOf(x) });

      const featureRows = [];
      for (const f of feats) {
        const mine = tasks.filter((x) => x.featureId === f.id);
        if (!mine.length) continue;
        const open = mine.filter((x) => x.state !== "done");
        const ratio = (mine.length - open.length) / mine.length;
        const tail = ratio >= TAIL_FROM ? open.map(brief).sort((x, y) => y.ageMs - x.ageMs) : [];
        const limit = company90.p50 === null || !trusted ? null : company90.p50 * TAIL_FLAG_TIMES;
        const row = {
          id: f.id,
          title: f.title,
          status: f.status,
          tasksDone: mine.length - open.length,
          tasksTotal: mine.length,
          tail,
          tailFlag: limit !== null && tail.some((x) => x.ageMs > limit),
          tailLagMs: null as number | null,
          criticalPath: null as null | { chain: { id: string; ref: string | null; title: string; state: string }[]; p50Ms: number | null; p85Ms: number | null; ageing: { id: string; ref: string | null; title: string; reasons: string[] }[] },
        };
        if (f.status === "released") {
          const finished = mine.filter((x) => x.state === "done").map((x) => x.stateChangedAt.getTime());
          const p75 = percentile(finished, 0.75);
          row.tailLagMs = p75 === null ? null : Math.max(...finished) - p75;
        } else if (open.length) {
          const by = new Map(open.map((x) => [x.id, x]));
          const cyc = (x: (typeof open)[number]) => roleCycles(roleOf(x.assigneeAgentId));
          const chainIds = longestPath(
            open.map((x) => ({ id: x.id, weight: cyc(x).p50 ?? 1 })),
            deps_.map((d) => [d.blocker!, d.blocked]),
          );
          const chain = chainIds.map((id) => by.get(id)!);
          const sum = (pick: (c: Cycles) => number | null) => (trusted ? chain.reduce((a, x) => a + (pick(cyc(x)) ?? 0), 0) : null);
          row.criticalPath = {
            chain: chain.map(({ id, number, title, state }) => ({ id, ref: ticketRef(company?.prefix, number), title, state })),
            p50Ms: sum((c) => c.p50),
            p85Ms: sum((c) => c.p85),
            ageing: chain.flatMap((x) => {
              const p85 = cyc(x).p85;
              const reasons = [...(x.assigneeAgentId ? [] : ["Nobody is assigned"]), ...(x.state === "blocked" ? ["Blocked"] : []), ...(p85 !== null && ageOf(x) > p85 ? ["Older than usual for this role"] : [])];
              return reasons.length ? [{ id: x.id, ref: ticketRef(company?.prefix, x.number), title: x.title, reasons }] : [];
            }),
          };
        }
        featureRows.push(row);
      }

      return { days, since: since.toISOString(), byRole, byAgent, handoffs, features: featureRows };
    },
  };
}
