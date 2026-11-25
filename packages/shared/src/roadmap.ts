// The roadmap view: each objective's milestones on a timeline, with a status worked out from
// their tickets and target date.
import { isTimeZone } from "./dates.js";

export type MilestoneCounts = { total: number; done: number; blocked: number };

export const HORIZONS = ["now", "next", "later"] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Days ahead that a target date puts a milestone in Now, and in Next. */
export const NOW_DAYS = 30;
export const NEXT_DAYS = 90;
export type MilestoneStatus = "done" | "late" | "at_risk" | "on_track" | "live_checked" | "no_work" | "no_date";

/** With no estimate (nothing finished in the last 4 weeks), a milestone due within this many days is at risk. */
export const NO_ESTIMATE_RISK_DAYS = 28;

/** A ticket named in a reason line: its reference (BOS-12) and id, so the page can link the reference. */
export type MilestoneReasonTicket = { ref: string; id: string };

/** An unbuilt ticket that makes a milestone at risk on its own, and why (BOS-2579). */
export type MilestoneAction = MilestoneReasonTicket & { why: "owner" | "stuck" };

/** A merged, live ticket whose final check hasn't reported. `quietDays` is set once it has gone quiet (BOS-2579 rule 5). */
export type MilestoneCheck = MilestoneReasonTicket & { assignee: string | null; quietDays: number | null };

/** What the status is worked out from. The counts cover the milestone's direct tickets and its features' tickets, cancelled left out. */
export type MilestoneStatusInput = MilestoneCounts & {
  /** Whole days the expected finish (at the milestone's own pace) falls after its date; 0 when on time. */
  daysLate: number;
  /** True when there is work left but no pace to estimate a finish from. */
  noEstimate: boolean;
  /** Merged and live, not yet done: counts as delivered, never as blocked (BOS-2579). Default none. */
  delivered?: number;
  /** Unbuilt tickets waiting on the owner, or flagged stuck: only these make a blocked ticket matter. Default none. */
  needsAction?: MilestoneAction[];
  /** The delivered tickets as final checks, for the reason line. Default none. */
  checks?: MilestoneCheck[];
  /** The latest end date of a final check's watch, YYYY-MM-DD; null when none has one. */
  lastCheckEnds?: string | null;
  /** Expected finish at the milestone's own pace, YYYY-MM-DD, for the reason line. */
  expectedFinish?: string | null;
};

export type MilestoneVerdict = { status: MilestoneStatus; /** One plain line saying why; null when the badge needs none. */ reason: string | null; /** The tickets the reason names. */ tickets: MilestoneReasonTicket[] };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const niceDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const showRefs = (ts: MilestoneReasonTicket[]) => (ts.length > 3 ? `${ts.slice(0, 3).map((t) => t.ref).join(", ")} and ${ts.length - 3} more` : list(ts.map((t) => t.ref)));

/**
 * The one status rule and its reason line (BOS-2558, BOS-2579), first match wins. Done when every ticket is done; No tickets
 * when it has none; No date when it has no date. A merged, live ticket counts as delivered. When every unfinished ticket is
 * delivered the milestone is "Live, being checked", never Late. Otherwise Late when the date has passed with unbuilt work
 * left; At risk when the unbuilt work finishes after the date at its own pace, there is no estimate and it's due within 28
 * days, or an unbuilt ticket waits on the owner or looks stuck; else On track. A blocked ticket alone
 * never turns it amber. `today` and `targetDate` are calendar dates, YYYY-MM-DD. The badge and the reason come from here
 * together, so they can't disagree; nothing is stored.
 */
export function milestoneVerdict(m: MilestoneStatusInput, targetDate: string | null, today: string): MilestoneVerdict {
  const delivered = m.delivered ?? 0;
  const unbuilt = m.total - m.done - delivered;
  const none = (status: MilestoneStatus): MilestoneVerdict => ({ status, reason: null, tickets: [] });
  if (m.total > 0 && m.done === m.total) return none("done");
  if (!m.total) return none("no_work");
  if (unbuilt <= 0) {
    const checks = m.checks ?? [];
    const quiet = checks.filter((c) => c.quietDays !== null);
    const parts = [`${delivered} final ${delivered === 1 ? "check" : "checks"} running`];
    if (quiet.length) parts.push(`${quiet.length} ${quiet.length === 1 ? "has" : "have"} gone quiet: ${showRefs(quiet)}`);
    if (m.lastCheckEnds) parts.push(`last check ends ${niceDate(m.lastCheckEnds)}`);
    return { status: "live_checked", reason: `All built and live. ${parts.join("; ")}.`, tickets: quiet.slice(0, 3).map(({ ref, id }) => ({ ref, id })) };
  }
  if (!targetDate) return none("no_date");
  if (targetDate < today) {
    return { status: "late", reason: `Late: its date passed ${days(dayDiff(targetDate, today))} ago and ${unbuilt} ${unbuilt === 1 ? "ticket is" : "tickets are"} not built and live yet.`, tickets: [] };
  }
  const act = m.needsAction ?? [];
  const owner = act.filter((a) => a.why === "owner");
  const stuck = act.filter((a) => a.why === "stuck");
  const ahead = dayDiff(today, targetDate);
  const risk = (reason: string, tickets: MilestoneReasonTicket[] = []): MilestoneVerdict => ({ status: "at_risk", reason: `At risk: ${reason}`, tickets: tickets.slice(0, 3).map(({ ref, id }) => ({ ref, id })) });
  // The single worst thing, in a fixed order: waiting for the owner, missing the date, looks stuck, no estimate.
  if (owner.length) return risk(`${showRefs(owner)} ${owner.length === 1 ? "waits" : "wait"} on your card.`, owner);
  if (m.daysLate > 0) return risk(`at its pace the unbuilt work finishes ${m.expectedFinish ? `about ${niceDate(m.expectedFinish)}, ` : ""}${days(m.daysLate)} after its date.`);
  if (stuck.length) return risk(`${showRefs(stuck)} ${stuck.length === 1 ? "looks" : "look"} stuck.`, stuck);
  if (m.noEstimate && ahead <= NO_ESTIMATE_RISK_DAYS) return risk(`nothing finished in the last 4 weeks, so there is no estimate, and it is due in ${days(ahead)}.`);
  return none("on_track");
}

/** The badge alone; see milestoneVerdict for the rule. */
export function milestoneStatus(m: MilestoneStatusInput, targetDate: string | null, today: string): MilestoneStatus {
  return milestoneVerdict(m, targetDate, today).status;
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
