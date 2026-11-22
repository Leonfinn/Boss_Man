// Working hours for one agent (BOS-2200): days of the week and a from-to time in a time zone. Off (null) means
// always available. A window that crosses midnight belongs to the day it starts on (Mon 22:00 to 07:00 runs
// until Tue 07:00). Everything is read in local calendar time of the zone, never by adding elapsed minutes,
// so a daylight-saving change neither skips nor doubles a window.
import { dateFormat } from "./dates.js";
import { minutesOf } from "./notify.js";

export type WorkingHours = { days: number[]; start: string; end: string; timeZone: string };

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The reason a wake waits for an agent's hours; the scheduler and the ticket card use the same text. */
export const WORKING_HOURS_REASON = "working hours";

/** Whether the zone name is one Intl knows. */
export function validTimeZone(timeZone: string): boolean {
  try {
    dateFormat("en-GB", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Whether the hours are well formed: 1 to 7 distinct days 0-6, HH:MM times that differ, a known zone. */
export function workingHoursProblem(wh: WorkingHours): string | null {
  if (!Array.isArray(wh.days) || !wh.days.length || wh.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Choose at least one day of the week.";
  const s = minutesOf(wh.start);
  const e = minutesOf(wh.end);
  if (s === null || e === null) return "Times are written HH:MM, like 08:00.";
  if (s === e) return "The from and to times can't be the same.";
  if (!validTimeZone(wh.timeZone)) return "That time zone isn't one Boss Man knows.";
  return null;
}

type Local = { y: number; mo: number; d: number; h: number; mi: number; dow: number };

function localParts(at: Date, timeZone: string): Local {
  const p = dateFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(at);
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const wd = p.find((x) => x.type === "weekday")!.value;
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour"), mi: n("minute"), dow: DAY_NAMES.indexOf(wd as (typeof DAY_NAMES)[number]) };
}

/** The offset (ms) of the zone from UTC at an instant. */
function offsetAt(at: Date, timeZone: string): number {
  const l = localParts(at, timeZone);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi) - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * The instant a local wall-clock time happens in the zone. A time that doesn't exist (spring forward) becomes
 * the first valid minute after the gap; a time that happens twice (fall back) is its first occurrence.
 */
export function localToInstant(y: number, mo: number, d: number, minutes: number, timeZone: string): Date {
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  // Offsets either side of the wall time cover every change a zone makes within a day.
  const candidates = new Set([offsetAt(new Date(wall - 86_400_000), timeZone), offsetAt(new Date(wall + 86_400_000), timeZone)]);
  const hits = [...candidates].map((o) => wall - o).filter((t) => offsetAt(new Date(t), timeZone) === wall - t).sort((a, b) => a - b);
  if (hits.length) return new Date(hits[0]!);
  // In a gap: the clocks jump from the earlier offset to the later one. Find the minute the jump happens by
  // searching for the first instant with the later offset.
  const later = Math.max(...candidates);
  let lo = Math.floor((wall - 2 * 86_400_000) / 60_000);
  let hi = Math.ceil((wall + 2 * 86_400_000) / 60_000);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(new Date(mid * 60_000), timeZone) >= later) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 60_000);
}

/** A calendar day in the zone, moved by whole days (Date.UTC does the month and year carry). */
function addDays(y: number, mo: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** Every window overlapping a few days around `now`: [start, end) instants, in order. */
function windowsAround(now: Date, wh: WorkingHours, daysBack: number, daysAhead: number): Array<{ start: Date; end: Date }> {
  const s = minutesOf(wh.start)!;
  const e = minutesOf(wh.end)!;
  const today = localParts(now, wh.timeZone);
  const out: Array<{ start: Date; end: Date }> = [];
  for (let i = -daysBack; i <= daysAhead; i++) {
    const day = addDays(today.y, today.mo, today.d, i);
    if (!wh.days.includes(day.dow)) continue;
    const start = localToInstant(day.y, day.mo, day.d, s, wh.timeZone);
    const endDay = e > s ? day : addDays(day.y, day.mo, day.d, 1);
    out.push({ start, end: localToInstant(endDay.y, endDay.mo, endDay.d, e, wh.timeZone) });
  }
  return out;
}

/** Whether `now` is inside the agent's working hours. No hours set means always. */
export function inWorkingHours(now: Date, wh: WorkingHours | null | undefined): boolean {
  if (!wh || workingHoursProblem(wh)) return true;
  return windowsAround(now, wh, 1, 0).some((w) => w.start <= now && now < w.end);
}

/** When the agent's hours next open, or null while they are open (or off). */
export function nextWorkingStart(now: Date, wh: WorkingHours | null | undefined): Date | null {
  if (!wh || workingHoursProblem(wh) || inWorkingHours(now, wh)) return null;
  const next = windowsAround(now, wh, 0, 8).find((w) => w.start > now);
  return next ? next.start : null;
}

/** "Mon 08:00" for an instant, in the hours' zone. */
export function startLabel(at: Date, timeZone: string): string {
  const l = localParts(at, timeZone);
  return `${DAY_NAMES[l.dow]} ${String(l.h).padStart(2, "0")}:${String(l.mi).padStart(2, "0")}`;
}

/** "from 00:00" wording for the ticket card: the time only when it is today. */
export function waitingText(agentName: string, at: Date, now: Date, timeZone: string): string {
  const same = (a: Local, b: Local) => a.y === b.y && a.mo === b.mo && a.d === b.d;
  const l = localParts(at, timeZone);
  const label = same(l, localParts(now, timeZone)) ? `${String(l.h).padStart(2, "0")}:${String(l.mi).padStart(2, "0")}` : startLabel(at, timeZone);
  return `Waiting for ${agentName}'s working hours, from ${label}`;
}
