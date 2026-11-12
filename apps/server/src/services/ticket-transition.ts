// The system (not a person or an agent) moves a ticket from one state to another because of something that
// happened elsewhere: a blocker finished, a decision closed, a dependency was added (BOS-898). It goes through
// moveTicket (DR-047 points 4 to 6, BOS-922), so the column follows the state and the history line says why.
import type { SystemState } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import type { tickets } from "../db/schema.js";
import { moveTicket } from "./ticket-moves.js";
import { WorkError } from "./ticket-links.js";

/**
 * Moves the ticket to `to` only if it is now in one of the `from` states (any state when `from` is left out). Returns the updated row, or null when
 * the guard didn't match or the ticket is gone (nothing changes and nothing is recorded). Writes "<old> -> <new>: <reason>".
 * Boss Man's own move: it skips the column's WIP limit, and wakes stay with the caller.
 */
export async function systemMoveTicket(
  db: Db,
  input: { ticketId: string; from?: SystemState[]; to: SystemState; reason: string; now: Date; /** Replaces the ticket's state note in the same write (a release says what freed it). */ stateNote?: string },
): Promise<typeof tickets.$inferSelect | null> {
  try {
    const fields = input.stateNote ? { stateNote: input.stateNote, stateNoteAt: input.now } : undefined;
    const { ticket } = await moveTicket(db, input.ticketId, input.to, { from: input.from, note: input.reason, overLimit: true, internal: true, now: input.now, fields });
    return ticket;
  } catch (e) {
    if (e instanceof WorkError && (e.status === 409 || e.status === 404)) return null;
    throw e;
  }
}
