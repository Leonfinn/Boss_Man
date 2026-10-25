// Projects, boards, tickets, dependencies and objectives (Phase 3, R16–R18, R25).
import { and, asc, eq, inArray, isNull, or, ne } from "drizzle-orm";
import { columnProblems, DEFAULT_COLUMNS, effectiveDueDate, planFirstByDefault, type ColumnSpec, type RiskTier, type SystemState } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import { agents, decisions, engagements, features, keyResults, milestones, objectives, projects, runs, ticketDependencies, tickets, workflowColumns } from "../db/schema.js";

export class WorkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type TicketPatch = {
  title?: string;
  body?: string | null;
  columnId?: string;
  state?: SystemState;
  outcome?: "completed" | "cancelled";
  assigneeAgentId?: string | null;
  /** A note for whoever reads the ticket next. */
  stateNote?: string;
  assignedToOwner?: boolean;
  milestoneId?: string | null;
  keyResultId?: string | null;
  dueDate?: string | null;
  customFields?: Record<string, unknown>;
  /** Risk tier (R48); null means medium. */
  risk?: RiskTier | null;
  /** The feature request this ticket delivers. */
  featureId?: string | null;
  /** Makes this a sub-task of that task: it joins the parent's feature and the parent waits on it. */
  parentTicketId?: string;
  /** The agent that created it, so a repeated call after a resume returns the same task. */
  createdByAgentId?: string | null;
  /** Start in plan mode until a plan is approved (R40). */
  planFirst?: boolean;
  /** Acceptance criteria (R?): 1 to 10 non-empty strings; empty means none. */
  acceptanceCriteria?: string[];
  /** Research, wiki, docs or deploy-only work: an empty diff is fine. */
  noCode?: boolean;
  /** Move past a full column anyway. */
  overLimit?: boolean;
};

export type WorkHooks = {
  onAssigned?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  onDone?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  /** A task of this feature started, finished, reopened, moved or was added: its status may need to follow. */
  onFeature?: (featureId: string) => Promise<unknown>;
  now?: () => Date;
};

