// The Spend page's read (BOS-2194), owner only: what a company spent per day, agent, feature and project.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { SPEND_REPORT_PERIODS, spendReport } from "../services/spend-report.js";

const Params = z.object({ id: z.string().uuid() });
const Query = z.object({
  days: z.coerce.number().int().refine((n) => (SPEND_REPORT_PERIODS as readonly number[]).includes(n), "days must be 7, 30 or 90").default(30),
  tz: z.string().max(64).optional(),
});

export function spendReportRoutes(owner: FastifyInstance, db: Db, deps: { now?: () => Date }) {
  owner.get("/api/companies/:id/spend-report", async (req, reply) => {
    const { id } = Params.parse(req.params);
    const q = Query.parse(req.query);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    return spendReport(db, id, { days: q.days, timeZone: q.tz, now: deps.now ? deps.now() : undefined });
  });
}
