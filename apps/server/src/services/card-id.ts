// BOS-1695: agents are shown a decision card's 8-character short id in replies and transcripts, so the card tools
// accept a unique prefix of a card in the caller's company as well as the full id.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { decisions } from "../db/schema.js";

const FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At least 6 hex digits (dashes allowed, as in a copied prefix), at most a full id. */
const PREFIX = /^[0-9a-f][0-9a-f-]{5,35}$/i;
const MAX_LISTED = 8;

/** Input schema for a card id: a full id or a short prefix. */
export const cardIdInput = () => z.string().trim().regex(PREFIX, "Give the card's id: the full id, or the first 8 characters shown with it.");

export type CardIdResult = { ok: true; id: string } | { ok: false; error: string };

/** The full id of the one card in `companyId` that `given` names. Any status counts; callers check the status themselves. */
export async function resolveCardId(db: Db, companyId: string, given: string): Promise<CardIdResult> {
  const s = given.trim().toLowerCase();
  if (FULL.test(s)) return { ok: true, id: s };
  if (!PREFIX.test(s)) return { ok: false, error: "Give the card's id: the full id, or at least the first 6 characters shown with it." };
  // The id column is a uuid: compare its text form so a dash in the prefix still lines up.
  const rows = await db
    .select({ id: decisions.id, question: decisions.question, status: decisions.status })
    .from(decisions)
    .where(and(eq(decisions.companyId, companyId), sql`${decisions.id}::text like ${s.replace(/[%_\\]/g, "\\$&") + "%"}`))
    .limit(MAX_LISTED + 1);
  if (rows.length === 0) return { ok: false, error: `No card in your company starts with ${s}.` };
  if (rows.length > 1) {
    const shown = rows.slice(0, MAX_LISTED).map((r) => `${r.id} (${r.status}): ${r.question.replace(/\s+/g, " ").slice(0, 60)}`);
    return { ok: false, error: `${s} matches more than one card; use the full id of the one you mean:\n${shown.join("\n")}${rows.length > MAX_LISTED ? "\n…and more." : ""}` };
  }
  return { ok: true, id: rows[0].id };
}

/** replacedBy "card:<short id>" becomes "card:<full id>"; other forms pass through for the usual checks. */
export async function resolveReplacedBy(db: Db, companyId: string, replacedBy: string | undefined): Promise<{ ok: true; value: string | undefined } | { ok: false; error: string }> {
  const raw = replacedBy?.trim();
  if (!raw || !raw.startsWith("card:")) return { ok: true, value: replacedBy };
  const r = await resolveCardId(db, companyId, raw.slice(5));
  return r.ok ? { ok: true, value: `card:${r.id}` } : { ok: false, error: `replacedBy: ${r.error}` };
}
