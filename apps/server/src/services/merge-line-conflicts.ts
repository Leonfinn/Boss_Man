// Two read-only warnings about work on the same code (BOS-1411, from the 13 Nov cock-up answer):
//
//  1. Plan overlap: when a plan is approved, its "Files" list is compared with the files of other open work
//     (urgent, in progress or in review). A match names those tickets and suggests a waits-on link. Only text.
//  2. Real conflicts: before the owner's sign-off card is raised, and when a ticket is marked urgent, the
//     runner runs `git merge-tree` of this branch against each approved branch in the merge line. A real
//     conflict (not merely a shared file) adds one line to the card and to the CEO's brief.
//
// Nothing here links tickets, holds a card or changes a merge. The words a note ends with are waits-on advice
// (the same suggestion the CEO would make by hand), so the two warnings and the tools tell one story.
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, companies, tickets } from "../db/schema.js";
import { MERGE_LINE_KIND } from "./merge-line.js";

type Ticket = typeof tickets.$inferSelect;

/** State names as the merge line uses them: "in the line" is in progress, in review or blocked after a sign-off. */
const OPEN_STATES = ["in_progress", "blocked", "review"] as const;

/**
 * The plans' "Files" list, as the plan writes it. A plan names its files in one of a few shapes:
 * "## Files" (or "**Files:**") followed by bullets or a separated list, or "Files: a.ts, b.ts". Only the file
 * names are read; anything that doesn't look like a repo path is dropped, so chatter under the heading adds no
 * false matches. Empty when the plan names no files.
 */
export function planFiles(plan: string | null | undefined): string[] {
  if (!plan?.trim()) return [];
  const lines = plan.split(/\r?\n/);
  const out: string[] = [];
  const takes = (text: string) => {
    for (const raw of text.split(/,|;|\s{2,}|\s+[-–—]\s+|\s+(?:and)\s+/)) {
      const m = /`?([\w./-]*[\w-]\.[A-Za-z0-9]{1,10})`?/.exec(raw.trim());
      if (!m) continue;
      // A path in this repo, not a sentence: no spaces, and not a URL or a version.
      const p = m[1]!.replace(/^\.\//, "").replace(/^\/+/, "");
      if (/\s/.test(p) || /^https?:/i.test(raw.trim()) || !p.includes(".") || p.length > 240) continue;
      if (!out.includes(p)) out.push(p);
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:the\s+)?files\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i.exec(line);
    if (!heading) continue;
    const inline = heading[1]!.trim();
    if (inline) {
      // "Files: a.ts, b.ts" on one line.
      if (/^[:–—-]\s*$/.test(inline)) continue;
      takes(inline);
      continue;
    }
    // The list runs to the next heading or a blank line followed by a new heading.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s*#{1,6}\s+\S/.test(l) && !/^\s*#{1,6}\s*(?:the\s+)?files/i.test(l)) break;
      if (!l.trim()) continue;
      takes(l.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, ""));
    }
    break;
  }
  return out;
}

/** The files a ticket's branch changed, from what its landing diff recorded (`diffFiles`, BOS-1411). No runner call. */
async function changedFilesOf(db: Db, ticketId: string): Promise<string[]> {
  const [row] = await db.select({ diffFiles: tickets.diffFiles }).from(tickets).where(eq(tickets.id, ticketId));
  return row?.diffFiles ?? [];
}

export type PlanOverlap = { ticketId: string; ref: string | null; title: string; state: string; urgent: boolean; files: string[] };

/**
 * The other open work whose files the plan shares (BOS-1411, warning 1). Files come from each ticket's state note
 * and its merge-line rows (the check that ran names the files), never from a runner call, so approving a plan
 * is still cheap and works with no runner connected. A ticket with no known files can't overlap.
 */
