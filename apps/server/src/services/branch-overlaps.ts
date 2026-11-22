// Overlap warning between open branches (BOS-2179). A branch's changed files are recorded when its ticket moves to review,
// is approved or attempts a merge (`tickets.diffFiles`), and compared with every other open ticket of the same project
// that has recorded files. A shared file (lock and generated files left out) shows on both ticket pages and gives each
// ticket one note per pair, posted again only when a new shared file appears. Advisory only: nothing here blocks,
// links, holds or wakes anything.
//
// Repeat notes are stopped from the database, never memory: each note writes an activity row on the ticket it is posted
// to (kind "branch_overlap", detail { otherTicketId, files }), and a new note needs a file that row doesn't list. So a
// restart or update never repeats a note.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, companies, ticketMessages, tickets } from "../db/schema.js";
import { record } from "./activity.js";

/** Open work as the merge line names it: in progress, in review, or blocked (BOS-1411). Nothing else is compared. */
export const OPEN_STATES = ["in_progress", "blocked", "review"] as const;

export const BRANCH_OVERLAP_KIND = "branch_overlap";
/** The most files `diffFiles` keeps (as before BOS-2179). */
export const MAX_DIFF_FILES = 2000;
/** How many shared files a note or the ticket page names before "and N more". */
export const NAMED_FILES = 5;

/**
 * Files that never count as an overlap: lock files and files a tool writes, which many branches change for reasons
 * that never clash in a way a person must sort out. Matched on the file name, in any folder.
 */
export const NOT_COUNTED: ReadonlyArray<{ test: (path: string) => boolean; why: string }> = [
  { test: (p) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/.test(p), why: "lock file" },
  { test: (p) => /(^|\/)drizzle\/meta\/(_journal|\d+_snapshot)\.json$/.test(p), why: "drizzle-kit output; the merge gate renumbers migration clashes (BOS-690)" },
  { test: (p) => /(^|\/)scripts\/test-lines-baseline\.json$/.test(p), why: "written by check-test-lines.mjs --update" },
  { test: (p) => /\.tsbuildinfo$/.test(p), why: "build output" },
];

export function countsForOverlap(path: string): boolean {
  return !NOT_COUNTED.some((n) => n.test(path));
}

export type BranchOverlap = { ticketId: string; ref: string | null; title: string; state: string; urgent: boolean; files: string[] };

type Me = { id: string; companyId: string; projectId: string };

/**
 * The other open tickets of the same project (in progress, blocked or in review) with recorded files, and the files
 * each shares with `mine`. One query. Shared by this warning and the plan-approval warning (BOS-1411).
 */
export async function sharedWithOpenTickets(db: Db, t: Me, mine: string[]): Promise<BranchOverlap[]> {
  const counted = new Set(mine.filter(countsForOverlap));
  if (!counted.size) return [];
  const others = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, systemState: tickets.systemState, urgent: tickets.urgent, diffFiles: tickets.diffFiles })
    .from(tickets)
    .where(and(eq(tickets.projectId, t.projectId), ne(tickets.id, t.id), inArray(tickets.systemState, [...OPEN_STATES]), sql`jsonb_array_length(${tickets.diffFiles}) > 0`));
  if (!others.length) return [];
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
  const out: BranchOverlap[] = [];
  for (const o of others) {
    const files = (o.diffFiles ?? []).filter((f) => counted.has(f));
    if (files.length) out.push({ ticketId: o.id, ref: ticketRef(c?.prefix, o.number), title: o.title, state: o.systemState, urgent: !!o.urgent, files });
  }
  // Urgent first, then in the line ahead (review before blocked before in progress).
  const rank = (s: string) => (s === "review" ? 0 : s === "blocked" ? 1 : 2);
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent) || rank(a.state) - rank(b.state));
}

/** The ticket page's overlap lines: only for an open ticket with recorded files, from what is recorded now. */
export async function branchOverlaps(db: Db, t: Me & { systemState: string | null; diffFiles: string[] | null }): Promise<BranchOverlap[]> {
  if (!t.systemState || !(OPEN_STATES as readonly string[]).includes(t.systemState) || !t.diffFiles?.length) return [];
  return sharedWithOpenTickets(db, t, t.diffFiles);
}

