// Objectives, the roadmap and plan views (R16, R25).
// Moved out of app.ts unchanged (BOS-298 step 15). The caller passes its owner scope, so
// requireOwner and the app's error handler still apply: this registers routes on that
// instance rather than through app.register, which would add a new scope.
// The board's own ticket routes stay in app.ts; only the roadmap-flavoured ones move here.
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { HORIZONS, dateIn } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, keyResults, objectives } from "../db/schema.js";
import type { feedbackService } from "../services/feedback.js";
import { WorkError } from "../services/ticket-links.js";
import { OBJECTIVE_STATUSES, type planningService } from "../services/planning.js";
import type { workService } from "../services/work.js";
import { setKeyResultValue } from "../services/key-result-readings.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });
/**
 * A calendar day written YYYY-MM-DD. The pattern alone lets 2026-02-30 through, and Postgres
 * then refuses it with a 500, so the day must also survive a round trip through Date (BOS-1968).
 * Used for ticket due dates and milestone target dates (app.ts, mcp-board.ts).
 */
export const DateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true; // the regex above already reported it
    const t = new Date(`${d}T00:00:00Z`); // month 13 gives an Invalid Date, and toISOString would throw
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, "That date doesn't exist. Use YYYY-MM-DD.");

/** True when a company with this id exists; the GET addresses for one company answer 404 when it doesn't (BOS-2253). */
export async function companyExists(db: Db, id: string): Promise<boolean> {
  const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
  return !!c;
}

/** Creating objectives, key results and milestones, and the tree the Plan page reads. */
export function objectiveRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    work: ReturnType<typeof workService>;
    /** Notes new scope for the CEO's next run; app.ts uses it for projects too. */
    teamCheck: (companyId: string, what: string) => Promise<void>;
  },
) {
  const { work, teamCheck } = deps;

  owner.post("/api/companies/:id/objectives", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ title: z.string().trim().min(1).max(200), priority: z.number().int().min(1).max(5).optional(), projectId: Uuid.optional() }).parse(req.body);
    const o = await work.createObjective(id, body);
    await teamCheck(id, `added an objective, "${o.title}"${body.projectId ? ` for project ${body.projectId}` : ""}`);
    return reply.code(201).send(o);
  });

  owner.post("/api/objectives/:id/key-results", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ title: z.string().trim().min(1).max(200), target: z.number().optional(), current: z.number().optional(), unit: z.string().max(20).optional(), method: z.enum(["manual", "agent", "check"]).optional() }).parse(req.body);
    const created = await work.addKeyResult(id, body);
    if (typeof body.current === "number") await setKeyResultValue(db, created.id, body.current, { kind: "owner" });
    return reply.code(201).send(created);
  });

  /** The company and title of a key result's objective, for the note the CEO reads (BOS-2250). */
  const keyResultContext = async (id: string) => {
    const [k] = await db
      .select({ title: keyResults.title, current: keyResults.current, companyId: objectives.companyId, objective: objectives.title })
      .from(keyResults)
      .innerJoin(objectives, eq(objectives.id, keyResults.objectiveId))
      .where(eq(keyResults.id, id));
    if (!k) throw new WorkError(404, "No such key result.");
    return k;
  };

  // Same limits as create. current and target can be cleared with null.
  owner.patch("/api/key-results/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const body = z
      .object({ title: z.string().trim().min(1).max(200), target: z.number().nullable(), current: z.number().nullable(), unit: z.string().max(20).nullable() })
      .partial()
      .parse(req.body);
    const before = await keyResultContext(id);
    if (Object.keys(body).length === 0) {
      const [same] = await db.select().from(keyResults).where(eq(keyResults.id, id));
      return same!;
    }
    const [k] = await db.update(keyResults).set(body).where(eq(keyResults.id, id)).returning();
    if (!k) throw new WorkError(404, "No such key result.");
    // A new value is a reading; saving the form with the value unchanged is not (BOS-2458).
    if (typeof body.current === "number" && body.current !== before.current) await setKeyResultValue(db, id, body.current, { kind: "owner" });
    await teamCheck(before.companyId, `changed the key result "${before.title}" under the objective "${before.objective}"`);
    return k;
  });

  owner.delete("/api/key-results/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const before = await keyResultContext(id);
    await db.delete(keyResults).where(eq(keyResults.id, id));
    await teamCheck(before.companyId, `removed the key result "${before.title}" from the objective "${before.objective}"`);
    return reply.code(204).send();
  });

  owner.post("/api/objectives/:id/milestones", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.optional(), horizon: z.enum(HORIZONS).optional() }).parse(req.body);
    const m = await work.addMilestone(id, body);
    const [o] = await db.select({ companyId: objectives.companyId, title: objectives.title }).from(objectives).where(eq(objectives.id, id));
    if (o) await teamCheck(o.companyId, `added a milestone, "${body.title}", under the objective "${o.title}"`);
    return reply.code(201).send(m);
  });

  owner.get("/api/companies/:id/objectives", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!(await companyExists(db, id))) return reply.code(404).send({ error: "not_found" });
    return work.objectivesTree(id);
  });
}

