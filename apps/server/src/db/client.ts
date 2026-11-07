import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Production: node-postgres. Migrated on start unless `migrate: false` (a separate migrate step ran), in which case the database must already be current. */
export async function openPostgres(url: string, opts: { migrate?: boolean } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { runMigrations, assertMigrated } = await import("./migrate-lib.js");
  if (opts.migrate === false) await assertMigrated(url, migrationsFolder);
  else await runMigrations(url, { folder: migrationsFolder });
  const pool = new Pool({ connectionString: url });
  // A database restart drops idle connections; pg reports that as an error event, and with no listener Node exits.
  // Log it and carry on: the pool discards the dead client and the next query connects again.
  const onError = (err: Error) => console.error("[db] connection error (will reconnect on next query):", err.message);
  pool.on("error", onError);
  pool.on("connect", (client) => client.on("error", onError));
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, close: () => pool.end() };
}

// A migrated, empty in-memory database to copy, so each test skips running every migration again.
// Lost on restart, harmless because it's rebuilt from the migrations on the next call.
let migratedTemplate: Promise<Blob> | undefined;

/**
 * Tests and quick local runs: an in-process Postgres (PGlite), migrated with the same SQL.
 * `logQuery` (tests only) sees every statement, so a test can prove a pass made none.
 */
export async function openPglite(dataDir?: string, opts: { logQuery?: (sql: string) => void } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const logger = opts.logQuery ? { logQuery: opts.logQuery } : undefined;
  if (dataDir === undefined) {
    migratedTemplate ??= (async () => {
      // The test run's global setup saves one migrated copy for every test file to share.
      const saved = process.env.BOSSMAN_PGLITE_TEMPLATE;
      if (saved) return new Blob([await readFile(saved)]);
      const first = new PGlite({ extensions: { vector } });
      await migrate(drizzle(first, { schema }), { migrationsFolder });
      const dump = await first.dumpDataDir("none");
      await first.close();
      return dump;
    })();
    const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate });
    // A copy's first query loads PGlite's array types; a close during that never returns, so do it now.
    await client.query("select 1");
    return { db: drizzle(client, { schema, logger }) as unknown as Db, close: () => client.close() };
  }
  const client = new PGlite({ dataDir, extensions: { vector } });
  const db = drizzle(client, { schema, logger });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
