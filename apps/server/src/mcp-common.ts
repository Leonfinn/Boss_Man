// Small helpers every MCP tool file shares (BOS-298 step 15): kept here so the tool files split out of
// mcp.ts import them without importing mcp.ts back.
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { afterMergeLint, criterionText, isAfterMerge, readVerdicts, stateNoteLine, ticketRef, type Criterion } from "@boss-man/shared";
import type { Db } from "./db/client.js";
import { agents, companies, projects, tickets, wakes } from "./db/schema.js";

/** Why the watcher is woken when everything in its watched tree has stopped; the wake's note names the tree's root ticket. */
export const TREE_REASON = "tree stopped";
export const TREE_ROOT_LINE = /^Tree of ticket ([0-9a-f-]{36})$/gm;

export const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
/** Shared wording for every tool that takes the "fixes live" marker (BOS-639). */
export const FIXES_LIVE_HELP =
  "Only for a ticket that fixes a problem on the live server now: one sentence naming the symptom the owner sees, e.g. \"server freezes as memory climbs\". When it merges the CEO is woken, and the deploy card is headed \"Urgent: contains the fix for <symptom> (BOS-n)\", pages the owner once and sorts first. Set it by hand; never because the ticket is high priority or urgent.";

/** Shared wording for the "fixes the merge check" mark (BOS-1173). */
export const FIXES_MERGE_CHECK_HELP =
  "True on the ticket that fixes a merge check broken for reasons no branch caused (a runner or gate fault that fails every branch). While it is open and its fix isn't merged and live, every other approved ticket in the project waits on it in Review as \"Passed, held / waits on BOS-n\": its check doesn't run, it isn't sent back, and its reviews and sign-off stand. Once the fix is merged and live (runners rebuilt, for runner code), those merges start again by themselves. False clears it. Set it only for a real gate fault, never for a branch's own failure.";

/** What finished work does while it can't merge yet (BOS-1173): the one sentence every tool that moves tickets repeats. */
export const FINISHED_STAYS_IN_REVIEW =
  "Finished work goes to review and stays there, even when it can't merge yet: a ticket waiting on another ticket's fix (a waits-on link, or a ticket marked fixesMergeCheck) waits in review as \"Passed, held\" with its approvals kept, and merges by itself once that fix is merged and live. Don't move it out to wait.";

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

export const withNote = <T extends { stateNote: string | null; stateNoteAt: Date | null; lastActivityAt: Date; stateNoteStaleAt?: Date | null; stateNoteStaleReason?: string | null }>({ stateNote, stateNoteAt, stateNoteStaleAt, stateNoteStaleReason, ...r }: T) => {
  const note = stateNoteLine({ stateNote, stateNoteAt, stateNoteStaleAt, stateNoteStaleReason, lastActivityAt: r.lastActivityAt }, new Date());
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

/**
 * Write-time advice only (BOS-989): a summary that names another ticket (BOS-12, or a ticket id) close to "wait",
 * "after" or "blocked" is an ordering written as prose, which nothing acts on. Returns the one line to add to the
 * tool's reply, or "" when there is nothing to say. Never a refusal.
 */
export function waitsOnAdvice(summary: string | undefined | null): string {
  if (!summary) return "";
  const ticket = /\b[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const cue = /\b(waits?|waiting|after|blocked)\b/i;
  for (const m of summary.matchAll(ticket)) {
    const near = summary.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30);
    if (cue.test(near)) return "\nTip: use update_ticket waitsOn to make this a real link, so you are woken when it is merged or done.";
  }
  return "";
}

/** An ordering written as prose: "after BOS-12", "waits on BOS-12", "once BOS-12 lands/merges/is done" (BOS-1375). */
const ORDER_PROSE = /\b(?:after|waits?\s+on|waiting\s+on|once)\s+([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})\b/gi;

/**
 * Write-time warning (BOS-1375): the title or body says a ticket comes after BOS-n, but the ticket has no waits-on
 * link to it. `linkedNumbers` are the numbers it already waits on. Returns "" when nothing is missing; never a refusal.
 */
export function unlinkedOrderWarning(texts: ReadonlyArray<string | null | undefined>, linkedNumbers: ReadonlySet<number>): string {
  const missing = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(ORDER_PROSE)) {
      const ref = m[1]!;
      if (!linkedNumbers.has(Number(ref.slice(ref.lastIndexOf("-") + 1)))) missing.add(ref.toUpperCase());
    }
  }
  if (!missing.size) return "";
  const list = [...missing].join(", ");
  return `\n\nHeads-up: the text says this comes after ${list}, but there is no waits-on link to ${missing.size === 1 ? "it" : "them"}, so nothing waits and you will not be woken when ${missing.size === 1 ? "it" : "they"} merge${missing.size === 1 ? "s" : ""}. Link ${missing.size === 1 ? "it" : "them"} with update_ticket waitsOn add: [${[...missing].map((r) => `"${r}"`).join(", ")}], or reword the text if no wait is meant.`;
}

