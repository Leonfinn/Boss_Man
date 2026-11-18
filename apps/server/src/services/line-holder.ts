// R32 (BOS-1669): a ticket that holds the merge line and is sent back by the gate wakes the CEO too, not only its
// assignee. Without it a promise like "if the fix fails I'll tell you" has nothing to trigger it: the CEO can't book a
// check on another agent's ticket, and the gate told only the assignee (16 Nov, BOS-1641).
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, reviewHolds, reviewHoldWaits, settings, ticketDependencies, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { mainCiFailures } from "./main-ci.js";
import { MERGE_LINE_KIND } from "./merge-line.js";
import { githubOnlyScope, waitsOnFix } from "./review-holds.js";

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
    // R40: a fix for a GitHub-only red holds only the tickets that touch it (waitsOnFix), so only those count.
    const held = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.projectId, t.projectId), eq(tickets.systemState, "review"), ne(tickets.id, ticketId)));
    for (const h of held) if (await waitsOnFix(db, { id: h.id, projectId: t.projectId }, ticketId)) waiting.add(h.id);
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

/**
 * R40 (BOS-1685): the warning for setting fixesMergeCheck on a main-CI watcher ticket, or "" for any other ticket.
 * Such a red is GitHub's: the gate's own check doesn't see it, so the mark holds only what touches the red.
 */
export async function githubOnlyMarkWarning(db: Db, ticketId: string): Promise<string> {
  const [opened] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MAIN_CI_OPENED))).limit(1);
  if (!opened) return "";
  const [t] = await db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return "";
  const scope = await githubOnlyScope(db, t.projectId, ticketId);
  if (!scope)
    return " Warning: this is a main-CI ticket, and Boss Man can't tell which files its failure covers (the error lines name no file it could find, or the gate's own check of main is red too), so the mark holds every approved merge in the project until this fix is in force.";
  const jobs = [...new Set((await mainCiFailures(db, t.projectId)).filter((o) => o.ticketId === ticketId).map((o) => o.job).filter(Boolean))];
  return ` Warning: this is a GitHub-only red: the gate's own check doesn't see it. The mark holds only approved tickets that change ${scope.join(", ")} (or .github/, or a file at the repo root); the rest keep merging, and their GitHub failure in ${jobs.join(", ") || "the same job"}, when it matches main's exactly, is taken as main's. If the gate's own check fails too, mark a separate gate-fault ticket.`;
}

/** The CEO's note for a line holder sent back by the gate. */
export function lineHolderNote(h: LineHolder, what: string, assignee: string | null): string {
  const name = h.ref ? `${h.ref} "${h.title}"` : `"${h.title}"`;
  const marked = h.why === "fixes_merge_check" ? "it's marked as fixing the merge check" : "it's the fix for main's failing CI";
  const waits = h.waiting === 0 ? "no ticket waits on it yet" : `${h.waiting} ticket${h.waiting === 1 ? " waits" : "s wait"} on it`;
  return `The merge gate sent ${name} back to ${assignee ?? "its assignee"} on merge attempt ${h.attempt}: ${what}. It holds the merge line (${marked}; ${waits}). If you told the owner you'd say when it failed, tell them now, and make sure ${assignee ?? "someone"} is on it.`;
}

/** Activity kinds (R40): one per send-back of a line holder, and the once-per-fix quarantine-or-revert wake. */
export const LINE_HOLDER_SENT_BACK = "line_holder_sent_back";
export const LINE_HOLDER_ESCALATED = "line_holder_escalated";
/** A main fix holding merges this long wakes the CEO with the choice (R40). */
export const STUCK_HOLDER_MS = 2 * 60 * 60_000;
const ESCALATED_KEY = (ticketId: string) => `line_holder_escalated:${ticketId}`;

/**
 * The CEO's choice for a main fix that keeps failing (R40, BOS-1685): set the failing test aside with a ticket to fix
 * it, or revert. Revert is offered only for a suspect commit R41 found (a commit since the last green run that changed
 * the failing job's files): "where main was when it failed" is not a cause (BOS-1641's 24b77dd8 didn't touch the test).
 */
