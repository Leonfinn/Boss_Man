import { DEFAULT_REVIEW_POLICY, DEFAULT_WATCHDOG } from "@boss-man/shared";
import type { ReviewPolicy } from "../api";

/** A named starting point for a settings panel: a name, one sentence for the owner, and the values it sets. */
export type Preset<V> = { id: string; name: string; blurb: string; values: V };

/** The 16 limits a Watchdog preset sets. On/off, record only, the Scrum Master, the snooze cap and the progress contract are never touched. */
export const WATCHDOG_LIMIT_KEYS = [
  "unassignedMinutes",
  "inProgressHours",
  "reviewHours",
  "blockedHours",
  "blockedUntilGraceHours",
  "ownerDecisionHours",
  "reviewBounces",
  "maxSmRunsPerHour",
  "maxNudgesPerHour",
  "alertMinutes",
  "maxCeoAlertsPerHour",
  "silentSteerMinutes",
  "silentFlagMinutes",
  "unprovenHours",
  "idleAgentMinutes",
  "spareCapacityMinutes",
] as const;
export type WatchdogLimitKey = (typeof WATCHDOG_LIMIT_KEYS)[number];
export type WatchdogLimits = Record<WatchdogLimitKey, number>;

// Roles only (CEO, senior developer, owner), never a named agent, so a preset fits any company.
export const REVIEW_PRESETS: Array<Preset<ReviewPolicy>> = [
  {
    id: "light",
    name: "Light",
    blurb: "The CEO checks everything up to medium risk. You still approve plans and sign off high and critical work, with a security review.",
    values: {
      trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
      low: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
      medium: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
      high: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true, kinds: { security: "ceo" } },
      critical: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true, kinds: { security: "ceo" } },
    },
  },
  {
    id: "standard",
    name: "Standard",
    blurb: "A senior developer reviews medium risk and above; you sign off high and critical work, with a security review.",
    values: DEFAULT_REVIEW_POLICY as ReviewPolicy,
  },
  {
    id: "strict",
    name: "Strict",
    blurb: "Two reviewers on every ticket above trivial, and you sign off medium risk and above.",
    values: {
      trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
      low: { planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false, kinds: { adversarial: "ceo" } },
      medium: { planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: true, kinds: { adversarial: "ceo" } },
      high: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true, kinds: { security: "ceo", adversarial: "ceo" } },
      critical: { planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true, kinds: { security: "ceo", adversarial: "ceo" } },
    },
  },
];

const pickLimits = (s: Record<WatchdogLimitKey, number>): WatchdogLimits => Object.fromEntries(WATCHDOG_LIMIT_KEYS.map((k) => [k, s[k]])) as WatchdogLimits;

export const WATCHDOG_PRESETS: Array<Preset<WatchdogLimits>> = [
  {
    id: "relaxed",
    name: "Relaxed",
    blurb: "Waits longer before it raises anything and wakes the Scrum Master less often. Quieter, but slower to notice stuck work.",
    values: {
      unassignedMinutes: 30,
      inProgressHours: 4,
      reviewHours: 4,
      blockedHours: 16,
      blockedUntilGraceHours: 4,
      ownerDecisionHours: 16,
      reviewBounces: 3,
      maxSmRunsPerHour: 3,
      maxNudgesPerHour: 8,
      alertMinutes: 60,
      maxCeoAlertsPerHour: 4,
      silentSteerMinutes: 60,
      silentFlagMinutes: 120,
      unprovenHours: 4,
      idleAgentMinutes: 30,
      spareCapacityMinutes: 40,
    },
  },
  { id: "normal", name: "Normal", blurb: "Today's limits: a good balance of noticing stuck work and leaving people alone.", values: pickLimits(DEFAULT_WATCHDOG) },
  {
    id: "tight",
    name: "Tight",
    blurb: "Notices stuck work early and acts sooner. More wake-ups and alerts.",
    values: {
      unassignedMinutes: 10,
      inProgressHours: 1,
      reviewHours: 1,
      blockedHours: 4,
      blockedUntilGraceHours: 1,
      ownerDecisionHours: 4,
      reviewBounces: 1,
      maxSmRunsPerHour: 6,
      maxNudgesPerHour: 20,
      alertMinutes: 15,
      maxCeoAlertsPerHour: 10,
      silentSteerMinutes: 15,
      silentFlagMinutes: 30,
      unprovenHours: 1,
      idleAgentMinutes: 10,
      spareCapacityMinutes: 10,
    },
  },
];

/** Deep compare that ignores key order and treats a missing value as absent; arrays of agents compare in order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // A missing "kinds" is the same as an empty one.
  if (a === undefined && b && typeof b === "object" && !Array.isArray(b)) return same({}, b);
  if (b === undefined && a && typeof a === "object" && !Array.isArray(a)) return same(a, {});
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** The preset whose values equal these, or null (shown as "Custom"). An absent reviewer kind is the same as one that is off. */
export function matchPreset<V>(values: V, presets: Array<Preset<V>>): Preset<V> | null {
  return presets.find((p) => same(values, p.values)) ?? null;
}

/** Watchdog form values (strings, as typed) as numbers, for matching. A blank or bad entry never matches. */
export function limitsFromDraft(draft: Record<string, string>): Record<string, number> {
  return Object.fromEntries(WATCHDOG_LIMIT_KEYS.map((k) => [k, draft[k] === undefined || draft[k].trim() === "" ? Number.NaN : Number(draft[k])]));
}
