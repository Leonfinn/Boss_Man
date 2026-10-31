// Parsers for subscription quota data reported by the agent adapters.
//
// Claude: `usage_update._meta["_claude/rateLimit"]` from claude-agent-acp (an adapter
// extension, not ACP spec; observed in spike S2). Codex: the app-server's
// `account/rateLimits/read` response (seen in openai/codex source; not yet run live).
import { usdToMicros } from "./billing.js";

export type QuotaWindow = "five_hour" | "seven_day" | (string & {});

export type QuotaSample = {
  provider: "anthropic" | "openai";
  window: QuotaWindow;
  /** 0..1. */
  utilization: number;
  resetsAt: Date | null;
  /** Provider-specific status, e.g. "allowed" or "rejected". */
  status: string | null;
  overageInUse: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Unix seconds, unix milliseconds or an ISO string. */
export function toDate(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Utilisation as a 0..1 fraction. Spike S2 saw `1` while the week was at 100% and
 * "rejected", so the adapter reports a fraction; a value above 1.5 is taken as a percentage.
 * The scale still needs confirming with a reading below 100%.
 */
export function normaliseUtilization(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const f = v > 1.5 ? v / 100 : v;
  return Math.min(f, 1);
}

export function parseClaudeRateLimit(meta: unknown): QuotaSample[] {
  if (!isRecord(meta)) return [];
  const rl = meta["_claude/rateLimit"];
  if (!isRecord(rl)) return [];
  const windows = rl["unifiedWindows"];
  const status = typeof rl["status"] === "string" ? rl["status"] : null;
  const overageInUse = rl["overageInUse"] === true || rl["isUsingOverage"] === true;
  const limitedWindow = typeof rl["rateLimitType"] === "string" ? rl["rateLimitType"] : null;
  if (!isRecord(windows)) return [];
  const out: QuotaSample[] = [];
  for (const [name, w] of Object.entries(windows)) {
    if (!isRecord(w)) continue;
    const utilization = normaliseUtilization(w["utilization"]);
    if (utilization === null) continue;
    out.push({
      provider: "anthropic",
      window: name,
      utilization,
      resetsAt: toDate(w["resetsAt"]),
      // The top-level status describes the window named by rateLimitType.
      status: name === limitedWindow ? status : null,
      overageInUse,
    });
  }
  return out;
}

export function parseCodexRateLimits(resp: unknown): QuotaSample[] {
  if (!isRecord(resp)) return [];
  const root = isRecord(resp["rateLimits"]) ? resp["rateLimits"] : resp;
  const out: QuotaSample[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = root[key];
    if (!isRecord(w)) continue;
    const utilization = normaliseUtilization(typeof w["usedPercent"] === "number" ? w["usedPercent"] / 100 : null);
    if (utilization === null) continue;
    const mins = typeof w["windowDurationMins"] === "number" ? w["windowDurationMins"] : null;
    out.push({
      provider: "openai",
      window: mins === 300 ? "five_hour" : mins === 10080 ? "seven_day" : mins ? `${mins}_min` : key,
      utilization,
      resetsAt: toDate(w["resetsAt"]),
      status: null,
      overageInUse: false,
    });
  }
  return out;
}

/**
 * Synthetic's own quota reading. `weekly` is the plan's weekly credit pool, which is what the
 * subscription actually spends (BOS-260): a percentage of the week's credits left, plus how much
 * comes back at the next regeneration. `requests` is the old request window, kept only so an
 * account that only reports that can still show something. A missing or unreadable measure is
 * null, never 0.
 */
export type SyntheticQuota = {
  weekly: { percentRemaining: number; nextRegenAt: Date | null; nextRegenPercent: number | null } | null;
  requests: { used: number; limit: number; renewsAt: Date | null } | null;
};

/**
 * Synthetic's own quota endpoint (`GET /v2/quotas`). A real response (BOS-260) is:
 * `{subscription: {limit, requests, renewsAt}, search: {...}, planWeeklyLimit: {nextRegenAt,
 * percentRemaining, nextRegenPercent}}`. The weekly credits are the measure the plan spends; the
 * request window is often stuck at 0 and must never be shown as usage on its own.
 */
export function parseSyntheticQuota(resp: unknown): SyntheticQuota | null {
  if (!isRecord(resp)) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  // The used count and renewal are sometimes beside `subscription`, sometimes inside it.
  const sub = isRecord(resp["subscription"]) ? resp["subscription"] : {};
  const used = count(sub["requests"]) ?? count(resp["requests"]);
  const limit = count(sub["limit"]) ?? count(resp["limit"]);
  const requests = used !== null && limit !== null && limit > 0 ? { used, limit, renewsAt: toDate(sub["renewsAt"]) ?? toDate(resp["renewsAt"]) } : null;
  const weeklyRaw = isRecord(resp["planWeeklyLimit"]) ? resp["planWeeklyLimit"] : null;
  // percentRemaining is 0..100; anything outside that is not a percentage we can trust.
  const percentRemaining = weeklyRaw ? count(weeklyRaw["percentRemaining"]) : null;
  const weekly =
    percentRemaining !== null && percentRemaining <= 100
      ? {
          percentRemaining,
          nextRegenAt: toDate(weeklyRaw!["nextRegenAt"]),
          nextRegenPercent: count(weeklyRaw!["nextRegenPercent"]),
        }
      : null;
  if (!weekly && !requests) return null;
  return { weekly, requests };
}

export type UsageCost = { costMicros: number; currency: string; model: string | null; contextUsed: number | null };

/**
 * Cost from an ACP `usage_update` (claude-agent-acp attaches `cost` on the final update of a turn).
 * Kandev reports this figure is cumulative per session; until confirmed, callers record the
 * delta from the previous value for the same session (R34).
 */
export function parseAcpUsageCost(update: unknown): UsageCost | null {
  if (!isRecord(update)) return null;
  const cost = update["cost"];
  if (!isRecord(cost) || typeof cost["amount"] !== "number") return null;
  const meta = isRecord(update["_meta"]) ? update["_meta"] : {};
  return {
    costMicros: usdToMicros(cost["amount"]),
    currency: typeof cost["currency"] === "string" ? cost["currency"] : "USD",
    model: typeof meta["_claude/model"] === "string" ? meta["_claude/model"] : null,
    contextUsed: typeof update["used"] === "number" ? update["used"] : null,
  };
}

/**
 * Plain names for the limits Claude reports; anything unknown gets a readable name, never the raw key.
 * The Fable key is a guess: the owner's screenshot showed "seven day overage included", and no sample of that
 * data is in the repo, so any key containing `fable` or `overage_included` is taken as the weekly Fable limit.
 */
export function windowLabel(key: string): { name: string; note?: string } {
  if (key === "five_hour") return { name: "5-hour window" };
  if (key === "seven_day") return { name: "This week" };
  if (/fable|overage_included/.test(key))
    return { name: "Fable (this week)", note: "Fable can use up to 50% of your weekly limit." };
  const m = /^(\d+)_min$/.exec(key);
  if (m) return { name: `${m[1]}-minute window` };
  const words = key.replace(/_/g, " ").trim();
  return { name: words ? `${words[0]!.toUpperCase()}${words.slice(1)} limit` : "Other limit" };
}
