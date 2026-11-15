// BOS-1516: the group a Priority 1 ticket belongs to, so the owner is paged once when the last of its work has merged, not once
// per ticket (the owner's rule of 15 Nov: one page when all 3 check worker parts had merged).
//
// A group is every ticket joined to it by a parent link (both ways), a waits-on link (both ways), or the same feature when the
// other ticket carries the owner's Priority 1 mark too (a Priority 1 feature marks all its open tickets). The closure is
// followed up to MAX_GROUP tickets. A ticket counts as finished once it has merged or is done (a cancelled one too: it no longer
// holds the page back).
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, ticketDependencies, tickets } from "../db/schema.js";
import { readyHeading, type DeployUrgent } from "./decisions.js";

const MAX_GROUP = 200;

type Member = { id: string; state: string; mergedAt: Date | null; mergeCommit: string | null; urgentByOwner: boolean; featureId: string | null; parentTicketId: string | null };

/** Merged (a ticket riding along on another's merge has a commit but no mergedAt) or done. */
export const isFinished = (t: Pick<Member, "state" | "mergedAt" | "mergeCommit">) => t.state === "done" || t.mergedAt !== null || t.mergeCommit !== null;

const columns = { id: tickets.id, state: tickets.systemState, mergedAt: tickets.mergedAt, mergeCommit: tickets.mergeCommit, urgentByOwner: tickets.urgentByOwner, featureId: tickets.featureId, parentTicketId: tickets.parentTicketId };

/** The group of a ticket (itself included), each member with whether it has finished. */
export async function priorityGroup(db: Db, ticketId: string): Promise<Array<{ id: string; finished: boolean }>> {
  const seen = new Map<string, Member>();
  let frontier = [ticketId];
  while (frontier.length && seen.size < MAX_GROUP) {
    const rows = await db.select(columns).from(tickets).where(inArray(tickets.id, frontier));
    for (const r of rows) seen.set(r.id, r);
    const ids = rows.map((r) => r.id);
    const next = new Set<string>();
    // Parent links, both ways.
    for (const r of rows) if (r.parentTicketId) next.add(r.parentTicketId);
    for (const c of await db.select({ id: tickets.id }).from(tickets).where(inArray(tickets.parentTicketId, ids))) next.add(c.id);
    // Waits-on links, both ways (ticket blockers only).
    for (const d of await db.select().from(ticketDependencies).where(or(inArray(ticketDependencies.blockedTicketId, ids), inArray(ticketDependencies.blockerTicketId, ids)))) {
      next.add(d.blockedTicketId);
      if (d.blockerTicketId) next.add(d.blockerTicketId);
    }
    // The same feature, only for tickets carrying the owner's mark (a Priority 1 feature marked them all).
    const features = [...new Set(rows.filter((r) => r.urgentByOwner && r.featureId).map((r) => r.featureId!))];
    if (features.length) {
      for (const f of await db.select({ id: tickets.id }).from(tickets).where(and(inArray(tickets.featureId, features), eq(tickets.urgentByOwner, true)))) next.add(f.id);
    }
    frontier = [...next].filter((id) => !seen.has(id));
  }
  return [...seen.values()].map((m) => ({ id: m.id, finished: isFinished(m) }));
}

/**
 * BOS-1516: the "Ready to put live" mark for a deploy card a company's own agent raises for this ticket: set when the ticket
 * carries the owner's Priority 1 mark and its whole group has merged. `repeat`: an earlier deploy card already named it, so no
 * second page. Undefined otherwise (the card is a plain ask).
 */
export async function readyUrgentFor(db: Db, ticketId: string): Promise<DeployUrgent | undefined> {
  const [r] = await db
    .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, title: tickets.title, urgent: tickets.urgent, byOwner: tickets.urgentByOwner })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(eq(tickets.id, ticketId));
  if (!r || !r.urgent || !r.byOwner) return undefined;
  const ref = ticketRef(r.prefix, r.number);
  if (!ref || !(await priorityGroup(db, r.id)).every((m) => m.finished)) return undefined;
  const fixes = [{ ticketId: r.id, ref, symptom: r.title }];
  const [earlier] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(sql`${decisions.context}->'urgent'->'fixes' @> ${JSON.stringify([{ ticketId: r.id }])}::jsonb`)
    .limit(1);
  return { heading: readyHeading(fixes), fixes, kind: "ready", ...(earlier ? { repeat: true } : {}) };
}
