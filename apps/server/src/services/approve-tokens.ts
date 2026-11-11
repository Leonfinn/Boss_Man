// The phone Approve links' table helpers (BOS-243), kept apart from phone-approve.ts so decisions.ts
// can revoke a card's links inside its own transactions without an import cycle.
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approveTokens, phoneActionHits } from "../db/schema.js";

/** Kills every live Approve link for a decision: called in the same transaction that rewrites or withdraws the card. */
export const revokeApproveTokens = (db: Db, decisionId: string, at: Date = new Date()) =>
  db
    .update(approveTokens)
    .set({ revokedAt: at })
    .where(and(eq(approveTokens.decisionId, decisionId), isNull(approveTokens.usedAt), isNull(approveTokens.revokedAt)));

/** Retention (spec rule 8): links and tap records go after a day. */
export async function sweepPhoneApprove(db: Db, t: Date) {
  const cutoff = new Date(t.getTime() - 86_400_000);
  const tokens = await db.delete(approveTokens).where(lt(approveTokens.createdAt, cutoff)).returning({ id: approveTokens.id });
  const hits = await db.delete(phoneActionHits).where(lt(phoneActionHits.at, cutoff)).returning({ id: phoneActionHits.id });
  return tokens.length + hits.length;
}
