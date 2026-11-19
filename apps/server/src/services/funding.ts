import { and, count, desc, eq, gte, lt, notInArray, sql, type SQL } from "drizzle-orm";
import {
  billingCycle,
  boundsAsEpoch,
  budgetStatus,
  creditStatus,
  dateIn,
  currentReportSamples,
  forecastQuota,
  FORECAST_WINDOW_MS,
  formatDate,
  parseClaudeRateLimit,
  parseCodexRateLimits,
  parseSyntheticQuota,
  windowBounds,
  type BudgetWindow,
  type QuotaSample,
  type SyntheticQuota,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, budgetPolicies, companies, costEvents, fundingSources, providerQuotaReadings, providerQuotaWarnings, quotaSamples, runs, secretGrants, settings } from "../db/schema.js";

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
/**
 * How long a Synthetic reading keeps counting towards the quota hold when no newer one comes (BOS-852):
 * three refreshes, so one missed sweep doesn't drop a hold, but an outage at Synthetic can't hold the plan
 * on an old reading for long (an unknown reading never blocks a run).
 */
export const SYNTHETIC_HOLD_SAMPLE_MS = 3 * 5 * 60_000;
/** The quota_samples windows a Synthetic reading is fed into, so the scheduler's hold sees it (BOS-852). */
export const SYNTHETIC_WINDOWS = { weekly: "synthetic_weekly", requests: "synthetic_requests" } as const;
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
/** The warning key for "the weekly allowance is used up and work now draws on top-up credit" (BOS-934). */
export const TOP_UP_NOTICE = 100;

/**
 * Whether work on a Synthetic plan keeps running once its reading reaches 100%, so Synthetic spends
 * the account's top-up credit (BOS-934): the owner chose "keep urgent" or "keep all work" under
 * "I have top-up credit", switched the reading off as a hold trigger, or the plan isn't a subscription
 * (the scheduler holds subscriptions only).
 */
function carriesOnPastLimit(source: FundingRow, measure: "weekly" | "requests") {
  return source.kind !== "subscription" || source.quotaOverage !== "pause" || (source.quotaDisabledWindows ?? []).includes(SYNTHETIC_WINDOWS[measure]);
}

/**
 * What the scheduler will do about this Synthetic reading, in the owner's words, for the warnings. They
 * used to say "Boss Man won't pause any runs", which stopped being true when BOS-852 fed the reading
 * into the hold.
 */
