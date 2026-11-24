// BOS-1546: a merged ticket that only waits to go live says so in plain words on the board card and the ticket page,
// so it doesn't look stalled in Blocked. Display only: it reads the wait the ticket already stores (goLiveWait) and the
// owner's open update cards (the Updates waiting list); nothing here changes a state or a merge.
import { and, eq, sql } from "drizzle-orm";
import type { GoLiveWait } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, tickets } from "../db/schema.js";

/**
 * BOS-1636: SQL twin of isLiveCheckWait (shared) for the Blocked half: in Blocked with a merge, or (BOS-1907) a split-out
 * check ticket whose parent is merged and not done. Counts of "blocked" tickets leave these out.
 */
export const liveCheckWaitSql = sql`(${tickets.systemState} = 'blocked' and (${tickets.mergeCommit} is not null
  or exists (select 1 from tickets p where p.id = ${tickets.checksTicketId} and p.merge_commit is not null and (p.system_state <> 'done' or p.outcome is distinct from 'cancelled'))))`;

/** Blocked tickets of a company that really are blocked, and those that are only merged work waiting for a live check. */
export async function blockedSplit(db: Db, companyId: string): Promise<{ blocked: number; liveCheck: number }> {
  const [r] = await db
    .select({ live: sql<number>`count(*) filter (where ${liveCheckWaitSql})::int`, all: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "blocked")));
  const live = r?.live ?? 0;
  return { blocked: (r?.all ?? 0) - live, liveCheck: live };
}

/** The owner's open server-update and runner-update cards of a company, by target (null when there is none). */
export type UpdateCards = { server: string | null; runner: string | null };
export type GoLiveNote = { text: string; cardId: string | null };

export async function openUpdateCards(db: Db, companyId: string): Promise<UpdateCards> {
  const rows = await db
    .select({ id: decisions.id, target: sql<string>`${decisions.context}->>'target'` })
    .from(decisions)
    .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'self_deploy'`))
    .orderBy(decisions.createdAt);
  return { server: rows.find((r) => r.target === "server")?.id ?? null, runner: rows.find((r) => r.target === "runner")?.id ?? null };
}

/** Null when the ticket waits for nothing to go live, so a real stall still looks like one. */
export function goLiveNote(wait: GoLiveWait | null | undefined, cards: UpdateCards): GoLiveNote | null {
  if (!wait) return null;
  if (wait === "own") return { text: "Merged. Waiting for the CEO to mark it live (this company puts its own work live). Nothing for an agent to do.", cardId: null };
  const needs = wait === "both" ? "the server update and the runner rebuild (Build and update runners)" : wait === "runner" ? "the runner rebuild (Build and update runners)" : "the server update";
  const cardId = wait === "runner" ? cards.runner : cards.server ?? cards.runner;
  const card = cardId ? " Your update card is open in Decisions." : " No update card is open yet; it shows in Settings → Server and runner → Updates.";
  return { text: `Merged. Waiting to go live: ${needs}.${card} Nothing for an agent to do.`, cardId };
}
