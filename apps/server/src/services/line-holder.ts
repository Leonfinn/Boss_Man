// R32 (BOS-1669): a ticket that holds the merge line and is sent back by the gate wakes the CEO too, not only its
// assignee. Without it a promise like "if the fix fails I'll tell you" has nothing to trigger it: the CEO can't book a
// check on another agent's ticket, and the gate told only the assignee (16 Nov, BOS-1641).
import { and, eq, ne, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, ticketDependencies, tickets } from "../db/schema.js";
import { MERGE_LINE_KIND } from "./merge-line.js";

/** Activity kind main-ci.ts records when it opens a main-CI fix ticket. */
const MAIN_CI_OPENED = "main_ci_failure";

export type LineHolder = { why: "fixes_merge_check" | "main_ci"; waiting: number; attempt: number; ref: string | null; title: string };

/**
 * Whether this ticket holds the merge line, and what the CEO needs to know: why, how many open tickets wait on it, and
 * which merge attempt this was. Holds it: marked fixesMergeCheck (every approved ticket in the project waits on it in
 * review), or a main-CI fix ticket that at least one open ticket waits on. A main-CI ticket nobody waits on holds
 * nothing back, and ordinary waits-on links (a parent on its sub-task) are left out on purpose: the CEO would be woken
 * for every sub-task send-back. Null otherwise.
 */
export async function lineHolder(db: Db, ticketId: string): Promise<LineHolder | null> {
  const [t] = await db
    .select({ id: tickets.id, projectId: tickets.projectId, fixesMergeCheck: tickets.fixesMergeCheck, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(eq(tickets.id, ticketId));
  if (!t) return null;
  const linked = await db
    .select({ id: ticketDependencies.blockedTicketId })
    .from(ticketDependencies)
    .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
    .where(and(eq(ticketDependencies.blockerTicketId, ticketId), ne(tickets.systemState, "done")));
  const waiting = new Set(linked.map((l) => l.id).filter((id): id is string => !!id && id !== ticketId));
  let why: LineHolder["why"] | null = null;
  if (t.fixesMergeCheck) {
    why = "fixes_merge_check";
    // mergeWaits: every other approved ticket in the project waits on a fixesMergeCheck ticket; those in review are held.
    const held = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.projectId, t.projectId), eq(tickets.systemState, "review"), ne(tickets.id, ticketId)));
    for (const h of held) waiting.add(h.id);
  } else if (waiting.size) {
    const [opened] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MAIN_CI_OPENED))).limit(1);
    if (opened) why = "main_ci";
  }
  if (!why) return null;
  const [a] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(activity)
    .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND), sql`${activity.detail}->>'event' = 'attempt'`));
  return { why, waiting: waiting.size, attempt: Math.max(1, Number(a?.n ?? 0)), ref: ticketRef(t.prefix, t.number), title: t.title };
}

/** The CEO's note for a line holder sent back by the gate. */
export function lineHolderNote(h: LineHolder, what: string, assignee: string | null): string {
  const name = h.ref ? `${h.ref} "${h.title}"` : `"${h.title}"`;
  const marked = h.why === "fixes_merge_check" ? "it's marked as fixing the merge check" : "it's the fix for main's failing CI";
  const waits = h.waiting === 0 ? "no ticket waits on it yet" : `${h.waiting} ticket${h.waiting === 1 ? " waits" : "s wait"} on it`;
  return `The merge gate sent ${name} back to ${assignee ?? "its assignee"} on merge attempt ${h.attempt}: ${what}. It holds the merge line (${marked}; ${waits}). If you told the owner you'd say when it failed, tell them now, and make sure ${assignee ?? "someone"} is on it.`;
}

/** Wakes the CEO once for this send-back when the ticket holds the line; nothing when it doesn't or the CEO is its assignee. Never throws. */
export async function tellCeoLineHolderSentBack(
  db: Db,
  wake: ((agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>) | null | undefined,
  t: { id: string; companyId: string; assigneeAgentId: string | null },
  what: string,
): Promise<boolean> {
  try {
    if (!wake) return false;
    const h = await lineHolder(db, t.id);
    if (!h) return false;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
    if (!ceo || ceo.id === t.assigneeAgentId) return false;
    const [who] = t.assigneeAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId)) : [];
    await wake(ceo.id, { ticketId: t.id, reason: "line holder sent back", note: lineHolderNote(h, what, who?.name ?? null), priority: 2 });
    return true;
  } catch (err) {
    // A note to the CEO must never stop the send-back itself.
    console.warn(`line holder wake failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
