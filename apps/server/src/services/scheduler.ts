// Wakes agents and starts runs, inside the launch-safety limits Kandev learned the hard
// way (R30): kill switches, concurrency ceilings, a causation-depth cap, a self-wake rate
// limit and priority order. Before launching it checks budgets and fails closed (R34),
// and holds low-priority work while a subscription window is nearly used up (R33).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, fundingSources, projects, quotaSamples, runners, runs, settings, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { issueRunToken } from "../mcp.js";
import type { fundingService } from "./funding.js";
import type { runnersService } from "./runners.js";

export type Limits = {
  instance: number;
  company: number;
  agent: number;
  /** Wake chains deeper than this are dropped and reported. */
  maxDepth: number;
  /** Wakes an agent may cause for itself in ten minutes. */
  selfWakesPer10Min: number;
  /** Subscription utilisation at which low-priority work waits for the reset. */
  quotaHoldAt: number;
  /** Wakes at or above this priority ignore the quota hold. */
  highPriority: number;
};

export const DEFAULT_LIMITS: Limits = { instance: 8, company: 4, agent: 1, maxDepth: 8, selfWakesPer10Min: 5, quotaHoldAt: 0.95, highPriority: 3 };

export type WakeInput = {
  agentId: string;
  reason: string;
  ticketId?: string | null;
  note?: string | null;
  priority?: number;
  causedByRunId?: string | null;
  /** The wake carries out this approved deploy; its run gets the target's secrets. */
  deployId?: string | null;
};

type Alert = (companyId: string, question: string) => Promise<unknown>;

