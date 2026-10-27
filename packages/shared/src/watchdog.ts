// The Scrum Master watchdog (BOS-58): rule limits the owner edits in Settings, and the names of
// the rules and logged actions that the activity view and daily summary read.
import { z } from "zod";

export const WatchdogSettings = z.object({
  enabled: z.boolean(),
  /** A ready or in-progress ticket with no assignee for this long is flagged; short, so a ticket mid-creation isn't. */
  unassignedMinutes: z.number().int().min(1).max(24 * 60),
  inProgressHours: z.number().min(0.25).max(24 * 14),
  reviewHours: z.number().min(0.25).max(24 * 14),
  blockedHours: z.number().min(0.25).max(24 * 14),
  /** Quiet past a ticket's "blocked until" time for this long before it is flagged. */
  blockedUntilGraceHours: z.number().min(0).max(24 * 7),
  /** The owner is reminded once about a decision blocking a ticket after this long. */
  ownerDecisionHours: z.number().min(0.25).max(24 * 14),
  /** More send-backs than this is a review loop. */
  reviewBounces: z.number().int().min(1).max(20),
  maxSnoozeHours: z.number().min(1).max(48),
  /** Hard caps per rolling hour; crossing one switches the watchdog off and tells the owner. */
  maxSmRunsPerHour: z.number().int().min(1).max(30),
  maxNudgesPerHour: z.number().int().min(1).max(100),
  /** Boss Man's own alerts (BOS-64): how long the Scrum Master, then the CEO, has to settle one before it moves up a rung. */
  alertMinutes: z.number().int().min(5).max(24 * 60),
  /** Alerts handed to the CEO in a rolling hour; past it they go to the owner, so a loop can't keep starting CEO runs. */
  maxCeoAlertsPerHour: z.number().int().min(1).max(30),
});
export type WatchdogSettings = z.infer<typeof WatchdogSettings>;

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  enabled: false,
  unassignedMinutes: 15,
  inProgressHours: 2,
  reviewHours: 2,
  blockedHours: 8,
  blockedUntilGraceHours: 2,
  ownerDecisionHours: 8,
  reviewBounces: 2,
  maxSnoozeHours: 48,
  maxSmRunsPerHour: 4,
  maxNudgesPerHour: 12,
  alertMinutes: 30,
  maxCeoAlertsPerHour: 6,
};

/** Reads a stored value defensively: unknown or bad fields fall back to the defaults. */
export function readWatchdogSettings(v: unknown): WatchdogSettings {
  const out = { ...DEFAULT_WATCHDOG };
  if (!v || typeof v !== "object") return out;
  for (const [k, s] of Object.entries(WatchdogSettings.shape)) {
    const r = s.safeParse((v as Record<string, unknown>)[k]);
    if (r.success) (out as Record<string, unknown>)[k] = r.data;
  }
  return out;
}

export const WATCHDOG_RULES = ["unassigned", "run_crashed", "run_ended_unmoved", "stale_in_progress", "stale_review", "stale_blocked", "blocked_until_passed", "review_loop", "owner_decision_waiting"] as const;
export type WatchdogRule = (typeof WATCHDOG_RULES)[number];

export const WATCHDOG_RULE_LABEL: Record<WatchdogRule, string> = {
  unassigned: "nobody is assigned",
  run_crashed: "its last run crashed",
  run_ended_unmoved: "its last run ended without moving it",
  stale_in_progress: "no movement in progress",
  stale_review: "no movement in review",
  stale_blocked: "blocked with no movement",
  blocked_until_passed: "its 'blocked until' time has passed",
  review_loop: "it keeps bouncing between review and changes",
  owner_decision_waiting: "it waits on the owner's decision",
};

export const WATCHDOG_ACTIONS = ["sweep_wake", "nudge", "assign", "rewake", "chase_review", "snooze", "escalate", "raise_decision", "owner_reminder", "auto_escalate", "tripped", "undo", "alert_hop", "alert_resolved"] as const;
export type WatchdogActionKind = (typeof WATCHDOG_ACTIONS)[number];

/** Actions that reach another agent or the owner; they count toward maxNudgesPerHour (an undone one still counts, so undo can't refill the cap). */
export const WATCHDOG_NUDGE_KINDS: readonly WatchdogActionKind[] = ["nudge", "assign", "rewake", "chase_review", "escalate", "auto_escalate", "raise_decision"];

/** The "blocked until" reason: one line, at most this long (BOS-59). */
export const BLOCKED_UNTIL_REASON_MAX = 240;
