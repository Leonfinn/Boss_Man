// Phone Approve, device profiles and notifications (R44, BOS-243, BOS-641).
// Moved out of app.ts unchanged (BOS-298 step 15). The owner functions register on the caller's owner
// scope, so requireOwner and the app's error handler still apply: they add routes on that instance
// rather than through app.register, which would add a new scope. phoneApproveRoutes opens its own
// scope for the ntfy taps, exactly as app.ts did, so their own JSON parsers and error handler still
// answer a bad body with plain JSON rather than the error handler's message.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { deviceProfilesService } from "../services/device-profiles.js";
import type { hostFactsService } from "../services/host-facts.js";
import { NotifySettings, NtfyUrl, type notificationsService } from "../services/notifications.js";
import type { phoneApproveService } from "../services/phone-approve.js";
import type { secretsService } from "../services/secrets.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

// Phone Approve (BOS-243 rules 3, 4, 8): an ntfy http action posts {"token": "..."} here, with no
// session. JSON in and out, never a page; request logging is off and the body is never logged or
// echoed, so the token can't reach a log, the error buffer or a response. Its own parsers, in their
// own scope, so a bad body gets a plain JSON answer rather than the error handler's message.
export function phoneApproveRoutes(
  app: FastifyInstance,
  deps: {
    notes: ReturnType<typeof notificationsService>;
    phoneApprove: ReturnType<typeof phoneApproveService>;
  },
) {
  const { notes, phoneApprove } = deps;
  return app.register(async (phone) => {
    phone.removeAllContentTypeParsers();
    phone.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 }, (_req, body, done) => done(null, { json: body }));
    phone.addContentTypeParser("*", { parseAs: "string", bodyLimit: 1024 }, (_req, _body, done) => done(null, { json: null }));
    phone.setErrorHandler((err, _req, reply) => {
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ ok: false, error: "bad_request" });
      // A fixed line only: the error itself could quote the request.
      app.log.warn("phone approve: a tap failed inside the server");
      return reply.code(500).send({ ok: false, error: "internal_error" });
    });
    // The "Got it" button on the test push: a tap proves the phone received it. Same body rules as Approve.
    phone.post("/api/phone/got-it", { logLevel: "silent" }, async (req, reply) => {
      const raw = (req.body as { json?: string | null } | undefined)?.json;
      if (typeof raw !== "string") return reply.code(415).send({ ok: false, error: "json_only" });
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { token?: unknown } | null)?.token;
      } catch {
        return reply.code(400).send({ ok: false, error: "bad_request" });
      }
      return (await notes.confirmTest(token)) ? { ok: true } : reply.code(404).send({ ok: false, error: "not_found" });
    });
    phone.post("/api/phone/approve", { logLevel: "silent" }, async (req, reply) => {
      const raw = (req.body as { json?: string | null } | undefined)?.json;
      if (typeof raw !== "string") return reply.code(415).send({ ok: false, error: "json_only" });
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { token?: unknown } | null)?.token;
      } catch {
        return reply.code(400).send({ ok: false, error: "bad_request" });
      }
      const r = await phoneApprove.redeem(token, req.ip);
      return reply.code(r.status).send(r.body);
    });
  });
}

