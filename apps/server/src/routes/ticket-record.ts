// What Boss Man recorded about a ticket (BOS-2175): runs, spend against the cap, the last check and the
// files changed, read from Boss Man's own records so the owner can set them beside the agent's "done".
// Read-only. The caller passes its owner scope, so requireOwner and the app's error handler apply.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { checkJobs, costEvents, projects, runs, tickets } from "../db/schema.js";

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
}