export async function planOverlaps(db: Db, t: Ticket, plan: string): Promise<PlanOverlap[]> {
  const mine = planFiles(plan);
  if (!mine.length) return [];
  const others = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, systemState: tickets.systemState, urgent: tickets.urgent })
    .from(tickets)
    .where(and(eq(tickets.projectId, t.projectId), ne(tickets.id, t.id), inArray(tickets.systemState, [...OPEN_STATES])));
  if (!others.length) return [];
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
  const out: PlanOverlap[] = [];
  for (const o of others) {
    const have = await changedFilesOf(db, o.id);
    const shared = mine.filter((f) => have.includes(f));
    if (shared.length) out.push({ ticketId: o.id, ref: ticketRef(c?.prefix, o.number), title: o.title, state: o.systemState, urgent: !!o.urgent, files: shared });
  }
  // Urgent first, then in the line ahead of the plan (review before in progress), then by ticket number.
  const rank = (s: string) => (s === "review" ? 0 : s === "blocked" ? 1 : 2);
  return out.sort((a, b) => Number(b.urgent) - Number(a.urgent) || rank(a.state) - rank(b.state));
}

/**
 * The plan-approval note (warning 1). One sentence naming the other tickets and their shared files, then the
 * waits-on suggestion; empty when nothing overlaps. Never links anything: the agent or the CEO decides.
 */
export function planOverlapNote(overlaps: PlanOverlap[]): string {
  if (!overlaps.length) return "";
  const named = overlaps.slice(0, 5).map((o) => `${o.ref ? `${o.ref} "${o.title}"` : `"${o.title}"`} (${o.urgent ? "urgent, " : ""}${o.state === "review" ? "in review" : o.state === "blocked" ? "blocked" : "in progress"})`);
  const more = overlaps.length > named.length ? ` and ${overlaps.length - named.length} more` : "";
  const files = [...new Set(overlaps.flatMap((o) => o.files))].slice(0, 6).join(", ");
  return `Plan overlap: this plan's files (${files}) are also being changed by ${named.join(", ")}${more}. Nothing has been linked. If they should land first, add a waits-on link with update_ticket waitsOn (until merged), and agree the order with the CEO.`;
}

/** "Conflicts with BOS-12, which is ahead in the merge line. If you sign now, it'll likely need signing again after BOS-12 lands." */
export function conflictNote(conflicts: Array<{ ref: string | null; title: string }>): string {
  if (!conflicts.length) return "";
  const names = conflicts.map((c) => c.ref ?? `"${c.title}"`);
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const it = names.length === 1 ? "it" : "they";
  const them = names.length === 1 ? names[0] : "them";
  return `Conflicts with ${list}, which ${names.length === 1 ? "is" : "are"} ahead in the merge line. If you sign now, ${it}'ll likely need signing again after ${them} land${names.length === 1 ? "s" : ""}.`;
}

/** The server's last row for the ticket: is it in the merge line (approved and not merged or left)? */
export async function inMergeLine(db: Db, ticketId: string): Promise<{ inLine: boolean; approvedAt: Date | null }> {
  const [row] = await db
    .select({ at: activity.at, detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND)))
    .orderBy(desc(activity.at))
    .limit(1);
  const d = row?.detail as { event?: string } | null;
  const inLine = !!d && d.event !== "merged" && d.event !== "left";
  const [approved] = inLine
    ? await db
        .select({ at: activity.at })
        .from(activity)
        .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND), sql`${activity.detail}->>'event' = 'approved'`))
        .orderBy(desc(activity.at))
        .limit(1)
    : [];
  return { inLine, approvedAt: approved?.at ?? null };
}

/** Every ticket of the project that is approved and in the merge line right now, oldest approval first. */
export async function mergeLineApproved(db: Db, projectId: string, excludeId: string): Promise<Array<{ id: string; branch: string; number: number | null }>> {
  const rows = await db
    .select({ id: tickets.id, branch: tickets.branch, number: tickets.number, state: tickets.systemState })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.id, excludeId), eq(tickets.systemState, "review"), isNotNull(tickets.branch)));
  const out: Array<{ id: string; branch: string; number: number | null; at: Date }> = [];
  for (const r of rows) {
    if (!r.branch) continue;
    const line = await inMergeLine(db, r.id);
    if (line.inLine && line.approvedAt) out.push({ id: r.id, branch: r.branch, number: r.number, at: line.approvedAt });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).map(({ id, branch, number }) => ({ id, branch, number }));
}
