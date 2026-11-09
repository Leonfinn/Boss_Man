// The Scrum Master watchdog (BOS-58): rule limits the owner edits in Settings, and the names of
// the rules and logged actions that the activity view and daily summary read.
import { z } from "zod";

export const WatchdogSettings = z.object({
  enabled: z.boolean(),
  /**
   * Record-only (rehearsal) mode (BOS-166): the sweep still opens and closes flags and logs what it
   * would have done, but wakes, nudges, assigns, escalates or reminds nobody and spends no cap.
   */
  recordOnly: z.boolean(),
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
  /** The progress contract (BOS-314): runs that go quiet are asked for a status and flagged, reviews that stall move on. It works even while the watchdog is off. */
  progressContract: z.boolean(),
  /** A working run with no post on its ticket this long is sent a note asking for a status. */
  silentSteerMinutes: z.number().int().min(5).max(24 * 60),
  /** ...and flagged to the Scrum Master after this long. */
  silentFlagMinutes: z.number().int().min(5).max(24 * 60),
  /** An in-progress ticket whose note still says "likely / not proven" after this long goes to the CEO. */
  unprovenHours: z.number().min(0.25).max(24 * 14),
  /**
   * The idle-capacity rules (BOS-659): an agent holding in-progress work with no run for this long is
   * handed to the Scrum Master to re-wake, short enough to notice half the slots going quiet.
   */
  idleAgentMinutes: z.number().int().min(5).max(24 * 60),
  /** Fewer than this many run slots busy for `spareCapacityMinutes` while work waits means the company is under-used: the CEO is told. */
  spareCapacityMinutes: z.number().int().min(5).max(24 * 60),
});
export type WatchdogSettings = z.infer<typeof WatchdogSettings>;

