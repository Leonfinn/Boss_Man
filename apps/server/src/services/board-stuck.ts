// BOS-1910: the board's "Looks stuck" verdict for one ticket, taken from the watchdog's open flag, the same flag that hands
// the ticket to the Scrum Master. A pure function so the exclusions are tested without a database.
import { actionClaim } from "@boss-man/shared";

export type StuckFlag = { rule: string; openedAt: Date; lastFlaggedAt: Date | null; detail: unknown };

/**
 * What the board shows on a card: how long nothing has moved, since when, and who is acting on it. `claim` is
 * actionClaim's line (BOS-2737): the Scrum Master's run if one started after the hand-off, else when it was handed on
 * and that nobody has picked it up. It used to be a fixed "The Scrum Master has been told."
 */
export type LooksStuck = { rule: string; idleMs: number; since: string; claim: string };

/** What puts a ticket out of the watchdog's reach on the board: it waits on a machine or its date, not on anyone. */
export type StuckContext = {
  /** In Review, built and waiting for its quick check ("Being checked"). */
  beingChecked: boolean;
  /** In Ready, marked Next up behind a busy agent. */
  nextUp: boolean;
  /** Merged, and its watch date has not passed ("Merged, watching"). */
  watching: boolean;
  /** The Scrum Master's first run that started at or after the flag's hand-off, if any (the run that got this flag). */
  smRun?: { agent: string; startedAt: Date } | null;
};

/**
 * The verdict, or null. Never for Being checked, Merged watching (before its date) or Next up, and never for a flag that is
 * the owner's own reminder (owner_decision_waiting): only a flag handed on to the Scrum Master counts.
 */
export function looksStuck(flag: StuckFlag | undefined, ctx: StuckContext, now: Date): LooksStuck | null {
  if (!flag || flag.rule === "owner_decision_waiting" || !flag.lastFlaggedAt) return null;
  if (ctx.beingChecked || ctx.nextUp || ctx.watching) return null;
  const idle = (flag.detail as { idleMs?: unknown } | null)?.idleMs;
  const idleMs = typeof idle === "number" && idle > 0 ? idle : now.getTime() - flag.openedAt.getTime();
  const run = ctx.smRun && ctx.smRun.startedAt.getTime() >= flag.lastFlaggedAt.getTime() ? ctx.smRun : null;
  const claim = actionClaim({ who: "The Scrum Master", raisedAt: flag.lastFlaggedAt, run }).text;
  return { rule: flag.rule, idleMs: Math.max(0, idleMs), since: new Date(now.getTime() - Math.max(0, idleMs)).toISOString(), claim };
}
