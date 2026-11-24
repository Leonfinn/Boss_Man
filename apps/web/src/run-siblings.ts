import type { RunRow } from "./api";

export type Siblings = { rows: RunRow[]; previous: RunRow | null; next: RunRow | null };

/**
 * The runs of one ticket, oldest first. `GET /api/runs/recent?q=` also matches title words, so keep
 * only rows whose ticketId is this ticket's. The run being viewed is kept (it is marked on the page)
 * even when the list is capped and left it out; Previous and Next are its neighbours in start order.
 */
export function ticketSiblings(rows: RunRow[], current: Pick<RunRow, "id" | "ticketId" | "startedAt"> & Partial<RunRow>): Siblings {
  if (!current.ticketId) return { rows: [], previous: null, next: null };
  const seen = new Set<string>();
  const mine = rows.filter((r) => r.ticketId === current.ticketId && !seen.has(r.id) && !!seen.add(r.id));
  if (!seen.has(current.id)) mine.push(current as RunRow);
  mine.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
  const i = mine.findIndex((r) => r.id === current.id);
  return { rows: mine, previous: i > 0 ? mine[i - 1]! : null, next: i >= 0 && i < mine.length - 1 ? mine[i + 1]! : null };
}
