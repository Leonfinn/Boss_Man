// BOS-2115: create_ticket looks for an open ticket, or one done in the last 14 days, in the same
// company and project whose title shares key words with the new one, and refuses once with the
// list. The caller repeats the call with notDuplicateOf (nothing is created, that ticket is
// returned) or notDuplicateReason (one line, kept on the new ticket). Word overlap on titles only:
// no model call. Follow-ups Boss Man opens itself and sub-tasks never come through here.
import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, tickets } from "../db/schema.js";

export const DUPLICATE_WINDOW_DAYS = 14;
const LISTED_MAX = 5;

export const DUPLICATE_HELP = "notDuplicateOf: a ticket ref (like BOS-42) when one of the tickets listed already covers this; nothing is created and that ticket is returned. notDuplicateReason: one line (up to 240 characters) saying why this is different, kept on the new ticket. Boss Man refuses a create once when open or recently done tickets in the project have similar titles, and lists them.";

/** Words too common in ticket titles to say two tickets are about the same thing. Edit this list only. */
const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "when", "not", "are", "its", "into", "than", "then", "ticket", "tickets", "add", "fix", "make", "use", "new", "all", "one", "can", "per", "show", "shows", "list", "get", "set", "has", "have", "does", "doesn", "after", "before", "only", "each", "any", "too", "out", "off", "now", "page", "test", "tests"]);

/** The key words of a title: lower case, at least 3 characters, not a stop word, each once. A trailing "s" is dropped so "tickets" and "ticket" match. */
export function titleWords(title: string): Set<string> {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).map((raw) => (raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw));
  return new Set(words.filter((w) => w.length >= 3 && !STOP_WORDS.has(w)));
}

/** Similar when they share three key words, or two that make up at least 60% of the shorter title's key words. */
export function similarTitles(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const smaller = Math.min(wa.size, wb.size);
  return shared >= 3 || (shared >= 2 && shared >= smaller * 0.6);
}

export type SimilarTicket = { id: string; ref: string | null; title: string; state: string };

/** Open tickets, and tickets done (not cancelled) in the last 14 days, in the project with a similar title. */
export async function similarTickets(db: Db, companyId: string, projectId: string, title: string, now = new Date()): Promise<SimilarTicket[]> {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 24 * 3_600_000);
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, state: tickets.systemState, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(eq(tickets.companyId, companyId), eq(tickets.projectId, projectId), or(ne(tickets.systemState, "done"), and(gt(tickets.stateChangedAt, since), sql`${tickets.outcome} is distinct from 'cancelled'`))));
  return rows.filter((r) => similarTitles(title, r.title)).map((r) => ({ id: r.id, ref: ticketRef(r.prefix, r.number), title: r.title, state: r.state }));
}

export function duplicateRefusal(list: SimilarTicket[]): string {
  const shown = list.slice(0, LISTED_MAX).map((t) => `- ${t.ref ?? t.id} "${t.title}" (${t.state})`).join("\n");
  const more = list.length > LISTED_MAX ? `\n(and ${list.length - LISTED_MAX} more)` : "";
  return `Nothing was created: open or recently done tickets in this project have similar titles:\n${shown}${more}\nIf one of them already covers this, call create_ticket again with notDuplicateOf set to its ref (nothing is created and you get that ticket back). If yours is different, call it again with notDuplicateReason (one line saying why); the reason is kept on the new ticket.`;
}
