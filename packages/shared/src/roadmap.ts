// The roadmap view: each objective's milestones on a timeline, with a status worked out from
// their tickets and target date.

export type MilestoneCounts = { total: number; done: number; blocked: number };

export const HORIZONS = ["now", "next", "later"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Days ahead that a target date puts a milestone in Now, and in Next. */
export const NOW_DAYS = 30;
export const NEXT_DAYS = 90;
export type MilestoneStatus = "done" | "late" | "at_risk" | "on_track" | "no_work" | "unscheduled";

/** Days before its target date that a milestone can be flagged as at risk. */
export const AT_RISK_DAYS = 14;

/**
 * No work until it has tickets. Done when every ticket is done. Late when the target date has passed first. At risk when
 * it's due within two weeks and has blocked tickets or less than half its tickets done.
 * `today` and `targetDate` are calendar dates, YYYY-MM-DD.
 */
export function milestoneStatus(counts: MilestoneCounts, targetDate: string | null, today: string): MilestoneStatus {
  if (counts.total > 0 && counts.done === counts.total) return "done";
  if (!counts.total) return "no_work";
  if (!targetDate) return "unscheduled";
  if (targetDate < today) return "late";
  const days = (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (days <= AT_RISK_DAYS && (counts.blocked > 0 || counts.done / counts.total < 0.5)) return "at_risk";
  return "on_track";
}

/** Today's date, YYYY-MM-DD, in the given time zone. */
/** A timezone name Intl understands, such as "Europe/London"; otherwise the fallback. */
export function timeZoneOr(tz: string | null | undefined, fallback = "Europe/London"): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export function dateIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Where a milestone sits on the Now / Next / Later roadmap. The owner can pin it; otherwise
 * it's Now while its tickets are being worked on, it's late or it's due within 30 days; Next
 * when it's due within 90 days; and Later otherwise, including when it has no date.
 */
export function milestoneHorizon(m: MilestoneCounts & { active: number; targetDate: string | null; horizon: Horizon | null }, today: string): Horizon {
  if (m.horizon) return m.horizon;
  if (m.active > 0 || m.blocked > 0) return "now";
  if (!m.targetDate) return "later";
  const days = (Date.parse(`${m.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (days <= NOW_DAYS) return "now";
  return days <= NEXT_DAYS ? "next" : "later";
}
