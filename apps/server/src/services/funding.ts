import { and, count, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
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
  type SyntheticQuota,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, budgetPolicies, companies, costEvents, fundingSources, providerQuotaReadings, providerQuotaWarnings, quotaSamples, runs, secretGrants } from "../db/schema.js";

type FundingRow = typeof fundingSources.$inferSelect;
type PolicyRow = typeof budgetPolicies.$inferSelect;
/** Used and limit for a provider's own quota endpoint; null used/limit means the reading is unknown. */
export type ProviderQuota = { used: number | null; limit: number | null; renewsAt: string | null; measure: "weekly" | "requests" };

/**
 * The weekly plan's percentage-left reading is stored in the existing used/limit pair, so no new
 * columns and no migration: the week is 10,000 "units", used is the credits already spent and
 * limit is 10,000 (BOS-260). Readings taken at or above this limit were stored before that change
 * and are the old request window, not weekly credits.
 */
export const SYNTHETIC_WEEKLY_LIMIT = 10_000;

const weeklyReading = (q: Extract<SyntheticQuota, { weekly: unknown }>) => ({
  used: Math.round(((100 - q.weekly!.percentRemaining) / 100) * SYNTHETIC_WEEKLY_LIMIT),
  limit: SYNTHETIC_WEEKLY_LIMIT,
  // The warning period keys on the renewal, so a regeneration time that moves every reading would warn
  // again each time. The week is 49.9 ticks long, so the tick number names the same week all day.
  renewsAt: (q.weekly!.nextRegenAt ?? new Date()).toISOString(),
  measure: "weekly" as const,
});

/** How long the newest Synthetic reading is served before asking Synthetic again (BOS-239). */
export const PROVIDER_QUOTA_REFRESH_MS = 5 * 60_000;
/** Readings older than this are pruned; the history is for the trend, not forever (BOS-239). */
export const PROVIDER_QUOTA_HISTORY_MS = 30 * 86_400_000;
/** The newest readings returned as the trend, count and age. */
const PROVIDER_QUOTA_HISTORY = 20;
/**
 * The percentages of the weekly credits the owner hears about, each once per period (BOS-260):
 * credits come back 2% at a time, so these are the warning points the owner asked for.
 */
export const PROVIDER_QUOTA_THRESHOLDS = [60, 80, 92] as const;
/** The old request-window reading warned at these; kept only for accounts that report no weekly credits. */
export const PROVIDER_QUOTA_REQUEST_THRESHOLDS = [80, 100] as const;

/** Credits come back 2% every 202 minutes, so a week is about 49.9 of those ticks. */
const WEEKLY_REGEN_TICK_MS = 202 * 60_000;
const WEEKLY_REGEN_TICKS = 50;

/**
 * The key that groups warnings by renewal period, so the owner hears each threshold once per period
 * and again in the next. For the request window that is the renewal rounded down to the hour. For
 * weekly credits the time is the *next* regeneration, which moves every tick, so the key is which of
 * the week's (about 50) regeneration ticks it falls in, counted from the epoch: it stays the same all
 * week and changes when the week does.
 */
