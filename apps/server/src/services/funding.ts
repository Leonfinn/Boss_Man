import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import {
  budgetStatus,
  creditStatus,
  dateIn,
  forecastQuota,
  parseClaudeRateLimit,
  parseCodexRateLimits,
  type BudgetWindow,
  type QuotaSample,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, budgetPolicies, costEvents, fundingSources, quotaSamples, runs } from "../db/schema.js";

type FundingRow = typeof fundingSources.$inferSelect;
type PolicyRow = typeof budgetPolicies.$inferSelect;

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

export function fundingService(db: Db) {
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
        daily: await this.daily(id, now, timeZone),
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

