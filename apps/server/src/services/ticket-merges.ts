// BOS-2653: every merge of a ticket. tickets.mergeCommit holds only the latest one, so a ticket reopened and merged
// again lost its first merge from merge order: a runner image or a live server built from that first merge could no
// longer be placed ("isn't a merge Boss Man recorded"), and a runner change in it no longer counted. ticket_merges
// keeps each one; tickets.mergeCommit stays "the latest merge" for everything else.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { deploysNothing, touchesRunnerCode, touchesRunnerUpdate } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { ticketMerges, tickets } from "../db/schema.js";

/** One merge of one ticket. Null runner facts: the merge's files weren't known. */
export type TicketMerge = { ticketId: string; commit: string; at: Date; touchesRunner: boolean | null; touchesRunnerUpdate: boolean | null; deploysNothing: boolean | null };

/** The runner facts of a merge from its changed files; no file list = touches the runners (wait for both), the rest unknown. */
export function mergeFacts(files: readonly string[] | null | undefined): { touchesRunner: boolean; touchesRunnerUpdate: boolean | null; deploysNothing: boolean | null } {
  return files ? { touchesRunner: touchesRunnerCode(files), touchesRunnerUpdate: touchesRunnerUpdate(files), deploysNothing: deploysNothing(files) } : { touchesRunner: true, touchesRunnerUpdate: null, deploysNothing: null };
}

/** Records one merge of a ticket; a merge already recorded is left as it is. Returns true when it was new. */
export async function recordTicketMerge(
  db: Db,
  m: { companyId: string; ticketId: string; commit: string; at: Date; files?: readonly string[] | null },
): Promise<boolean> {
  const rows = await db
    .insert(ticketMerges)
    .values({ companyId: m.companyId, ticketId: m.ticketId, commit: m.commit.toLowerCase(), mergedAt: m.at, ...mergeFacts(m.files) })
    .onConflictDoNothing({ target: [ticketMerges.ticketId, ticketMerges.commit] })
    .returning({ id: ticketMerges.id });
  return rows.length > 0;
}

/** The merges already recorded for these tickets, as "ticketId:commit" keys. */
export async function recordedMergeKeys(db: Db, ticketIds: string[]): Promise<Set<string>> {
  if (!ticketIds.length) return new Set();
  const rows = await db.select({ ticketId: ticketMerges.ticketId, commit: ticketMerges.commit }).from(ticketMerges).where(inArray(ticketMerges.ticketId, ticketIds));
  return new Set(rows.map((r) => `${r.ticketId}:${r.commit}`));
}

/**
 * Every merge of the company's tickets, oldest first: the ticket_merges rows, plus each ticket's latest merge
 * (tickets.mergeCommit) when no row has it, so a merge written only to the ticket still places as before. mergedAt
 * places a merge; a ticket merged before mergedAt existed falls back to when it last changed state.
 */
export async function companyMerges(db: Db, companyId: string): Promise<TicketMerge[]> {
  const [kept, latest] = await Promise.all([
    db.select().from(ticketMerges).where(eq(ticketMerges.companyId, companyId)),
    db
      .select({ id: tickets.id, mergeCommit: tickets.mergeCommit, mergedAt: tickets.mergedAt, stateChangedAt: tickets.stateChangedAt, touchesRunner: tickets.touchesRunner, touchesRunnerUpdate: tickets.touchesRunnerUpdate, deploysNothing: tickets.deploysNothing })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), isNotNull(tickets.mergeCommit))),
  ]);
  const out: TicketMerge[] = kept.map((r) => ({ ticketId: r.ticketId, commit: r.commit.toLowerCase(), at: r.mergedAt, touchesRunner: r.touchesRunner, touchesRunnerUpdate: r.touchesRunnerUpdate, deploysNothing: r.deploysNothing }));
  const have = new Set(out.map((m) => `${m.ticketId}:${m.commit}`));
  for (const t of latest) {
    const commit = t.mergeCommit!.toLowerCase();
    if (have.has(`${t.id}:${commit}`)) continue;
    out.push({ ticketId: t.id, commit, at: t.mergedAt ?? t.stateChangedAt, touchesRunner: t.touchesRunner, touchesRunnerUpdate: t.touchesRunnerUpdate, deploysNothing: t.deploysNothing });
  }
  // Stable for equal times: the order rows came in, as the single-query ORDER BY gave before.
  return out.map((m, i) => ({ m, i })).sort((a, b) => a.m.at.getTime() - b.m.at.getTime() || a.i - b.i).map((x) => x.m);
}
