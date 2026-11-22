// BOS-1910: the board's "Looks stuck" verdict for one ticket, taken from the watchdog's open flag, the same flag that hands
// the ticket to the Scrum Master. A pure function so the exclusions are tested without a database.

export type StuckFlag = { rule: string; openedAt: Date; lastFlaggedAt: Date | null; detail: unknown };

/** What the board shows on a card: how long nothing has moved, and since when. */
export type LooksStuck = { rule: string; idleMs: number; since: string };

/** What puts a ticket out of the watchdog's reach on the board: it waits on a machine or its date, not on anyone. */
export type StuckContext = {
  /** In Review, built and waiting for its quick check ("Being checked"). */
  beingChecked: boolean;
  /** In Ready, marked Next up behind a busy agent. */
  nextUp: boolean;
  /** Merged, and its watch date has not passed ("Merged, watching"). */
  watching: boolean;
};

/**
 * The verdict, or null. Never for Being checked, Merged watching (before its date) or Next up, and never for a flag that is
 * the owner's own reminder (owner_decision_waiting): the line says the Scrum Master has been told, so a flag counts only
 * once it has been handed on.
 */
export function looksStuck(flag: StuckFlag | undefined, ctx: StuckContext, now: Date): LooksStuck | null {
  if (!flag || flag.rule === "owner_decision_waiting" || !flag.lastFlaggedAt) return null;
  if (ctx.beingChecked || ctx.nextUp || ctx.watching) return null;
  const idle = (flag.detail as { idleMs?: unknown } | null)?.idleMs;
  const idleMs = typeof idle === "number" && idle > 0 ? idle : now.getTime() - flag.openedAt.getTime();
  return { rule: flag.rule, idleMs: Math.max(0, idleMs), since: new Date(now.getTime() - Math.max(0, idleMs)).toISOString() };
}
