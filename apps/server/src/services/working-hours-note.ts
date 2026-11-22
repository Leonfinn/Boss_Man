// BOS-2200: why a ticket's agent hasn't started it when the agent is outside its working hours, in the words
// the ticket card shows: "Waiting for Dylan's working hours, from 00:00". A ticket whose own wake is held,
// or whose assignee has a wake held (the wakes of one agent merge), gets the line.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { WORKING_HOURS_REASON, waitingText } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, wakes } from "../db/schema.js";

export async function workingHoursNotes(db: Db, tickets: Array<{ id: string; assigneeAgentId: string | null }>, now: Date = new Date()): Promise<Map<string, string>> {
  // lost on restart, harmless because it is built fresh inside each call and returned, never kept between calls
  const out = new Map<string, string>();
  if (!tickets.length) return out;
  const assigneeIds = [...new Set(tickets.map((t) => t.assigneeAgentId).filter((x): x is string => !!x))];
  const held = await db
    .select({ ticketId: wakes.ticketId, agentId: wakes.agentId, until: wakes.notBefore, name: agents.name, hours: agents.workingHours })
    .from(wakes)
    .innerJoin(agents, eq(agents.id, wakes.agentId))
    .where(and(eq(wakes.status, "deferred"), eq(wakes.statusReason, WORKING_HOURS_REASON), or(inArray(wakes.ticketId, tickets.map((t) => t.id)), assigneeIds.length ? inArray(wakes.agentId, assigneeIds) : sql`false`)));
  for (const t of tickets) {
    const h = held.find((w) => w.ticketId === t.id) ?? (t.assigneeAgentId ? held.find((w) => w.agentId === t.assigneeAgentId) : undefined);
    if (h?.until && h.hours) out.set(t.id, waitingText(h.name, h.until, now, h.hours.timeZone));
  }
  return out;
}