export function schedulerService(
  db: Db,
  deps: {
    runners: ReturnType<typeof runnersService>;
    funding: ReturnType<typeof fundingService>;
    alert: Alert;
    /** Binds a deploy to its run before launch, so the run's first secrets fetch includes the target. */
    deploys?: { bindRun(deployId: string, runId: string): Promise<unknown>; unbindRun(deployId: string): Promise<unknown> };
    workspaceRoot?: string;
    limits?: Partial<Limits>;
    now?: () => Date;
  },
) {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const workspaceRoot = deps.workspaceRoot ?? "/home/node/workspaces";

  async function globallyPaused() {
    const [row] = await db.select().from(settings).where(eq(settings.key, "paused"));
    return row?.value === true;
  }

  async function prompt(w: typeof wakes.$inferSelect, agent: typeof agents.$inferSelect, companyName: string) {
    const lines = [`You are ${agent.name}, the ${agent.role === "ceo" ? "CEO" : agent.role} of ${companyName}, working through Boss Man.`];
    if (w.ticketId) {
      const [t] = await db.select({ t: tickets, project: projects.name }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, w.ticketId));
      if (t) {
        lines.push("", `Ticket ${t.t.id} in project "${t.project}": ${t.t.title}`);
        if (t.t.body) lines.push("", t.t.body);
        if (t.t.engagementId) lines.push("", `This ticket does work for engagement ${t.t.engagementId}. Use the engagement tool to view it, message the requester, or deliver.`);
      }
    }
    if (w.note) lines.push("", w.note);
    lines.push(
      "",
      "Use the bossman tools to report back: set_ticket_state with \"review\" when the work is ready to check or \"done\" when it's finished; raise_decision (with your recommended answer) when you need the owner; create_ticket for follow-up work; request_engagement to ask another company for help.",
      "Ending your turn does not move the ticket.",
    );
    return lines.join("\n");
  }

  async function launch(w: typeof wakes.$inferSelect): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, w.agentId));
    const [company] = await db.select().from(companies).where(eq(companies.id, w.companyId));
    const [runner] = await db.select().from(runners).where(eq(runners.companyId, w.companyId));
    if (!agent || !company) return { ok: false, reason: "agent or company gone" };
    if (!runner || !deps.runners.isConnected(runner.id)) return { ok: false, reason: "runner offline" };

    const runId = randomUUID();
    // Work on a provider ticket for an engagement is charged back to the requester (R26).
    const [ticket] = w.ticketId ? await db.select({ engagementId: tickets.engagementId }).from(tickets).where(eq(tickets.id, w.ticketId)) : [];
    await db.insert(runs).values({ id: runId, companyId: w.companyId, agentId: w.agentId, ticketId: w.ticketId, engagementId: ticket?.engagementId ?? null, model: agent.model, startedAt: now() });
    const mcpToken = await issueRunToken(db, { companyId: w.companyId, agentId: w.agentId, runId });
    if (w.deployId) await deps.deploys?.bindRun(w.deployId, runId);
    const sent = deps.runners.send(runner.id, {
      type: "run.start",
      runId,
      agentId: agent.id,
      agentKind: agent.agentKind,
      model: agent.model,
      fundingSourceId: agent.fundingSourceId,
      cwd: path.posix.join(workspaceRoot, w.ticketId ?? agent.id),
      prompt: await prompt(w, agent, company.name),
      mcpToken,
    });
    if (!sent) {
      if (w.deployId) await deps.deploys?.unbindRun(w.deployId);
      await db.delete(runs).where(eq(runs.id, runId));
      return { ok: false, reason: "runner offline" };
    }
    await db.update(wakes).set({ status: "launched", runId, launchedAt: now(), statusReason: null }).where(eq(wakes.id, w.id));
    return { ok: true };
  }

  return {
    limits,

    /** Queues a wake, or drops it (and tells the owner) if it looks like a loop. */
    async wake(input: WakeInput) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
      if (!agent) throw new Error("No such agent.");
      let depth = 0;
      let causedByAgentId: string | null = null;
      if (input.causedByRunId) {
        const [parent] = await db.select({ depth: wakes.causationDepth }).from(wakes).where(eq(wakes.runId, input.causedByRunId));
        const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, input.causedByRunId));
        depth = (parent?.depth ?? 0) + 1;
        causedByAgentId = run?.agentId ?? null;
      }
      const base = {
        companyId: agent.companyId,
        agentId: agent.id,
        ticketId: input.ticketId ?? null,
        reason: input.reason,
        note: input.note ?? null,
        priority: input.priority ?? 2,
        causationDepth: depth,
        causedByRunId: input.causedByRunId ?? null,
        causedByAgentId,
        deployId: input.deployId ?? null,
      };

      if (depth > limits.maxDepth) {
        const [row] = await db.insert(wakes).values({ ...base, status: "dropped", statusReason: `chain of ${depth} wake-ups exceeds ${limits.maxDepth}` }).returning();
        await deps.alert(agent.companyId, `${agent.name} was woken ${depth} times in a chain, which looks like a loop. The last wake ("${input.reason}") was dropped. Look into it, then wake the agent again if it's fine.`);
        return row!;
      }
      if (causedByAgentId === agent.id) {
        const since = new Date(now().getTime() - 10 * 60_000);
        const recent = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(wakes)
          .where(and(eq(wakes.agentId, agent.id), eq(wakes.causedByAgentId, agent.id), gt(wakes.createdAt, since)));
        if ((recent[0]?.n ?? 0) >= limits.selfWakesPer10Min) {
          const [row] = await db.insert(wakes).values({ ...base, status: "dropped", statusReason: `woke itself more than ${limits.selfWakesPer10Min} times in 10 minutes` }).returning();
          await deps.alert(agent.companyId, `${agent.name} keeps waking itself (more than ${limits.selfWakesPer10Min} times in 10 minutes). New self-wakes are being dropped.`);
          return row!;
        }
      }
      const [row] = await db.insert(wakes).values(base).returning();
      return row!;
    },

    /** One scheduling pass. Safe to call often; returns what it did. */
    async tick() {
      const result = { launched: 0, deferred: 0, waiting: 0, paused: false };
      if (await globallyPaused()) return { ...result, paused: true };

      const t = now();
      const queue = await db
        .select()
        .from(wakes)
        .where(or(eq(wakes.status, "queued"), and(eq(wakes.status, "deferred"), or(isNull(wakes.notBefore), lte(wakes.notBefore, t)))))
        .orderBy(desc(wakes.priority), asc(wakes.createdAt));
      if (queue.length === 0) return result;

      const active = await db.select({ companyId: runs.companyId, agentId: runs.agentId }).from(runs).where(isNull(runs.endedAt));
      let total = active.length;
      const byCompany = new Map<string, number>();
      const byAgent = new Map<string, number>();
      for (const r of active) {
        byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + 1);
        if (r.agentId) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + 1);
      }

      // Budget admission fails closed: if budgets can't be read, nothing launches.
      let budgets: Awaited<ReturnType<ReturnType<typeof fundingService>["budgetStatuses"]>>;
      try {
        budgets = await deps.funding.budgetStatuses(t);
      } catch {
        await db.update(wakes).set({ status: "deferred", statusReason: "budget check failed", notBefore: new Date(t.getTime() + 60_000) }).where(inArray(wakes.id, queue.map((w) => w.id)));
        return { ...result, deferred: queue.length };
      }
      const paused = new Set((await db.select({ id: companies.id }).from(companies).where(eq(companies.paused, true))).map((c) => c.id));

      for (const w of queue) {
        const defer = async (reason: string, notBefore: Date | null) => {
          await db.update(wakes).set({ status: "deferred", statusReason: reason, notBefore }).where(eq(wakes.id, w.id));
          result.deferred++;
        };
        const wait = async (reason: string) => {
          if (w.statusReason !== reason || w.status !== "queued") await db.update(wakes).set({ status: "queued", statusReason: reason }).where(eq(wakes.id, w.id));
          result.waiting++;
        };

        if (paused.has(w.companyId)) {
          await wait("company paused");
          continue;
        }
        if (total >= limits.instance || (byCompany.get(w.companyId) ?? 0) >= limits.company || (byAgent.get(w.agentId) ?? 0) >= limits.agent) {
          await wait("at a concurrency limit");
          continue;
        }

        const [agent] = await db.select().from(agents).where(eq(agents.id, w.agentId));
        const stopped = budgets.find(
          (b) =>
            b.status.action === "pause" &&
            ((b.policy.scopeKind === "company" && b.policy.scopeId === w.companyId) || (b.policy.scopeKind === "agent" && b.policy.scopeId === w.agentId)),
        );
        if (stopped) {
          await defer("budget limit reached", stopped.status.bounds.end ?? null);
          continue;
        }

        if (agent?.fundingSourceId && w.priority < limits.highPriority) {
          const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, agent.fundingSourceId));
          if (source?.kind === "subscription") {
            const samples = await db
              .selectDistinctOn([quotaSamples.window])
              .from(quotaSamples)
              .where(eq(quotaSamples.fundingSourceId, source.id))
              .orderBy(quotaSamples.window, desc(quotaSamples.observedAt));
            const full = samples.filter((s) => s.utilization >= limits.quotaHoldAt && (!s.resetsAt || s.resetsAt > t));
            if (full.length) {
              const until = full.reduce<Date | null>((m, s) => (s.resetsAt && (!m || s.resetsAt > m) ? s.resetsAt : m), null);
              await defer(`subscription ${full.map((s) => s.window).join(", ")} window nearly used up`, until);
              continue;
            }
          }
        }

        const launched = await launch(w);
        if (!launched.ok) {
          await wait(launched.reason);
          continue;
        }
        result.launched++;
        total++;
        byCompany.set(w.companyId, (byCompany.get(w.companyId) ?? 0) + 1);
        byAgent.set(w.agentId, (byAgent.get(w.agentId) ?? 0) + 1);
      }
      return result;
    },

    async setGlobalPause(paused: boolean) {
      await db.insert(settings).values({ key: "paused", value: paused }).onConflictDoUpdate({ target: settings.key, set: { value: paused } });
    },

    async setCompanyPause(companyId: string, paused: boolean) {
      await db.update(companies).set({ paused }).where(eq(companies.id, companyId));
    },

    async queue() {
      return db.select().from(wakes).where(inArray(wakes.status, ["queued", "deferred"])).orderBy(desc(wakes.priority), asc(wakes.createdAt));
    },

    /**
     * After a ticket is done: dependents whose blockers are all resolved move to ready,
     * and their assignees are woken. Wakes caused by an agent's run carry the chain depth.
     */
    async onTicketDone(ticketId: string, causedByRunId?: string | null) {
      const dependents = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerTicketId, ticketId));
      for (const { id } of dependents) {
        const blockers = await db
          .select({ state: tickets.systemState })
          .from(ticketDependencies)
          .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
          .where(eq(ticketDependencies.blockedTicketId, id));
        if (blockers.some((b) => b.state !== "done")) continue;
        const [t] = await db.update(tickets).set({ systemState: "ready", lastActivityAt: now() }).where(and(eq(tickets.id, id), eq(tickets.systemState, "blocked"))).returning();
        if (t?.assigneeAgentId) await this.wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked", causedByRunId });
      }
    },
  };
}
