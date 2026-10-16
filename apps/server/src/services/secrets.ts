import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { checkSecretFormat, normaliseSecret, secretHint, type SecretKind } from "@boss-man/shared";
import { decryptSecret, encryptSecret, type MasterKey } from "../crypto.js";
import type { Db } from "../db/client.js";
import { companies, deploys, deployTargets, secretAccessLog, secretGrants, secrets } from "../db/schema.js";

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

    /** A grant tied to a deploy target is only handed to runs carrying out an approved deploy there. */
    async grant(secretId: string, companyId: string, envName: string, deployTargetId?: string) {
      if (deployTargetId) {
        const [t] = await db.select({ id: deployTargets.id }).from(deployTargets).where(and(eq(deployTargets.id, deployTargetId), eq(deployTargets.companyId, companyId)));
        if (!t) throw new Error("That deploy target isn't in this company.");
      }
      const [row] = await db.insert(secretGrants).values({ secretId, companyId, envName, deployTargetId: deployTargetId ?? null }).returning();
      return row!;
    },

    async revoke(grantId: string) {
      const rows = await db.delete(secretGrants).where(eq(secretGrants.id, grantId)).returning({ id: secretGrants.id });
      return rows.length > 0;
    },

    /** Who a secret is granted to, for the secrets screen. */
    async grantsForSecret(secretId: string) {
      return db
        .select({ id: secretGrants.id, envName: secretGrants.envName, companyId: secretGrants.companyId, company: companies.name, deployTargetId: secretGrants.deployTargetId, deployTarget: deployTargets.name })
        .from(secretGrants)
        .innerJoin(companies, eq(companies.id, secretGrants.companyId))
        .leftJoin(deployTargets, eq(deployTargets.id, secretGrants.deployTargetId))
        .where(eq(secretGrants.secretId, secretId))
        .orderBy(companies.name, secretGrants.envName);
    },

    /** Each time a run was given the secret, newest first. */
    async accessLog(secretId: string, limit = 100) {
      return db
        .select({ id: secretAccessLog.id, at: secretAccessLog.at, companyId: secretAccessLog.companyId, company: companies.name, runId: secretAccessLog.runId, purpose: secretAccessLog.purpose })
        .from(secretAccessLog)
        .leftJoin(companies, eq(companies.id, secretAccessLog.companyId))
        .where(eq(secretAccessLog.secretId, secretId))
        .orderBy(desc(secretAccessLog.at))
        .limit(limit);
    },

    async grantsForCompany(companyId: string) {
      return db
        .select({ id: secretGrants.id, envName: secretGrants.envName, deployTargetId: secretGrants.deployTargetId, secretId: secrets.id, secretName: secrets.name, hint: secrets.hint })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(eq(secretGrants.companyId, companyId))
        .orderBy(secretGrants.envName);
    },

    /**
     * The environment a company's runner gets for a run: every company-wide grant, plus the
     * grants of a deploy target when this run is carrying out an approved deploy to it (R14).
     * Each use is written to the access log.
     */
    async resolveCompanyEnv(companyId: string, purpose: string, runId?: string): Promise<Record<string, string>> {
      const targets = runId
        ? (await db.select({ id: deploys.targetId }).from(deploys).where(and(eq(deploys.runId, runId), eq(deploys.status, "running"), eq(deploys.companyId, companyId)))).map((d) => d.id)
        : [];
      const rows = await db
        .select({
          grantId: secretGrants.id,
          envName: secretGrants.envName,
          deployTargetId: secretGrants.deployTargetId,
          secretId: secrets.id,
          ciphertext: secrets.ciphertext,
          wrappedKey: secrets.wrappedKey,
        })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(and(eq(secretGrants.companyId, companyId), targets.length ? or(isNull(secretGrants.deployTargetId), inArray(secretGrants.deployTargetId, targets)) : isNull(secretGrants.deployTargetId)));
      const env: Record<string, string> = {};
      for (const r of rows) env[r.envName] = decryptSecret(master, r);
      if (rows.length > 0) {
        await db.insert(secretAccessLog).values(
          rows.map((r) => ({ grantId: r.grantId, secretId: r.secretId, companyId, runId: runId ?? null, purpose: r.deployTargetId ? "deploy" : purpose })),
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
