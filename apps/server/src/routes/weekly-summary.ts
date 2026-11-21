// The Notifications page's "Weekly summary by email" section (BOS-2195), owner only. Off until the owner switches it on.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { mailerService } from "../services/mailer.js";
import { WeeklySettingsInput, type weeklySummaryService } from "../services/weekly-summary.js";

export function weeklySummaryRoutes(owner: FastifyInstance, deps: { weekly: ReturnType<typeof weeklySummaryService>; mailer: ReturnType<typeof mailerService> }) {
  const Id = z.object({ id: z.string().uuid() });
  owner.get("/api/companies/:id/weekly-summary", async (req) => {
    const s = await deps.weekly.get(Id.parse(req.params).id);
    return { enabled: s.enabled, to: s.to, lastSentAt: s.lastSentAt, configured: await deps.mailer.isConfigured() };
  });
  owner.put("/api/companies/:id/weekly-summary", async (req, reply) => {
    try {
      return await deps.weekly.save(Id.parse(req.params).id, WeeklySettingsInput.parse(req.body));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 422) return reply.code(422).send({ error: "invalid", message: (err as Error).message });
      throw err;
    }
  });
}