export type BranchOverlapView = { ticketId: string; ref: string | null; title: string; state: string; files: string[]; more: number };

/** What the ticket page shows: each overlapping ticket with up to NAMED_FILES shared files and how many more. */
export async function branchOverlapView(db: Db, t: Parameters<typeof branchOverlaps>[1]): Promise<BranchOverlapView[]> {
  return (await branchOverlaps(db, t)).map((o) => ({ ticketId: o.ticketId, ref: o.ref, title: o.title, state: o.state, files: o.files.slice(0, NAMED_FILES), more: Math.max(0, o.files.length - NAMED_FILES) }));
}

/** "a.ts, b.ts, c.ts, d.ts, e.ts and 3 more" */
export function namedFiles(files: string[]): string {
  const named = files.slice(0, NAMED_FILES).join(", ");
  return files.length > NAMED_FILES ? `${named} and ${files.length - NAMED_FILES} more` : named;
}

const stateWords = (s: string) => (s === "review" ? "in review" : s === "blocked" ? "blocked" : "in progress");

export function overlapNoteText(other: { ref: string | null; title: string; state: string }, files: string[]): string {
  const name = other.ref ? `${other.ref} "${other.title}"` : `"${other.title}"`;
  return `Changes the same files as ${name} (${stateWords(other.state)}): ${namedFiles(files)}. Advisory only: nothing is held. If one should land first, agree the order with the CEO and add a waits-on link.`;
}

/** The files already noted on `ticketId` about `otherId`: the newest branch_overlap row's list. */
async function notedFiles(db: Db, ticketId: string, otherId: string): Promise<string[]> {
  const [row] = await db
    .select({ detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, BRANCH_OVERLAP_KIND), sql`${activity.detail}->>'otherTicketId' = ${otherId}`))
    .orderBy(desc(activity.at))
    .limit(1);
  const files = (row?.detail as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

/** One note on `on` about `other`, only when `shared` has a file not noted before for this pair. True when posted. */
async function noteOnce(db: Db, on: { id: string; companyId: string }, other: { ticketId: string; ref: string | null; title: string; state: string }, shared: string[]): Promise<boolean> {
  const before = await notedFiles(db, on.id, other.ticketId);
  if (shared.every((f) => before.includes(f))) return false;
  await db.insert(ticketMessages).values({ companyId: on.companyId, ticketId: on.id, author: "system", text: overlapNoteText(other, shared) });
  await db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, on.id));
  await record(db, {
    companyId: on.companyId,
    ticketId: on.id,
    kind: BRANCH_OVERLAP_KIND,
    summary: `Changes the same files as ${other.ref ?? `"${other.title}"`}: ${namedFiles(shared)}`,
    detail: { otherTicketId: other.ticketId, files: [...new Set([...before, ...shared])].slice(0, MAX_DIFF_FILES) },
  });
  return true;
}

/**
 * Compare a ticket's recorded files with the other open tickets of its project and post the notes still owed, on
 * both sides of each pair. Returns the overlaps found.
 */
export async function noteBranchOverlaps(db: Db, ticketId: string): Promise<BranchOverlap[]> {
  const [t] = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title, companyId: tickets.companyId, projectId: tickets.projectId, systemState: tickets.systemState, diffFiles: tickets.diffFiles }).from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return [];
  const overlaps = await branchOverlaps(db, t);
  if (!overlaps.length) return [];
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
  const me = { ticketId: t.id, ref: ticketRef(c?.prefix, t.number), title: t.title, state: t.systemState! };
  for (const o of overlaps) {
    await noteOnce(db, t, o, o.files);
    await noteOnce(db, { id: o.ticketId, companyId: t.companyId }, me, o.files);
  }
  return overlaps;
}

/**
 * Record the files a ticket's branch changes, then post any overlap notes owed. Called on a move to review, an
 * approval and a merge attempt. Never throws: a failure here must not fail a move, a review or a merge.
 */
export async function recordBranchFiles(db: Db, ticketId: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await db.update(tickets).set({ diffFiles: paths.slice(0, MAX_DIFF_FILES) }).where(eq(tickets.id, ticketId));
    await noteBranchOverlaps(db, ticketId);
  } catch {
    // Advisory: the next move, approval or merge attempt records again.
  }
}
