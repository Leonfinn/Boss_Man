/** Grouping the notifications feed by the owner's local day (BOS-2441). */

export type DayGroup<T> = { key: string; label: string; items: T[]; unreadIds: string[] };

const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of a time, "2026-11-24". */
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Yesterday", then "Mon 23 Nov" (the year is added when it is not this year). */
export function dayLabel(day: Date, now: Date): string {
  if (dayKey(day) === dayKey(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(day) === dayKey(yesterday)) return "Yesterday";
  const base = `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
  return day.getFullYear() === now.getFullYear() ? base : `${base} ${day.getFullYear()}`;
}

/** Groups rows (already newest first) under their local day; a day split across pages stays one group. */
export function groupByDay<T extends { id: string; createdAt: string; readAt?: string | null }>(rows: T[], now: Date = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const r of rows) {
    const t = new Date(r.createdAt);
    const valid = !Number.isNaN(t.getTime());
    const key = valid ? dayKey(t) : "unknown";
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: valid ? dayLabel(t, now) : "Earlier", items: [], unreadIds: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(r);
    if (!r.readAt) g.unreadIds.push(r.id);
  }
  return groups;
}

/** The server takes up to 500 ids at once. */
export const READ_IDS_MAX = 500;
