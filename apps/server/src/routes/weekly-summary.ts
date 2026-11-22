// The Notifications page's "Weekly summary by email" section (BOS-2195), owner only. Off until the owner switches it on.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { mailerService } from "../services/mailer.js";
import { WeeklySettingsInput, type weeklySummaryService } from "../services/weekly-summary.js";

export function weeklySummaryRoutes(owner: FastifyInstance, deps: { weekly: ReturnType<typeof weeklySummaryService>; mailer: ReturnType<typeof mailerService> }) {
  const Id = z.object({ id: z.string().uuid() });
  const notFound = { error: "not_found", message: "No such company." };
  owner.get("/api/companies/:id/weekly-summary", async (req, reply) => {
    const id = Id.parse(req.params).id;
    if (!(await deps.weekly.companyExists(id))) return reply.code(404).send(notFound);
    const s = await deps.weekly.get(id);
    return { enabled: s.enabled, to: s.to, lastSentAt: s.lastSentAt, configured: await deps.mailer.isConfigured() };
  });
  owner.put("/api/companies/:id/weekly-summary", async (req, reply) => {
    const id = Id.parse(req.params).id;
    if (!(await deps.weekly.companyExists(id))) return reply.code(404).send(notFound);
    try {
      return await deps.weekly.save(id, WeeklySettingsInput.parse(req.body));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 422) return reply.code(422).send({ error: "invalid", message: (err as Error).message });
      throw err;
    }
  });
  // "Send one now" (BOS-2241): the same email as Monday's, at once; lastSentAt is untouched.
  owner.post("/api/companies/:id/weekly-summary/send-now", async (req, reply) => {
    const id = Id.parse(req.params).id;
    if (!(await deps.weekly.companyExists(id))) return reply.code(404).send(notFound);
    try {
      return await deps.weekly.sendNow(id);
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 422 || code === 502) return reply.code(code).send({ error: code === 422 ? "invalid" : "mail_failed", message: (err as Error).message });
      throw err;
    }
  });
}
