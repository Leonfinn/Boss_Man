// R59 (BOS-2571): an owner-facing "still under way" state must be backed by a live record. Every path that ends a server
// update without the host reporting on it (cancelled, not sent, replaced) writes its end onto the update's own card,
// so Recent updates never has to guess. Never overwrites a result the host already reported.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";

export type CardEnd = { result: "cancelled" | "not_sent" | "replaced"; message: string; by?: string };

export async function stampCardEnd(db: Db, decisionId: string, end: CardEnd, at: Date = new Date()): Promise<void> {
  const value = JSON.stringify({ ...end, at: at.toISOString() });
  await db
    .update(decisions)
    .set({ context: sql`jsonb_set(${decisions.context}, '{result}', ${value}::jsonb)` })
    .where(and(eq(decisions.id, decisionId), sql`${decisions.context}->>'type' = 'self_deploy'`, sql`${decisions.context}->'result' is null`));
}