function holdWords(source: FundingRow, measure: "weekly" | "requests") {
  const off = source.kind !== "subscription" || (source.quotaDisabledWindows ?? []).includes(SYNTHETIC_WINDOWS[measure]);
  if (off || source.quotaOverage === "all")
    return "Boss Man won't pause runs for it (your Funding page settings), so once it's used up Synthetic draws on any top-up credit the account has.";
  const at = Math.round((source.quotaHoldAt ?? 0.95) * 100);
  return source.quotaOverage === "urgent"
    ? `Boss Man pauses routine work at ${at}%. Chats and reviews keep running, and urgent tickets carry on past the limit on any top-up credit.`
    : `Boss Man pauses routine work at ${at}%. Chats and reviews keep running, and urgent tickets run until the limit. Infinite-mode agents are never paused.`;
}

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

  /**
   * Feeds a good Synthetic reading into quota_samples, the only table the scheduler's quota hold reads
   * (BOS-852), so a Synthetic plan is held at its hold level like a Claude one (Infinite-mode agents stay
   * exempt in the scheduler). resetsAt is the renewal (for weekly credits the next regeneration, which is
   * when the share used drops), but never less than SYNTHETIC_HOLD_SAMPLE_MS after the reading: each
   * 5-minute refresh then replaces the sample before it lapses, and when Synthetic stops answering the
   * hold lifts on its own instead of sticking on a stale number. An unchanged reading moves the newest
   * row forward instead of adding one, so the table only grows when usage changes.
   */
  async function holdSample(fundingSourceId: string, q: ProviderQuota, takenAt: Date) {
    if (q.used === null || q.limit === null || q.limit <= 0) return;
    const window = SYNTHETIC_WINDOWS[q.measure];
    const utilization = q.used / q.limit;
    const renews = q.renewsAt ? Date.parse(q.renewsAt) : NaN;
    const resetsAt = new Date(Math.max(Number.isNaN(renews) ? 0 : renews, takenAt.getTime() + SYNTHETIC_HOLD_SAMPLE_MS));
    const [last] = await db
      .select({ id: quotaSamples.id, utilization: quotaSamples.utilization })
      .from(quotaSamples)
      .where(and(eq(quotaSamples.fundingSourceId, fundingSourceId), eq(quotaSamples.window, window)))
      .orderBy(desc(quotaSamples.observedAt))
      .limit(1);
    // utilization is a 4-byte real, so it never reads back exactly equal to the JS number.
    if (last && Math.abs(last.utilization - utilization) < 1e-6) await db.update(quotaSamples).set({ observedAt: takenAt, resetsAt }).where(eq(quotaSamples.id, last.id));
    else await db.insert(quotaSamples).values({ fundingSourceId, window, utilization, resetsAt, observedAt: takenAt });
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
        await holdSample(source.id, q, takenAt);
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
        ? `${formatDate("en-GB", new Date(iso), { weekday: "short", day: "numeric", month: "short", timeZone })} at ${formatDate("en-GB", new Date(iso), { hour: "2-digit", minute: "2-digit", timeZone })}`
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
        ? `About ${usedPercent}% of this week's credits are used, ${leftPercent}% left. Credits come back 2% at a time${regenAt ? ` (next about ${when(regenAt)})` : ""}. Paid from it: ${who}. ${holdWords(source, view.measure)}`
        : `${view.used.toLocaleString()} of ${view.limit.toLocaleString()} requests used (${Math.round(percent)}%). It renews ${when(view.renewsAt)}. Paid from it: ${who}. ${holdWords(source, view.measure)}`;
      try {
        await notify({ title, body });
      } catch {
        // The warning never reached the owner: drop the row so the next reading tries again.
        await db.delete(providerQuotaWarnings).where(and(eq(providerQuotaWarnings.fundingSourceId, source.id), eq(providerQuotaWarnings.period, period), eq(providerQuotaWarnings.threshold, threshold)));
        continue;
      }
      sent.push(threshold);
    }
    // Once the allowance is used up and the owner lets work carry on, Synthetic spends the account's
    // paid top-up credit (BOS-934). Synthetic doesn't report that balance, so this once-a-week note is
    // the nearest Boss Man can get to "warn when it runs low". Kept under its own key, 100, so it never
    // displaces the 60/80/92 points; an account held at the limit (the default) never gets it.
    if (weekly && percent >= 100 && carriesOnPastLimit(source, view.measure)) {
      const told = await db.insert(providerQuotaWarnings).values({ fundingSourceId: source.id, period, threshold: TOP_UP_NOTICE, warnedAt: now() }).onConflictDoNothing().returning();
      if (told.length) {
        const urgentOnly = source.kind === "subscription" && source.quotaOverage === "urgent" && !(source.quotaDisabledWindows ?? []).includes(SYNTHETIC_WINDOWS.weekly);
        try {
          await notify({
            title: `${source.name}: the weekly allowance is used up, so work now draws on top-up credit`,
            body: `${urgentOnly ? "Urgent tickets, chats and reviews on this plan keep" : "Work on this plan keeps"} running${regenAt ? ` (credits start coming back about ${when(regenAt)})` : ""}, paid from your Synthetic top-up credit. Synthetic doesn't tell Boss Man the balance, so check it at synthetic.new; when it runs out, Synthetic refuses the runs. To stop spending it, set "I have top-up credit" to hold on the Funding page.`,
          });
          sent.push(TOP_UP_NOTICE);
        } catch {
          await db.delete(providerQuotaWarnings).where(and(eq(providerQuotaWarnings.fundingSourceId, source.id), eq(providerQuotaWarnings.period, period), eq(providerQuotaWarnings.threshold, TOP_UP_NOTICE)));
        }
      }
    }
    return sent;
  }

  /**
   * What a scope spent: all of it, and inside each `[after, before)` range (epoch milliseconds, null
   * for no bound: `after` inclusive, `before` exclusive) asked for. One statement, so a source with
   * 50k cost events costs a scan of the `(funding_source_id, occurred_at)` index, not 50k rows read
   * into JS (BOS-671).
   */
  async function spendFor(where: SQL | undefined, ranges: Array<{ after: number | null; before: number | null }>) {
    const inRange = (r: { after: number | null; before: number | null }) =>
      and(
        r.after !== null ? gte(costEvents.occurredAt, new Date(r.after)) : undefined,
        r.before !== null ? lt(costEvents.occurredAt, new Date(r.before)) : undefined,
      );
    const sumExpr = sql`sum(${costEvents.costMicros})`;
    const sums: Record<string, SQL> = { total: sql<string>`coalesce(${sumExpr}, 0)::text` };
    ranges.forEach((r, i) => {
      const range = inRange(r);
      // An unbounded range is the all-time total; only a bounded one needs the filter. `filter` binds
      // to the aggregate itself, so it sits inside `coalesce` (before the zero fallback).
      sums[`r${i}`] = range
        ? sql<string>`coalesce(${sumExpr} filter (where ${range}), 0)::text`
        : sql<string>`coalesce(${sumExpr}, 0)::text`;
    });
    const [row] = await db.select(sums).from(costEvents).where(where);
    const total = Number(row?.total ?? 0);
    return { total, ranges: ranges.map((_, i) => Number(row?.[`r${i}`] ?? 0)) };
  }

  /**
   * How far back a forecast must read a window's samples to see the whole window so far: a day
   * (FORECAST_WINDOW_MS), or longer when the window has more of it left than that (a week's reset).
   */
  function lookbackFor(quota: (typeof quotaSamples.$inferSelect)[], now: Date) {
    const left = Math.max(0, ...quota.filter((q) => q.resetsAt && q.resetsAt.getTime() > now.getTime()).map((q) => q.resetsAt!.getTime() - now.getTime()));
    return Math.max(FORECAST_WINDOW_MS, left);
  }

  async function latestQuota(source: typeof fundingSources.$inferSelect) {
    // The newest sample per window, limited to the windows the latest report included (BOS-1916).
    const rows = await db
      .selectDistinctOn([quotaSamples.window])
      .from(quotaSamples)
      .where(eq(quotaSamples.fundingSourceId, source.id))
      .orderBy(quotaSamples.window, desc(quotaSamples.observedAt));
    return source.provider === "synthetic" || !rows.length ? rows : currentReportSamples(rows);
  }

  /**
   * The latest reading per window and when each runs out at its own pace (R78, BOS-1012). The rate
   * averages over the whole window so far, or its last day, whichever is longer, so one busy hour
   * can't swing it; the lookback here is wider than that rate's floor so a window starting earlier
   * still has its first reading to average from.
   */
  async function quotaForecasts(source: typeof fundingSources.$inferSelect, now: Date) {
    const fundingSourceId = source.id;
    const quota = source.kind === "subscription" ? await latestQuota(source) : [];
    const since = new Date(now.getTime() - lookbackFor(quota, now));
    const recent = quota.length ? await db.select().from(quotaSamples).where(and(eq(quotaSamples.fundingSourceId, fundingSourceId), gte(quotaSamples.observedAt, since))) : [];
    return { quota, forecasts: Object.fromEntries(quota.map((q) => [q.window, forecastQuota(recent.filter((r) => r.window === q.window), now)])) };
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
      // Synthetic's hold samples (BOS-852) are copies of readings Synthetic still has, not history only Boss Man holds.
      const [samples] = await db
        .select({ n: count() })
        .from(quotaSamples)
        .where(and(eq(quotaSamples.fundingSourceId, id), notInArray(quotaSamples.window, Object.values(SYNTHETIC_WINDOWS))));
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
      // The credit card reads this cycle's spend; the window is known before any row is read.
      const cycle = source.kind === "api_credit" && source.monthlyGrantMicros != null && source.cycleAnchor ? billingCycle(source.cycleAnchor, now) : null;
      const spend = await spendFor(eq(costEvents.fundingSourceId, id), [boundsAsEpoch(cycle ?? { start: null, end: null })]);
      const credit =
        cycle && source.cycleAnchor && source.monthlyGrantMicros != null
          ? creditStatus({ grantMicros: source.monthlyGrantMicros, anchor: source.cycleAnchor }, [], now, spend.ranges[0])
          : null;
      const { quota, forecasts } = await quotaForecasts(source, now);
      // The window names the latest report includes, so the owner can switch each one on or off (BOS-227). A limit
      // the account stopped reporting leaves the list; its saved on/off choice stays in quotaDisabledWindows (BOS-1916).
      // Synthetic keeps every name it has fed in, as before.
      const windowsSeen = source.kind !== "subscription" ? [] : source.provider === "synthetic" ? [...new Set((await db.selectDistinct({ window: quotaSamples.window }).from(quotaSamples).where(eq(quotaSamples.fundingSourceId, id))).map((r) => r.window))].sort() : quota.map((q) => q.window).sort();
      return {
        source,
        credit,
        quota,
        windowsSeen,
        claudeActive: ((await db.select().from(settings).where(eq(settings.key, "claude-active-account")))[0]?.value ?? null) === id,
        forecasts,
        /** Synthetic's own used/limit reading, its age and its history; null for other providers. */
        providerQuota: await providerQuota(source),
        daily: await this.daily(id, now, timeZone),
        byCompany: await this.byCompany(id, now),
        totalSpentMicros: spend.total,
        // Boss Man only sees its own runs (spike S3: no Admin API on individual accounts).
        coverage: "boss_man_runs_only" as const,
      };
    },

    /**
     * Just the source and its window forecasts, for the quota alert on every `run.quota` event.
     * status() also adds up a week of runs and every cost event, which the alert never reads
     * (BOS-604/BOS-649 T1: that roll-up on each event was what froze the server).
     */
    async forecasts(id: string, now = new Date()) {
      const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, id));
      if (!source) return null;
      return { source, ...(await quotaForecasts(source, now)) };
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
      // One pass per row, not one per row per day (BOS-643: a week of runs froze the server).
      const byDay = new Map(dates.map((d) => [d, { day: d, runs: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 }]));
      for (const r of runsHere) {
        const b = byDay.get(dateIn(r.startedAt, timeZone));
        if (!b) continue;
        b.runs++;
        b.inputTokens += r.input ?? 0;
        b.outputTokens += r.output ?? 0;
      }
      for (const m of money) {
        const b = byDay.get(dateIn(m.occurredAt, timeZone));
        if (b) b.costMicros += m.costMicros;
      }
      return [...byDay.values()];
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

    async recordCost(input: typeof costEvents.$inferInsert, tx: Db = db) {
      const [row] = await tx.insert(costEvents).values(input).returning();
      return row!;
    },

    async recordQuota(fundingSourceId: string, samples: QuotaSample[], observedAt = new Date(), tx: Db = db) {
      if (samples.length === 0) return [];
      return tx
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
    async recordQuotaFromAdapter(fundingSourceId: string, payload: { claudeMeta?: unknown; codexRateLimits?: unknown }, tx: Db = db) {
      const samples = [...parseClaudeRateLimit(payload.claudeMeta), ...parseCodexRateLimits(payload.codexRateLimits)];
      return this.recordQuota(fundingSourceId, samples, new Date(), tx);
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
        const source = p.fundingSourceId ? sources.get(p.fundingSourceId) : undefined;
        const window = toWindow(p, source);
        const spend = await spendFor(where, [boundsAsEpoch(windowBounds(window, now))]);
        out.push({
          policy: p,
          status: budgetStatus({ limitMicros: p.limitMicros, window, onLimit: p.onLimit, warnAt: p.warnAt }, [], now, spend.ranges[0]),
        });
      }
      return out;
    },
  };
}

