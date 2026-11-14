// Settings → Outgoing email (BOS-1387), owner only: the mail server details, the password (kept in the secret
// store, never sent back) and a test email. Registered on the owner scope so requireOwner still applies.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { mailerService } from "../services/mailer.js";
import { EmailSettingsInput, MailNotConfigured } from "../services/mailer.js";
import type { secretsService } from "../services/secrets.js";

export function emailSettingsRoutes(owner: FastifyInstance, deps: { mailer: ReturnType<typeof mailerService>; secretsSvc: ReturnType<typeof secretsService> }) {
  const { mailer, secretsSvc } = deps;

  owner.get("/api/settings/email", async () => ({ settings: await mailer.get(), configured: await mailer.isConfigured() }));

  owner.put("/api/settings/email", async (req) => {
    const { password, ...b } = EmailSettingsInput.parse(req.body);
    let secretId = await mailer.passwordSecretId();
    if (password === null && secretId) {
      await secretsSvc.remove(secretId);
      secretId = null;
    } else if (password) {
      secretId = secretId && (await secretsSvc.rotate(secretId, password, { acceptUnusualFormat: true })) ? secretId : (await secretsSvc.create({ name: "outgoing email password", kind: "generic", value: password })).secret.id;
    }
    const saved = await mailer.save({ ...b, passwordSecretId: secretId });
    return { settings: saved, configured: true };
  });

  // Off again: forget the settings and the password.
  owner.delete("/api/settings/email", async () => {
    const id = await mailer.passwordSecretId();
    await mailer.clear();
    if (id) await secretsSvc.remove(id);
    return { settings: null, configured: false };
  });

  // Sends to the saved settings. The answer on failure is the mail server's own words with the password hidden.
  owner.post("/api/settings/email/test", async (req, reply) => {
    const { to } = z.object({ to: z.string().trim().max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, "That isn't an email address.") }).parse(req.body);
    try {
      await mailer.send({ to, subject: "Boss Man test email", text: "This is a test email from Boss Man. If you can read it, outgoing email works." });
      return { ok: true };
    } catch (err) {
      if (err instanceof MailNotConfigured) return reply.code(409).send({ error: "not_configured", message: err.message });
      return reply.code(502).send({ error: "send_failed", message: `The test email didn't go through: ${(err as Error).message}` });
    }
  });
}
