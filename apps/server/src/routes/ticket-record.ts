// What Boss Man recorded about a ticket (BOS-2175): runs, spend against the cap, the last check and the
// files changed, read from Boss Man's own records so the owner can set them beside the agent's "done".
// Read-only. The caller passes its owner scope, so requireOwner and the app's error handler apply.
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { firstFailingLine } from "@boss-man/shared";
import { checkJobs, checkWorkers, costEvents, projects, runs, ticketTransitions, tickets } from "../db/schema.js";

const IdParam = z.object({ id: z.string().uuid() });

export function ticketRecordRoutes(owner: FastifyInstance, db: Db, deps: { filesChanged: (ticketId: string) => Promise<number | null> }) {
  owner.get("/api/tickets/:id/record", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [t] = await db
      .select({ cap: tickets.costCapMicros, projectCap: projects.ticketCostCapMicros })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, id));
    if (!t) return reply.code(404).send({ error: "not_found", message: "No such ticket." });

    const [r] = await db
      .select({ total: sql<number>`count(*)::int`, errored: sql<number>`count(*) filter (where ${runs.outcome} like 'error%')::int` })
      .from(runs)
      .where(eq(runs.ticketId, id));
    const [spend] = await db
      .select({ micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
      .from(costEvents)
      .innerJoin(runs, eq(runs.id, costEvents.runId))
      .where(eq(runs.ticketId, id));
    const [last] = await db
      .select({ state: checkJobs.state, scope: checkJobs.scope, at: checkJobs.endedAt })
      .from(checkJobs)
      .where(and(eq(checkJobs.ticketId, id), inArray(checkJobs.state, ["passed", "failed"])))
      .orderBy(desc(checkJobs.endedAt))
      .limit(1);

    return {
      runs: { total: r?.total ?? 0, errored: r?.errored ?? 0 },
      spendMicros: Number(spend?.micros ?? 0),
      capMicros: t.cap ?? t.projectCap ?? null,
      lastCheck: last ? { result: last.state === "passed" ? "pass" : "fail", scope: last.scope, at: last.at?.toISOString() ?? null } : null,
      filesChanged: await deps.filesChanged(id).catch(() => null),
    };
  });

  // BOS-2371: every check the ticket has had, newest first (up to 50), so the owner can read a ticket's bounces
  // without an agent: what ran, the result, how long, on which machine, and for a failed or stuck one the first
  // failing line, worked out the same way as check_log's list (the log tail, else the recorded reason).
  owner.get("/api/tickets/:id/checks", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [t] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
    if (!t) return reply.code(404).send({ error: "not_found", message: "No such ticket." });
    const rows = await db
      .select({
        id: checkJobs.id,
        kind: checkJobs.kind,
        scope: checkJobs.scope,
        state: checkJobs.state,
        queuedAt: checkJobs.queuedAt,
        startedAt: checkJobs.startedAt,
        endedAt: checkJobs.endedAt,
        runnerId: checkJobs.runnerId,
        workerId: checkJobs.workerId,
        worker: checkWorkers.name,
        reason: checkJobs.reason,
        logTail: checkJobs.logTail,
      })
      .from(checkJobs)
      .leftJoin(checkWorkers, eq(checkWorkers.id, checkJobs.workerId))
      .where(eq(checkJobs.ticketId, id))
      .orderBy(desc(checkJobs.queuedAt))
      .limit(50);
    return {
      checks: rows.map((r) => ({
        id: r.id,
        what: r.kind === "merge" ? "merge" : r.scope === "full" ? "full" : "quick",
        state: r.state,
        queuedAt: r.queuedAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        endedAt: r.endedAt?.toISOString() ?? null,
        // A job that never started has no machine; one whose worker was since removed keeps only that it was a worker.
        machine: r.workerId ? (r.worker ?? "a check worker") : r.runnerId ? "company runner" : null,
        firstLine: r.state === "failed" || r.state === "stuck" ? (firstFailingLine(r.logTail ?? "") ?? r.reason ?? null) : null,
      })),
    };
  });

  // BOS-2419: every state change the ticket has had, oldest first, for the "State history" fold. The first
  // row of a ticket made after transitions were recorded has no from-state; if it has one, the ticket is older
  // than the records, so the page says where the history starts instead of totalling a partial story.
  owner.get("/api/tickets/:id/state-history", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [t] = await db.select({ id: tickets.id, state: tickets.systemState }).from(tickets).where(eq(tickets.id, id));
    if (!t) return reply.code(404).send({ error: "not_found", message: "No such ticket." });
    const rows = await db
      .select({ fromState: ticketTransitions.fromState, toState: ticketTransitions.toState, at: ticketTransitions.at })
      .from(ticketTransitions)
      .where(eq(ticketTransitions.ticketId, id))
      .orderBy(asc(ticketTransitions.at), asc(ticketTransitions.id))
      .limit(500);
    return {
      state: t.state,
      complete: rows.length > 0 && rows[0]!.fromState === null,
      transitions: rows.map((r) => ({ from: r.fromState, to: r.toState, at: r.at.toISOString() })),
    };
  });
}