export function providerQuotaPeriod(renewsAt: string | null, weekly = false): string {
  if (!renewsAt) return "";
  const ms = Date.parse(renewsAt);
  if (Number.isNaN(ms)) return "";
  if (weekly) return `week-${Math.floor(ms / (WEEKLY_REGEN_TICK_MS * WEEKLY_REGEN_TICKS))}`;
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

export type ProviderQuotaView = {
  /** The current reading, or null counts when there is none and Synthetic couldn't be reached. */
  used: number | null;
  limit: number | null;
  renewsAt: string | null;
  /**
   * Which measure `used / limit` is: the plan's weekly credits (the real one, BOS-260) or the old
   * request window, which the plan often doesn't spend and must never be shown as total usage.
   */
  measure: "weekly" | "requests";
  /** Seconds since the reading was taken from Synthetic; null when there is no reading. */
  ageSeconds: number | null;
  history: Array<{ used: number; limit: number; renewsAt: string | null; takenAt: string }>;
  /** The warnings the owner has already had in this period (60, 80, 92 for weekly credits). */
  warned: number[];
};

/** Readings at or above this limit are the weekly credits stored in the used/limit pair (BOS-260). */
const isWeeklyReading = (limit: number) => limit >= SYNTHETIC_WEEKLY_LIMIT;

type FundingDeps = { reveal?: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; now?: () => Date };

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
  const now = deps.now ?? (() => new Date());
  const unknown: ProviderQuota = { used: null, limit: null, renewsAt: null, measure: "weekly" };
  /** A refresh already under way per source, so two loads at once ask Synthetic once.
   * shortcut: lost on restart, harmless because the stored reading survives and is read again after 5 minutes. */
  const refreshing = new Map<string, Promise<ProviderQuota | null>>();
  /** When a refresh last failed per source, so an outage isn't retried on every Funding load or
   * server_status: a failed call stores nothing, so without this each load would wait 10s again.
   * shortcut: lost on restart, harmless because a restart is a fresh reason to try once. */
  const lastFailed = new Map<string, number>();

  /** Don't re-ask Synthetic within this window after a failed call (BOS-239, review round 2). */
  const PROVIDER_QUOTA_FAIL_BACKOFF_MS = 60_000;

  /** One call to Synthetic; never throws and never logs the request or the key. */
  async function callProviderQuota(source: FundingRow): Promise<ProviderQuota> {
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
      if (!q) return unknown;
      // Weekly credits are what the plan spends; the request window is only a fallback when Synthetic
      // sends nothing weekly, so an account that doesn't spend it never reads a bare "0 of 500" (BOS-260).
      if (q.weekly) return weeklyReading(q);
      const r = q.requests!;
      return { used: r.used, limit: r.limit, renewsAt: r.renewsAt?.toISOString() ?? null, measure: "requests" };
    } catch {
      return unknown;
    }
  }

  /** The newest stored reading for a source (not counting renewals synthetic never sends). */
  async function newestReading(fundingSourceId: string) {
    const [row] = await db.select().from(providerQuotaReadings).where(eq(providerQuotaReadings.fundingSourceId, fundingSourceId)).orderBy(desc(providerQuotaReadings.takenAt)).limit(1);
    return row ?? null;
  }

  async function refreshProviderQuota(source: FundingRow): Promise<ProviderQuota | null> {
    if (source.provider !== "synthetic") return null;
    const running = refreshing.get(source.id);
    if (running) return running;
    const p = (async () => {
      const takenAt = now();
      const q = await callProviderQuota(source);
      // A failure keeps the last good reading: nothing new is stored, so the age shows how old it is.
      if (q.used !== null && q.limit !== null) {
        const previous = await newestReading(source.id);
        await db.insert(providerQuotaReadings).values({ fundingSourceId: source.id, used: q.used, limit: q.limit, renewsAt: q.renewsAt ? new Date(q.renewsAt) : null, takenAt });
        // Prune the history to the last 30 days (BOS-239).
        await db.delete(providerQuotaReadings).where(and(eq(providerQuotaReadings.fundingSourceId, source.id), lt(providerQuotaReadings.takenAt, new Date(takenAt.getTime() - PROVIDER_QUOTA_HISTORY_MS))));
        // Weekly credits move 2% at a time, so a refresh between ticks repeats the same point; drop the
        // older copy so the trend counts real changes, not how often the page was refreshed (BOS-260).
        if (previous && previous.used === q.used && previous.limit === q.limit) await db.delete(providerQuotaReadings).where(eq(providerQuotaReadings.id, previous.id));
        lastFailed.delete(source.id);
      } else {
        // Store nothing on failure, so remember the attempt: the next few loads reuse the old reading
        // instead of each waiting on Synthetic again (BOS-239, review round 2).
        lastFailed.set(source.id, takenAt.getTime());
      }
      return q;
    })().finally(() => refreshing.delete(source.id));
    refreshing.set(source.id, p);
    return p;
  }

  /**
   * The reading to show: the stored one when it's younger than the refresh interval, otherwise a
   * fresh one; and a failed refresh falls back to the last good reading, marked with its age.
   */
  async function providerQuota(source: FundingRow): Promise<ProviderQuotaView | null> {
    if (source.provider !== "synthetic") return null;
    const latest = await newestReading(source.id);
    const stale = !latest || now().getTime() - latest.takenAt.getTime() >= PROVIDER_QUOTA_REFRESH_MS;
    // During an outage, don't make every load wait on Synthetic again: reuse the old reading until
    // the backoff passes. With no reading to fall back on, still try, so the card turns known
    // again as soon as Synthetic answers (BOS-239, review round 2).
    const failedAt = lastFailed.get(source.id);
    const backingOff = !!latest && failedAt !== undefined && now().getTime() - failedAt < PROVIDER_QUOTA_FAIL_BACKOFF_MS;
    if (stale && !backingOff) await refreshProviderQuota(source);
    const at = await newestReading(source.id);
    if (!at) return { ...unknown, ageSeconds: null, history: [], warned: [] };
    const history = await db
      .select()
      .from(providerQuotaReadings)
      .where(eq(providerQuotaReadings.fundingSourceId, source.id))
      .orderBy(desc(providerQuotaReadings.takenAt))
      .limit(PROVIDER_QUOTA_HISTORY);
    const measure = isWeeklyReading(at.limit) ? ("weekly" as const) : ("requests" as const);
    const weekly = measure === "weekly";
    // On the weekly measure the renewal is the next regeneration, not when the plan ends, so it is
    // not "when it renews": the card says so in words instead of showing a time that would mislead.
    const renewsAt = weekly ? null : at.renewsAt?.toISOString() ?? null;
    const warned = await db
      .select({ threshold: providerQuotaWarnings.threshold })
      .from(providerQuotaWarnings)
      .where(and(eq(providerQuotaWarnings.fundingSourceId, source.id), eq(providerQuotaWarnings.period, providerQuotaPeriod(at.renewsAt?.toISOString() ?? null, weekly))));
    return {
      used: at.used,
      limit: at.limit,
      renewsAt,
      measure,
      ageSeconds: Math.max(0, Math.round((now().getTime() - at.takenAt.getTime()) / 1000)),
      history: history.map((h) => ({ used: h.used, limit: h.limit, renewsAt: h.renewsAt?.toISOString() ?? null, takenAt: h.takenAt.toISOString() })),
      warned: warned.map((w) => w.threshold).sort((a, b) => a - b),
    };
  }

  /**
   * Tell the owner once per period when the plan's weekly credits pass 60%, 80% and 92% used (BOS-260).
   * The period is the stored week, so the next week warns again; nothing is sent twice. On an account
   * that reports no weekly credits, the old request window warns at 80% and 100% as before.
   */
  async function providerQuotaNotices(source: FundingRow, notify: (n: { title: string; body: string }) => Promise<unknown>, timeZone = "Europe/London") {
    if (source.provider !== "synthetic") return [];
    const view = await providerQuota(source);
    if (!view || view.used === null || view.limit === null || view.limit <= 0) return [];
    const weekly = view.measure === "weekly";
    // The stored time is the next regeneration for weekly credits (it names the week), the renewal otherwise.
    const period = providerQuotaPeriod(view.history[0]?.renewsAt ?? view.renewsAt, weekly);
    const percent = (view.used / view.limit) * 100;
    const paid = await db.select({ name: agents.name, company: companies.name }).from(agents).innerJoin(companies, eq(companies.id, agents.companyId)).where(and(eq(agents.fundingSourceId, source.id), sql`${agents.retiredAt} is null`)).orderBy(agents.name);
    const when = (iso: string | null) =>
      iso
        ? `${new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone })} at ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })}`
        : "Synthetic doesn't say";
    // The card says "about X% used": the stored count is the percentage rounded to 0.01 points.
    const usedPercent = Math.floor(percent);
    const leftPercent = 100 - usedPercent;
    const regenAt = view.history[0]?.renewsAt ?? null;
    const thresholds = weekly ? PROVIDER_QUOTA_THRESHOLDS : PROVIDER_QUOTA_REQUEST_THRESHOLDS;
    const sent: number[] = [];
    for (const threshold of thresholds) {
      if (percent < threshold) continue;
      const told = await db.insert(providerQuotaWarnings).values({ fundingSourceId: source.id, period, threshold, warnedAt: now() }).onConflictDoNothing().returning();
      if (!told.length) continue;
      const who = paid.length ? paid.map((a) => `${a.name} (${a.company})`).join(", ") : "no agents right now";
      const title = weekly
        ? leftPercent <= 0
          ? `${source.name}: the weekly Synthetic credits are used up`
          : `${source.name}: about ${usedPercent}% of this week's Synthetic credits are used`
        : threshold >= 100
          ? `${source.name}: the Synthetic request allowance is used up`
          : `${source.name}: ${threshold}% of the Synthetic request allowance is used`;
      const body = weekly
        ? `About ${usedPercent}% of this week's credits are used, ${leftPercent}% left. Credits come back 2% at a time${regenAt ? ` (next about ${when(regenAt)})` : ""}. Paid from it: ${who}. Boss Man won't pause any runs; move less urgent work or wait for credits to come back.`
        : `${view.used.toLocaleString()} of ${view.limit.toLocaleString()} requests used (${Math.round(percent)}%). It renews ${when(view.renewsAt)}. Paid from it: ${who}. Boss Man won't pause any runs; move less urgent work or wait for the renewal.`;
      try {
        await notify({ title, body });
      } catch {
        // The warning never reached the owner: drop the row so the next reading tries again.
        await db.delete(providerQuotaWarnings).where(and(eq(providerQuotaWarnings.fundingSourceId, source.id), eq(providerQuotaWarnings.period, period), eq(providerQuotaWarnings.threshold, threshold)));
        continue;
      }
      sent.push(threshold);
    }
    return sent;
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
      // Every window name the adapter has reported, so the owner can switch each one on or off (BOS-227).
      const windowsSeen = source.kind === "subscription" ? [...new Set((await db.selectDistinct({ window: quotaSamples.window }).from(quotaSamples).where(eq(quotaSamples.fundingSourceId, id))).map((r) => r.window))].sort() : [];
      // When each window runs out at the recent rate (R78).
      const recent = quota.length ? await db.select().from(quotaSamples).where(and(eq(quotaSamples.fundingSourceId, id), gte(quotaSamples.observedAt, new Date(now.getTime() - 3 * 3_600_000)))) : [];
      const forecasts = Object.fromEntries(quota.map((q) => [q.window, forecastQuota(recent.filter((r) => r.window === q.window), now)]));
      return {
        source,
        credit,
        quota,
        windowsSeen,
        forecasts,
        /** Synthetic's own used/limit reading, its age and its history; null for other providers. */
        providerQuota: await providerQuota(source),
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

    /**
     * Refresh every Synthetic source's cached reading (a no-op within the 5-minute window), warn the
     * owner once per period at 80% and 100%, and prune old readings. `notify` is given the owner's
     * notification service; this never throws into the caller.
     */
    async refreshSynthetic(notify: (n: { title: string; body: string; level: "flag"; link: string }) => Promise<unknown>, timeZone?: string) {
      const sources = await db.select().from(fundingSources).where(eq(fundingSources.provider, "synthetic"));
      const out: Array<{ id: string; name: string; warned: number[] }> = [];
      for (const source of sources) {
        try {
          const warned = await providerQuotaNotices(source, (n) => notify({ ...n, level: "flag", link: "#/funding" }), timeZone);
          out.push({ id: source.id, name: source.name, warned });
        } catch {
          // A quota failure only leaves the reading stale; it never blocks anything.
        }
      }
      return out;
    },

    /**
     * What the CEO sees: every Synthetic source's reading, its age, history and warnings had (BOS-239).
     * The reading is the owner's own plan, so every company's CEO may see it; but agent names are
     * company-scoped (BOS-224): only the calling company's agents are named, and agents another
     * company runs on the same plan are counted, not named.
     */
    async syntheticUsage(companyId: string) {
      const sources = await db.select().from(fundingSources).where(eq(fundingSources.provider, "synthetic")).orderBy(fundingSources.name);
      const out = [];
      for (const source of sources) {
        const reading = await providerQuota(source);
        const paid = await db
          .select({ name: agents.name, company: companies.name, companyId: agents.companyId, model: agents.model })
          .from(agents)
          .innerJoin(companies, eq(companies.id, agents.companyId))
          .where(and(eq(agents.fundingSourceId, source.id), sql`${agents.retiredAt} is null`))
          .orderBy(agents.name);
        const mine = paid.filter((a) => a.companyId === companyId);
        out.push({
          fundingSourceId: source.id,
          name: source.name,
          reading,
          agents: mine.map((a) => ({ name: a.name, model: a.model })),
          // Agents outside this company on the same plan: counted, never named.
          otherCompaniesAgents: paid.length - mine.length,
        });
      }
      return out;
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

