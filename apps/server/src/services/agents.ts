// The Agents tab (R62): who works for each company, what they cost this month, and every change
// to them, with what it was before so it can be undone.
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { AGENT_TEMPLATES, CEO_TEMPLATE } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentChanges, agents, costEvents, fundingSources, runs, tickets } from "../db/schema.js";

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AgentRow = typeof agents.$inferSelect;
export type AgentPatch = Partial<Pick<AgentRow, "name" | "title" | "instructions" | "model" | "fundingSourceId" | "agentKind" | "paused">>;
/** Fields whose changes are kept, and can be undone, under the name the history shows. */
const TRACKED: Array<[keyof AgentPatch, string]> = [
  ["name", "name"],
  ["title", "title"],
  ["instructions", "instructions"],
  ["model", "model"],
  ["fundingSourceId", "funding"],
  ["agentKind", "kind"],
  ["paused", "paused"],
];
const FIELD_COLUMN = Object.fromEntries(TRACKED.map(([col, field]) => [field, col])) as Record<string, keyof AgentPatch>;
const OPEN = ["backlog", "ready", "in_progress", "blocked", "review"] as const;

export function agentsService(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());

  async function agent(id: string) {
    const [a] = await db.select().from(agents).where(eq(agents.id, id));
    if (!a) throw new AgentError(404, "No such agent.");
    return a;
  }

  async function record(a: AgentRow, field: string, before: unknown, after: unknown, byAgentId: string | null) {
    await db.insert(agentChanges).values({ companyId: a.companyId, agentId: a.id, byAgentId, field, before: before ?? null, after: after ?? null });
  }

  return {
    templates: () => ({ templates: AGENT_TEMPLATES, ceo: CEO_TEMPLATE }),

    /** Each agent with what it's doing and what it has used this month. Retired agents come last. */
    async list(companyId: string) {
      const t = now();
      const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
      const rows = await db.select({ a: agents, funding: fundingSources.name, fundingKind: fundingSources.kind }).from(agents).leftJoin(fundingSources, eq(fundingSources.id, agents.fundingSourceId)).where(eq(agents.companyId, companyId));
      const live = await db
        .select({ agentId: runs.agentId, ticketId: runs.ticketId, ticket: tickets.title, purpose: runs.purpose })
        .from(runs)
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .where(and(eq(runs.companyId, companyId), isNull(runs.endedAt)));
      const money = await db
        .select({ agentId: costEvents.agentId, micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
        .from(costEvents)
        .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart), ne(fundingSources.kind, "subscription")))
        .groupBy(costEvents.agentId);
      const used = await db
        .select({ agentId: runs.agentId, runs: sql<number>`count(*)::int`, tokens: sql<string>`coalesce(sum(coalesce(${runs.inputTokens}, 0) + coalesce(${runs.outputTokens}, 0)), 0)` })
        .from(runs)
        .where(and(eq(runs.companyId, companyId), gte(runs.startedAt, monthStart)))
        .groupBy(runs.agentId);
      const assigned = await db
        .select({ agentId: tickets.assigneeAgentId, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), inArray(tickets.systemState, [...OPEN])))
        .groupBy(tickets.assigneeAgentId);
      return rows
        .map(({ a, funding, fundingKind }) => {
          const working = live.find((r) => r.agentId === a.id && r.purpose !== "chat");
          return {
            ...a,
            funding,
            fundingKind,
            status: a.retiredAt ? "retired" : working ? "working" : a.paused ? "paused" : "idle",
            current: working?.ticketId ? { ticketId: working.ticketId, title: working.ticket } : null,
            openTickets: assigned.find((r) => r.agentId === a.id)?.n ?? 0,
            month: {
              costMicros: Number(money.find((m) => m.agentId === a.id)?.micros ?? 0),
              runs: used.find((u) => u.agentId === a.id)?.runs ?? 0,
              tokens: Number(used.find((u) => u.agentId === a.id)?.tokens ?? 0),
            },
          };
        })
        .sort((x, y) => Number(!!x.retiredAt) - Number(!!y.retiredAt) || (x.role === "ceo" ? -1 : y.role === "ceo" ? 1 : x.name.localeCompare(y.name)));
    },

    /** Hires an agent, optionally from a template; the template fills in what isn't given. */
    async hire(companyId: string, input: { name: string; template?: string; title?: string | null; instructions?: string | null; role?: "manager" | "worker"; agentKind?: string; model?: string | null; fundingSourceId?: string | null; reportsTo?: string | null }, byAgentId: string | null = null) {
      const tpl = input.template ? AGENT_TEMPLATES.find((x) => x.id === input.template) : undefined;
      if (input.template && !tpl) throw new AgentError(422, `There's no template called ${input.template}.`);
      const [a] = await db
        .insert(agents)
        .values({
          companyId,
          name: input.name,
          role: input.role ?? tpl?.role ?? "worker",
          agentKind: input.agentKind ?? "claude",
          model: input.model ?? null,
          fundingSourceId: input.fundingSourceId ?? null,
          reportsTo: input.reportsTo ?? null,
          template: tpl?.id ?? null,
          title: input.title !== undefined ? input.title : (tpl?.title ?? null),
          instructions: input.instructions !== undefined ? input.instructions : (tpl?.instructions ?? null),
        })
        .returning();
      await record(a!, "hired", null, { name: a!.name, title: a!.title, template: a!.template }, byAgentId);
      return a!;
    },

    /** Changes an agent, keeping each changed field with its old value. */
    async update(agentId: string, patch: AgentPatch, byAgentId: string | null = null) {
      const before = await agent(agentId);
      if (before.retiredAt && patch.paused === false) throw new AgentError(409, `${before.name} is retired. Rehire them first.`);
      const changed = TRACKED.filter(([col]) => patch[col] !== undefined && patch[col] !== before[col]);
      if (!changed.length) return before;
      const [after] = await db.update(agents).set(patch).where(eq(agents.id, agentId)).returning();
      for (const [col, field] of changed) await record(before, field, before[col], after![col], byAgentId);
      return after!;
    },

    /**
     * Retires an agent: it stops working, its open tickets go back to unassigned, and it stops
     * watching tickets. Its runs and history stay. The CEO can't be retired.
     */
    async retire(agentId: string, byAgentId: string | null = null) {
      const a = await agent(agentId);
      if (a.role === "ceo") throw new AgentError(409, "The CEO can't be retired; change its instructions or model instead.");
      if (a.retiredAt) return { agent: a, unassigned: 0 };
      const freed = await db
        .update(tickets)
        .set({ assigneeAgentId: null, lastActivityAt: now() })
        .where(and(eq(tickets.assigneeAgentId, agentId), inArray(tickets.systemState, [...OPEN])))
        .returning({ id: tickets.id });
      const watching = await db.update(tickets).set({ watcherAgentId: null, watchedAt: null }).where(eq(tickets.watcherAgentId, agentId)).returning({ id: tickets.id });
      const [after] = await db.update(agents).set({ retiredAt: now(), paused: true }).where(eq(agents.id, agentId)).returning();
      await record(a, "retired", { paused: a.paused, tickets: freed.map((t) => t.id), watching: watching.map((t) => t.id) }, null, byAgentId);
      return { agent: after!, unassigned: freed.length };
    },

    async history(agentId: string) {
      await agent(agentId);
      return db.select({ c: agentChanges, by: agents.name }).from(agentChanges).leftJoin(agents, eq(agents.id, agentChanges.byAgentId)).where(eq(agentChanges.agentId, agentId)).orderBy(desc(agentChanges.createdAt)).limit(200);
    },

    /**
     * Puts a change back. A field goes back to its old value (if nobody has changed it again
     * since); a retirement is undone by rehiring, with the tickets it had and what it watched.
     */
    async undo(changeId: string) {
      const [c] = await db.select().from(agentChanges).where(eq(agentChanges.id, changeId));
      if (!c) throw new AgentError(404, "No such change.");
      if (c.undoneAt) throw new AgentError(409, "That change was already undone.");
      const a = await agent(c.agentId);
      if (c.field === "retired") {
        const was = (c.before ?? {}) as { paused?: boolean; tickets?: string[]; watching?: string[] };
        await db.update(agents).set({ retiredAt: null, paused: was.paused ?? true }).where(eq(agents.id, a.id));
        if (was.tickets?.length) await db.update(tickets).set({ assigneeAgentId: a.id }).where(and(inArray(tickets.id, was.tickets), isNull(tickets.assigneeAgentId)));
        if (was.watching?.length) await db.update(tickets).set({ watcherAgentId: a.id }).where(and(inArray(tickets.id, was.watching), isNull(tickets.watcherAgentId)));
        await record(a, "rehired", null, null, null);
      } else {
        const col = FIELD_COLUMN[c.field];
        if (!col) throw new AgentError(409, `A "${c.field}" change can't be undone.`);
        if (JSON.stringify(a[col] ?? null) !== JSON.stringify(c.after ?? null)) throw new AgentError(409, `${a.name}'s ${c.field} has changed again since; edit it instead.`);
        await this.update(a.id, { [col]: c.before ?? null } as AgentPatch);
      }
      await db.update(agentChanges).set({ undoneAt: now() }).where(eq(agentChanges.id, c.id));
      return agent(a.id);
    },
  };
}
