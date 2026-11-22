// The roadmap view: each objective's milestones on a timeline, with a status worked out from
// their tickets and target date.
import { isTimeZone } from "./dates.js";

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

/** A timezone name Intl understands, such as "Europe/London"; otherwise the fallback. */
export function timeZoneOr(tz: string | null | undefined, fallback = "Europe/London"): string {
  if (!tz) return fallback;
  return isTimeZone(tz) ? tz : fallback;
}

// One formatter per zone: building an Intl.DateTimeFormat costs ~70 µs, formatting with one ~1 µs,
// and per-row callers (funding's daily use) froze the server for seconds (BOS-643). Only zones
// Intl accepts get here (an unknown one throws before it's cached). Intl also accepts any casing
// ("europe/LONDON") and offsets, so the map is keyed by the spelling for the fast lookup, shares one
// formatter per resolved zone name, and is emptied when it reaches DAY_FORMATS_MAX spellings
// (Jane measured 50,000 spellings at ~1.4 GB uncapped). A real server sees a handful of zones.
const DAY_FORMATS_MAX = 256;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Today's date, YYYY-MM-DD, in the given time zone. */
export function dateIn(now: Date, timeZone: string): string {
  let f = dayFormats.get(timeZone);
  if (!f) {
    const made = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const resolved = made.resolvedOptions().timeZone;
    f = dayFormats.get(resolved) ?? made;
    if (dayFormats.size + 2 > DAY_FORMATS_MAX) dayFormats.clear();
    dayFormats.set(resolved, f);
    dayFormats.set(timeZone, f);
  }
  return f.format(now);
}

/**
 * The next local midnight after `now` in the zone, as an absolute time (BOS-2188). Found by bisection on the
 * date changing, so a 23-hour or 25-hour DST day and half-hour zones come out right. `now` itself is never returned.
 */
export function nextMidnightIn(now: Date, timeZone: string): Date {
  const today = dateIn(now, timeZone);
  let lo = Math.floor(now.getTime() / 1000) * 1000; // whole seconds, so the answer is one; still today
  let hi = lo + 26 * 3_600_000; // always tomorrow or later
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (dateIn(new Date(mid), timeZone) === today) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/** How many zone spellings dateIn has cached; for tests of the cap. */
export function dateInCacheSize(): number {
  return dayFormats.size;
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
