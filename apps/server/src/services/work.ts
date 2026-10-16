// Projects, boards, tickets, dependencies and objectives (Phase 3, R16–R18, R25).
import { and, asc, eq, inArray } from "drizzle-orm";
import { columnProblems, DEFAULT_COLUMNS, effectiveDueDate, type ColumnSpec, type SystemState } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, engagements, keyResults, milestones, objectives, projects, ticketDependencies, tickets, workflowColumns } from "../db/schema.js";

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
  assignedToOwner?: boolean;
  milestoneId?: string | null;
  keyResultId?: string | null;
  dueDate?: string | null;
  customFields?: Record<string, unknown>;
  /** Move past a full column anyway. */
  overLimit?: boolean;
};

export type WorkHooks = {
  onAssigned?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
  onDone?: (ticket: typeof tickets.$inferSelect) => Promise<unknown>;
};

export function workService(db: Db, hooks: WorkHooks = {}) {
  async function project(id: string) {
    const [p] = await db.select().from(projects).where(eq(projects.id, id));
    if (!p) throw new WorkError(404, "No such project.");
    return p;
  }

  async function columnsOf(projectId: string) {
    return db.select().from(workflowColumns).where(eq(workflowColumns.projectId, projectId)).orderBy(asc(workflowColumns.position));
  }

  async function assertAgentInCompany(agentId: string, companyId: string) {
    const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!a) throw new WorkError(422, "That agent isn't in this company.");
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
      const cards = rows.map(({ t, milestoneTarget }) => ({
        ...t,
        dueDate: effectiveDueDate(t.dueDate, milestoneTarget),
        // Work not linked to any objective may be drifting (R16).
        unlinked: !t.keyResultId && !t.milestoneId,
        blockedBy: deps.filter((d) => d.blockedTicketId === t.id).map((d) => ({ ticketId: d.blockerTicketId, engagementId: d.blockerEngagementId, decisionId: d.blockerDecisionId })),
      }));
      return {
        project: p,
        columns: cols.map((c) => ({
          ...c,
          // A ticket without a column shows in the first column for its state.
          tickets: cards.filter((t) => t.columnId === c.id || (!t.columnId && cols.find((x) => x.systemState === t.systemState)?.id === c.id)),
        })),
      };
    },

    async createTicket(projectId: string, input: TicketPatch & { title: string }) {
      const p = await project(projectId);
      if (input.assigneeAgentId) await assertAgentInCompany(input.assigneeAgentId, p.companyId);
      if (input.milestoneId) await assertLinkInCompany("milestone", input.milestoneId, p.companyId);
      if (input.keyResultId) await assertLinkInCompany("keyResult", input.keyResultId, p.companyId);
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
        })
        .returning();
      if (t!.assigneeAgentId && t!.systemState !== "done") await hooks.onAssigned?.(t!);
      return t!;
    },

    async updateTicket(ticketId: string, patch: TicketPatch) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) throw new WorkError(404, "No such ticket.");
      if (patch.assigneeAgentId) await assertAgentInCompany(patch.assigneeAgentId, t.companyId);
      if (patch.milestoneId) await assertLinkInCompany("milestone", patch.milestoneId, t.companyId);
      if (patch.keyResultId) await assertLinkInCompany("keyResult", patch.keyResultId, t.companyId);
      const moves = patch.columnId !== undefined || patch.state !== undefined;
      const col = moves ? await placement(t.projectId, { columnId: patch.columnId, state: patch.state }, { ticketId, overLimit: patch.overLimit }) : null;
      const { overLimit: _ignored, state: _s, columnId: _c, ...fields } = patch;
      const [updated] = await db
        .update(tickets)
        .set({
          ...fields,
          ...(col ? { columnId: col.id, systemState: col.systemState, outcome: col.systemState === "done" ? (patch.outcome ?? "completed") : null } : {}),
          lastActivityAt: new Date(),
        })
        .where(eq(tickets.id, ticketId))
        .returning();
      if (updated!.assigneeAgentId && updated!.assigneeAgentId !== t.assigneeAgentId && updated!.systemState !== "done") await hooks.onAssigned?.(updated!);
      if (updated!.systemState === "done" && t.systemState !== "done") await hooks.onDone?.(updated!);
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

    async addMilestone(objectiveId: string, input: { title: string; targetDate?: string }) {
      const [m] = await db.insert(milestones).values({ objectiveId, title: input.title, targetDate: input.targetDate ?? null }).returning();
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