export async function quarantineOrRevert(db: Db, fix: { id: string; projectId: string }): Promise<string> {
  const suspects = (await mainCiFailures(db, fix.projectId)).filter((o) => o.ticketId === fix.id).flatMap((o) => o.suspects ?? []);
  const seen = new Set<string>();
  const top = suspects.filter((s) => !seen.has(s.sha) && seen.add(s.sha)).slice(0, 3);
  const quarantine = "Quarantine: set the failing test aside with a linked ticket to fix it properly, then clear the fix's merge-check mark so the line moves.";
  if (!top.length) return `Choose one. ${quarantine} No suspect commit since the last green run changed the failing files, so don't revert.`;
  const [first, ...more] = top;
  const line = (s: { sha: string; message: string; reason: string }) => `${s.sha.slice(0, 8)} "${s.message.split("\n")[0]!.slice(0, 100)}" (${s.reason})`;
  return `Choose one. ${quarantine} Or revert ${line(first!)}${more.length ? `; other suspects: ${more.map(line).join("; ")}` : ""}.`;
}

/** Claims the one quarantine-or-revert wake for this fix (R40): an insert on a unique key, so two callers never both win. */
async function claimEscalation(db: Db, t: { id: string; companyId: string }, why: string): Promise<boolean> {
  const won = await db.insert(settings).values({ key: ESCALATED_KEY(t.id), value: { at: new Date().toISOString(), why } }).onConflictDoNothing({ target: settings.key }).returning({ key: settings.key });
  if (!won.length) return false;
  await record(db, { companyId: t.companyId, ticketId: t.id, kind: LINE_HOLDER_ESCALATED, summary: `This fix holds the merge line and ${why}, so Boss Man asked the CEO to quarantine the failing test or revert.` });
  return true;
}

/**
 * R40: wakes the CEO once per main fix that has held approved merges for STUCK_HOLDER_MS: an open fixesMergeCheck
 * ticket that an open hold waits on. The hold's age counts from no earlier than the fix ticket's creation (a hold
 * that gained this wait later can't have waited on it before it existed). Nothing when the CEO is its assignee.
 */
export async function escalateStuckLineHolders(db: Db, now: Date, wake: (input: { agentId: string; reason: string; ticketId: string; note: string; priority: number }) => Promise<unknown>): Promise<number> {
  const fixes = await db
    .select({ id: tickets.id, companyId: tickets.companyId, projectId: tickets.projectId, assignee: tickets.assigneeAgentId, createdAt: tickets.createdAt })
    .from(tickets)
    .where(and(eq(tickets.fixesMergeCheck, true), ne(tickets.systemState, "done")));
  let woken = 0;
  for (const f of fixes) {
    const [h] = await db
      .select({ at: sql<Date>`min(${reviewHolds.createdAt})` })
      .from(reviewHoldWaits)
      .innerJoin(reviewHolds, eq(reviewHolds.id, reviewHoldWaits.holdId))
      .where(and(eq(reviewHoldWaits.blockerTicketId, f.id), eq(reviewHolds.status, "open")));
    if (!h?.at) continue;
    const since = Math.max(new Date(h.at).getTime(), f.createdAt.getTime());
    if (now.getTime() - since < STUCK_HOLDER_MS) continue;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo || ceo.id === f.assignee) continue;
    const holder = await lineHolder(db, f.id);
    if (!holder || !(await claimEscalation(db, f, "has held merges for over 2 hours"))) continue;
    const name = holder.ref ? `${holder.ref} "${holder.title}"` : `"${holder.title}"`;
    await wake({ agentId: ceo.id, reason: "line holder stuck", ticketId: f.id, priority: 2, note: `${name} has held the merge line for over 2 hours (${holder.waiting} ticket${holder.waiting === 1 ? " waits" : "s wait"} on it). ${await quarantineOrRevert(db, f)} You get this once for this fix.` });
    woken++;
  }
  return woken;
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
    // R40: from the second send-back, the note ends with the quarantine-or-revert choice, once per fix (claimEscalation).
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: LINE_HOLDER_SENT_BACK, summary: `Sent back while it holds the merge line: ${what.slice(0, 200)}` });
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, LINE_HOLDER_SENT_BACK)));
    const [fix] = await db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, t.id));
    const choice = Number(n?.n ?? 0) >= 2 && fix && (await claimEscalation(db, t, "was sent back twice")) ? ` It has been sent back ${n!.n} times. ${await quarantineOrRevert(db, { id: t.id, projectId: fix.projectId })}` : "";
    await wake(ceo.id, { ticketId: t.id, reason: "line holder sent back", note: `${lineHolderNote(h, what, who?.name ?? null)}${choice}`, priority: 2 });
    return true;
  } catch (err) {
    // A note to the CEO must never stop the send-back itself.
    console.warn(`line holder wake failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
