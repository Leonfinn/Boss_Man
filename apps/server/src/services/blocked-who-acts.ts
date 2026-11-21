// R36 (BOS-1679): a Blocked hold must name who acts. A note that names a colleague needs a link to their ticket
// (a date only wakes the ticket's own assignee), and a ticket parked by date again and again goes to the CEO.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity, agents } from "../db/schema.js";
import { record } from "./activity.js";
import type { BlockedHold } from "./ticket-links.js";

/** This many date-only parks in a row, with no link between them, wake the CEO once. */
export const DATE_PARK_LIMIT = 3;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The name of another agent in the company that the text names (full name, or the first name before " - "), or null. */
export async function namedColleague(db: Db, companyId: string, selfAgentId: string | null | undefined, text: string): Promise<string | null> {
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId));
  for (const a of rows) {
    if (a.id === selfAgentId) continue;
    const first = a.name.split(" - ")[0]!.trim();
    // Exact, case-sensitive names: precise, unlike a word list. A one- or two-letter name is too loose to match.
    for (const n of new Set([a.name, first])) {
      if (n.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, "u").test(text)) return first;
    }
  }
  return null;
}

export const NAMED_AGENT_REFUSAL = (name: string) =>
  `This note says the ticket waits on ${name}, but nothing tells ${name}: a date only wakes you. Link ${name}'s ticket first (update_ticket waitsOn add, until done), or ask the CEO to open one for ${name} with this ticket as waitsOn, then move it to Blocked again. If ${name} is not what holds it, leave their name out of the note.`;

/** Whether a Blocked move names a colleague and has nothing but a date (or nothing) behind it. Go-live and checks holds don't need a name. */
export async function refusalForNamedAgent(db: Db, input: { companyId: string; agentId: string | null | undefined; text: string; holds: BlockedHold[] }): Promise<string | null> {
  if (input.holds.some((h) => h.kind === "blocker" || h.kind === "card" || h.kind === "go_live")) return null;
  // BOS-2141: "merged_watch" no longer exempts a note that names a colleague: the watch wakes the assignee, not them.
  const name = await namedColleague(db, input.companyId, input.agentId, input.text);
  if (name) return NAMED_AGENT_REFUSAL(name);
  // BOS-2141: on merged work a note that says it waits on another ticket (BOS-123) needs that ticket linked too.
  if (input.holds.some((h) => h.kind === "merged_watch")) {
    const ref = WAITS_ON_TICKET.exec(input.text)?.[1];
    if (ref) return NAMED_TICKET_REFUSAL(ref);
  }
  return null;
}

/** "waiting on Moony, BOS-2078", "blocked by BOS-12": a wait word, then a ticket number a few words later. */
const WAITS_ON_TICKET = /\b(?:[Ww]ait(?:s|ing)?|[Bb]locked|[Hh]eld|[Pp]arked|[Ss]tuck)\b[^.\n]{0,60}?\b([A-Z]{2,6}-\d+)\b/;

export const NAMED_TICKET_REFUSAL = (ref: string) =>
  `This note says the ticket waits on ${ref}, but nothing links it: a date only wakes you. Link ${ref} first (update_ticket waitsOn add, until merged or done), then move it to Blocked again. If ${ref} is not what holds it, leave it out of the note.`;

/**
 * Records how this Blocked move was held and says whether this is the 3rd date-only park in a row (no link or card between,
 * none alerted yet). Returns the number to alert on, else null.
 */
export async function noteBlockedPark(db: Db, input: { companyId: string; ticketId: string; agentId: string | null | undefined; holds: BlockedHold[]; at: Date }): Promise<number | null> {
  const dateOnly = input.holds.length > 0 && input.holds.every((h) => h.kind === "date");
  await record(db, { companyId: input.companyId, ticketId: input.ticketId, agentId: input.agentId ?? null, kind: dateOnly ? "date_park" : "date_park_reset", summary: dateOnly ? "Parked by date, no link" : "Blocked with a link, card or go-live wait", at: input.at });
  if (!dateOnly) return null;
  const rows = await db
    .select({ kind: activity.kind })
    .from(activity)
    .where(and(eq(activity.ticketId, input.ticketId), inArray(activity.kind, ["date_park", "date_park_reset", "date_park_alert"])))
    .orderBy(desc(activity.at), desc(activity.id));
  let n = 0;
  for (const r of rows) {
    if (r.kind !== "date_park") break;
    n++;
  }
  if (n !== DATE_PARK_LIMIT) return null;
  await record(db, { companyId: input.companyId, ticketId: input.ticketId, kind: "date_park_alert", summary: `CEO told: parked by date ${n} times in a row`, at: new Date(input.at.getTime() + 1) });
  return n;
}
