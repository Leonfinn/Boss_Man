// Settings → Notifications → "Other places to send alerts" (BOS-2199). Owner-only. The webhook address is a secret:
// it is stored in the secrets store, and no answer here ever carries it, only its last 4 characters.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { alertDestinations, secrets } from "../db/schema.js";
import type { notificationsService } from "../services/notifications.js";
import type { secretsService } from "../services/secrets.js";
import { ALERT_KINDS, DEFAULT_ALERT_KINDS, DESTINATION_TYPES, type webhookDeliveryService } from "../services/webhook-delivery.js";

const Kinds = z.array(z.enum(ALERT_KINDS)).max(ALERT_KINDS.length);
const Name = z.string().trim().min(1).max(80);
const Address = z.string().trim().min(1).max(2000);
const Create = z.object({ type: z.enum(DESTINATION_TYPES), name: Name, address: Address, kinds: Kinds.default(DEFAULT_ALERT_KINDS), allowPrivate: z.boolean().default(false) });
const Update = z.object({ name: Name.optional(), address: Address.optional(), kinds: Kinds.optional(), allowPrivate: z.boolean().optional(), enabled: z.boolean().optional() });
const IdParam = z.object({ id: z.string().uuid() });

export function alertDestinationRoutes(
  owner: FastifyInstance,
  deps: { db: Db; secretsSvc: ReturnType<typeof secretsService>; webhooks: ReturnType<typeof webhookDeliveryService>; notes: ReturnType<typeof notificationsService> },
) {
  const { db, secretsSvc, webhooks, notes } = deps;

  const view = async () => {
    const rows = await db.select({ d: alertDestinations, hint: secrets.hint }).from(alertDestinations).leftJoin(secrets, eq(secrets.id, alertDestinations.secretId)).orderBy(alertDestinations.createdAt);
    return rows.map(({ d, hint }) => ({ id: d.id, type: d.type, name: d.name, kinds: d.kinds, allowPrivate: d.allowPrivate, enabled: d.enabled, hint, lastFailureNote: d.lastFailureNote, lastFailedAt: d.lastFailedAt }));
  };
  const one = async (id: string) => (await view()).find((r) => r.id === id) ?? null;

  owner.get("/api/alert-destinations", async () => ({ destinations: await view(), kinds: ALERT_KINDS, defaultKinds: DEFAULT_ALERT_KINDS }));

  owner.post("/api/alert-destinations", { logLevel: "silent" }, async (req, reply) => {
    const b = Create.parse(req.body);
    const problem = await webhooks.problem(b.address, b.allowPrivate);
    if (problem) return reply.code(400).send({ error: "bad_address", message: problem });
    const { secret } = await secretsSvc.create({ name: `Alert address ${randomBytes(4).toString("hex")}`, kind: "generic", value: b.address, acceptUnusualFormat: true });
    const [row] = await db.insert(alertDestinations).values({ type: b.type, name: b.name, secretId: secret.id, kinds: b.kinds, allowPrivate: b.allowPrivate }).returning({ id: alertDestinations.id });
    return reply.code(201).send(await one(row!.id));
  });

  owner.put("/api/alert-destinations/:id", { logLevel: "silent" }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = Update.parse(req.body);
    const [cur] = await db.select().from(alertDestinations).where(eq(alertDestinations.id, id));
    if (!cur) return reply.code(404).send({ error: "not_found", message: "No such destination." });
    const allowPrivate = b.allowPrivate ?? cur.allowPrivate;
    if (b.address) {
      const problem = await webhooks.problem(b.address, allowPrivate);
      if (problem) return reply.code(400).send({ error: "bad_address", message: problem });
    }
    let secretId = cur.secretId;
    if (b.address) {
      const rotated = secretId ? await secretsSvc.rotate(secretId, b.address, { acceptUnusualFormat: true }) : null;
      if (!rotated) secretId = (await secretsSvc.create({ name: `Alert address ${randomBytes(4).toString("hex")}`, kind: "generic", value: b.address, acceptUnusualFormat: true })).secret.id;
    }
    // A new address or switching back on starts the failure count again.
    const fresh = !!b.address || (b.enabled === true && !cur.enabled);
    await db
      .update(alertDestinations)
      .set({ ...(b.name ? { name: b.name } : {}), ...(b.kinds ? { kinds: b.kinds } : {}), allowPrivate, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), secretId, ...(fresh ? { failingSince: null, lastFailureNote: null, lastFailedAt: null } : {}) })
      .where(eq(alertDestinations.id, id));
    return one(id);
  });

  owner.delete("/api/alert-destinations/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [cur] = await db.select().from(alertDestinations).where(eq(alertDestinations.id, id));
    if (!cur) return reply.code(404).send({ error: "not_found", message: "No such destination." });
    await db.delete(alertDestinations).where(eq(alertDestinations.id, id));
    if (cur.secretId) await secretsSvc.remove(cur.secretId);
    return { ok: true };
  });

  // "Send a test message": always 200 with the outcome, so the page shows success or the HTTP status as text.
  owner.post("/api/alert-destinations/:id/test", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = await webhooks.test(id, (await notes.getSettings()).publicUrl);
    return r ?? reply.code(404).send({ error: "not_found", message: "No such destination." });
  });
}
