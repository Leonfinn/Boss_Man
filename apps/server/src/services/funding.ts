import { and, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import {
  budgetStatus,
  creditStatus,
  dateIn,
  forecastQuota,
  parseClaudeRateLimit,
  parseCodexRateLimits,
  parseSyntheticQuota,
  type BudgetWindow,
  type QuotaSample,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, budgetPolicies, companies, costEvents, fundingSources, quotaSamples, runs, secretGrants } from "../db/schema.js";

type FundingRow = typeof fundingSources.$inferSelect;
type PolicyRow = typeof budgetPolicies.$inferSelect;
/** Used and limit for a provider's own quota endpoint; null used/limit means the reading is unknown. */
export type ProviderQuota = { used: number | null; limit: number | null; renewsAt: string | null };

type FundingDeps = { reveal?: (secretId: string) => Promise<string | null>; fetch?: typeof fetch };

function toWindow(p: PolicyRow, source: FundingRow | undefined): BudgetWindow {
  switch (p.windowKind) {
    case "lifetime":
      return { kind: "lifetime" };
    case "calendar_month":
      return { kind: "calendar_month" };
    case "rolling_days":
      return { kind: "rolling_days", days: p.rollingDays ?? 30 };
    case "billing_cycle":
      // A billing-cycle budget follows its funding source's cycle; without one it falls back to calendar months.
      return source?.cycleAnchor ? { kind: "billing_cycle", anchor: source.cycleAnchor } : { kind: "calendar_month" };
  }
}

export function fundingService(db: Db, deps: FundingDeps = {}) {
  const http = deps.fetch ?? fetch;
  const unknown: ProviderQuota = { used: null, limit: null, renewsAt: null };

  async function fetchProviderQuota(source: FundingRow): Promise<ProviderQuota | null> {
    if (source.provider !== "synthetic") return null;
    // A failed or missing reading is unknown, never an error: it must not block a run.
    if (!deps.reveal) return unknown;
    try {
      // A Synthetic source usually has no secret attached; the key is the one granted to the
      // company as SYNTHETIC_API_KEY from Settings > Secrets.
      const [granted] = source.secretId
        ? [{ secretId: source.secretId }]
        : await db.select({ secretId: secretGrants.secretId }).from(secretGrants).where(eq(secretGrants.envName, "SYNTHETIC_API_KEY"));
      const key = granted ? await deps.reveal(granted.secretId) : null;
      if (!key) return unknown;
      // Synthetic's quota endpoint is free and doesn't count against the plan's limits.
      const res = await http("https://api.synthetic.new/v2/quotas", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return unknown;
      const q = parseSyntheticQuota(await res.json());
      return q ? { used: q.used, limit: q.limit, renewsAt: q.renewsAt?.toISOString() ?? null } : unknown;
    } catch {
      // Never log the request or the key: a quota failure only leaves the reading unknown.
      return unknown;
    }
  }

  async function spendFor(where: SQL | undefined) {
    return db.select({ occurredAt: costEvents.occurredAt, costMicros: costEvents.costMicros }).from(costEvents).where(where);
  }

  async function latestQuota(fundingSourceId: string) {
    // The newest sample per window.
    const rows = await db
      .selectDistinctOn([quotaSamples.window])
      .from(quotaSamples)
      .where(eq(quotaSamples.fundingSourceId, fundingSourceId))
      .orderBy(quotaSamples.window, desc(quotaSamples.observedAt));
    return rows;
  }

  return {
    async create(input: typeof fundingSources.$inferInsert) {
      const [row] = await db.insert(fundingSources).values(input).returning();
      return row!;
    },

    async update(id: string, patch: Partial<typeof fundingSources.$inferInsert>) {
      const [row] = await db.update(fundingSources).set(patch).where(eq(fundingSources.id, id)).returning();
      return row!;
    },

    /** Deletes a source with no history; agents on it fall back to none. Null: unknown id. */
    async remove(id: string) {
      const [source] = await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.id, id));
      if (!source) return null;
      // Both tables cascade, so deleting would silently erase them.
      const [costs] = await db.select({ n: count() }).from(costEvents).where(eq(costEvents.fundingSourceId, id));
      const [samples] = await db.select({ n: count() }).from(quotaSamples).where(eq(quotaSamples.fundingSourceId, id));
      if (costs!.n + samples!.n > 0) return "has_history" as const;
      const [agentsOn] = await db.select({ n: count() }).from(agents).where(eq(agents.fundingSourceId, id));
      await db.delete(fundingSources).where(eq(fundingSources.id, id));
      return { agentsUnlinked: agentsOn!.n };
    },

    async list() {
      return db.select().from(fundingSources).orderBy(fundingSources.name);
    },

    async status(id: string, now = new Date(), timeZone = "Europe/London") {
      const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, id));
      if (!source) return null;
      const events = await spendFor(eq(costEvents.fundingSourceId, id));
      const credit =
        source.kind === "api_credit" && source.monthlyGrantMicros != null && source.cycleAnchor
          ? creditStatus({ grantMicros: source.monthlyGrantMicros, anchor: source.cycleAnchor }, events, now)
          : null;
      const quota = source.kind === "subscription" ? await latestQuota(id) : [];
      // When each window runs out at the recent rate (R78).
      const recent = quota.length ? await db.select().from(quotaSamples).where(and(eq(quotaSamples.fundingSourceId, id), gte(quotaSamples.observedAt, new Date(now.getTime() - 3 * 3_600_000)))) : [];
      const forecasts = Object.fromEntries(quota.map((q) => [q.window, forecastQuota(recent.filter((r) => r.window === q.window), now)]));
      return {
        source,
        credit,
        quota,
        forecasts,
        /** Synthetic's own used/limit reading; null for other providers. */
        providerQuota: await fetchProviderQuota(source),
        daily: await this.daily(id, now, timeZone),
        byCompany: await this.byCompany(id, now),
        totalSpentMicros: events.reduce((s, e) => s + e.costMicros, 0),
        // Boss Man only sees its own runs (spike S3: no Admin API on individual accounts).
        coverage: "boss_man_runs_only" as const,
      };
    },

    /**
     * Use per day for the last 7 days, oldest first (R78): tokens for runs paid from this source
     * (a subscription's real measure) and the money its cost events add up to. Days are the
     * owner's local days (e.g. BST in a UK summer), since that's how Claude's limits are shown.
     */
    async daily(id: string, now = new Date(), timeZone = "Europe/London", days = 7) {
      // Calendar dates in that zone; 8 days back covers the oldest one whatever the offset.
      const [y, m, d] = dateIn(now, timeZone).split("-").map(Number) as [number, number, number];
      const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
      const since = new Date(now.getTime() - (days + 1) * 86_400_000);
      const runsHere = await db
        .select({ startedAt: runs.startedAt, input: runs.inputTokens, output: runs.outputTokens })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(and(gte(runs.startedAt, since), sql`(${runs.id} in (select ${costEvents.runId} from ${costEvents} where ${costEvents.fundingSourceId} = ${id} and ${costEvents.runId} is not null) or ${agents.fundingSourceId} = ${id})`));
      const money = await db.select({ occurredAt: costEvents.occurredAt, costMicros: costEvents.costMicros }).from(costEvents).where(and(eq(costEvents.fundingSourceId, id), gte(costEvents.occurredAt, since)));
      const day = (at: Date) => dateIn(at, timeZone);
      return dates.map((d) => {
        const on = runsHere.filter((r) => day(r.startedAt) === d);
        return {
          day: d,
          runs: on.length,
          inputTokens: on.reduce((n, r) => n + (r.input ?? 0), 0),
          outputTokens: on.reduce((n, r) => n + (r.output ?? 0), 0),
          costMicros: money.filter((m) => day(m.occurredAt) === d).reduce((n, m) => n + m.costMicros, 0),
        };
      });
    },

    /**
     * This source's use over the last 7 days, per company: runs and tokens (a subscription's measure)
     * and money from its cost events. The company is the one whose agent did the work.
     */
    async byCompany(id: string, now = new Date(), days = 7) {
      const since = new Date(now.getTime() - days * 86_400_000);
      const used = await db
        .select({ companyId: runs.companyId, runs: count(), input: sql<number>`coalesce(sum(${runs.inputTokens}), 0)`, output: sql<number>`coalesce(sum(${runs.outputTokens}), 0)` })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .where(and(gte(runs.startedAt, since), sql`(${runs.id} in (select ${costEvents.runId} from ${costEvents} where ${costEvents.fundingSourceId} = ${id} and ${costEvents.runId} is not null) or ${agents.fundingSourceId} = ${id})`))
        .groupBy(runs.companyId);
      const money = await db
        .select({ companyId: costEvents.companyId, micros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)` })
        .from(costEvents)
        .where(and(eq(costEvents.fundingSourceId, id), gte(costEvents.occurredAt, since)))
        .groupBy(costEvents.companyId);
      const ids = [...new Set([...used.map((u) => u.companyId), ...money.map((m) => m.companyId)])];
      const names = ids.length ? await db.select({ id: companies.id, name: companies.name }).from(companies) : [];
      return ids
        .map((companyId) => {
          const u = used.find((x) => x.companyId === companyId);
          return {
            companyId,
            name: names.find((n) => n.id === companyId)?.name ?? "Deleted company",
            runs: Number(u?.runs ?? 0),
            tokens: Number(u?.input ?? 0) + Number(u?.output ?? 0),
            costMicros: Number(money.find((m) => m.companyId === companyId)?.micros ?? 0),
          };
        })
        .sort((a, b) => b.costMicros - a.costMicros || b.tokens - a.tokens);
    },

    async recordCost(input: typeof costEvents.$inferInsert) {
      const [row] = await db.insert(costEvents).values(input).returning();
      return row!;
    },

    async recordQuota(fundingSourceId: string, samples: QuotaSample[], observedAt = new Date()) {
      if (samples.length === 0) return [];
      return db
        .insert(quotaSamples)
        .values(
          samples.map((s) => ({
            fundingSourceId,
            window: s.window,
            utilization: s.utilization,
            resetsAt: s.resetsAt,
            status: s.status,
            overageInUse: s.overageInUse,
            observedAt,
          })),
        )
        .returning();
    },

    /** Raw adapter payloads straight from the runner. */
    async recordQuotaFromAdapter(fundingSourceId: string, payload: { claudeMeta?: unknown; codexRateLimits?: unknown }) {
      const samples = [...parseClaudeRateLimit(payload.claudeMeta), ...parseCodexRateLimits(payload.codexRateLimits)];
      return this.recordQuota(fundingSourceId, samples);
    },

    async createPolicy(input: typeof budgetPolicies.$inferInsert) {
      const [row] = await db.insert(budgetPolicies).values(input).returning();
      return row!;
    },

    async budgetStatuses(now = new Date()) {
      const policies = await db.select().from(budgetPolicies).orderBy(budgetPolicies.createdAt);
      const sources = new Map((await db.select().from(fundingSources)).map((s) => [s.id, s]));
      const out = [];
      for (const p of policies) {
        // Engagement charge-back (R26): spend counts against the company and project it was charged to.
        const scope =
          p.scopeKind === "instance"
            ? sql`true`
            : p.scopeKind === "company"
            ? sql`coalesce(${costEvents.chargedCompanyId}, ${costEvents.companyId}) = ${p.scopeId}`
            : p.scopeKind === "project"
              ? sql`coalesce(${costEvents.chargedProjectId}, ${costEvents.projectId}) = ${p.scopeId}`
              : eq(costEvents.agentId, p.scopeId);
        const where = p.fundingSourceId ? and(scope, eq(costEvents.fundingSourceId, p.fundingSourceId)) : scope;
        const events = await spendFor(where);
        const source = p.fundingSourceId ? sources.get(p.fundingSourceId) : undefined;
        out.push({
          policy: p,
          status: budgetStatus({ limitMicros: p.limitMicros, window: toWindow(p, source), onLimit: p.onLimit, warnAt: p.warnAt }, events, now),
        });
      }
      return out;
    },
  };
}

