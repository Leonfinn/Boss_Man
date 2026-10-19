import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Production: node-postgres, migrated on start. */
export async function openPostgres(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}

/** Tests and quick local runs: an in-process Postgres (PGlite), migrated with the same SQL. */
export async function openPglite(dataDir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const client = new PGlite({ dataDir, extensions: { vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
