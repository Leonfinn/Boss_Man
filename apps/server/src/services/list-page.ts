// One page of a newest-first list (BOS-2165): `limit` rows, older than the row `before` names.
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

export type Page = { limit?: number; before?: string };

/** `?limit=&before=` on a list route. A limit over the cap is clamped, not refused. */
export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).optional(), before: z.string().uuid().optional() });

export const pageLimit =(limit?: number) => Math.min(PAGE_MAX, Math.max(1, Math.floor(limit ?? PAGE_DEFAULT)));

/**
 * Rows older than the row with id `before`, in (createdAt, id) order.
 * The cursor is the id, not a timestamp: Postgres keeps microseconds that a JS Date drops, and two rows can share a
 * created time, so a timestamp cursor could skip or repeat rows. An id that no longer exists gives an empty page.
 */
export function olderThan(table: PgTable, cols: { createdAt: PgColumn; id: PgColumn }, before: string): SQL {
  return sql`(${cols.createdAt}, ${cols.id}) < (select ${cols.createdAt}, ${cols.id} from ${table} where ${cols.id} = ${before})`;
}
