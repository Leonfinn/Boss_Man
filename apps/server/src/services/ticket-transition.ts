// The system (not a person or an agent) moves a ticket from one state to another because of something that
// happened elsewhere: a blocker finished, a decision closed, a dependency was added (BOS-898). One guarded
// update plus the `state` activity row with the reason, so the ticket's history shows why it moved.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { tickets } from "../db/schema.js";
import { record } from "./activity.js";

type TicketState = (typeof tickets.$inferSelect)["systemState"];

/**
 * Moves the ticket to `to` only if it is now in one of the `from` states (any state when `from` is left out). Returns the updated row, or null when
 * the guard didn't match (nothing changes and nothing is recorded). Writes "<old> -> <new>: <reason>".
 */
export async function systemMoveTicket(
  db: Db,
  input: { ticketId: string; from?: TicketState[]; to: TicketState; reason: string; now: Date },
): Promise<typeof tickets.$inferSelect | null> {
  const [before] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, input.ticketId));
  if (!before || (input.from && !input.from.includes(before.state))) return null;
  const [t] = await db
    .update(tickets)
    .set({ systemState: input.to, lastActivityAt: input.now })
    .where(and(eq(tickets.id, input.ticketId), input.from ? inArray(tickets.systemState, input.from) : undefined))
    .returning();
  if (!t) return null;
  // Same state (e.g. already blocked and held again) is not a move; the history stays quiet.
  if (before.state !== t.systemState) {
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: "state", summary: `${before.state} -> ${t.systemState}: ${input.reason}`, at: input.now });
  }
  return t;
}
