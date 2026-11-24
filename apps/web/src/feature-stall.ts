// BOS-2454: when a feature's work last moved, and whether it has gone quiet.
import { ageLabel } from "./age";

export const STALL_DAYS = 3;
const DAY_MS = 86_400_000;

type StallFeature = {
  status: string;
  lastMovedAt?: string | null;
  tickets: { items: Array<{ state: string; outcome: string | null }> };
};

/** "today", "2 d ago" or "—" when nothing has moved. */
export function lastMovedLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  return days < 1 ? "today" : `${days} d ago`;
}

/** "Last moved" sort: longest quiet first, features with no tasks last, ties by higher priority. */
export function compareLastMoved(
  a: { lastMovedAt?: string | null; priority: number },
  b: { lastMovedAt?: string | null; priority: number },
): number {
  if (!a.lastMovedAt && !b.lastMovedAt) return b.priority - a.priority;
  if (!a.lastMovedAt) return 1;
  if (!b.lastMovedAt) return -1;
  return a.lastMovedAt.localeCompare(b.lastMovedAt) || b.priority - a.priority;
}

/** In progress, some task done and some not, and no movement for more than 3 days. Cancelled tasks count for neither. */
export function isStalled(f: StallFeature, now = Date.now()): boolean {
  if (f.status !== "in_progress" || !f.lastMovedAt) return false;
  const live = f.tickets.items.filter((t) => t.outcome !== "cancelled");
  const done = live.filter((t) => t.state === "done").length;
  if (done === 0 || done === live.length) return false;
  return now - new Date(f.lastMovedAt).getTime() > STALL_DAYS * DAY_MS;
}

/** The tooltip: the exact age in the shared words. */
export function lastMovedTitle(iso: string | null | undefined, now = Date.now()): string {
  return iso ? `Last task change ${ageLabel(now - new Date(iso).getTime())}` : "No tasks yet";
}
