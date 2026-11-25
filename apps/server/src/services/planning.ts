// Roadmap and plan views (v1.1). The roadmap is each company's objectives with their milestones
// on a timeline; the plan is a company's tickets and what they wait on, as a graph with blocked
// chains and their causes worked out on the server, so the browser only draws.
import { and, asc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { layoutPlan, milestoneHorizon, milestoneVerdict, ticketRef, type Horizon, type MilestoneAction, type MilestoneStatus } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagements, features, keyResults, milestones, objectives, projects, ticketDependencies, tickets, watchdogFlags } from "../db/schema.js";
import { WorkError } from "./work.js";
import { record } from "./activity.js";
import { ticketBlockerFinished } from "./ticket-links.js";
import { hiddenWhileRechecked } from "./card-validity.js";
import { heldReadyTickets } from "./agent-wip.js";
import { readingsFor } from "./key-result-readings.js";
import { ticketsOfMilestones } from "./milestone-tickets.js";
import { burnupWeeks, paceFromBurnup } from "./roadmap-burnup.js";

export const OBJECTIVE_STATUSES = ["active", "done", "dropped"] as const;

type NodeKind = "ticket" | "engagement" | "decision";
export type PlanNodeView = {
  id: string;
  kind: NodeKind;
  /** The ticket's reference, e.g. BOS-458; null for engagements and decisions. */
  ref: string | null;
  title: string;
  state: string;
  open: boolean;
  link: string;
  assignee: string | null;
  project: string | null;
  layer: number;
  blocked: boolean;
  causes: string[];
  holdingUp: number;
};

export const PACE_DAYS = 28;
const dayMs = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

export type MilestoneForecast = {
  pointsDone: number;
  pointsLeft: number;
  unsized: number;
  /** Points the company finished per week over the last 28 days. */
  pace: number;
  /** today + left / pace; null when there is no pace. Today when nothing is left. */
  expectedFinish: string | null;
  /** Whole days the expected finish falls after the target date; 0 when on time or no target. */
  daysLate: number;
};

/**
 * The points of a sized task, as a whole number: 0 for a task with no size. A task whose size reads as 0 (a whole
 * number that is not one of TASK_SIZES, e.g. saved before the size check) counts as unsized rather than adding
 * nothing, so "N of M points done" never leaves a sized task's points out of M (BOS-2532, G2).
 */
export const effectiveSize = (size: number | null | undefined): number => (typeof size === "number" && Number.isFinite(size) && size >= 1 ? Math.round(size) : 0);

/** Pure forecast for one milestone: sized points done and left, plus the finish date at the recent pace. */
export function forecastMilestone(rows: Array<{ size: number | null; done: boolean }>, pace: number, targetDate: string | null, today: string): MilestoneForecast {
  let pointsDone = 0;
  let pointsLeft = 0;
  let unsized = 0;
  for (const r of rows) {
    const size = effectiveSize(r.size);
    if (size === 0) {
      if (!r.done) unsized++;
    } else if (r.done) pointsDone += size;
    else pointsLeft += size;
  }
  const expectedFinish = pointsLeft === 0 ? today : pace > 0 ? addDays(today, Math.ceil((pointsLeft / pace) * 7)) : null;
  const daysLate = expectedFinish && targetDate && expectedFinish > targetDate ? Math.round((Date.parse(expectedFinish) - Date.parse(targetDate)) / dayMs) : 0;
  return { pointsDone, pointsLeft, unsized, pace, expectedFinish, daysLate };
}

/** Points each company finished per week over the last PACE_DAYS days (companies with none are absent). */
export async function paceByCompany(db: Db, today: string): Promise<Map<string, number>> {
  const since = new Date(Date.parse(`${addDays(today, -PACE_DAYS)}T00:00:00Z`));
  const paceRows = await db
    .select({ companyId: tickets.companyId, points: sql<number>`coalesce(sum(${tickets.size}), 0)`.mapWith(Number) })
    .from(tickets)
    .where(and(eq(tickets.systemState, "done"), sql`${tickets.outcome} is distinct from 'cancelled'`, gte(tickets.stateChangedAt, since)))
    .groupBy(tickets.companyId);
  return new Map(paceRows.map((p) => [p.companyId, p.points / (PACE_DAYS / 7)]));
}

