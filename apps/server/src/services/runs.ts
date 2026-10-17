// Steering and stopping agents (R37). The owner, or a CEO for its own company, can send a
// message into a running agent's session or stop it. A message for a run that has already
// ended wakes the agent again on the same ticket with the message instead.
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, costEvents, runnerEvents, runners, runs, tickets, wakes } from "../db/schema.js";
import type { runnersService } from "./runners.js";

export class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type WakeHook = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

export function runsService(db: Db, deps: { runners: ReturnType<typeof runnersService> }) {
  let wake: WakeHook | null = null;

  async function load(runId: string, companyId?: string) {
    const [r] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!r || (companyId && r.companyId !== companyId)) throw new RunError(404, "No such run.");
    const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, r.companyId));
    return { run: r, runnerId: runner?.id ?? null };
  }

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    /** Runs that have finished, newest first, with what they cost. */
    async recent(limit = 50, companyId?: string) {
      const rows = await db
        .select({ id: runs.id, companyId: runs.companyId, agent: agents.name, agentId: runs.agentId, ticketId: runs.ticketId, ticket: tickets.title, model: runs.model, startedAt: runs.startedAt, endedAt: runs.endedAt, outcome: runs.outcome , purpose: runs.purpose, reason: wakes.reason, note: wakes.note })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .leftJoin(wakes, eq(wakes.runId, runs.id))
        .where(companyId ? and(isNotNull(runs.endedAt), eq(runs.companyId, companyId)) : isNotNull(runs.endedAt))
        .orderBy(desc(runs.endedAt))
        .limit(limit);
      const costs = rows.length
        ? await db
            .select({ runId: costEvents.runId, micros: sql<string>`sum(${costEvents.costMicros})` })
            .from(costEvents)
            .where(inArray(costEvents.runId, rows.map((r) => r.id)))
            .groupBy(costEvents.runId)
        : [];
      const byRun = new Map(costs.map((c) => [c.runId, Number(c.micros)]));
      return rows.map((r) => ({ ...r, costMicros: byRun.get(r.id) ?? 0 }));
    },

    /**
     * A run's transcript after a given event, oldest first, at most `limit` items (R43). The
     * browser pages through it with `after`, so a long run is never sent whole.
     */
    async transcript(runId: string, opts: { after?: number; limit?: number } = {}) {
      const { run } = await load(runId);
      const [agent] = run.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, run.agentId)) : [];
      const [ticket] = run.ticketId ? await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, run.ticketId)) : [];
      const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
      const rows = await db
        .select({ id: runnerEvents.id, seq: runnerEvents.seq, type: runnerEvents.type, payload: runnerEvents.payload, at: runnerEvents.occurredAt })
        .from(runnerEvents)
        .where(
          and(
            sql`(${runnerEvents.payload}->>'runId') = ${runId}`,
            inArray(runnerEvents.type, ["run.started", "run.update", "run.workspace", "run.permission_request", "run.ended"]),
            opts.after != null ? gt(runnerEvents.seq, opts.after) : undefined,
          ),
        )
        .orderBy(asc(runnerEvents.seq))
        .limit(limit);
      const [spent] = await db.select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` }).from(costEvents).where(eq(costEvents.runId, runId));
      return {
        run: { id: run.id, companyId: run.companyId, agent: agent?.name ?? null, ticketId: run.ticketId, ticket: ticket?.title ?? null, model: run.model, startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.outcome, costMicros: Number(spent?.micros ?? 0) },
        items: rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at, event: r.payload })),
        next: rows.at(-1)?.seq ?? opts.after ?? 0,
        more: rows.length === limit,
      };
    },

    /** Runs still going, newest first, with agent and ticket names. */
    async active(companyId?: string) {
      return db
        .select({ id: runs.id, companyId: runs.companyId, agent: agents.name, agentId: runs.agentId, ticketId: runs.ticketId, ticket: tickets.title, model: runs.model, startedAt: runs.startedAt, lastEventAt: runs.lastEventAt , purpose: runs.purpose, reason: wakes.reason, note: wakes.note })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .leftJoin(wakes, eq(wakes.runId, runs.id))
        .where(companyId ? and(isNull(runs.endedAt), eq(runs.companyId, companyId)) : isNull(runs.endedAt))
        .orderBy(desc(runs.startedAt));
    },

    /**
     * Sends a message into the run. Without interrupt it goes after the current turn;
     * with interrupt the turn stops first. An ended run is woken again with the message.
     */
    async message(runId: string, input: { text: string; interrupt?: boolean; from: string; companyId?: string; causedByRunId?: string | null }) {
      const { run, runnerId } = await load(runId, input.companyId);
      const text = `Message from ${input.from}: ${input.text}`;
      if (run.endedAt) {
        if (!run.agentId || !wake) throw new RunError(409, "That run has ended and has no agent to wake.");
        await wake({ agentId: run.agentId, ticketId: run.ticketId, reason: "message", priority: 3, note: text, causedByRunId: input.causedByRunId });
        return { delivered: "woken" as const };
      }
      if (!runnerId || !deps.runners.send(runnerId, { type: "run.message", runId, text, interrupt: input.interrupt ?? false })) {
        throw new RunError(409, "The company's runner is offline, so the message can't reach the agent. Try again when it's back.");
      }
      return { delivered: input.interrupt ? ("interrupted" as const) : ("queued" as const) };
    },

    async cancel(runId: string, companyId?: string) {
      const { run, runnerId } = await load(runId, companyId);
      if (run.endedAt) throw new RunError(409, "That run has already ended.");
      if (!runnerId || !deps.runners.send(runnerId, { type: "run.cancel", runId })) throw new RunError(409, "The company's runner is offline, so the run can't be stopped from here.");
      return { cancelled: true };
    },
  };
}
