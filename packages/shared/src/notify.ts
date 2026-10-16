// The notification ladder (R44). Every notification has a level:
//   note  - the feed only;
//   flag  - a browser notification;
//   page  - a browser notification and a phone push;
//   ask   - needs an answer: a browser notification and a phone push.
// Quiet hours and per-agent caps lower the level rather than dropping the notification.
export const NOTIFY_LEVELS = ["note", "flag", "page", "ask"] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

/** One step quieter: an ask or a page becomes a flag, a flag becomes a note. */
export function demote(level: NotifyLevel): NotifyLevel {
  return level === "ask" || level === "page" ? "flag" : "note";
}

export type QuietHours = { start: string; end: string; timeZone: string };

/** Minutes since midnight of a "HH:MM" time, or null if it isn't one. */
export function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Whether `now` falls in the quiet hours, read in their own time zone. Overnight ranges wrap. */
export function inQuietHours(now: Date, quiet: QuietHours | null | undefined): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const at = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/**
 * The level a notification is delivered at: over the agent's hourly cap it becomes a note;
 * in quiet hours it goes one step quieter.
 */
export function effectiveLevel(requested: NotifyLevel, opts: { overCap: boolean; quiet: boolean }): { level: NotifyLevel; demotedBy: "cap" | "quiet hours" | null } {
  if (opts.overCap && requested !== "note") return { level: "note", demotedBy: "cap" };
  if (opts.quiet && requested !== "note") return { level: demote(requested), demotedBy: "quiet hours" };
  return { level: requested, demotedBy: null };
}
