// Roadmap and plan views (v1.1). The roadmap is each company's objectives with their milestones
// on a timeline; the plan is a company's tickets and what they wait on, as a graph with blocked
// chains and their causes worked out on the server, so the browser only draws.
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { layoutPlan, milestoneHorizon, milestoneStatus, ticketRef, type Horizon, type MilestoneStatus } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagements, features, keyResults, milestones, objectives, projects, ticketDependencies, tickets } from "../db/schema.js";
import { WorkError } from "./work.js";
import { ticketBlockerFinished } from "./ticket-links.js";

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
      const msIds = ms.map((m) => m.id);
      const counts = msIds.length
        ? await db
            .select({
              milestoneId: tickets.milestoneId,
              total: sql<number>`count(*) filter (where ${tickets.outcome} is distinct from 'cancelled')`.mapWith(Number),
              done: sql<number>`count(*) filter (where ${tickets.systemState} = 'done' and ${tickets.outcome} is distinct from 'cancelled')`.mapWith(Number),
              blocked: sql<number>`count(*) filter (where ${tickets.systemState} = 'blocked')`.mapWith(Number),
              active: sql<number>`count(*) filter (where ${tickets.systemState} in ('in_progress', 'review'))`.mapWith(Number),
            })
            .from(tickets)
            .where(inArray(tickets.milestoneId, msIds))
            .groupBy(tickets.milestoneId)
        : [];
      const byMs = new Map(counts.map((c) => [c.milestoneId, c]));
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
                .map((k) => ({ id: k.id, title: k.title, current: k.current, target: k.target, unit: k.unit, progress: k.target ? Math.max(0, Math.min(1, (k.current ?? 0) / k.target)) : null })),
              milestones: ms
                .filter((m) => m.objectiveId === o.id)
                .map((m) => {
                  const n = byMs.get(m.id) ?? { total: 0, done: 0, blocked: 0, active: 0 };
                  const counts = { total: n.total, done: n.done, blocked: n.blocked };
                  return {
                    id: m.id,
                    title: m.title,
                    targetDate: m.targetDate,
                    ...counts,
                    active: n.active,
                    status: milestoneStatus(counts, m.targetDate, today) as MilestoneStatus,
                    pinned: m.horizon,
                    horizon: milestoneHorizon({ ...counts, active: n.active, targetDate: m.targetDate, horizon: m.horizon }, today),
                  };
                }),
            })),
        }));
    },

    /** A milestone's tickets, for the roadmap's detail panel. */
    async milestoneTickets(milestoneId: string) {
      return db
        .select({ id: tickets.id, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, assignee: agents.name })
        .from(tickets)
        .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
        .where(eq(tickets.milestoneId, milestoneId))
        .orderBy(asc(tickets.createdAt));
    },

    async updateObjective(id: string, patch: { title?: string; priority?: number; status?: (typeof OBJECTIVE_STATUSES)[number] }) {
      const [o] = await db.update(objectives).set(patch).where(eq(objectives.id, id)).returning();
      if (!o) throw new WorkError(404, "No such objective.");
      return o;
    },

    async updateMilestone(id: string, patch: { title?: string; targetDate?: string | null; objectiveId?: string; horizon?: Horizon | null }) {
      const [m] = await db.select({ objectiveId: milestones.objectiveId }).from(milestones).where(eq(milestones.id, id));
      if (!m) throw new WorkError(404, "No such milestone.");
      if (patch.objectiveId && (await companyOfObjective(patch.objectiveId)) !== (await companyOfObjective(m.objectiveId))) throw new WorkError(422, "A milestone can only move to an objective of the same company.");
      const [u] = await db.update(milestones).set(patch).where(eq(milestones.id, id)).returning();
      return u!;
    },

    /** Deleting a milestone leaves its tickets in place, unscheduled. */
    async deleteMilestone(id: string) {
      const [m] = await db.delete(milestones).where(eq(milestones.id, id)).returning({ id: milestones.id });
      if (!m) throw new WorkError(404, "No such milestone.");
    },

    /** The company's open tickets, plus everything they wait on, as a laid-out graph. */
    async plan(companyId: string) {
      const edges = await db
        .select({ id: ticketDependencies.id, to: ticketDependencies.blockedTicketId, ticket: ticketDependencies.blockerTicketId, engagement: ticketDependencies.blockerEngagementId, decision: ticketDependencies.blockerDecisionId })
        .from(ticketDependencies)
        .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
        .where(and(eq(tickets.companyId, companyId), ne(tickets.systemState, "done")));
      const ticketIds = new Set<string>();
      for (const e of edges) (ticketIds.add(e.to), e.ticket && ticketIds.add(e.ticket));
      const ts = ticketIds.size
        ? await db
            .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, title: tickets.title, state: tickets.systemState, assignee: agents.name, project: projects.name })
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
        ...ts.map((t) => ({ id: t.id, kind: "ticket" as const, ref: ticketRef(t.prefix, t.number), title: t.title, state: t.state, open: t.state !== "done", link: `#/tickets/${t.id}`, assignee: t.assignee, project: t.project })),
        ...es.map((e) => ({ id: e.id, kind: "engagement" as const, ref: null, title: e.title, state: e.status, open: e.status !== "signed_off", link: `#/engagements/${e.id}`, assignee: null, project: null })),
        ...ds.map((d) => ({ id: d.id, kind: "decision" as const, ref: null, title: d.question, state: d.status, open: d.status === "open", link: "#/decisions", assignee: null, project: null })),
      ];
      const links = edges.map((e) => ({ id: e.id, from: (e.ticket ?? e.engagement ?? e.decision)!, to: e.to }));
      const layout = layoutPlan(base, links);
      const nodes: PlanNodeView[] = base.map((n) => ({ ...n, layer: layout.layer[n.id] ?? 0, blocked: layout.blocked.has(n.id), causes: layout.causes[n.id] ?? [], holdingUp: layout.holdingUp[n.id] ?? 0 }));
      return { nodes, edges: links, columns: layout.columns };
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
      const ds = dIds.length ? await db.select({ id: decisions.id, question: decisions.question, status: decisions.status }).from(decisions).where(inArray(decisions.id, dIds)) : [];
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
            return { dependencyId: r.id, kind: "decision" as const, id: r.blockerDecisionId!, title: d?.question ?? "", state: d?.status ?? "", open: d?.status === "open", link: "#/decisions" };
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
