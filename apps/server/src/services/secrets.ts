import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { checkSecretFormat, normaliseSecret, secretHint, type SecretKind } from "@boss-man/shared";
import { decryptSecret, encryptSecret, type MasterKey } from "../crypto.js";
import type { Db } from "../db/client.js";
import { agents, companies, deploys, deployTargets, fundingSources, runs, secretAccessLog, secretGrantAgents, secretGrants, secrets } from "../db/schema.js";

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

/** Env names only the server may read, and the one purpose that may read them. Agent runs and runner jobs never get them. */
const SERVER_ONLY_ENV_NAMES = new Set(["GITHUB_WATCH_TOKEN"]);
const SERVER_ONLY_PURPOSES = new Set(["github_watch"]);

/** Told which company grants changed (granted, revoked, re-valued or deleted with their secret), by env name. */
export type GrantChangeListener = (change: { companyId: string; envName: string }) => void;

export function secretsService(db: Db, master: MasterKey, live?: LiveValidator) {
  // BOS-1582: the network guard opens the address in a company's PENPOT_URL grant, so it must hear when that grant or its
  // value changes, from whichever route made the change (the Secrets page, the Penpot form, a grant revoke).
  const listeners: GrantChangeListener[] = [];
  const changed = (rows: { companyId: string; envName: string }[]) => {
    for (const r of rows) for (const l of listeners) l({ companyId: r.companyId, envName: r.envName });
  };
  const grantsOf = (secretId: string) => db.select({ companyId: secretGrants.companyId, envName: secretGrants.envName }).from(secretGrants).where(eq(secretGrants.secretId, secretId));
  /** grantId -> the agents it is limited to; a grant missing from the map goes to every agent. */
  const agentsByGrant = async (grantIds: string[]) => {
    const map = new Map<string, string[]>();
    if (!grantIds.length) return map;
    for (const r of await db.select().from(secretGrantAgents).where(inArray(secretGrantAgents.grantId, grantIds))) map.set(r.grantId, [...(map.get(r.grantId) ?? []), r.agentId]);
    return map;
  };

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
      changed(await grantsOf(id));
      return { secret: row!, warnings, verified };
    },

    /** Checks a value without saving it: its format, then the provider when Boss Man can ask one (R58). */
    async check(kind: SecretKind, raw: string) {
      const value = normaliseSecret(kind, raw);
      const format = checkSecretFormat(kind, value);
      return { problems: format.problems, live: live ? await live(kind, value) : null };
    },

    /** Asks the provider about a saved value again, e.g. after it may have been revoked. */
    async checkStored(id: string) {
      const [row] = await db.select().from(secrets).where(eq(secrets.id, id));
      if (!row) return null;
      return { live: live ? await live(row.kind as SecretKind, decryptSecret(master, row)) : null };
    },

    async remove(id: string) {
      // Read the grants first: deleting the secret cascades them away.
      const grants = await grantsOf(id);
      const rows = await db.delete(secrets).where(eq(secrets.id, id)).returning({ id: secrets.id });
      if (rows.length) changed(grants);
      return rows.length > 0;
    },

    /** Hears every grant change (see GrantChangeListener). */
    onGrantChange(listener: GrantChangeListener) {
      listeners.push(listener);
    },

    /**
     * The value of the company's company-wide grant under this env name, for the server's own use (BOS-1582: the network
     * guard reads PENPOT_URL to open Penpot's host:port). Not a run's access, so not written to the access log; never sent
     * to a client. Null when there is no such grant.
     */
    async grantedValue(companyId: string, envName: string): Promise<string | null> {
      const [row] = await db
        .select({ ciphertext: secrets.ciphertext, wrappedKey: secrets.wrappedKey })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(and(eq(secretGrants.companyId, companyId), eq(secretGrants.envName, envName), isNull(secretGrants.deployTargetId)));
      return row ? decryptSecret(master, row) : null;
    },

    /** A grant tied to a deploy target is only handed to runs carrying out an approved deploy there. */
    async grant(secretId: string, companyId: string, envName: string, deployTargetId?: string) {
      if (deployTargetId) {
        const [t] = await db.select({ id: deployTargets.id }).from(deployTargets).where(and(eq(deployTargets.id, deployTargetId), eq(deployTargets.companyId, companyId)));
        if (!t) throw new Error("That deploy target isn't in this company.");
      }
      const [row] = await db.insert(secretGrants).values({ secretId, companyId, envName, deployTargetId: deployTargetId ?? null }).returning();
      changed([row!]);
      return row!;
    },

    async revoke(grantId: string) {
      const rows = await db.delete(secretGrants).where(eq(secretGrants.id, grantId)).returning({ id: secretGrants.id, companyId: secretGrants.companyId, envName: secretGrants.envName });
      changed(rows);
      return rows.length > 0;
    },

    /** A secret's value, for the server's own use (e.g. its ntfy token). Never sent to a client. */
    async reveal(secretId: string): Promise<string | null> {
      const [row] = await db.select().from(secrets).where(eq(secrets.id, secretId));
      return row ? decryptSecret(master, row) : null;
    },

    /** Who a secret is granted to, for the secrets screen. */
    async grantsForSecret(secretId: string) {
      const rows = await db
        .select({ id: secretGrants.id, envName: secretGrants.envName, companyId: secretGrants.companyId, company: companies.name, deployTargetId: secretGrants.deployTargetId, deployTarget: deployTargets.name })
        .from(secretGrants)
        .innerJoin(companies, eq(companies.id, secretGrants.companyId))
        .leftJoin(deployTargets, eq(deployTargets.id, secretGrants.deployTargetId))
        .where(eq(secretGrants.secretId, secretId))
        .orderBy(companies.name, secretGrants.envName);
      const limited = await agentsByGrant(rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, agentIds: limited.get(r.id) ?? [] }));
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
      const rows = await db
        .select({ id: secretGrants.id, envName: secretGrants.envName, deployTargetId: secretGrants.deployTargetId, secretId: secrets.id, secretName: secrets.name, hint: secrets.hint })
        .from(secretGrants)
        .innerJoin(secrets, eq(secrets.id, secretGrants.secretId))
        .where(eq(secretGrants.companyId, companyId))
        .orderBy(secretGrants.envName);
      const limited = await agentsByGrant(rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, agentIds: limited.get(r.id) ?? [] }));
    },

    /** Limits a grant to these agents of its company; none means every agent. Refuses an unknown grant or an agent from another company. */
    async setGrantAgents(grantId: string, agentIds: string[]): Promise<{ ok: true } | { ok: false; reason: "not_found" | "foreign_agent" }> {
      const [grant] = await db.select({ companyId: secretGrants.companyId }).from(secretGrants).where(eq(secretGrants.id, grantId));
      if (!grant) return { ok: false, reason: "not_found" };
      const ids = [...new Set(agentIds)];
      if (ids.length) {
        const mine = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, grant.companyId), inArray(agents.id, ids)));
        if (mine.length !== ids.length) return { ok: false, reason: "foreign_agent" };
      }
      await db.transaction(async (tx) => {
        await tx.delete(secretGrantAgents).where(eq(secretGrantAgents.grantId, grantId));
        if (ids.length) await tx.insert(secretGrantAgents).values(ids.map((agentId) => ({ grantId, agentId })));
      });
      return { ok: true };
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
      // Company-level jobs (merge, check, pull request) have no run and so no agent: they keep every company grant.
      const [run] = runId ? await db.select({ agentId: runs.agentId }).from(runs).where(and(eq(runs.id, runId), eq(runs.companyId, companyId))) : [];
      const limited = await agentsByGrant(rows.map((r) => r.grantId));
      const granted = runId ? rows.filter((r) => !limited.has(r.grantId) || (!!run?.agentId && limited.get(r.grantId)!.includes(run.agentId))) : rows;
      // Server-only grants (the GitHub watcher's token) go to the server job that reads them and to no runner job or agent run (BOS-1450).
      const visible = granted.filter((r) => !SERVER_ONLY_ENV_NAMES.has(r.envName) || SERVER_ONLY_PURPOSES.has(purpose));
      const env: Record<string, string> = {};
      for (const r of visible) env[r.envName] = decryptSecret(master, r);
      // A run the scheduler placed on one of the owner's Claude subscriptions carries that account's login instead of the company's default (BOS-383). Never logged; sent only to the runner.
      const [chosen] = runId
        ? await db
            .select({ id: secrets.id, ciphertext: secrets.ciphertext, wrappedKey: secrets.wrappedKey })
            .from(runs)
            .innerJoin(fundingSources, eq(fundingSources.id, runs.fundingSourceId))
            .innerJoin(secrets, eq(secrets.id, fundingSources.secretId))
            .where(and(eq(runs.id, runId), eq(runs.companyId, companyId), eq(fundingSources.provider, "anthropic"), eq(fundingSources.kind, "subscription")))
        : [];
      if (chosen) {
        env.CLAUDE_CODE_OAUTH_TOKEN = decryptSecret(master, chosen);
        await db.insert(secretAccessLog).values({ grantId: null, secretId: chosen.id, companyId, runId: runId ?? null, purpose: "claude_account" });
      }
      if (visible.length > 0) {
        await db.insert(secretAccessLog).values(
          visible.map((r) => ({ grantId: r.grantId, secretId: r.secretId, companyId, runId: runId ?? null, purpose: r.deployTargetId ? "deploy" : purpose })),
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
