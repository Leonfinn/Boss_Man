// The workflow scorecard (docs/19-workflow-retros.md, parts 1 and 5): read-only numbers from tickets, transitions,
// reviews, runs and costs. No model calls. Ticket history before ticket_transitions existed is missing, so those
// tickets have no cycle time.
import { and, asc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
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
/** A size needs this many timed tickets before the "behaves like the next size" note will lean on its median. */
const SIGNAL_MIN = 3;
/** Whole weeks in the week-by-week table (the part-week so far comes after them). */
const TREND_WEEKS = 8;
/** Reference tickets kept per size for the sizing guide. */
const EXAMPLES_PER_SIZE = 3;

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

export type SizeRow = { role: string; size: number; done: number; p50CycleMs: number | null; p85CycleMs: number | null; meanCostMicros: number | null; meanRework: number | null };

/** Sizes whose median cycle time sits closer to the next size's than to the one below: "3s that behave like 5s". Needs both neighbours, each with enough timed tickets. */
export function sizeSignals(rows: SizeRow[], timed: (r: SizeRow) => number = (r) => r.done): Array<{ role: string; size: number; likeSize: number; p50CycleMs: number; nextP50Ms: number; prevP50Ms: number }> {
  const out = [];
  for (const role of new Set(rows.map((r) => r.role))) {
    const mine = rows.filter((r) => r.role === role && r.p50CycleMs !== null && timed(r) >= SIGNAL_MIN).sort((a, b) => a.size - b.size);
    for (let i = 1; i < mine.length - 1; i++) {
      const [prev, r, next] = [mine[i - 1]!, mine[i]!, mine[i + 1]!];
      if (Math.abs(next.p50CycleMs! - r.p50CycleMs!) < Math.abs(r.p50CycleMs! - prev.p50CycleMs!)) out.push({ role, size: r.size, likeSize: next.size, p50CycleMs: r.p50CycleMs!, nextP50Ms: next.p50CycleMs!, prevP50Ms: prev.p50CycleMs! });
    }
  }
  return out;
}

export type Stats = { done: number; firstPassRate: number | null; meanRework: number | null; medianCycleMs: number | null; costPerDoneMicros: number | null; ownCostPerDoneMicros: number | null; watchdogFlags: number; overrideShare: number | null; answered: number };
/** costBy: what each agent's runs on the ticket cost (null key: runs with no agent), so a row can count only its own. */
type Done = { agentId: string; cycleMs: number | null; rework: number; reviewed: boolean; costMicros: number; costBy: Map<string | null, number> };

function stats(rows: Done[], flags: number, answered: number, overridden: number, own: (runAgentId: string | null) => boolean): Stats {
  const reviewed = rows.filter((r) => r.reviewed);
  return {
    done: rows.length,
    firstPassRate: reviewed.length ? reviewed.filter((r) => r.rework === 0).length / reviewed.length : null,
    meanRework: mean(rows.map((r) => r.rework)),
    medianCycleMs: median(rows.flatMap((r) => (r.cycleMs === null ? [] : [r.cycleMs]))),
    costPerDoneMicros: rows.length ? rows.reduce((a, r) => a + r.costMicros, 0) / rows.length : null,
    ownCostPerDoneMicros: rows.length ? rows.reduce((a, r) => a + [...r.costBy].reduce((b, [who, m]) => b + (own(who) ? m : 0), 0), 0) / rows.length : null,
    watchdogFlags: flags,
    overrideShare: answered ? overridden / answered : null,
    answered,
  };
}

/** One scorecard number for a change's scope (docs/19 part 3): a role, an agent, a handoff pair, or the company's tail lag. Null when there is nothing to measure. */
export function metricValue(sc: Awaited<ReturnType<ReturnType<typeof workflowService>["scorecard"]>>, metric: string, scope: Record<string, unknown>): number | null {
  if (metric === "tailLagMs") return median(sc.features.flatMap((f) => (f.tailLagMs === null ? [] : [f.tailLagMs])));
  if (metric === "medianWaitMs" || metric === "bounceRate") {
    const h = sc.handoffs.find((x) => x.from === scope.from && x.to === scope.to && x.kind === scope.kind);
    return h ? ((h as Record<string, unknown>)[metric] as number | null) : null;
  }
  const row: Record<string, unknown> | undefined = scope.agentId ? sc.byAgent.find((x) => x.agentId === scope.agentId) : sc.byRole.find((x) => x.role === scope.role);
  return (row?.[metric] as number | null | undefined) ?? null;
}

/** How many finished tickets (or handoffs, for a handoff measure) the scorecard behind `metricValue` rests on. */
export function metricSample(sc: Awaited<ReturnType<ReturnType<typeof workflowService>["scorecard"]>>, metric: string, scope: Record<string, unknown>): number {
  if (metric === "tailLagMs") return sc.byRole.reduce((n, r) => n + r.done, 0);
  if (metric === "medianWaitMs" || metric === "bounceRate") return sc.handoffs.find((x) => x.from === scope.from && x.to === scope.to && x.kind === scope.kind)?.count ?? 0;
  return (scope.agentId ? sc.byAgent.find((x) => x.agentId === scope.agentId) : sc.byRole.find((x) => x.role === scope.role))?.done ?? 0;
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
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, size: tickets.size, assigneeAgentId: tickets.assigneeAgentId, stateChangedAt: tickets.stateChangedAt })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done"), or(sql`${tickets.outcome} is null`, ne(tickets.outcome, "cancelled")), gte(tickets.stateChangedAt, since90), lte(tickets.stateChangedAt, t)));
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

      // ----- Sizes (docs/19 part 6): the same 90 days, by role and size -----
      const sizedRows = doneRows.filter((r) => r.size !== null);
      const sizedIds = sizedRows.map((r) => r.id);
      const sizedReviews = sizedIds.length ? await db.select({ ticketId: ticketReviews.ticketId }).from(ticketReviews).where(and(inArray(ticketReviews.ticketId, sizedIds), eq(ticketReviews.verdict, "changes_requested"))) : [];
      const sizedRework = new Map<string, number>();
      for (const r of sizedReviews) sizedRework.set(r.ticketId, (sizedRework.get(r.ticketId) ?? 0) + 1);
      const sizedCosts = sizedIds.length
        ? await db.select({ ticketId: runs.ticketId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8` }).from(costEvents).innerJoin(runs, eq(runs.id, costEvents.runId)).where(inArray(runs.ticketId, sizedIds)).groupBy(runs.ticketId)
        : [];
      const sizedCost = new Map(sizedCosts.map((c) => [c.ticketId, Number(c.micros)]));
      const cellKey = (role: string, size: number) => `${role}|${size}`;
      const cells = new Map<string, { role: string; size: number; rows: typeof sizedRows }>();
      for (const r of sizedRows) {
        const role = roleOf(r.assigneeAgentId);
        if (!role) continue;
        const k = cellKey(role, r.size!);
        cells.set(k, { role, size: r.size!, rows: [...(cells.get(k)?.rows ?? []), r] });
      }
      const cycleList = (rows: typeof sizedRows) => rows.flatMap((r) => (cycleOf.has(r.id) ? [cycleOf.get(r.id)!] : []));
      const sizes: SizeRow[] = [...cells.values()]
        .map(({ role, size, rows }) => ({ role, size, done: rows.length, p50CycleMs: median(cycleList(rows)), p85CycleMs: percentile(cycleList(rows), 0.85), meanCostMicros: mean(rows.map((r) => sizedCost.get(r.id) ?? 0)), meanRework: mean(rows.map((r) => sizedRework.get(r.id) ?? 0)) }))
        .sort((x, y) => x.role.localeCompare(y.role) || x.size - y.size);
      // Timed tickets per cell, for the "behaves like" note and the critical path.
      const timedIn = (role: string, size: number) => cycleList(cells.get(cellKey(role, size))?.rows ?? []);
      /** Role and size times once that pair has enough history, else the role's. */
      const sizeCycles = (role: string | null, size: number | null): Cycles => {
        const pair = role && size !== null ? spread(timedIn(role, size)) : null;
        return pair && pair.samples >= MIN_SAMPLES ? pair : roleCycles(role);
      };
      const sizeNotes = sizeSignals(sizes, (r) => timedIn(r.role, r.size).length);
      // The newest finished tickets of each size, as reference points for whoever sizes the next task.
      const examples = [...new Set(sizedRows.map((r) => r.size!))]
        .sort((a, b) => a - b)
        .flatMap((size) =>
          sizedRows
            .filter((r) => r.size === size)
            .sort((a, b) => b.stateChangedAt.getTime() - a.stateChangedAt.getTime())
            .slice(0, EXAMPLES_PER_SIZE)
            .map((r) => ({ size, ref: ticketRef(company?.prefix, r.number), title: r.title, role: roleOf(r.assigneeAgentId), cycleMs: cycleOf.get(r.id) ?? null, costMicros: sizedCost.get(r.id) ?? 0, rework: sizedRework.get(r.id) ?? 0 })),
        );

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
        ? await db
            .select({ ticketId: runs.ticketId, agentId: runs.agentId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8`, billed: sql<boolean>`bool_or(${costEvents.basis} = 'billed')` })
            .from(costEvents)
            .innerJoin(runs, eq(runs.id, costEvents.runId))
            .where(inArray(runs.ticketId, windowIds))
            .groupBy(runs.ticketId, runs.agentId)
        : [];
      const costBy = new Map<string, Map<string | null, number>>();
      for (const c of costs) {
        const m = costBy.get(c.ticketId!) ?? new Map<string | null, number>();
        m.set(c.agentId, Number(c.micros));
        costBy.set(c.ticketId!, m);
      }
      // Costs are list-price estimates unless the provider reported what it billed.
      const costBasis = !costs.length ? null : costs.every((c) => c.billed) ? "billed" : costs.some((c) => c.billed) ? "mixed" : "estimate";
      const done: Done[] = inWindow.map((r) => {
        const by = costBy.get(r.id) ?? new Map<string | null, number>();
        return { agentId: r.assigneeAgentId!, cycleMs: cycleOf.get(r.id) ?? null, rework: rework.get(r.id) ?? 0, reviewed: reviewed.has(r.id), costMicros: [...by.values()].reduce((a, b) => a + b, 0), costBy: by };
      });

      const flagRows = await db
        .select({ agentId: tickets.assigneeAgentId })
        .from(watchdogFlags)
        .innerJoin(tickets, eq(tickets.id, watchdogFlags.ticketId))
        .where(and(eq(watchdogFlags.companyId, companyId), gte(watchdogFlags.openedAt, since), lte(watchdogFlags.openedAt, t)));
      const answeredRows = await db
        .select({ agentId: decisions.raisedByAgentId, answer: decisions.answer, recommended: decisions.recommendedOption })
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "answered"), isNotNull(decisions.raisedByAgentId), gte(decisions.answeredAt, since), lte(decisions.answeredAt, t)));

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
          return { key: k, ...stats(d.get(k) ?? [], (f.get(k) ?? []).length, ans.length, ans.filter((x) => x.answer !== x.recommended).length, (who) => !!who && key(who) === k) };
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
      // The assigner is the agent the activity row names; none means the owner or Boss Man itself.
      const assigned = await db.select({ ticketId: activity.ticketId, agentId: activity.agentId, at: activity.at }).from(activity).where(and(eq(activity.companyId, companyId), eq(activity.kind, "assigned"), isNotNull(activity.ticketId), gte(activity.at, since), lte(activity.at, t))).orderBy(asc(activity.at));
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
        .where(and(eq(tickets.companyId, companyId), inArray(reviewRequests.status, ["approved", "changes_requested"]), gte(reviewRequests.decidedAt, since), lte(reviewRequests.decidedAt, t)));
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
            .select({ id: tickets.id, featureId: tickets.featureId, number: tickets.number, title: tickets.title, size: tickets.size, state: tickets.systemState, assigneeAgentId: tickets.assigneeAgentId, stateChangedAt: tickets.stateChangedAt, createdAt: tickets.createdAt })
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
          const cyc = (x: (typeof open)[number]) => sizeCycles(roleOf(x.assigneeAgentId), x.size);
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
              const reasons = [...(x.assigneeAgentId ? [] : ["Nobody is assigned"]), ...(x.state === "blocked" ? ["Blocked"] : []), ...(p85 !== null && startedAt.has(x.id) && ageOf(x) > p85 ? ["Older than usual for this role"] : [])];
              return reasons.length ? [{ id: x.id, ref: ticketRef(company?.prefix, x.number), title: x.title, reasons }] : [];
            }),
          };
        }
        featureRows.push(row);
      }

      // The whole team over the same window: a company-wide middle time can't be summed from the roles.
      const overall = stats(done, flagRows.length, answeredRows.length, answeredRows.filter((x) => x.answer !== x.recommended).length, () => true);
      // ----- Week by week: the last 8 whole weeks (Monday 00:00 UTC), oldest first, then the part-week so far -----
      const dow = (t.getUTCDay() + 6) % 7;
      const thisMonday = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - dow * DAY;
      const weekStarts = Array.from({ length: TREND_WEEKS + 1 }, (_, i) => thisMonday - (TREND_WEEKS - i) * 7 * DAY);
      const trendRows = doneRows.filter((r) => r.assigneeAgentId && r.stateChangedAt.getTime() >= weekStarts[0]!);
      const trendIds = trendRows.map((r) => r.id);
      const trendReviews = trendIds.length ? await db.select({ ticketId: ticketReviews.ticketId, verdict: ticketReviews.verdict }).from(ticketReviews).where(inArray(ticketReviews.ticketId, trendIds)) : [];
      const trendRework = new Map<string, number>();
      const trendReviewed = new Set<string>();
      for (const r of trendReviews) {
        trendReviewed.add(r.ticketId);
        if (r.verdict === "changes_requested") trendRework.set(r.ticketId, (trendRework.get(r.ticketId) ?? 0) + 1);
      }
      const trendCosts = trendIds.length
        ? await db.select({ ticketId: runs.ticketId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::float8` }).from(costEvents).innerJoin(runs, eq(runs.id, costEvents.runId)).where(inArray(runs.ticketId, trendIds)).groupBy(runs.ticketId)
        : [];
      const trendCost = new Map(trendCosts.map((c) => [c.ticketId!, Number(c.micros)]));
      const trend = weekStarts.map((start, i) => {
        const end = i === TREND_WEEKS ? Infinity : weekStarts[i + 1]!;
        const wk: Done[] = trendRows
          .filter((r) => r.stateChangedAt.getTime() >= start && r.stateChangedAt.getTime() < end)
          .map((r) => ({ agentId: r.assigneeAgentId!, cycleMs: cycleOf.get(r.id) ?? null, rework: trendRework.get(r.id) ?? 0, reviewed: trendReviewed.has(r.id), costMicros: trendCost.get(r.id) ?? 0, costBy: new Map() }));
        const s = stats(wk, 0, 0, 0, () => true);
        return { weekStart: new Date(start).toISOString(), partial: i === TREND_WEEKS, done: s.done, firstPassRate: s.firstPassRate, meanRework: s.meanRework, medianCycleMs: s.medianCycleMs, costPerDoneMicros: s.costPerDoneMicros };
      });
      return { days, since: since.toISOString(), costBasis, trend, overall, byRole, byAgent, handoffs, features: featureRows, sizes, sizeNotes, sizeExamples: examples };
    },
    /** The scorecard plus `previous`: the whole team's figures and the handoffs for the same length of time just before (as the retro builds its earlier period). */
    async scorecardWithPrevious(companyId: string, days: number) {
      const sc = await workflowService(db, deps).scorecard(companyId, days);
      const before = new Date(now().getTime() - days * DAY);
      const prev = await workflowService(db, { now: () => before }).scorecard(companyId, days);
      return { ...sc, previous: { overall: prev.overall, handoffs: prev.handoffs } };
    },
  };
}
