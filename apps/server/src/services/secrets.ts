import { and, eq } from "drizzle-orm";
import { checkSecretFormat, normaliseSecret, secretHint, type SecretKind } from "@boss-man/shared";
import { decryptSecret, encryptSecret, type MasterKey } from "../crypto.js";
import type { Db } from "../db/client.js";
import { secretAccessLog, secretGrants, secrets } from "../db/schema.js";

/** A live check against the provider, e.g. a cheap authenticated call. */
export type LiveValidator = (kind: SecretKind, value: string) => Promise<{ ok: boolean; message: string } | null>;

export class SecretRejected extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}

export type SecretInput = { name: string; kind: SecretKind; value: string; acceptUnusualFormat?: boolean; verify?: boolean };

async function prepare(kind: SecretKind, raw: string, opts: { acceptUnusualFormat?: boolean; verify?: boolean }, live?: LiveValidator) {
  const value = normaliseSecret(kind, raw);
  const check = checkSecretFormat(kind, value);
  if (!check.ok && !opts.acceptUnusualFormat) throw new SecretRejected(check.problems);
  let verified: { ok: boolean; message: string } | null = null;
  if (opts.verify && live) {
    verified = await live(kind, value);
    if (verified && !verified.ok) throw new SecretRejected([verified.message]);
  }
  return { value, warnings: check.problems, verified };
}

export function secretsService(db: Db, master: MasterKey, live?: LiveValidator) {
  const publicFields = {
    id: secrets.id,
    name: secrets.name,
    kind: secrets.kind,
    hint: secrets.hint,
    version: secrets.version,
    createdAt: secrets.createdAt,
    updatedAt: secrets.updatedAt,
  };

  return {
    async list() {
      return db.select(publicFields).from(secrets).orderBy(secrets.name);
    },

    async create(input: SecretInput) {
      const { value, warnings, verified } = await prepare(input.kind, input.value, input, live);
      const sealed = encryptSecret(master, value);
      const [row] = await db
        .insert(secrets)
        .values({ name: input.name, kind: input.kind, hint: secretHint(value), ...sealed })
        .returning(publicFields);
      return { secret: row!, warnings, verified };
    },

    /** Rotation: every company granted this secret gets the new value on its next run. */
    async rotate(id: string, raw: string, opts: { acceptUnusualFormat?: boolean; verify?: boolean } = {}) {
      const [existing] = await db.select({ kind: secrets.kind, version: secrets.version }).from(secrets).where(eq(secrets.id, id));
      if (!existing) return null;
      const { value, warnings, verified } = await prepare(existing.kind as SecretKind, raw, opts, live);
      const sealed = encryptSecret(master, value);
      const [row] = await db
        .update(secrets)
        .set({ ...sealed, hint: secretHint(value), version: existing.version + 1, updatedAt: new Date() })
        .where(eq(secrets.id, id))
        .returning(publicFields);
      return { secret: row!, warnings, verified };
    },

    async remove(id: string) {
      const rows = await db.delete(secrets).where(eq(secrets.id, id)).returning({ id: secrets.id });
      return rows.length > 0;
    },

    async grant(secretId: string, companyId: string, envName: string) {
      const [row] = await db.insert(secretGrants).values({ secretId, companyId, envName }).returning();
      return row!;
    },

    async revoke(grantId: string) {
      const rows = await db.delete(secretGrants).where(eq(secretGrants.id, grantId)).returning({ id: secretGrants.id });
      return rows.length > 0;
    },

    async grantsForCompany(companyId: string) {
      return db
        .select({ id: secretGrants.id, envName: secretGrants.envName, secretId: secrets.id, secretName: secrets.name, hint: secrets.hint })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(eq(secretGrants.companyId, companyId))
        .orderBy(secretGrants.envName);
    },

    /**
     * The environment a company's runner gets: every granted secret, decrypted.
     * Each use is written to the access log.
     */
    async resolveCompanyEnv(companyId: string, purpose: string, runId?: string): Promise<Record<string, string>> {
      const rows = await db
        .select({
          grantId: secretGrants.id,
          envName: secretGrants.envName,
          secretId: secrets.id,
          ciphertext: secrets.ciphertext,
          wrappedKey: secrets.wrappedKey,
        })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(and(eq(secretGrants.companyId, companyId)));
      const env: Record<string, string> = {};
      for (const r of rows) env[r.envName] = decryptSecret(master, r);
      if (rows.length > 0) {
        await db.insert(secretAccessLog).values(
          rows.map((r) => ({ grantId: r.grantId, secretId: r.secretId, companyId, runId: runId ?? null, purpose })),
        );
      }
      return env;
    },
  };
}

/** Live checks that cost nothing: listing models. A Claude setup-token has no free check, so it is format-checked only. */
export const providerLiveValidator: LiveValidator = async (kind, value) => {
  const attempt = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, message: "The provider accepted the key." };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `The provider rejected the key (HTTP ${res.status}).` };
    return { ok: true, message: `Couldn't confirm the key (HTTP ${res.status}); saved anyway.` };
  };
  switch (kind) {
    case "anthropic_api_key":
      return attempt("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": value, "anthropic-version": "2023-06-01" });
    case "openai_api_key":
      return attempt("https://api.openai.com/v1/models", { authorization: `Bearer ${value}` });
    default:
      return null;
  }
};
