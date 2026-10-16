// Steering and stopping agents (R37). The owner, or a CEO for its own company, can send a
// message into a running agent's session or stop it. A message for a run that has already
// ended wakes the agent again on the same ticket with the message instead.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, runners, runs, tickets } from "../db/schema.js";
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

    /** Runs still going, newest first, with agent and ticket names. */
    async active(companyId?: string) {
      return db
        .select({ id: runs.id, companyId: runs.companyId, agent: agents.name, agentId: runs.agentId, ticketId: runs.ticketId, ticket: tickets.title, model: runs.model, startedAt: runs.startedAt, lastEventAt: runs.lastEventAt })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
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