export function planningService(db: Db, deps: { release: (ticketId: string) => Promise<unknown> }) {
  async function companyOfObjective(id: string) {
    const [o] = await db.select({ companyId: objectives.companyId }).from(objectives).where(eq(objectives.id, id));
    if (!o) throw new WorkError(404, "No such objective.");
    return o.companyId;
  }

  return {
    /** Every company's active objectives, milestones by date, and each milestone's progress. */
    async roadmap(today: string, opts: { includeClosed?: boolean } = {}) {
      const cos = await db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(asc(companies.name));
      const objs = await db
        .select()
        .from(objectives)
        .where(opts.includeClosed ? undefined : eq(objectives.status, "active"))
        .orderBy(asc(objectives.priority), asc(objectives.createdAt));
      const ids = objs.map((o) => o.id);
      const ms = ids.length ? await db.select().from(milestones).where(inArray(milestones.objectiveId, ids)).orderBy(sql`${milestones.targetDate} asc nulls last`, asc(milestones.title)) : [];
      const krs = ids.length ? await db.select().from(keyResults).where(inArray(keyResults.objectiveId, ids)) : [];
      const readings = await readingsFor(db, krs.map((k) => k.id));
      const msIds = ms.map((m) => m.id);
      // One set of tickets per milestone (direct plus its features', cancelled left out): the counts, the status, the
      // forecast and the burn-up are all worked out from it, so the timeline and the list can't disagree (BOS-2560).
      const ticketsOf = new Map<string, Awaited<ReturnType<typeof ticketsOfMilestones>>>();
      for (const t of await ticketsOfMilestones(db, msIds)) ticketsOf.set(t.milestoneId, [...(ticketsOf.get(t.milestoneId) ?? []), t]);
      // BOS-2579: a merged ticket with no go-live wait left is live, so it counts as delivered, not blocked. Whether the
      // unbuilt rest waits on the owner (an open card) or the watchdog flags it stuck is read once for every milestone.
      const delivered = (t: { state: string; mergeCommit: string | null; goLiveWait: string | null }) => (t.state === "blocked" || t.state === "in_progress") && !!t.mergeCommit && !t.goLiveWait;
      const unbuiltIds = [...ticketsOf.values()].flat().filter((t) => t.state !== "done" && !delivered(t)).map((t) => t.id);
      const ownerWaiting = new Set<string>();
      const stuckIds = new Set<string>();
      if (unbuiltIds.length) {
        for (const r of await db
          .select({ id: ticketDependencies.blockedTicketId })
          .from(ticketDependencies)
          .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
          .where(and(inArray(ticketDependencies.blockedTicketId, unbuiltIds), eq(decisions.status, "open")))) ownerWaiting.add(r.id);
        for (const f of await db
          .select({ id: watchdogFlags.ticketId })
          .from(watchdogFlags)
          .where(and(inArray(watchdogFlags.ticketId, unbuiltIds), eq(watchdogFlags.status, "open"), ne(watchdogFlags.rule, "owner_decision_waiting"), sql`${watchdogFlags.lastFlaggedAt} is not null`))) stuckIds.add(f.id);
      }
      const QUIET_DAYS = 3;
      const figures = (m: (typeof ms)[number]) => {
        const rows = ticketsOf.get(m.id) ?? [];
        const done = rows.filter((t) => t.state === "done");
        const live = rows.filter(delivered);
        const burnup = burnupWeeks(rows.map((t) => ({ size: t.size, createdAt: t.createdAt, doneAt: t.state === "done" ? t.changedAt : null })), today);
        // Its own pace: points of this milestone finished in the last 4 weeks, a week. Delivered tickets are built and live, so they count as done.
        const forecast = forecastMilestone(rows.map((t) => ({ size: t.size, done: t.state === "done" || delivered(t) })), paceFromBurnup(burnup), m.targetDate, today);
        const counts = { total: rows.length, done: done.length, blocked: rows.filter((t) => t.state === "blocked" && !delivered(t)).length };
        const finishedAt = rows.length > 0 && done.length === rows.length ? new Date(Math.max(...done.map((t) => t.changedAt.getTime()))).toISOString() : null;
        const nowMs = Date.parse(`${today}T00:00:00Z`);
        const checks = live.map((t) => {
          // Gone quiet: its watch date has passed with no report, or it has no date of its own and nobody touched it for 3 days.
          const since = t.watchUntil ? t.watchUntil.getTime() : t.changedAt.getTime();
          const idle = Math.floor((nowMs - since) / dayMs);
          const quiet = t.watchUntil ? since < nowMs : idle >= QUIET_DAYS;
          return { id: t.id, ref: t.ref, assignee: t.assignee, quietDays: quiet ? Math.max(0, idle) : null };
        });
        const ends = live.flatMap((t) => (t.watchUntil ? [t.watchUntil.toISOString().slice(0, 10)] : [])).sort().at(-1) ?? null;
        const needsAction = rows
          .filter((t) => t.state !== "done" && !delivered(t))
          .flatMap((t): MilestoneAction[] => (ownerWaiting.has(t.id) ? [{ id: t.id, ref: t.ref, why: "owner" }] : stuckIds.has(t.id) ? [{ id: t.id, ref: t.ref, why: "stuck" }] : []));
        // One function gives the badge and the line under it, worked out when the page is read, so they can't disagree (R59).
        const verdict = milestoneVerdict({ ...counts, delivered: live.length, daysLate: forecast.daysLate, noEstimate: forecast.pointsLeft > 0 && forecast.expectedFinish === null, needsAction, checks, lastCheckEnds: ends, expectedFinish: forecast.expectedFinish }, m.targetDate, today);
        return { counts, active: rows.filter((t) => t.state === "in_progress" || t.state === "review").length, burnup, forecast, finishedAt, status: verdict.status as MilestoneStatus, reason: verdict.reason, reasonTickets: verdict.tickets };
      };
      return cos
        .map((c) => ({
          ...c,
          objectives: objs
            .filter((o) => o.companyId === c.id)
            .map((o) => ({
              id: o.id,
              title: o.title,
              priority: o.priority,
              status: o.status,
              keyResults: krs
                .filter((k) => k.objectiveId === o.id)
                .map((k) => ({ id: k.id, title: k.title, current: k.current, target: k.target, unit: k.unit, progress: k.target ? Math.max(0, Math.min(1, (k.current ?? 0) / k.target)) : null, readings: readings.get(k.id) ?? [] })),
              milestones: ms
                .filter((m) => m.objectiveId === o.id)
                .map((m) => {
                  const f = figures(m);
                  return {
                    id: m.id,
                    title: m.title,
                    targetDate: m.targetDate,
                    ...f.counts,
                    active: f.active,
                    status: f.status,
                    reason: f.reason,
                    reasonTickets: f.reasonTickets,
                    forecast: f.forecast,
                    /** When the last of its tickets was finished (the burn-up's stand-in); null until it is done. */
                    finishedAt: f.finishedAt,
                    /** 8 weekly points of points done and planned, oldest first (BOS-2397). */
                    burnup: f.burnup,
                    pinned: m.horizon,
                    horizon: milestoneHorizon({ ...f.counts, active: f.active, targetDate: m.targetDate, horizon: m.horizon }, today),
                    /** BOS-2581: the owner has asked the CEO to plan a remedy when this turns At risk or Late. Off unless turned on. */
                    ceoManagesRisk: m.ceoManagesRisk,
                  };
                }),
            })),
        }));
    },

    /** A milestone's tickets, for the roadmap's detail panel: the same set the counts and forecast use, with cancelled ones shown as such. */
    async milestoneTickets(milestoneId: string) {
      const rows = await ticketsOfMilestones(db, [milestoneId], { includeCancelled: true });
      return rows.map((t) => ({ id: t.id, title: t.title, state: t.state, outcome: t.outcome, assignee: t.assignee }));
    },

    async updateObjective(id: string, patch: { title?: string; priority?: number; status?: (typeof OBJECTIVE_STATUSES)[number] }) {
      const [o] = await db.update(objectives).set(patch).where(eq(objectives.id, id)).returning();
      if (!o) throw new WorkError(404, "No such objective.");
      return o;
    },

    async updateMilestone(id: string, patch: { title?: string; targetDate?: string | null; objectiveId?: string; horizon?: Horizon | null; ceoManagesRisk?: boolean }) {
      const [m] = await db.select({ objectiveId: milestones.objectiveId }).from(milestones).where(eq(milestones.id, id));
      if (!m) throw new WorkError(404, "No such milestone.");
      if (patch.objectiveId && (await companyOfObjective(patch.objectiveId)) !== (await companyOfObjective(m.objectiveId))) throw new WorkError(422, "A milestone can only move to an objective of the same company.");
      const [u] = await db.update(milestones).set(patch).where(eq(milestones.id, id)).returning();
      return u!;
    },

    /**
     * BOS-2581: turn "CEO manages at risk" on or off for every milestone of a company at once. Off first: turning them back
     * on later starts each afresh, so one that is At risk now doesn't wake the CEO again. On leaves a milestone already on
     * exactly as it is (same rule). The page warns that each managed milestone can cost a CEO run before this is pressed.
     */
    async setCeoManagesRiskForCompany(companyId: string, on: boolean) {
      const objs = await db.select({ id: objectives.id }).from(objectives).where(eq(objectives.companyId, companyId));
      if (!objs.length) return { changed: 0, on };
      const rows = await db.update(milestones).set({ ceoManagesRisk: on }).where(inArray(milestones.objectiveId, objs.map((o) => o.id))).returning({ id: milestones.id });
      return { changed: rows.length, on };
    },

    /** Deleting a milestone leaves its tickets in place, unscheduled. */
    async deleteMilestone(id: string) {
      const [m] = await db.delete(milestones).where(eq(milestones.id, id)).returning({ id: milestones.id });
      if (!m) throw new WorkError(404, "No such milestone.");
    },

    /** The company's open tickets, plus everything they wait on, as a laid-out graph. */
    async plan(companyId: string) {
      const edges = await db
        .select({ id: ticketDependencies.id, to: ticketDependencies.blockedTicketId, ticket: ticketDependencies.blockerTicketId, engagement: ticketDependencies.blockerEngagementId, decision: ticketDependencies.blockerDecisionId, until: ticketDependencies.until })
        .from(ticketDependencies)
        .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
        .where(and(eq(tickets.companyId, companyId), ne(tickets.systemState, "done")));
      const ticketIds = new Set<string>();
      for (const e of edges) (ticketIds.add(e.to), e.ticket && ticketIds.add(e.ticket));
      const ts = ticketIds.size
        ? await db
            .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, title: tickets.title, state: tickets.systemState, mergeCommit: tickets.mergeCommit, assignee: agents.name, project: projects.name })
            .from(tickets)
            .innerJoin(projects, eq(projects.id, tickets.projectId))
            .innerJoin(companies, eq(companies.id, tickets.companyId))
            .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
            .where(inArray(tickets.id, [...ticketIds]))
        : [];
      const engIds = [...new Set(edges.flatMap((e) => (e.engagement ? [e.engagement] : [])))];
      const es = engIds.length ? await db.select({ id: engagements.id, title: engagements.title, status: engagements.status }).from(engagements).where(inArray(engagements.id, engIds)) : [];
      const decIds = [...new Set(edges.flatMap((e) => (e.decision ? [e.decision] : [])))];
      const ds = decIds.length ? await db.select({ id: decisions.id, question: decisions.question, status: decisions.status }).from(decisions).where(inArray(decisions.id, decIds)) : [];

      const base: Array<Omit<PlanNodeView, "layer" | "blocked" | "causes" | "holdingUp">> = [
        ...ts.map((t) => ({ id: t.id, kind: "ticket" as const, ref: ticketRef(t.prefix, t.number), title: t.title, state: t.state, open: !ticketBlockerFinished({ ticketState: t.state, mergeCommit: t.mergeCommit, until: edges.some((e) => e.ticket === t.id && e.until !== "merged") || !edges.some((e) => e.ticket === t.id) ? "done" : "merged" }), link: `#/tickets/${t.id}`, assignee: t.assignee, project: t.project })),
        ...es.map((e) => ({ id: e.id, kind: "engagement" as const, ref: null, title: e.title, state: e.status, open: e.status !== "signed_off", link: `#/engagements/${e.id}`, assignee: null, project: null })),
        ...ds.map((d) => ({ id: d.id, kind: "decision" as const, ref: null, title: d.question, state: d.status, open: d.status === "open", link: "#/decisions", assignee: null, project: null })),
      ];
      const links = edges.map((e) => ({ id: e.id, from: (e.ticket ?? e.engagement ?? e.decision)!, to: e.to }));
      const layout = layoutPlan(base, links);
      const nodes: PlanNodeView[] = base.map((n) => ({ ...n, layer: layout.layer[n.id] ?? 0, blocked: layout.blocked.has(n.id), causes: layout.causes[n.id] ?? [], holdingUp: layout.holdingUp[n.id] ?? 0 }));
      // BOS-1489: Ready tickets the merge line or check queue is holding back, for "What's holding work up".
      const queueHeld = (await heldReadyTickets(db, companyId)).filter((h) => h.scope === "queue");
      const startHold = queueHeld.length
        ? { reason: (queueHeld[0]!.ticket.stateNote ?? "Held while the merge line or check queue is long").replace(/\. It starts by itself.*$/, ""), tickets: queueHeld.map((h) => ({ id: h.ticket.id, title: h.ticket.title, link: `#/tickets/${h.ticket.id}` })) }
        : null;
      return { nodes, edges: links, columns: layout.columns, startHold };
    },

    /** What a ticket waits on and what waits on it. */
    async ticketLinks(ticketId: string) {
      const rows = await db
        .select({
          id: ticketDependencies.id,
          blockedTicketId: ticketDependencies.blockedTicketId,
          blockerTicketId: ticketDependencies.blockerTicketId,
          blockerEngagementId: ticketDependencies.blockerEngagementId,
          blockerDecisionId: ticketDependencies.blockerDecisionId,
          until: ticketDependencies.until,
        })
        .from(ticketDependencies)
        .where(or(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerTicketId, ticketId)));
      const tIds = [...new Set(rows.flatMap((r) => [r.blockedTicketId, r.blockerTicketId]).filter((x): x is string => !!x && x !== ticketId))];
      const ts = tIds.length ? await db.select({ id: tickets.id, title: tickets.title, state: tickets.systemState, mergeCommit: tickets.mergeCommit }).from(tickets).where(inArray(tickets.id, tIds)) : [];
      const eIds = rows.flatMap((r) => (r.blockerEngagementId ? [r.blockerEngagementId] : []));
      const es = eIds.length ? await db.select({ id: engagements.id, title: engagements.title, status: engagements.status }).from(engagements).where(inArray(engagements.id, eIds)) : [];
      const dIds = rows.flatMap((r) => (r.blockerDecisionId ? [r.blockerDecisionId] : []));
      const ds = dIds.length ? await db.select({ id: decisions.id, question: decisions.question, status: decisions.status, staleAt: decisions.staleAt, recheckStage: decisions.recheckStage, context: decisions.context }).from(decisions).where(inArray(decisions.id, dIds)) : [];
      // A card being re-checked is not the owner's to answer yet (BOS-1193), so this ticket's page doesn't offer to answer it.
      const hiddenCards = await hiddenWhileRechecked(db, ds);
      const t = (id: string) => ts.find((x) => x.id === id);
      return {
        waitsOn: rows
          .filter((r) => r.blockedTicketId === ticketId)
          .map((r) => {
            if (r.blockerTicketId) {
              const b = t(r.blockerTicketId);
              return { dependencyId: r.id, kind: "ticket" as const, id: r.blockerTicketId, title: b?.title ?? "", state: b?.state ?? "", open: !ticketBlockerFinished({ ticketState: b?.state ?? null, mergeCommit: b?.mergeCommit ?? null, until: r.until }), until: r.until, link: `#/tickets/${r.blockerTicketId}` };
            }
            if (r.blockerEngagementId) {
              const e = es.find((x) => x.id === r.blockerEngagementId);
              return { dependencyId: r.id, kind: "engagement" as const, id: r.blockerEngagementId, title: e?.title ?? "", state: e?.status ?? "", open: e?.status !== "signed_off", link: `#/engagements/${r.blockerEngagementId}` };
            }
            const d = ds.find((x) => x.id === r.blockerDecisionId);
            return { dependencyId: r.id, kind: "decision" as const, id: r.blockerDecisionId!, title: d?.question ?? "", state: d?.status ?? "", open: d?.status === "open" && !hiddenCards.has(r.blockerDecisionId!), rechecking: hiddenCards.has(r.blockerDecisionId!), link: `#/decisions/${r.blockerDecisionId}` };
          }),
        blocks: rows
          .filter((r) => r.blockerTicketId === ticketId)
          .map((r) => {
            const b = t(r.blockedTicketId);
            return { dependencyId: r.id, id: r.blockedTicketId, title: b?.title ?? "", state: b?.state ?? "", link: `#/tickets/${r.blockedTicketId}` };
          }),
      };
    },

    /**
     * The tickets around one ticket, for the ticket page's Related section: the feature it delivers, its parent,
     * its sub-tasks, its peers (same feature or same parent), what it waits on and blocks, and the tickets its
     * description names by number. Only tickets in its own company.
     */
    async relatedTickets(ticketId: string) {
      const [me] = await db
        .select({ id: tickets.id, companyId: tickets.companyId, featureId: tickets.featureId, parentId: tickets.parentTicketId, body: tickets.body })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!me) throw new WorkError(404, "No such ticket.");
      const cols = { id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, prefix: companies.ticketPrefix };
      const from = () => db.select(cols).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId));
      type Row = Awaited<ReturnType<ReturnType<typeof from>["limit"]>>[number];
      const view = (r: Row) => ({ id: r.id, ref: ticketRef(r.prefix, r.number), title: r.title, state: r.state, cancelled: r.state === "done" && r.outcome === "cancelled" });
      const others = (rows: Row[]) => rows.filter((r) => r.id !== ticketId).map(view);

      const [feature] = me.featureId ? await db.select({ id: features.id, title: features.title, status: features.status }).from(features).where(eq(features.id, me.featureId)) : [];
      const [parent] = me.parentId ? await from().where(eq(tickets.id, me.parentId)) : [];
      const children = await from().where(eq(tickets.parentTicketId, ticketId)).orderBy(asc(tickets.number)).limit(200);
      const siblings = [
        ...(me.featureId ? await from().where(eq(tickets.featureId, me.featureId)).orderBy(asc(tickets.number)).limit(200) : []),
        ...(me.parentId ? await from().where(eq(tickets.parentTicketId, me.parentId)).orderBy(asc(tickets.number)).limit(200) : []),
      ];
      // A sub-task of this ticket under the same feature is listed as a sub-task, not a peer.
      const childIds = new Set(children.map((c) => c.id));
      const peers = [...new Map(siblings.map((r) => [r.id, r])).values()].filter((r) => !childIds.has(r.id) && r.id !== me.parentId);

      const edges = await db
        .select({ blocked: ticketDependencies.blockedTicketId, blocker: ticketDependencies.blockerTicketId, until: ticketDependencies.until })
        .from(ticketDependencies)
        .where(or(eq(ticketDependencies.blockedTicketId, ticketId), eq(ticketDependencies.blockerTicketId, ticketId)));
      const waitIds = edges.filter((e) => e.blocked === ticketId && e.blocker).map((e) => e.blocker!);
      const blockIds = edges.filter((e) => e.blocker === ticketId).map((e) => e.blocked);
      const byIds = async (ids: string[]) => (ids.length ? from().where(and(inArray(tickets.id, ids), eq(tickets.companyId, me.companyId))) : []);

      const numbers = [...new Set([...(me.body ?? "").matchAll(/\b([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})\b/g)].map((m) => `${m[1]!.toUpperCase()}-${Number(m[2])}`))];
      const mentioned = numbers.length
        ? (await from().where(and(eq(tickets.companyId, me.companyId), inArray(tickets.number, numbers.map((r) => Number(r.slice(r.lastIndexOf("-") + 1))))))).filter((r) => {
            const ref = ticketRef(r.prefix, r.number);
            return !!ref && numbers.includes(ref.toUpperCase());
          })
        : [];
      // A ticket shown under a more specific heading isn't repeated under Mentioned.
      const shown = new Set([ticketId, me.parentId, ...children.map((r) => r.id), ...peers.map((r) => r.id), ...waitIds, ...blockIds]);

      return {
        feature: feature ? { id: feature.id, title: feature.title, status: feature.status } : null,
        parent: parent ? view(parent) : null,
        subtasks: others(children),
        peers: others(peers),
        // "Until merged" or "until done" shows beside each ticket it waits on (BOS-989).
        waitsOn: others(await byIds(waitIds)).map((r) => ({ ...r, until: edges.find((e) => e.blocked === ticketId && e.blocker === r.id)?.until ?? "done" })),
        blocks: others(await byIds(blockIds)),
        mentioned: others(mentioned.filter((r) => !shown.has(r.id))),
      };
    },

    /**
     * Removes a dependency. A decision blocker is removed by answering the decision, so it stays.
     * The ticket that was waiting moves to ready if nothing else holds it.
     */
    async removeDependency(id: string) {
      const [d] = await db.select().from(ticketDependencies).where(eq(ticketDependencies.id, id));
      if (!d) throw new WorkError(404, "No such dependency.");
      if (d.blockerDecisionId) throw new WorkError(422, "This ticket waits on a decision. Answer the decision to release it.");
      await db.delete(ticketDependencies).where(eq(ticketDependencies.id, id));
      // Leave a line in the ticket's history, so it doesn't just start with no sign of why.
      let what = "a ticket";
      if (d.blockerTicketId) {
        const [b] = await db
          .select({ number: tickets.number, prefix: companies.ticketPrefix, title: tickets.title })
          .from(tickets)
          .innerJoin(companies, eq(companies.id, tickets.companyId))
          .where(eq(tickets.id, d.blockerTicketId));
        if (b) what = `${ticketRef(b.prefix, b.number)} ${b.title}`;
      } else if (d.blockerEngagementId) {
        const [e] = await db.select({ title: engagements.title }).from(engagements).where(eq(engagements.id, d.blockerEngagementId));
        what = `engagement ${e?.title ?? d.blockerEngagementId}`;
      }
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, d.blockedTicketId));
      if (t) await record(db, { companyId: t.companyId, ticketId: d.blockedTicketId, kind: "dependency", summary: `The owner removed the wait on ${what}`, at: new Date() });
      await deps.release(d.blockedTicketId);
    },

    /** Open tickets of a company, for pickers. */
    async openTickets(companyId: string) {
      return db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, project: projects.name })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(and(eq(tickets.companyId, companyId), ne(tickets.systemState, "done")))
        .orderBy(asc(projects.name), asc(tickets.createdAt))
        .limit(1000);
    },
  };
}