export const DEFAULT_WATCHDOG: WatchdogSettings = {
  // On for a new or imported company (BOS-762, DR-041: the safe value is the default). It is a
  // liveness check and spends no model tokens, and until the owner picks a Scrum Master it reaches
  // nobody, so switching it on costs nothing and a company is never left without it by accident.
  // An existing company keeps whatever it has stored; the owner switches it off in Settings.
  enabled: true,
  recordOnly: false,
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
  progressContract: true,
  silentSteerMinutes: 30,
  silentFlagMinutes: 60,
  unprovenHours: 2,
  idleAgentMinutes: 15,
  spareCapacityMinutes: 20,
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

export const WATCHDOG_RULES = ["unassigned", "run_crashed", "run_ended_unmoved", "idle_agent", "unstarted", "stale_in_progress", "stale_review", "stale_blocked", "blocked_until_passed", "review_loop", "owner_decision_waiting"] as const;
export type WatchdogRule = (typeof WATCHDOG_RULES)[number];

export const WATCHDOG_RULE_LABEL: Record<WatchdogRule, string> = {
  unassigned: "nobody is assigned",
  run_crashed: "its last run crashed",
  run_ended_unmoved: "its last run ended without moving it",
  idle_agent: "in progress with no run for the set time",
  unstarted: "ready to start but no run has started on it",
  stale_in_progress: "no movement in progress",
  stale_review: "no movement in review",
  stale_blocked: "blocked with no movement",
  blocked_until_passed: "its 'blocked until' time has passed",
  review_loop: "it keeps bouncing between review and changes",
  owner_decision_waiting: "it waits on the owner's decision",
};

export const WATCHDOG_ACTIONS = ["sweep_wake", "nudge", "assign", "rewake", "chase_review", "snooze", "escalate", "raise_decision", "owner_reminder", "auto_escalate", "tripped", "undo", "daily_summary", "urgent_alert", "alert_hop", "alert_resolved", "record_sweep_wake", "record_owner_reminder", "record_auto_escalate", "record_urgent_page", "record_alert_skip", "quota_held_alert", "record_quota_held_alert", "spare_capacity_alert", "record_spare_capacity_alert"] as const;
export type WatchdogActionKind = (typeof WATCHDOG_ACTIONS)[number];

/**
 * Record-only entries (BOS-166): what the watchdog would have done in rehearsal. Nothing reached
 * anyone, so they never count toward a cap or toward the once-per-hand-off rule.
 */
export const WATCHDOG_RECORD_KINDS: readonly WatchdogActionKind[] = ["record_sweep_wake", "record_owner_reminder", "record_auto_escalate", "record_urgent_page", "record_alert_skip", "record_quota_held_alert", "record_spare_capacity_alert"];

/** The caps and the once-per-hand-off rule never count these (BOS-166); every other log entry is real. */
export const WATCHDOG_NON_CAPPED_KINDS: readonly WatchdogActionKind[] = [...WATCHDOG_RECORD_KINDS, "urgent_alert", "alert_hop", "alert_resolved", "tripped", "undo", "daily_summary", "quota_held_alert", "spare_capacity_alert"];

/** True for a rehearsal entry, written while record-only mode was on. */
export const isRecordedAction = (kind: string) => (WATCHDOG_RECORD_KINDS as readonly string[]).includes(kind);

/** Actions that reach another agent or the owner; they count toward maxNudgesPerHour (an undone one still counts, so undo can't refill the cap). */
export const WATCHDOG_NUDGE_KINDS: readonly WatchdogActionKind[] = ["nudge", "assign", "rewake", "chase_review", "escalate", "auto_escalate", "raise_decision"];

/** The "blocked until" reason: one line, at most this long (BOS-59). */
export const BLOCKED_UNTIL_REASON_MAX = 240;

/** "Blocked until" may be at most this many days ahead, so a ticket can't hide from the watchdog (BOS-77). */
export const BLOCKED_UNTIL_MAX_DAYS = 30;
export const BLOCKED_UNTIL_MAX_MS = BLOCKED_UNTIL_MAX_DAYS * 24 * 3_600_000;

/**
 * Whether a ticket was parked on purpose, so a finished blocker must not start it (BOS-742): a
 * "blocked until" time still ahead, or a state note that says "parked". Plain words only: the note
 * is what the CEO or the owner wrote when they meant to hold the ticket back.
 */
const PARKED_NOTE = /\bparked\b/i;

export function parkedOnPurpose(t: { stateNote?: string | null; blockedUntil?: Date | null }, at: Date): boolean {
  if (t.blockedUntil && t.blockedUntil.getTime() > at.getTime()) return true;
  return !!t.stateNote && PARKED_NOTE.test(t.stateNote);
}

/** Plain-English heading for each logged action, as the owner reads it in the Scrum Master's log and a ticket's activity. A new action kind must have one (the type enforces it). */
export const WATCHDOG_ACTION_LABEL: Record<WatchdogActionKind, string> = {
  sweep_wake: "Woke the Scrum Master",
  nudge: "Nudged",
  assign: "Assigned",
  rewake: "Re-woke",
  chase_review: "Chased a review",
  snooze: "Snoozed",
  escalate: "Escalated",
  raise_decision: "Asked you",
  owner_reminder: "Reminded you",
  auto_escalate: "Escalated to the CEO",
  tripped: "Switched itself off",
  undo: "Undone",
  daily_summary: "Sent the daily summary",
  urgent_alert: "Paged you",
  alert_hop: "Passed a warning on",
  alert_resolved: "Settled a warning",
  // Record-only: written while the watchdog is rehearsing, so they say "would have" and are never sent.
  record_sweep_wake: "Would have woken the Scrum Master",
  record_owner_reminder: "Would have reminded you",
  record_auto_escalate: "Would have escalated to the CEO",
  record_urgent_page: "Would have paged you",
  record_alert_skip: "Would have passed Boss Man's own alert up the ladder",
  quota_held_alert: "Told the CEO work is held by the usage limit",
  record_quota_held_alert: "Would have told the CEO work is held by the usage limit",
  spare_capacity_alert: "Told the CEO there is spare capacity while work waits",
  record_spare_capacity_alert: "Would have told the CEO there is spare capacity",
};
