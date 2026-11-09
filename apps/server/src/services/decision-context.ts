import { sql } from "drizzle-orm";
import { decisions } from "../db/schema.js";

/**
 * A card's `context` update that sets only the top-level keys in `patch` (BOS-899, BOS-298 step 13).
 * The merge happens in Postgres (`context || patch`), against the row as it is when the UPDATE runs, so a
 * writer that read the card earlier cannot wipe a key another writer set in between. Use it as
 * `.set({ context: mergeContext({ ladder }) })`. A key with an `undefined` value is left out of the patch.
 */
export function mergeContext(patch: Record<string, unknown>) {
  return sql`coalesce(${decisions.context}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}
