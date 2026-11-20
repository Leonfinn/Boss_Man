import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// apps/server/drizzle, from the source (src/db/client.ts) or from the image's bundle (dist/main.js, BOS-410 step 3).
const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = [path.resolve(here, "../../drizzle"), path.resolve(here, "../drizzle")].find((d) => existsSync(path.join(d, "meta"))) ?? path.resolve(here, "../../drizzle");

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
// lost on restart, harmless because it's rebuilt from the migrations on the next call.
let migratedTemplate: Promise<Blob> | undefined;

// BOS-657: opening a copy costs ~0.7 CPU-s, emptying its tables ~0.08. close() empties a template copy and parks it here for the next openPglite().
// Opt out with `{ fresh: true }`, or for a whole run with BOSSMAN_PGLITE_REUSE=0.
type PgliteClient = InstanceType<(typeof import("@electric-sql/pglite"))["PGlite"]>;
const idlePool: { client: PgliteClient; tables: string }[] = [];

async function listTables(client: PgliteClient): Promise<string> {
  const r = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename");
  return r.rows.map((x) => x.tablename).join(",");
}

/** Tests: really close every parked copy (a test file's last step). */
export async function closePglitePool(): Promise<void> {
  const parked = idlePool.splice(0);
  await Promise.all(parked.map((e) => e.client.close().catch(() => undefined)));
}
// BOS-1926: the test setup file closes the pool through this handle, so a test file that never loads the database code
// (about a quarter of them) doesn't import pg, drizzle and the whole schema just to close nothing.
(globalThis as { __bossmanClosePglitePool?: () => Promise<void> }).__bossmanClosePglitePool = closePglitePool;

/**
 * Tests and quick local runs: an in-process Postgres (PGlite), migrated with the same SQL.
 * `logQuery` (tests only) sees every statement, so a test can prove a pass made none.
 */
export async function openPglite(dataDir?: string, opts: { logQuery?: (sql: string) => void; fresh?: boolean } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
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
    const reuse = !opts.fresh && process.env.BOSSMAN_PGLITE_REUSE !== "0";
    let entry = reuse ? idlePool.pop() : undefined;
    if (!entry) {
      const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate });
      // A copy's first query loads PGlite's array types; a close during that never returns, so do it now.
      await client.query("select 1");
      entry = { client, tables: await listTables(client) };
    }
    const { client, tables } = entry;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (reuse) {
        try {
          // Back to the migrated, empty state: no rows, sequences from 1. If a test added or dropped a table, the copy is not the template any more.
          const now = await listTables(client);
          if (now === tables) {
            if (now) await client.exec(`truncate table ${now.split(",").map((t) => `"${t}"`).join(", ")} restart identity cascade`);
            idlePool.push({ client, tables });
            return;
          }
        } catch {
          // Fall through and close it for real.
        }
      }
      await client.close();
    };
    return { db: drizzle(client, { schema, logger }) as unknown as Db, close };
  }
  const client = new PGlite({ dataDir, extensions: { vector } });
  const db = drizzle(client, { schema, logger });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
