// BOS-1546: a merged ticket that only waits to go live says so in plain words on the board card and the ticket page,
// so it doesn't look stalled in Blocked. Display only: it reads the wait the ticket already stores (goLiveWait) and the
// owner's open update cards (the Updates waiting list); nothing here changes a state or a merge.
import { and, eq, sql } from "drizzle-orm";
import type { GoLiveWait } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";

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
