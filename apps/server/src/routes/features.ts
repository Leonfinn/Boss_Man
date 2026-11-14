// Feature requests, feedback and the public portal's owner settings (R16, R25).
// Moved out of app.ts unchanged (BOS-298 step 15). The caller passes its owner scope, so
// requireOwner and the app's error handler still apply: this registers routes on that
// instance rather than through app.register, which would add a new scope.
// The agent-picture route, the owner chat and the chapters stay in app.ts. The public
// portal itself is portal.ts (portalRoutes) and is not touched here.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { FEATURE_STATUSES, HORIZONS, IMPORTANCE, NOTE_SOURCES, OWNER_MESSAGE_MAX, RISK_TIERS, SYSTEM_STATES } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { projects } from "../db/schema.js";
import { FeedbackError, type feedbackService } from "../services/feedback.js";
import { logoType } from "../services/image-type.js";
import type { workService } from "../services/work.js";
import { sendLogo } from "../portal.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function featureRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    feedback: ReturnType<typeof feedbackService>;
    work: ReturnType<typeof workService>;
    /** The public portal's address, as configured, so Settings can show it (trailing slashes trimmed). */
    portalUrl?: string;
  },
) {
  const { feedback, work, portalUrl } = deps;

  // Feature requests: feedback notes, features and prioritisation.
  const Text = (max: number) => z.string().trim().min(1).max(max);
  const CustomerIn = z.object({ name: Text(200), email: z.string().trim().email().max(320).nullable().optional(), segment: z.string().trim().max(100).nullable().optional() });
  const FeatureFields = z.object({
    title: Text(200),
    description: z.string().max(OWNER_MESSAGE_MAX).nullable(),
    status: z.enum(FEATURE_STATUSES),
    areaId: Uuid.nullable(),
    parentId: Uuid.nullable(),
    effort: z.number().int().min(1).max(5).nullable(),
    rank: z.number().int().min(1).max(5).nullable(),
    horizon: z.enum(HORIZONS).nullable(),
    driverScores: z.record(Uuid, z.number().int().min(0).max(5).nullable()),
    milestoneId: Uuid.nullable(),
    objectiveId: Uuid.nullable(),
    portalVisible: z.boolean(),
    keepOffPortal: z.boolean(),
    keepOffReason: z.string().trim().max(500).nullable(),
    publicSummary: z.string().trim().max(2000).nullable(),
    publicTitle: z.string().trim().max(200).nullable(),
    showPublicly: z.boolean(),
  });
  owner.get("/api/companies/:id/feedback-settings", async (req) => {
    const { id } = IdParam.parse(req.params);
    const s = await feedback.settings(id);
    return { ...s, portalUrl: portalUrl?.replace(/\/+$/, "") || null, drivers: await feedback.drivers(id), areas: await feedback.areas(id) };
  });
  owner.patch("/api/companies/:id/feedback-settings", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ demandWeight: z.number().int().min(0).max(10), ceoTriage: z.boolean() }).partial().parse(req.body);
    return feedback.setSettings(id, b);
  });
  owner.post("/api/companies/:id/feature-drivers", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return reply.code(201).send(await feedback.addDriver(id, z.object({ name: Text(80), weight: z.number().int().min(0).max(10).default(1) }).parse(req.body)));
  });
  owner.patch("/api/feature-drivers/:id", async (req) => feedback.updateDriver(IdParam.parse(req.params).id, z.object({ name: Text(80), weight: z.number().int().min(0).max(10), position: z.number().int().min(0) }).partial().parse(req.body)));
  owner.delete("/api/feature-drivers/:id", async (req, reply) => (await feedback.removeDriver(IdParam.parse(req.params).id), reply.code(204).send()));
  owner.post("/api/companies/:id/feature-areas", async (req, reply) => reply.code(201).send(await feedback.addArea(IdParam.parse(req.params).id, z.object({ name: Text(80) }).parse(req.body).name)));
  owner.patch("/api/feature-areas/:id", async (req) => feedback.updateArea(IdParam.parse(req.params).id, z.object({ name: Text(80), position: z.number().int().min(0) }).partial().parse(req.body)));
  owner.delete("/api/feature-areas/:id", async (req, reply) => (await feedback.removeArea(IdParam.parse(req.params).id), reply.code(204).send()));

  owner.patch("/api/companies/:id/portal", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ enabled: z.boolean(), title: z.string().trim().max(120).nullable(), intro: z.string().trim().max(2000).nullable(), backUrl: z.string().trim().max(2000).nullable(), backText: z.string().trim().max(40).nullable() }).partial().parse(req.body);
    // BOS-967: the back link must be a full https address, or empty for none.
    if (b.backUrl && !/^https:\/\/[^\s]+$/i.test(b.backUrl)) throw new FeedbackError(422, "Enter a full web address that starts with https://");
    return feedback.setPortal(id, { ...b, ...(b.title === "" ? { title: null } : {}), ...(b.intro === "" ? { intro: null } : {}), ...(b.backUrl === "" ? { backUrl: null } : {}), ...(b.backText === "" ? { backText: null } : {}) });
  });
  owner.put("/api/companies/:id/feedback/portal-logo", { bodyLimit: 400 * 1024 }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { data } = z.object({ data: z.string() }).parse(req.body);
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 256 * 1024) return reply.code(413).send({ error: "too_large", message: "The logo must be 256 KB or smaller." });
    const type = logoType(bytes);
    if (!type) return reply.code(415).send({ error: "bad_type", message: "The logo must be a PNG, JPEG or WebP image." });
    await feedback.setPortalLogo(id, { bytes, type });
    return feedback.settings(id);
  });
  owner.delete("/api/companies/:id/feedback/portal-logo", async (req) => {
    const { id } = IdParam.parse(req.params);
    await feedback.setPortalLogo(id, null);
    return feedback.settings(id);
  });
  owner.get("/api/companies/:id/feedback/portal-logo", async (req, reply) => {
    const logo = await feedback.portalLogo(IdParam.parse(req.params).id);
    return logo ? sendLogo(reply, logo) : reply.code(404).send({ error: "not_found", message: "No logo." });
  });

  owner.post("/api/companies/:id/portal/rotate", async (req) => feedback.rotatePortal(IdParam.parse(req.params).id));
  owner.get("/api/companies/:id/features", async (req) => feedback.scored(IdParam.parse(req.params).id));
  owner.post("/api/companies/:id/features", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return reply.code(201).send(await feedback.createFeature(id, FeatureFields.partial().required({ title: true }).parse(req.body)));
  });
  owner.get("/api/features/:id", async (req) => feedback.featureDetail(IdParam.parse(req.params).id));
  owner.patch("/api/features/:id", async (req) => feedback.updateFeature(IdParam.parse(req.params).id, FeatureFields.partial().parse(req.body)));
  owner.delete("/api/features/:id", async (req, reply) => (await feedback.removeFeature(IdParam.parse(req.params).id), reply.code(204).send()));
  /** A ticket that delivers the feature, described from what people asked for. */
  owner.post("/api/features/:id/tickets", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ projectId: Uuid, title: Text(200).optional(), risk: z.enum(RISK_TIERS).optional(), assigneeAgentId: Uuid.optional(), state: z.enum(SYSTEM_STATES).optional(), noCode: z.boolean().optional() }).parse(req.body);
    const { feature: f, body } = await feedback.brief(id);
    const [p] = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, b.projectId));
    if (!p || p.companyId !== f.companyId) return reply.code(422).send({ error: "rejected", message: "Pick a project of the feature's company." });
    const t = await work.createTicket(b.projectId, { title: b.title ?? f.title, body, featureId: id, risk: b.risk, assigneeAgentId: b.assigneeAgentId, state: b.state, noCode: b.noCode });
    if (f.status === "idea" || f.status === "considering") await feedback.updateFeature(id, { status: "planned" });
    return reply.code(201).send(t);
  });

  owner.get("/api/companies/:id/feedback-customers", async (req) => feedback.customers(IdParam.parse(req.params).id, z.object({ q: z.string().max(100).optional() }).parse(req.query).q));
  owner.get("/api/feedback/unprocessed", async () => feedback.unprocessedCount());
  owner.get("/api/companies/:id/feedback", async (req) => {
    const { id } = IdParam.parse(req.params);
    const q = z.object({ state: z.enum(["unprocessed", "processed", "archived"]).optional(), q: z.string().max(200).optional(), before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return feedback.notes(id, q);
  });
  owner.post("/api/companies/:id/feedback", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ title: z.string().trim().max(200).nullable().optional(), text: Text(20_000), source: z.enum(NOTE_SOURCES).exclude(["portal", "agent", "chat"]).optional(), customerId: Uuid.nullable().optional(), customer: CustomerIn.nullable().optional() }).parse(req.body);
    return reply.code(201).send(await feedback.createNote(id, b));
  });
  owner.get("/api/feedback/:id", async (req) => feedback.noteDetail(IdParam.parse(req.params).id));
  owner.patch("/api/feedback/:id", async (req) => {
    const b = z.object({ title: z.string().trim().max(200).nullable(), state: z.enum(["unprocessed", "processed", "archived"]), customerId: Uuid.nullable(), customer: CustomerIn.nullable() }).partial().parse(req.body);
    return feedback.updateNote(IdParam.parse(req.params).id, b);
  });
  owner.delete("/api/feedback/:id", async (req, reply) => (await feedback.removeNote(IdParam.parse(req.params).id), reply.code(204).send()));
  owner.post("/api/feedback/:id/insights", async (req, reply) => {
    const b = z.object({ featureId: Uuid, importance: z.enum(IMPORTANCE).default("important"), highlight: z.string().max(2000).nullable().optional() }).parse(req.body);
    return reply.code(201).send(await feedback.link(IdParam.parse(req.params).id, { ...b, createdBy: "the owner" }));
  });
  owner.delete("/api/insights/:id", async (req, reply) => (await feedback.unlink(IdParam.parse(req.params).id), reply.code(204).send()));
}
