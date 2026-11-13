// Outgoing email (BOS-1387): the one sender everything that mails uses (the portal's confirmation emails and later).
// The connection details sit in the settings table; the password is a stored secret and is never returned or logged.
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { sendMail, SmtpError, type MailMessage, type SmtpConfig } from "./smtp.js";

const KEY = "outgoing_email";

const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/, "Use a server name like smtp.example.com, with no spaces or https://.");
const Address = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, "That isn't an email address.");

export const EmailSettingsInput = z.object({
  host: Host,
  port: z.number().int().min(1).max(65535),
  security: z.enum(["starttls", "tls", "none"]),
  username: z.string().trim().max(255).regex(/^[^\r\n]*$/, "No line breaks.").nullable(),
  fromAddress: Address,
  fromName: z.string().trim().max(100).regex(/^[^\r\n]*$/, "No line breaks.").nullable(),
  /** A string replaces the saved password, null removes it, left out keeps it. */
  password: z.string().min(1).max(1000).regex(/^[^\r\n]*$/, "No line breaks.").nullable().optional(),
});

export type StoredEmail = Omit<z.infer<typeof EmailSettingsInput>, "password"> & { passwordSecretId: string | null };

/** The page's view: everything but the password, plus whether one is saved. */
export type EmailSettingsView = Omit<StoredEmail, "passwordSecretId"> & { hasPassword: boolean };

export const NOT_SET_UP = "Outgoing email isn't set up. Add the mail server in Settings → Server and runner → Outgoing email.";

export class MailNotConfigured extends Error {
  constructor() {
    super(NOT_SET_UP);
  }
}

/** Removes the password (and its base64 form, which AUTH sends) from any text before it is shown or logged. */
export function scrub(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of [s, Buffer.from(s).toString("base64"), Buffer.from(`\0${s}`).toString("base64")]) if (form.length >= 3) out = out.split(form).join("•••");
  }
  return out;
}

export function mailerService(
  db: Db,
  deps: { reveal: (secretId: string) => Promise<string | null>; /** Test hook: extra TLS options (a test CA). */ tlsOptions?: SmtpConfig["tlsOptions"]; send?: typeof sendMail },
) {
  const stored = async (): Promise<StoredEmail | null> => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY));
    return (row?.value as StoredEmail | undefined) ?? null;
  };
  const view = (s: StoredEmail | null): EmailSettingsView | null => {
    if (!s) return null;
    const { passwordSecretId, ...rest } = s;
    return { ...rest, hasPassword: !!passwordSecretId };
  };

  return {
    async get(): Promise<EmailSettingsView | null> {
      return view(await stored());
    },
    /** What anything that needs email checks first. */
    async isConfigured(): Promise<boolean> {
      const s = await stored();
      return !!s?.host && !!s.fromAddress;
    },
    /** Writes the settings; the password is handled by the caller (it owns the secret store). Returns the stored form. */
    async save(next: StoredEmail): Promise<EmailSettingsView> {
      await db.insert(settings).values({ key: KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
      return view(next)!;
    },
    async passwordSecretId(): Promise<string | null> {
      return (await stored())?.passwordSecretId ?? null;
    },
    /** Turns outgoing email off again: settings forgotten (the caller removes the password secret). */
    async clear(): Promise<void> {
      await db.delete(settings).where(eq(settings.key, KEY));
    },

    /** Sends one plain-text email. Throws MailNotConfigured when email isn't set up, otherwise an Error whose message is safe to show. */
    async send(msg: MailMessage): Promise<void> {
      const s = await stored();
      if (!s?.host || !s.fromAddress) throw new MailNotConfigured();
      const password = s.passwordSecretId ? await deps.reveal(s.passwordSecretId) : null;
      try {
        await (deps.send ?? sendMail)({ host: s.host, port: s.port, security: s.security, username: s.username || null, password, fromAddress: s.fromAddress, fromName: s.fromName || null, tlsOptions: deps.tlsOptions }, msg);
      } catch (e) {
        const raw = e instanceof Error ? (e instanceof SmtpError ? e.message : `${(e as NodeJS.ErrnoException).code ? `${(e as NodeJS.ErrnoException).code}: ` : ""}${e.message}`) : String(e);
        throw new Error(scrub(raw, [password]));
      }
    },
  };
}
