// The Agents tab (R62): who works for each company, what they cost this month, and every change
// to them, with what it was before so it can be undone.
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AGENT_TEMPLATES, CEO_TEMPLATE } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentChanges, agents, costEvents, decisions, fundingSources, paAnswers, projects, runs, settings, skills, tickets } from "../db/schema.js";
import { TEAM_HIRE, TEAM_NOT_NOW, type TeamHire } from "./decisions.js";

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AgentRow = typeof agents.$inferSelect;
export type AgentPatch = Partial<Pick<AgentRow, "name" | "title" | "instructions" | "model" | "thinking" | "fundingSourceId" | "agentKind" | "paused" | "starred">>;
/** Fields whose changes are kept, and can be undone, under the name the history shows. */
const TRACKED: Array<[keyof AgentPatch, string]> = [
  ["name", "name"],
  ["title", "title"],
  ["instructions", "instructions"],
  ["model", "model"],
  ["thinking", "thinking"],
  ["fundingSourceId", "funding"],
  ["agentKind", "kind"],
  ["paused", "paused"],
];
const FIELD_COLUMN = Object.fromEntries(TRACKED.map(([col, field]) => [field, col])) as Record<string, keyof AgentPatch>;
const OPEN = ["backlog", "ready", "in_progress", "blocked", "review"] as const;

/** What the CEO may do to the team without asking the owner (R62). */
export const AGENT_APPROVALS = ["hires", "hires_and_edits", "nothing"] as const;
export type AgentApprovals = (typeof AGENT_APPROVALS)[number];
export const HIRE = "Hire";
export const DONT_HIRE = "Don't hire";
export const APPLY = "Apply the change";
export const KEEP = "Keep them as they are";
export type HireProposal = { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; reason?: string; /** Tickets waiting for this hire; they go to the new agent once hired. */ forTickets?: string[] };

type Notify = (n: { companyId: string; agentId: string | null; level: "note" | "flag"; title: string; body: string | null; link: string }) => Promise<unknown>;