export function workService(db: Db, hooks: WorkHooks = {}) {
  const now = hooks.now ?? (() => new Date());
  async function project(id: string) {
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) throw new WorkError(404, "No such project.");
    return p;
  }

  async function columnsOf(projectId: string) {
    return db.select().from(workflowColumns).where(eq(workflowColumns.projectId, projectId)).orderBy(asc(workflowColumns.position));
  }

  async function assertAgentInCompany(agentId: string, companyId: string) {
    const [a] = await db.select({ id: agents.id, name: agents.name, retiredAt: agents.retiredAt }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!a) throw new WorkError(422, "That agent isn't in this company.");
    if (a.retiredAt) throw new WorkError(422, `${a.name} is retired.`);
  }

  async function assertLinkInCompany(kind: "milestone" | "keyResult", id: string, companyId: string) {
    const table = kind === "milestone" ? milestones : keyResults;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .innerJoin(objectives, eq(objectives.id, table.objectiveId))
      .where(and(eq(table.id, id), eq(objectives.companyId, companyId)));
    if (!row) throw new WorkError(422, `That ${kind === "milestone" ? "milestone" : "key result"} isn't in this company.`);
  }

  async function assertFeatureInCompany(id: string, companyId: string) {
    const [f] = await db.select({ id: features.id }).from(features).where(and(eq(features.id, id), eq(features.companyId, companyId)));
    if (!f) throw new WorkError(422, "That feature isn't in this company.");
  }

  /** The task a sub-task hangs off: in the same company and not itself a sub-task (one level only). */
  async function parentOf(parentId: string, companyId: string) {
    const [p] = await db.select().from(tickets).where(and(eq(tickets.id, parentId), eq(tickets.companyId, companyId)));
    if (!p) throw new WorkError(422, "That parent task isn't in this company.");
    if (p.parentTicketId) throw new WorkError(422, "A sub-task can't have sub-tasks.");
    return p;
  }

  /** Resolves where a ticket lands and enforces the column's card limit. */
  async function placement(projectId: string, target: { columnId?: string; state?: SystemState }, opts: { ticketId?: string; overLimit?: boolean }) {
    const cols = await columnsOf(projectId);
    const col = target.columnId ? cols.find((c) => c.id === target.columnId) : cols.find((c) => c.systemState === (target.state ?? "backlog"));
    if (!col) throw new WorkError(422, "That column isn't on this project's board.");
    if (col.wipLimit != null && !opts.overLimit) {
      const inCol = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.columnId, col.id));
      if (inCol.filter((t) => t.id !== opts.ticketId).length >= col.wipLimit) {
        throw new WorkError(409, `"${col.name}" is at its limit of ${col.wipLimit}.`);
      }
    }
    return col;
  }

  return {
    async createProject(companyId: string, name: string, columns: ColumnSpec[] = DEFAULT_COLUMNS) {
      const problems = columnProblems(columns);
      if (problems.length) throw new WorkError(422, problems.join(" "));
      return db.transaction(async (tx) => {
        const [p] = await tx.insert(projects).values({ companyId, name }).returning();
        await tx.insert(workflowColumns).values(columns.map((c, i) => ({ projectId: p!.id, name: c.name.trim(), systemState: c.systemState, wipLimit: c.wipLimit ?? null, position: i })));
        return p!;
      });
    },

    /** Replaces the board's columns. Tickets keep their state and move to the first column showing it. */
    async setColumns(projectId: string, columns: ColumnSpec[]) {
      await project(projectId);
      const problems = columnProblems(columns);
      if (problems.length) throw new WorkError(422, problems.join(" "));
      await db.transaction(async (tx) => {
        await tx.update(tickets).set({ columnId: null }).where(eq(tickets.projectId, projectId));
        await tx.delete(workflowColumns).where(eq(workflowColumns.projectId, projectId));
        const created = await tx
          .insert(workflowColumns)
          .values(columns.map((c, i) => ({ projectId, name: c.name.trim(), systemState: c.systemState, wipLimit: c.wipLimit ?? null, position: i })))
          .returning();
        for (const state of new Set(created.map((c) => c.systemState))) {
          const first = created.find((c) => c.systemState === state)!;
          await tx.update(tickets).set({ columnId: first.id }).where(and(eq(tickets.projectId, projectId), eq(tickets.systemState, state)));
        }
      });
      return columnsOf(projectId);
    },

    async board(projectId: string) {
      const p = await project(projectId);
      const cols = await columnsOf(projectId);
      const rows = await db
        .select({ t: tickets, milestoneTarget: milestones.targetDate })
        .from(tickets)
        .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
        .where(eq(tickets.projectId, projectId))
        .orderBy(asc(tickets.createdAt));
      const deps = rows.length
        ? await db.select().from(ticketDependencies).where(inArray(ticketDependencies.blockedTicketId, rows.map((r) => r.t.id)))
        : [];
      const fids = [...new Set(rows.map((r) => r.t.featureId).filter((x): x is string => !!x))];
      const featureTitle = new Map((fids.length ? await db.select({ id: features.id, title: features.title }).from(features).where(inArray(features.id, fids)) : []).map((f) => [f.id, f.title]));
      // A ticket in review waits on the owner while the sign-off decision raised after an agent's approval is open (review.approve).
      const decisionIds = deps.flatMap((d) => (d.blockerDecisionId ? [d.blockerDecisionId] : []));
      const signoffs = new Map(
        (decisionIds.length ? await db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(and(inArray(decisions.id, decisionIds), eq(decisions.status, "open"))) : [])
          .filter((d) => (d.context as { type?: string }).type === "risk_review")
          .map((d) => [d.id, (d.context as { reviewer?: string }).reviewer ?? null] as const),
      );
      // Who is running on each ticket right now, so a card can show live work (chat runs don't count).
      const ids = rows.map((r) => r.t.id);
      const live = ids.length
        ? await db
            .select({ ticketId: runs.ticketId, agent: agents.name })
            .from(runs)
            .innerJoin(agents, eq(agents.id, runs.agentId))
            .where(and(inArray(runs.ticketId, ids), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
        : [];
      const doneIds = new Set(rows.filter((r) => r.t.systemState === "done").map((r) => r.t.id));
      const cards = rows.map(({ t, milestoneTarget }) => {
        const waitingDecisionId = t.systemState === "review" ? (deps.find((d) => d.blockedTicketId === t.id && d.blockerDecisionId && signoffs.has(d.blockerDecisionId))?.blockerDecisionId ?? null) : null;
        return {
        ...t,
        waitingOnOwner: !!waitingDecisionId,
        waitingDecisionId,
        approvedBy: waitingDecisionId ? signoffs.get(waitingDecisionId) ?? null : null,
        featureTitle: t.featureId ? (featureTitle.get(t.featureId) ?? null) : null,
        parentTitle: rows.find((r) => r.t.id === t.parentTicketId)?.t.title ?? null,
        dueDate: effectiveDueDate(t.dueDate, milestoneTarget),
        // Work not linked to any objective may be drifting (R16).
        unlinked: !t.keyResultId && !t.milestoneId,
        working: live.filter((l) => l.ticketId === t.id).map((l) => l.agent),
        // A blocker task already done no longer holds the card up.
        blockedBy: deps.filter((d) => d.blockedTicketId === t.id && !(d.blockerTicketId && doneIds.has(d.blockerTicketId))).map((d) => ({ ticketId: d.blockerTicketId, ticketTitle: rows.find((r) => r.t.id === d.blockerTicketId)?.t.title ?? null, engagementId: d.blockerEngagementId, decisionId: d.blockerDecisionId })),
        };
      });
      return {
        project: p,
        columns: cols.map((c) => ({
          ...c,
          // A ticket shows in its column while that column matches its state; otherwise (no
          // column, or one left over from an older move) in the first column for its state.
          tickets: cards.filter((t) => {
            const own = cols.find((x) => x.id === t.columnId);
            return own && own.systemState === t.systemState ? own.id === c.id : cols.find((x) => x.systemState === t.systemState)?.id === c.id;
          }),
        })),
      };
    },

    async createTicket(projectId: string, input: TicketPatch & { title: string }) {
      const p = await project(projectId);
      if (p.archivedAt) throw new WorkError(409, `${p.name} is archived. Unarchive it in Settings → Projects to add tasks to it.`);
      if (input.assigneeAgentId) await assertAgentInCompany(input.assigneeAgentId, p.companyId);
      if (input.milestoneId) await assertLinkInCompany("milestone", input.milestoneId, p.companyId);
      if (input.keyResultId) await assertLinkInCompany("keyResult", input.keyResultId, p.companyId);
      if (input.featureId) await assertFeatureInCompany(input.featureId, p.companyId);
      const parent = input.parentTicketId ? await parentOf(input.parentTicketId, p.companyId) : null;
      const featureId = parent ? parent.featureId : (input.featureId ?? null);
      const col = await placement(projectId, { columnId: input.columnId, state: input.state }, { overLimit: input.overLimit });
      const [t] = await db
        .insert(tickets)
        .values({
          companyId: p.companyId,
          projectId,
          title: input.title,
          body: input.body ?? null,
          systemState: col.systemState,
          columnId: col.id,
          outcome: col.systemState === "done" ? (input.outcome ?? "completed") : null,
          assigneeAgentId: input.assigneeAgentId ?? null,
          assignedToOwner: input.assignedToOwner ?? false,
          milestoneId: input.milestoneId ?? null,
          keyResultId: input.keyResultId ?? null,
          dueDate: input.dueDate ?? null,
          customFields: input.customFields ?? {},
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          noCode: input.noCode ?? false,
          lastActivityAt: now(),
          risk: input.risk ?? null,
          // Graded planning: high and critical work is planned first unless the creator says otherwise.
          planFirst: input.planFirst ?? (input.risk ? planFirstByDefault(input.risk) : false),
          featureId,
          parentTicketId: parent?.id ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
        })
        .returning();
      await record(db, { companyId: p.companyId, ticketId: t!.id, kind: "ticket_created", summary: `Created "${t!.title}" in ${t!.systemState}${t!.assigneeAgentId ? ", assigned" : ""}`, at: now() });
      if (parent) await this.waitOnSubtask(parent, t!.id);
      if (featureId) await hooks.onFeature?.(featureId);
      if (t!.assigneeAgentId && t!.systemState !== "done") await hooks.onAssigned?.(t!);
      return t!;
    },

    /** The parent waits on its new sub-task; the existing unblocked note hands it back when the sub-task is done. */
    async waitOnSubtask(parent: typeof tickets.$inferSelect, childId: string) {
      await db.insert(ticketDependencies).values({ blockedTicketId: parent.id, blockerTicketId: childId });
      if (parent.systemState === "ready" || parent.systemState === "in_progress") await this.updateTicket(parent.id, { state: "blocked", overLimit: true });
    },

    /** Checks a parent for a new sub-task before it is created. */
    parentOf,

    /**
     * Turns the ticket's watcher on or off (R80). Turning it on asks for a first report straight
     * away; after that it reports every `everyMinutes`, and once more when the ticket is done.
     */
    async setWatcher(ticketId: string, watcher: { agentId: string | null; everyMinutes?: number }) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (watcher.agentId) await assertAgentInCompany(watcher.agentId, t.companyId);
      const [row] = await db
        .update(tickets)
        .set(
          watcher.agentId
            ? { watcherAgentId: watcher.agentId, watchEveryMinutes: watcher.everyMinutes ?? t.watchEveryMinutes ?? 30, ...(watcher.agentId !== t.watcherAgentId ? { watchedAt: null } : {}) }
            : { watcherAgentId: null, watchedAt: null },
        )
        .where(eq(tickets.id, ticketId))
        .returning({ watcherAgentId: tickets.watcherAgentId, watchEveryMinutes: tickets.watchEveryMinutes, watchedAt: tickets.watchedAt });
      return row!;
    },

    /**
     * Arms the ticket's monitor: wake the assignee at `at` to re-check `note`. An agent sets it only on
     * its own ticket, in the future; the owner may set "now". The owner re-arming a fired or exhausted
     * monitor starts the count again.
     */
    async setMonitor(ticketId: string, input: { at: Date; note: string; maxChecks?: number; by?: { agentId: string; companyId: string } }) {
      const [t] = await db.select().from(tickets).where(input.by ? and(eq(tickets.id, ticketId), eq(tickets.companyId, input.by.companyId)) : eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, input.by ? "No ticket with that ID in your company." : "No such ticket.");
      const note = input.note.trim();
      if (!note || note.length > 500) throw new WorkError(422, "Say what to re-check, in 1 to 500 characters.");
      if (Number.isNaN(input.at.getTime())) throw new WorkError(422, "That isn't a valid time.");
      if (input.maxChecks !== undefined && (!Number.isInteger(input.maxChecks) || input.maxChecks < 1 || input.maxChecks > 20)) throw new WorkError(422, "maxChecks is 1 to 20.");
      if (t.systemState !== "in_progress" && t.systemState !== "review") throw new WorkError(422, `A check can only be scheduled on a ticket that is in progress or in review; this one is ${t.systemState}.`);
      if (!t.assigneeAgentId) throw new WorkError(422, "The ticket has no agent to wake.");
      if (input.by) {
        if (t.assigneeAgentId !== input.by.agentId) throw new WorkError(403, "Only the agent the ticket is assigned to can schedule a check.");
        if (input.at.getTime() <= now().getTime()) throw new WorkError(422, "The time must be in the future.");
      }
      const [row] = await db
        .update(tickets)
        .set({ monitorAt: input.at, monitorNote: note, ...(input.maxChecks ? { monitorMax: input.maxChecks } : {}), ...(!input.by && !t.monitorAt ? { monitorAttempts: 0 } : {}) })
        .where(eq(tickets.id, ticketId))
        .returning();
      const [who] = input.by ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, input.by.agentId)) : [];
      await record(db, { companyId: t.companyId, agentId: input.by?.agentId, ticketId, kind: "monitor", summary: `${who?.name ?? "The owner"} scheduled a check for ${input.at.toISOString()}: ${note}`, at: now() });
      return row!;
    },

    async clearMonitor(ticketId: string, by?: { agentId: string; companyId: string }) {
      const [t] = await db.select().from(tickets).where(by ? and(eq(tickets.id, ticketId), eq(tickets.companyId, by.companyId)) : eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, by ? "No ticket with that ID in your company." : "No such ticket.");
      if (by && t.assigneeAgentId !== by.agentId) throw new WorkError(403, "Only the agent the ticket is assigned to can clear its check.");
      if (!t.monitorAt) return t;
      const [row] = await db.update(tickets).set({ monitorAt: null, monitorAttempts: 0 }).where(eq(tickets.id, ticketId)).returning();
      await record(db, { companyId: t.companyId, agentId: by?.agentId, ticketId, kind: "monitor", summary: "Cleared the scheduled check", at: now() });
      return row!;
    },

    async updateTicket(ticketId: string, patch: TicketPatch) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (patch.assigneeAgentId) await assertAgentInCompany(patch.assigneeAgentId, t.companyId);
      if (patch.milestoneId) await assertLinkInCompany("milestone", patch.milestoneId, t.companyId);
      if (patch.keyResultId) await assertLinkInCompany("keyResult", patch.keyResultId, t.companyId);
      if (patch.featureId) await assertFeatureInCompany(patch.featureId, t.companyId);
      const moves = patch.columnId !== undefined || patch.state !== undefined;
      const col = moves ? await placement(t.projectId, { columnId: patch.columnId, state: patch.state }, { ticketId, overLimit: patch.overLimit }) : null;
      const { overLimit: _ignored, state: _s, columnId: _c, ...fields } = patch;
      // Plan first follows the risk level (there's no checkbox): changing the risk before work
      // starts and before a plan is approved turns it on for high and critical, off otherwise.
      if (patch.risk !== undefined && patch.planFirst === undefined && !t.planApprovedAt && (t.systemState === "backlog" || t.systemState === "ready"))
        fields.planFirst = patch.risk ? planFirstByDefault(patch.risk) : false;
      const [updated] = await db
        .update(tickets)
        .set({
          ...fields,
          ...(col ? { columnId: col.id, systemState: col.systemState, outcome: col.systemState === "done" ? (patch.outcome ?? "completed") : null, ...(col.systemState === "done" ? { monitorAt: null } : {}) } : {}),
          lastActivityAt: now(),
          ...(patch.stateNote ? { stateNoteAt: now() } : {}),
        })
        .where(eq(tickets.id, ticketId))
        .returning();
      if (updated!.systemState !== t.systemState) await record(db, { companyId: t.companyId, ticketId: t.id, kind: "state", summary: `${t.systemState} -> ${updated!.systemState}`, at: now() });
      if (updated!.assigneeAgentId !== t.assigneeAgentId) {
        const [to] = updated!.assigneeAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, updated!.assigneeAgentId)) : [];
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "assigned", summary: `Assigned to ${to?.name ?? "nobody"}`, at: now() });
      }
      if (updated!.assigneeAgentId && updated!.assigneeAgentId !== t.assigneeAgentId && updated!.systemState !== "done") await hooks.onAssigned?.(updated!);
      if (updated!.systemState === "done" && t.systemState !== "done") await hooks.onDone?.(updated!);
      for (const fid of new Set([t.featureId, updated!.featureId])) if (fid) await hooks.onFeature?.(fid);
      return updated!;
    },

    /** A ticket can wait on another ticket in its company, or on an engagement its company requested (R25). */
    async addDependency(ticketId: string, blocker: { ticketId?: string; engagementId?: string }) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (!!blocker.ticketId === !!blocker.engagementId) throw new WorkError(422, "Give exactly one blocker: a ticket or an engagement.");
      if (blocker.ticketId) {
        if (blocker.ticketId === ticketId) throw new WorkError(422, "A ticket can't block itself.");
        const [b] = await db.select().from(tickets).where(and(eq(tickets.id, blocker.ticketId), eq(tickets.companyId, t.companyId)));
        if (!b) throw new WorkError(422, "The blocking ticket must be in the same company. Use an engagement to wait on another company.");
        if (await this.wouldCycle(ticketId, blocker.ticketId)) throw new WorkError(422, "That would make the tickets wait on each other.");
      } else {
        const [e] = await db.select().from(engagements).where(and(eq(engagements.id, blocker.engagementId!), eq(engagements.requesterCompanyId, t.companyId)));
        if (!e) throw new WorkError(422, "Only an engagement this company requested can block its tickets.");
      }
      const [dep] = await db
        .insert(ticketDependencies)
        .values({ blockedTicketId: ticketId, blockerTicketId: blocker.ticketId ?? null, blockerEngagementId: blocker.engagementId ?? null })
        .returning();
      await record(db, { companyId: t.companyId, ticketId, kind: "dependency", summary: blocker.ticketId ? `Now waits on ticket ${blocker.ticketId}` : `Now waits on engagement ${blocker.engagementId}`, at: now() });
      return dep!;
    },

    /** True if `blocker` already (transitively) waits on `ticket`. */
    async wouldCycle(ticketId: string, blockerId: string): Promise<boolean> {
      const seen = new Set<string>();
      const stack = [blockerId];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === ticketId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const next = await db.select({ id: ticketDependencies.blockerTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, cur));
        for (const n of next) if (n.id) stack.push(n.id);
      }
      return false;
    },

    async createObjective(companyId: string, input: { title: string; priority?: number; projectId?: string }) {
      const [o] = await db.insert(objectives).values({ companyId, title: input.title, priority: input.priority ?? 2, projectId: input.projectId ?? null }).returning();
      return o!;
    },

    async addKeyResult(objectiveId: string, input: { title: string; target?: number; current?: number; unit?: string; method?: "manual" | "agent" | "check" }) {
      const [k] = await db.insert(keyResults).values({ objectiveId, ...input }).returning();
      return k!;
    },

    async addMilestone(objectiveId: string, input: { title: string; targetDate?: string; horizon?: "now" | "next" | "later" }) {
      const [m] = await db.insert(milestones).values({ objectiveId, title: input.title, targetDate: input.targetDate ?? null, horizon: input.horizon ?? null }).returning();
      return m!;
    },

    async objectivesTree(companyId: string) {
      const objs = await db.select().from(objectives).where(eq(objectives.companyId, companyId)).orderBy(asc(objectives.priority), asc(objectives.createdAt));
      if (!objs.length) return [];
      const ids = objs.map((o) => o.id);
      const krs = await db.select().from(keyResults).where(inArray(keyResults.objectiveId, ids));
      const ms = await db.select().from(milestones).where(inArray(milestones.objectiveId, ids)).orderBy(asc(milestones.targetDate));
      return objs.map((o) => ({
        ...o,
        keyResults: krs
          .filter((k) => k.objectiveId === o.id)
          .map((k) => ({ ...k, progress: k.target ? Math.max(0, Math.min(1, (k.current ?? 0) / k.target)) : null })),
        milestones: ms.filter((m) => m.objectiveId === o.id),
      }));
    },
  };
}
