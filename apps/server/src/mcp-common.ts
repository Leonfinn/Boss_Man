// Small helpers every MCP tool file shares (BOS-298 step 15): kept here so the tool files split out of
// mcp.ts import them without importing mcp.ts back.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { afterMergeLint, isAfterMerge, readVerdicts, stateNoteLine, ticketRef, type Criterion } from "@boss-man/shared";
import type { Db } from "./db/client.js";
import { agents, companies, projects, tickets, wakes } from "./db/schema.js";

/** Why the watcher is woken when everything in its watched tree has stopped; the wake's note names the tree's root ticket. */
export const TREE_REASON = "tree stopped";
export const TREE_ROOT_LINE = /^Tree of ticket ([0-9a-f-]{36})$/gm;

export const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
/** Shared wording for every tool that takes the "fixes live" marker (BOS-639). */
export const FIXES_LIVE_HELP =
  "Only for a ticket that fixes a problem on the live server now: one sentence naming the symptom the owner sees, e.g. \"server freezes as memory climbs\". When it merges the CEO is woken, and the deploy card is headed \"Urgent: contains the fix for <symptom> (BOS-n)\", pages the owner once and sorts first. Set it by hand; never because the ticket is high priority or urgent.";

/** The plain-words warning for a live-looking criterion that isn't marked after merge; a trailing blank line for the reply. */
export const criteriaWarning = (criteria: readonly Criterion[] | undefined) => {
  const w = criteria?.length ? afterMergeLint(criteria) : "";
  return w ? `\n\nHeads-up: ${w}` : "";
};

/**
 * The heads-up a code ticket gets when it will be hard to pick up (BOS-595): no description, so the
 * person who gets it has only a title to go on, or no assignee, so it waits in the backlog for someone
 * to take it. It still creates the ticket; the warning is a nudge to fill the gap, not a refusal.
 */
export const thinTicketWarning = (body: string | null | undefined, assignee: string | undefined) => {
  const gaps = [!body?.trim() ? "no description (say what done looks like)" : "", !assignee ? "no assignee" : ""].filter(Boolean);
  return gaps.length ? `\n\nHeads-up: this ticket has ${gaps.join(" and ")}. Add the missing part with update_ticket so whoever takes it can start without asking.` : "";
};

export async function findProject(db: Db, scope: Scope, project?: string) {
  const rows = await db.select().from(projects).where(and(eq(projects.companyId, scope.companyId), isNull(projects.archivedAt)));
  if (project) return rows.find((p) => p.id === project || p.name.toLowerCase() === project.toLowerCase()) ?? null;
  return rows.length === 1 ? rows[0]! : null;
}

// A run woken with "tree stopped" may act only on the watched ticket and its sub-tasks; returns the refusal text, or null.
export async function treeRefusal(db: Db, scope: Scope, ticketId: string | undefined): Promise<string | null> {
  const [w] = await db.select({ note: wakes.note }).from(wakes).where(and(eq(wakes.runId, scope.runId), eq(wakes.reason, TREE_REASON)));
  if (!w) return null;
  // Wakes for several trees of one watcher can merge, so the note may name more than one root.
  const roots = [...(w.note ?? "").matchAll(TREE_ROOT_LINE)].map((m) => m[1]!);
  const inside = roots.length && ticketId ? await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, ticketId), or(inArray(tickets.id, roots), inArray(tickets.parentTicketId, roots)))) : [];
  return inside.length ? null : "Refused: this run was woken to watch one task and its sub-tasks, and may only change those. That ticket is outside the tree.";
}

// CEOs and managers hand work to a colleague by name; returns the agent's id or the refusal text.
export async function delegateTarget(db: Db, scope: Scope, name: string): Promise<{ id: string } | { error: string }> {
  if (!(await managerIn(db, scope))) return { error: "Only your company's CEO or a manager can assign tickets to colleagues." };
  // The PA only answers the owner from read-only tools, so it can't take ticket work.
  const team_ = await db.select({ id: agents.id, name: agents.name, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, scope.companyId), isNull(agents.retiredAt), sql`${agents.duty} is distinct from 'assistant'`));
  const a = team_.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!a) return { error: `No active agent called ${name} in your company. Valid names: ${team_.map((x) => x.name).join(", ")}.` };
  // The work service lets the owner assign to a paused agent, but the wake would sit unanswered; an agent shouldn't hand work to a dead end.
  if (a.paused) return { error: `${a.name} is paused, so they would not pick it up. Pick someone else.` };
  return { id: a.id };
}

export type Scope = { companyId: string; agentId: string | null; runId: string };

/** Shows a company's ticket numbers as references (HOL-12). */
export async function refsOf(db: Db, companyId: string) {
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  return <T extends { number: number | null }>({ number, ...r }: T) => ({ ref: ticketRef(c?.prefix, number), ...r });
}

export const withNote = <T extends { stateNote: string | null; stateNoteAt: Date | null; lastActivityAt: Date; stateNoteStaleAt?: Date | null }>({ stateNote, stateNoteAt, stateNoteStaleAt, ...r }: T) => {
  const note = stateNoteLine({ stateNote, stateNoteAt, stateNoteStaleAt, lastActivityAt: r.lastActivityAt }, new Date());
  return note ? { ...r, stateNote: note } : r;
};

export async function managerIn(db: Db, scope: Scope) {
  const [me] = scope.agentId ? await db.select({ role: agents.role }).from(agents).where(eq(agents.id, scope.agentId)) : [];
  return me?.role === "ceo" || me?.role === "manager";
}

export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
export const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** A lossless cap: at most n chars of s from offset; when there's more, says how much and how to get it. */
export const cut = (s: string, n: number, how: (next: number) => string, offset = 0) =>
  s.length <= offset + n ? s.slice(offset) : `${s.slice(offset, offset + n)}\n\n… ${s.length - offset - n} more chars; ${how(offset + n)}`;
export const CAP = 40_000;

/** A reference like HOL-12 (any prefix: an old one still finds the number). */
export const REF = /^[A-Za-z0-9]{1,10}-(\d{1,9})$/;

/** One line per criterion with the author's verdict, the after-merge ones marked so they read as skippable (DR-024 #5). */
export function criterionLines(criteria: readonly Criterion[], note: string | null): string[] {
  return readVerdicts(criteria, note).map((r, i) => `- [${r.verdict ?? "not reported"}] ${r.criterion}${isAfterMerge(criteria[i]!) ? " (checked after merge; don't fail the review on it)" : ""}`);
}