export function agentsService(db: Db, opts: { now?: () => Date; notify?: Notify; assignPlanned?: (companyId: string, hired: AgentRow, ticketIds: string[]) => Promise<unknown> } = {}) {
  const now = opts.now ?? (() => new Date());
  const notify: Notify = opts.notify ?? (async () => undefined);

  async function agent(id: string) {
    const [a] = await db.select().from(agents).where(eq(agents.id, id));
    if (!a) throw new AgentError(404, "No such agent.");
    return a;
  }

  async function record(a: AgentRow, field: string, before: unknown, after: unknown, byAgentId: string | null) {
    await db.insert(agentChanges).values({ companyId: a.companyId, agentId: a.id, byAgentId, field, before: before ?? null, after: after ?? null });
  }

  async function approvals(companyId: string): Promise<AgentApprovals> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `agent_approvals:${companyId}`));
    return AGENT_APPROVALS.includes(row?.value as AgentApprovals) ? (row!.value as AgentApprovals) : "hires";
  }

  return {
    templates: () => ({ templates: AGENT_TEMPLATES, ceo: CEO_TEMPLATE }),

    approvals,
    async setApprovals(companyId: string, value: AgentApprovals) {
      await db.insert(settings).values({ key: `agent_approvals:${companyId}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    /**
     * The CEO proposes a hire. Unless the owner has said hires need nobody's approval, it waits
     * in Decisions; either way the owner hears about it.
     */
    async proposeHire(companyId: string, ceoId: string, p: HireProposal): Promise<{ hired: AgentRow } | { decisionId: string }> {
      const tpl = p.template ? AGENT_TEMPLATES.find((x) => x.id === p.template) : undefined;
      if (p.template && !tpl) throw new AgentError(422, `There's no template called ${p.template}. Templates: ${AGENT_TEMPLATES.map((x) => x.id).join(", ")}.`);
      if (p.fundingSourceId && !(await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.id, p.fundingSourceId))).length) throw new AgentError(422, "No funding source with that ID.");
      const job = p.title ?? tpl?.title ?? "agent";
      if ((await approvals(companyId)) === "nothing") {
        const hired = await this.hire(companyId, p, ceoId);
        await opts.assignPlanned?.(companyId, hired, p.forTickets ?? []);
        await notify({ companyId, agentId: ceoId, level: "note", title: `The CEO hired ${hired.name} (${job})`, body: p.reason ?? null, link: "#/agents" });
        return { hired };
      }
      const instructions = p.instructions !== undefined ? p.instructions : (tpl?.instructions ?? null);
      const [d] = await db
        .insert(decisions)
        .values({
          companyId,
          raisedByAgentId: ceoId,
          kind: "approval",
          tier: "owner",
          question: [`The CEO wants to hire ${p.name} as ${job}${p.model ? ` on ${p.model}` : ""}.`, p.reason ? `Why: ${p.reason}` : null, instructions ? `Their instructions:\n${instructions.slice(0, 3000)}` : null].filter(Boolean).join("\n\n"),
          options: [HIRE, DONT_HIRE],
          recommendedOption: HIRE,
          context: { type: "hire", proposal: { ...p, instructions }, byAgentId: ceoId },
        })
        .returning({ id: decisions.id });
      return { decisionId: d!.id };
    },

    /**
     * The CEO changes an agent's instructions. Applied at once with a notification and Undo in
     * its history, unless the owner wants to approve edits too.
     */
    async proposeInstructions(agentId: string, ceoId: string, instructions: string, reason?: string): Promise<{ applied: AgentRow } | { decisionId: string }> {
      const a = await agent(agentId);
      if (a.retiredAt) throw new AgentError(409, `${a.name} is retired.`);
      if ((await approvals(a.companyId)) === "hires_and_edits") {
        const [d] = await db
          .insert(decisions)
          .values({
            companyId: a.companyId,
            raisedByAgentId: ceoId,
            kind: "approval",
            tier: "owner",
            question: [`The CEO wants to change ${a.name}'s instructions.`, reason ? `Why: ${reason}` : null, `New instructions:\n${instructions.slice(0, 3000)}`].filter(Boolean).join("\n\n"),
            options: [APPLY, KEEP],
            recommendedOption: APPLY,
            context: { type: "instructions", agentId, instructions, byAgentId: ceoId },
          })
          .returning({ id: decisions.id });
        return { decisionId: d!.id };
      }
      const applied = await this.update(agentId, { instructions }, ceoId);
      await notify({ companyId: a.companyId, agentId: ceoId, level: "note", title: `The CEO changed ${a.name}'s instructions`, body: `${reason ? `${reason}\n` : ""}See the change, or undo it, in Agents › ${a.name} › History.`, link: "#/agents" });
      return { applied };
    },

    /**
     * The CEO's team plan for a project or the company (docs/13): every proposed hire in one
     * decision, so the owner ticks the ones they want. Always asked, whatever the hire approvals.
     */
    async proposeTeam(companyId: string, ceoId: string, plan: { projectId?: string | null; covered: string; hires: TeamHire[] }) {
      for (const h of plan.hires) {
        if (h.template && !AGENT_TEMPLATES.some((x) => x.id === h.template)) throw new AgentError(422, `There's no template called ${h.template}. Templates: ${AGENT_TEMPLATES.map((x) => x.id).join(", ")}.`);
        for (const name of h.skills ?? []) {
          const [hit] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), or(eq(skills.name, name), eq(skills.pack, name)))).limit(1);
          if (!hit) throw new AgentError(422, `There's no skill or pack called ${name} in the library.`);
        }
      }
      const [project] = plan.projectId ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.id, plan.projectId), eq(projects.companyId, companyId))) : [];
      if (plan.projectId && !project) throw new AgentError(422, "No project with that ID in this company.");
      const open = await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")));
      if (open.some((d) => (d.context as { type?: string; projectId?: string | null } | null)?.type === "team_plan" && ((d.context as { projectId?: string | null }).projectId ?? null) === (project?.id ?? null))) throw new AgentError(409, "A team plan for this is already waiting for the owner.");
      const lines = plan.hires.map((h, i) => `${i + 1}. ${h.name}${h.title ? `, ${h.title}` : ""}${h.template ? ` (${h.template})` : ""}${h.model ? ` on ${h.model}` : ""}: ${h.reason}${h.skills?.length ? ` Skills: ${h.skills.join(", ")}.` : ""}`);
      const [d] = await db
        .insert(decisions)
        .values({
          companyId,
          raisedByAgentId: ceoId,
          kind: "approval",
          tier: "owner",
          question: [`Team plan for ${project ? project.name : "the company"}: the CEO proposes ${plan.hires.length === 1 ? "1 hire" : `${plan.hires.length} hires`}.`, `Already covered: ${plan.covered}`, ...lines].join("\n\n"),
          options: [TEAM_HIRE, TEAM_NOT_NOW],
          recommendedOption: TEAM_HIRE,
          context: { type: "team_plan", projectId: project?.id ?? null, covered: plan.covered, hires: plan.hires, byAgentId: ceoId },
        })
        .returning({ id: decisions.id });
      return { decisionId: d!.id };
    },

    /** Hires the ticked members of a team plan and gives each its skills; one that fails doesn't stop the rest. */
    async hireTeam(companyId: string, hires: TeamHire[], ceoId: string, give: (agentId: string, skill: string) => Promise<unknown>) {
      const hired: string[] = [];
      const failed: string[] = [];
      for (const h of hires) {
        try {
          const a = await this.hire(companyId, { name: h.name, template: h.template, title: h.title ?? undefined, model: h.model ?? null }, ceoId);
          for (const sk of h.skills ?? []) await give(a.id, sk).catch((err: Error) => failed.push(`${h.name} didn't get ${sk}: ${err.message}`));
          hired.push(h.name);
        } catch (err) {
          failed.push(`${h.name}: ${(err as Error).message}`);
        }
      }
      await notify({ companyId, agentId: ceoId, level: failed.length ? "flag" : "note", title: hired.length ? `Hired from the team plan: ${hired.join(", ")}` : "Nobody was hired from the team plan", body: failed.length ? failed.join("\n") : null, link: "#/agents" });
      return { hired, failed };
    },

    /** The owner's answer to a hire or instructions decision. */
    async onDecision(ctx: { type: "hire"; proposal: HireProposal; byAgentId: string } | { type: "instructions"; agentId: string; instructions: string; byAgentId: string }, companyId: string, approved: boolean) {
      if (!approved) return null;
      if (ctx.type === "hire") {
        const hired = await this.hire(companyId, ctx.proposal, ctx.byAgentId);
        await opts.assignPlanned?.(companyId, hired, ctx.proposal.forTickets ?? []);
        return hired;
      }
      return this.update(ctx.agentId, { instructions: ctx.instructions }, ctx.byAgentId);
    },

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
      const [pa] = await db
        .select({ total: sql<number>`count(*)::int`, posted: sql<number>`(count(*) filter (where ${paAnswers.outcome} = 'posted'))::int`, wrong: sql<number>`(count(*) filter (where ${paAnswers.verdict} = 'wrong'))::int` })
        .from(paAnswers)
        .where(eq(paAnswers.companyId, companyId));
      return rows
        .map(({ a, funding, fundingKind }) => {
          const working = live.find((r) => r.agentId === a.id && r.purpose !== "chat");
          return {
            ...a,
            funding,
            fundingKind,
            status: a.retiredAt ? "retired" : working ? "working" : a.paused ? "paused" : "idle",
            current: working?.ticketId ? { ticketId: working.ticketId, title: working.ticket } : null,
            pa: a.duty === "assistant" ? { posted: pa!.posted, escalated: pa!.total - pa!.posted, wrong: pa!.wrong } : null,
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
    async hire(companyId: string, input: { name: string; template?: string; title?: string | null; instructions?: string | null; role?: "manager" | "worker"; agentKind?: string; model?: string | null; thinking?: string | null; fundingSourceId?: string | null; reportsTo?: string | null }, byAgentId: string | null = null) {
      const tpl = input.template ? AGENT_TEMPLATES.find((x) => x.id === input.template) : undefined;
      if (input.template && !tpl) throw new AgentError(422, `There's no template called ${input.template}.`);
      // One assistant per company (R87); it starts paused so the owner picks its (cheap) model first.
      if (tpl?.duty && (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.duty, tpl.duty), isNull(agents.retiredAt)))).length) throw new AgentError(409, `This company already has an active ${tpl.title}; retire it first.`);
      const [a] = await db
        .insert(agents)
        .values({
          companyId,
          duty: tpl?.duty ?? null,
          paused: !!tpl?.duty,
          name: input.name,
          role: input.role ?? tpl?.role ?? "worker",
          agentKind: input.agentKind ?? "claude",
          model: input.model ?? null,
          thinking: input.thinking ?? null,
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
      // Starring is the owner's own tidy-up, so it isn't kept in the history.
      if (!changed.length && (patch.starred === undefined || patch.starred === before.starred)) return before;
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
        if (a.duty && (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, a.companyId), eq(agents.duty, a.duty), isNull(agents.retiredAt)))).length) throw new AgentError(409, `This company already has an active ${a.title ?? a.duty}; retire it before rehiring ${a.name}.`);
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
