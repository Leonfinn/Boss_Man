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