/** The roadmap, plan, milestone and ticket-link views (v1.1). */
export function roadmapRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    feedback: ReturnType<typeof feedbackService>;
    planning: ReturnType<typeof planningService>;
    now?: () => Date;
  },
) {
  const { feedback, planning, now } = deps;

  owner.get("/api/roadmap", async (req) => {
    const q = z.object({ today: DateStr.optional(), closed: z.enum(["1"]).optional() }).parse(req.query);
    const today = q.today ?? dateIn(now?.() ?? new Date(), "UTC");
    // Each milestone carries its status, forecast and 8-week burn-up (BOS-2397), all from one set of tickets (BOS-2560).
    return planning.roadmap(today, { includeClosed: !!q.closed });
  });
  /** Features for the roadmap's Now / Next / Later columns, grouped by objective on the client. */
  owner.get("/api/roadmap/features", async () => {
    const cos = await db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(asc(companies.name));
    return Promise.all(cos.map(async (c) => ({ ...c, features: await feedback.roadmapFeatures(c.id) })));
  });
  owner.patch("/api/objectives/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ title: z.string().trim().min(1).max(200), priority: z.number().int().min(1).max(5), status: z.enum(OBJECTIVE_STATUSES) }).partial().parse(req.body);
    return planning.updateObjective(id, b);
  });
  owner.get("/api/milestones/:id/tickets", async (req) => planning.milestoneTickets(IdParam.parse(req.params).id));
  owner.patch("/api/milestones/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ title: z.string().trim().min(1).max(200), targetDate: DateStr.nullable(), objectiveId: Uuid, horizon: z.enum(HORIZONS).nullable() }).partial().parse(req.body);
    return planning.updateMilestone(id, b);
  });
  owner.delete("/api/milestones/:id", async (req, reply) => {
    await planning.deleteMilestone(IdParam.parse(req.params).id);
    return reply.code(204).send();
  });
  owner.get("/api/companies/:id/plan", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!(await companyExists(db, id))) return reply.code(404).send({ error: "not_found" });
    return planning.plan(id);
  });
  owner.get("/api/companies/:id/open-tickets", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!(await companyExists(db, id))) return reply.code(404).send({ error: "not_found" });
    return planning.openTickets(id);
  });
  owner.get("/api/tickets/:id/links", async (req) => planning.ticketLinks(IdParam.parse(req.params).id));
  owner.get("/api/tickets/:id/related", async (req) => planning.relatedTickets(IdParam.parse(req.params).id));
  owner.delete("/api/dependencies/:id", async (req, reply) => {
    await planning.removeDependency(IdParam.parse(req.params).id);
    return reply.code(204).send();
  });
}
