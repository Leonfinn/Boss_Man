// Custom board columns over fixed system states (R17). Owners rename and split columns
// freely; agents only ever see the six states, so renaming a column never confuses them.

export const SYSTEM_STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
export type SystemState = (typeof SYSTEM_STATES)[number];

export type ColumnSpec = { name: string; systemState: SystemState; wipLimit?: number | null };

export const DEFAULT_COLUMNS: ColumnSpec[] = [
  { name: "Backlog", systemState: "backlog" },
  { name: "Ready", systemState: "ready" },
  { name: "In progress", systemState: "in_progress" },
  { name: "Blocked", systemState: "blocked" },
  { name: "Review", systemState: "review" },
  { name: "Done", systemState: "done" },
];

/** Every state needs at least one column, or tickets in it would vanish from the board. */
export function columnProblems(columns: ColumnSpec[]): string[] {
  const problems: string[] = [];
  if (columns.length === 0) problems.push("A board needs at least one column per state.");
  const names = new Set<string>();
  for (const c of columns) {
    const key = c.name.trim().toLowerCase();
    if (!key) problems.push("Column names can't be empty.");
    if (names.has(key)) problems.push(`Two columns are called "${c.name}".`);
    names.add(key);
    if (c.wipLimit != null && (!Number.isInteger(c.wipLimit) || c.wipLimit < 1)) problems.push(`"${c.name}" needs a card limit of 1 or more, or none.`);
  }
  for (const s of SYSTEM_STATES) {
    if (!columns.some((c) => c.systemState === s)) problems.push(`No column shows the "${s}" state.`);
  }
  return problems;
}

/** A ticket's due date: its own, else its milestone's target date (R16). */
export function effectiveDueDate(ticketDue: string | null, milestoneTarget: string | null): string | null {
  return ticketDue ?? milestoneTarget ?? null;
}

/** A ticket's state note for an agent, with its age; flagged when the ticket has moved or the owner has acted since it was written (R85, BOS-123). */
export function stateNoteLine(
  t: { stateNote: string | null; stateNoteAt: Date | null; lastActivityAt: Date; stateNoteStaleAt?: Date | null; stateNoteStaleReason?: string | null },
  now: Date,
): string | null {
  if (!t.stateNote || !t.stateNoteAt) return null;
  const ago = (d: Date) => {
    const m = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
    return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };
  const byOwner = t.stateNoteStaleAt != null && t.stateNoteStaleAt > t.stateNoteAt;
  // Say what the owner did and when, so the reader checks that and not the whole note (BOS-1192).
  const flag = byOwner ? ` (${staleNoteWhy(t.stateNoteStaleReason, ago(t.stateNoteStaleAt!))})` : t.stateNoteAt < t.lastActivityAt ? " (may be out of date)" : "";
  return `State note (${ago(t.stateNoteAt)} ago): ${t.stateNote}${flag}`;
}

/** The plain statement that goes after a state note the owner's action touched: what they did and how long ago (BOS-1192). */
export function staleNoteWhy(reason: string | null | undefined, ago: string): string {
  return reason ? `after this was written, ${reason}, ${ago} ago` : `the owner acted on this ticket ${ago} ago, after this was written`;
}

/** A company's ticket prefix, as in HOL-12: 1 to 10 capital letters or digits. */
export const TICKET_PREFIX = /^[A-Z0-9]{1,10}$/;
/** The prefix a company starts with: the first three letters or digits of its name (as migration 0056 did). */
export const defaultTicketPrefix = (name: string) => name.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "TKT";
/** How a ticket is referred to, e.g. HOL-12; null for one without a number yet. */
export const ticketRef = (prefix: string | null | undefined, number: number | null | undefined) => (number ? `${prefix || "T"}-${number}` : null);

/** Who a system note on a ticket is from: Boss Man, or the tool it was imported from (delivery "from:<tool>"). */
export function systemAuthor(delivery: string | null | undefined): string {
  return delivery?.startsWith("from:") ? `${delivery.slice(5)} (imported)` : "Boss Man";
}