// Device profiles (BOS-641): the owner's browsers report their measured screens so a layout
// ticket can be checked at the real device. Only screen facts; one row per signed-in browser.
export function deviceRoutes(
  owner: FastifyInstance,
  deps: {
    deviceProfiles: ReturnType<typeof deviceProfilesService>;
    /** The signed-in owner's id, for rows kept per owner. Only valid behind requireOwner. */
    currentOwnerId: (req: FastifyRequest) => Promise<string | null>;
  },
) {
  const { deviceProfiles, currentOwnerId } = deps;
  owner.get("/api/devices", async (req) => {
    const ownerId = await currentOwnerId(req);
    return ownerId ? deviceProfiles.list(ownerId) : [];
  });
  owner.post("/api/devices", async (req, reply) => {
    const ownerId = await currentOwnerId(req);
    if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
    return deviceProfiles.report(ownerId, req.body);
  });
  owner.patch("/api/devices/:id", async (req, reply) => {
    const ownerId = await currentOwnerId(req);
    if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
    const { id } = IdParam.parse(req.params);
    const { label } = z.object({ label: z.string().trim().min(1).max(80) }).parse(req.body);
    const p = await deviceProfiles.rename(ownerId, id, label);
    return p ?? reply.code(404).send({ error: "not_found" });
  });
  owner.delete("/api/devices/:id", async (req, reply) => {
    const ownerId = await currentOwnerId(req);
    if (!ownerId) return reply.code(401).send({ error: "not_signed_in" });
    const { id } = IdParam.parse(req.params);
    return (await deviceProfiles.remove(ownerId, id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
}

// Notifications (R44): the feed.
export function notificationRoutes(
  owner: FastifyInstance,
  deps: {
    notes: ReturnType<typeof notificationsService>;
  },
) {
  const { notes } = deps;
  owner.get("/api/notifications", async (req) => {
    const q = z
      .object({
        before: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        status: z.enum(["unread", "read"]).optional(),
        level: z.enum(["note", "flag", "page", "ask"]).optional(),
        company: z.union([z.literal("none"), Uuid]).optional(),
      })
      .parse(req.query);
    return { items: await notes.list(q), unread: await notes.unread(), counts: await notes.unreadCounts() };
  });
  // The last 20 phone pushes, with why each was urgent and whether its card is still open (BOS-1097).
  owner.get("/api/notifications/pushes", async () => ({ items: await notes.recentPushes(20) }));
  owner.post("/api/notifications/read", async (req) => {
    const b = z.object({ ids: z.array(Uuid).max(500).optional(), all: z.boolean().optional() }).parse(req.body);
    await notes.markRead(b.all ? "all" : (b.ids ?? []));
    return { unread: await notes.unread() };
  });
}

// Notifications settings (R44): what is on, which ntfy server and topic, and a test push (BOS-243).
export function notificationSettingsRoutes(
  owner: FastifyInstance,
  deps: {
    notes: ReturnType<typeof notificationsService>;
    phoneApprove: ReturnType<typeof phoneApproveService>;
    secretsSvc: ReturnType<typeof secretsService>;
    hostFacts: ReturnType<typeof hostFactsService>;
  },
) {
  const { notes, phoneApprove, secretsSvc, hostFacts } = deps;

  /** Whether phone Approve buttons are on, and if not why, for Notifications (BOS-243). */
  const approveStatus = async (s: NotifySettings) => {
    const { gate: g } = await phoneApprove.gate(s);
    return g.on ? { on: true } : { on: false, why: g.why };
  };
  // The address the phone app must use for ntfy: the add-on's own NTFY_BASE_URL as the host reports it (null: not reported).
  const phoneNtfyAddress = async () => (await hostFacts.value("ntfy.baseUrl").catch(() => null)) ?? null;
  const phoneNtfyContainer = async () => (await hostFacts.value("ntfy.container").catch(() => null)) ?? null;
  owner.get("/api/notification-settings", async () => {
    const s = await notes.getSettings();
    return { ...s, ntfy: s.ntfy ? { url: s.ntfy.url, topic: s.ntfy.topic, hasToken: !!s.ntfy.tokenSecretId } : null, approve: await approveStatus(s), phoneAddress: await phoneNtfyAddress(), phoneContainer: await phoneNtfyContainer(), phoneTest: await notes.testStatus() };
  });
  owner.put("/api/notification-settings", async (req) => {
    const b = NotifySettings.omit({ ntfy: true })
      .extend({
        ntfy: z.object({ url: NtfyUrl, topic: z.string(), token: z.string().trim().min(1).max(500).nullable().optional() }).nullable(),
      })
      .parse(req.body);
    const current = await notes.getSettings();
    let tokenSecretId = current.ntfy?.tokenSecretId ?? null;
    if (b.ntfy?.token === null) tokenSecretId = null;
    else if (b.ntfy?.token) {
      // The token goes into the encrypted secrets store, like every other credential.
      tokenSecretId = tokenSecretId
        ? ((await secretsSvc.rotate(tokenSecretId, b.ntfy.token, { acceptUnusualFormat: true })) ? tokenSecretId : null)
        : (await secretsSvc.create({ name: "ntfy access token", kind: "generic", value: b.ntfy.token })).secret.id;
    }
    const saved = await notes.setSettings({ ...b, ntfy: b.ntfy ? { url: b.ntfy.url, topic: b.ntfy.topic, tokenSecretId } : null });
    return { ...saved, ntfy: saved.ntfy ? { url: saved.ntfy.url, topic: saved.ntfy.topic, hasToken: !!saved.ntfy.tokenSecretId } : null, approve: await approveStatus(saved), phoneAddress: await phoneNtfyAddress(), phoneContainer: await phoneNtfyContainer(), phoneTest: await notes.testStatus() };
  });
  owner.post("/api/notification-settings/test", async (_req, reply) => {
    try {
      await notes.test();
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: "push_failed", message: `The test push didn't go through: ${(err as Error).message}` });
    }
  });
}