/** "urgent" as a claim: not "not urgent", "non-urgent" or "isn't urgent". */
const URGENT_WORD = /(?<!\bnot\s)(?<!\bnon-)(?<!n't\s)(?<!\bnon\s)\burgent\b/gi;
const REF_IN_TEXT = /\b[A-Za-z][A-Za-z0-9]{0,9}-(\d{1,9})\b/g;

/**
 * Which tickets a CEO message calls urgent (BOS-1375): a BOS-n within 40 characters of the word, or, when the word
 * stands with no reference near it, `ownTicketId` (the ticket the reply is on). "not urgent" is not a claim.
 */
export function urgentClaims(body: string): { numbers: number[]; unnamed: boolean } {
  const numbers = new Set<number>();
  let unnamed = false;
  const refs = [...body.matchAll(REF_IN_TEXT)];
  for (const m of body.matchAll(URGENT_WORD)) {
    const near = refs.filter((r) => Math.abs(r.index! - m.index!) <= 40);
    if (near.length) for (const r of near) numbers.add(Number(r[1]));
    else unnamed = true;
  }
  return { numbers: [...numbers], unnamed };
}

/** What the CEO is told when a message calls a ticket urgent while its urgent flag is off (BOS-1375). */
export async function urgentHeldMessage(db: Db, companyId: string, body: string, ownTicketId: string | undefined): Promise<string | null> {
  const claims = urgentClaims(body);
  if (!claims.numbers.length && !(claims.unnamed && ownTicketId)) return null;
  const rows = [
    ...(claims.numbers.length ? await db.select({ number: tickets.number, urgent: tickets.urgent }).from(tickets).where(and(eq(tickets.companyId, companyId), inArray(tickets.number, claims.numbers))) : []),
    ...(claims.unnamed && ownTicketId ? await db.select({ number: tickets.number, urgent: tickets.urgent }).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.id, ownTicketId))) : []),
  ];
  const off = [...new Set(rows.filter((r) => !r.urgent).map((r) => `BOS-${r.number}`))];
  if (!off.length) return null;
  return `Not sent. This calls ${off.join(", ")} "urgent", but ${off.length === 1 ? "its" : "their"} urgent flag is off, so Boss Man treats ${off.length === 1 ? "it" : "them"} as normal priority and the reader acts on the flag, not the word. Set the flag with update_ticket urgent: true, then send it again. If you only quote the word or mean something else, reword it, or send it again with quotesUrgent set to true and it will go.`;
}

/** One line per criterion with the author's verdict, the after-merge ones marked so they read as skippable (DR-024 #5). */
export function criterionLines(criteria: readonly Criterion[], note: string | null): string[] {
  return readVerdicts(criteria, note).map((r, i) => `- [${r.verdict ?? "not reported"}] ${r.criterion}${isAfterMerge(criteria[i]!) ? " (checked after merge; don't fail the review on it)" : ""}`);
}

/** The note Boss Man shows after a criterion it says to check once the work is live; stripped before matching text. */
const AFTER_MERGE_NOTE = /\s*\(checked after merge[^)]*\)\s*$/i;

/**
 * A criterion argument as the tool really receives it (BOS-1012). Claude Code sends a number as the string
 * "6", so a schema of `anyOf [integer, string]` never reaches the number branch: a number-looking string
 * becomes a number here, before anything tries to match it as text. Text is stripped of the after-merge
 * note Boss Man appends to it and compared with case and whitespace run together.
 */
export const criterionArg = z.preprocess((v) => (typeof v === "string" && /^\s*\d{1,2}\s*$/.test(v) ? Number(v.trim()) : v), z.union([z.number().int(), z.string().min(1).max(500)]).optional());

/** The index (0-based) into `criteria` that a `criterion` argument names, by number (1-based) or by its text. */
export function criterionAt(criteria: readonly Criterion[], criterion: number | string): number {
  if (typeof criterion === "number") return criterion - 1;
  const want = criterionArgText(criterion);
  return criteria.findIndex((c) => criterionArgText(criterionText(c)) === want);
}

/** Text for matching a criterion name: the after-merge note off, case and runs of whitespace normalised. */
const criterionArgText = (s: string) => s.replace(AFTER_MERGE_NOTE, "").trim().toLowerCase().replace(/\s+/g, " ");
