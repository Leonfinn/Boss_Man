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

export type DbPoolLimits = { max: number; connectTimeoutMs: number; idleTimeoutMs: number; statementTimeoutMs: number };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * BOS-2181: pool limits, each with an environment override. Generous defaults so a normally slow query never trips them:
 * 20 connections, 30 s to get one, 30 s idle, 120 s per statement. A bad override falls back to the default.
 */
export function dbPoolLimits(env: Record<string, string | undefined>): DbPoolLimits {
  return {
    max: positiveInt(env.BOSSMAN_DB_POOL_MAX, 20),
    connectTimeoutMs: positiveInt(env.BOSSMAN_DB_CONNECT_TIMEOUT_MS, 30_000),
    idleTimeoutMs: positiveInt(env.BOSSMAN_DB_IDLE_TIMEOUT_MS, 30_000),
    statementTimeoutMs: positiveInt(env.BOSSMAN_DB_STATEMENT_TIMEOUT_MS, 120_000),
  };
}

/** Logs each kind of limit hit once per process (not per query), naming which one. Takes any error; ignores the rest. */
export function makeLimitWatcher(limits: DbPoolLimits, log: (msg: string) => void = (m) => console.error(m)): (err: unknown) => void {
  const seen = new Set<string>();
  return (err) => {
    const e = err as { code?: string; message?: string } | null;
    const message = e?.message ?? "";
    let kind: string | undefined;
    if (e?.code === "57014" && /statement timeout/i.test(message)) {
      kind = "statement";
      if (!seen.has(kind)) log(`[db] a query was cancelled after ${limits.statementTimeoutMs} ms (statement timeout, BOSSMAN_DB_STATEMENT_TIMEOUT_MS). Further ones are not logged.`);
    } else if (/timeout exceeded when trying to connect/i.test(message)) {
      kind = "connect";
      if (!seen.has(kind)) log(`[db] no database connection free within ${limits.connectTimeoutMs} ms (pool of ${limits.max}, BOSSMAN_DB_POOL_MAX / BOSSMAN_DB_CONNECT_TIMEOUT_MS). Further ones are not logged.`);
    }
    if (kind) seen.add(kind);
  };
}

// Wrap query() so a rejected promise is reported to the watcher, passing the result through untouched.
function watchQueries(target: { query: (...a: never[]) => unknown }, watch: (err: unknown) => void): void {
  const original = target.query.bind(target) as (...a: unknown[]) => unknown;
  (target as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const r = original(...args);
    if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, (e) => watch(e));
    return r;
  };
}

/** Production: node-postgres. Migrated on start unless `migrate: false` (a separate migrate step ran), in which case the database must already be current. */
export async function openPostgres(url: string, opts: { migrate?: boolean } = {}): Promise<{ db: Db; close: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { runMigrations, assertMigrated } = await import("./migrate-lib.js");
  if (opts.migrate === false) await assertMigrated(url, migrationsFolder);
  else await runMigrations(url, { folder: migrationsFolder });
  // BOS-2181: migrations above ran on their own connection (runMigrations(url)), so the statement timeout below never cuts them.
  const limits = dbPoolLimits(process.env);
  const pool = new Pool({
    connectionString: url,
    max: limits.max,
    connectionTimeoutMillis: limits.connectTimeoutMs,
    idleTimeoutMillis: limits.idleTimeoutMs,
    // Server-side: Postgres cancels the statement itself, so a hung query frees its connection.
    statement_timeout: limits.statementTimeoutMs,
  });
  // A database restart drops idle connections; pg reports that as an error event, and with no listener Node exits.
  // Log it and carry on: the pool discards the dead client and the next query connects again.
  const onError = (err: Error) => console.error("[db] connection error (will reconnect on next query):", err.message);
  pool.on("error", onError);
  const watch = makeLimitWatcher(limits);
  pool.on("connect", (client) => {
    client.on("error", onError);
    watchQueries(client, watch);
  });
  // pool.query() gets its connection through pool.connect(), so this also sees an acquire timeout from pool.query().
  const poolConnect = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { connect: (...a: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    const r = poolConnect(...args);
    if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch((e) => watch(e));
    return r;
  };
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, close: () => pool.end() };
}

// A migrated, empty in-memory database to copy, so each test skips running every migration again.
// lost on restart, harmless because it's rebuilt from the migrations on the next call.
let migratedTemplate: Promise<Blob> | undefined;

// BOS-657: opening a copy costs ~0.7 CPU-s, emptying its tables ~0.015 (BOS-1940). close() empties a template copy and parks it here for the next openPglite().
// Opt out with `{ fresh: true }`, or for a whole run with BOSSMAN_PGLITE_REUSE=0.
type PgliteClient = InstanceType<(typeof import("@electric-sql/pglite"))["PGlite"]>;
type PoolEntry = { client: PgliteClient; tables: string; whichHaveRows: string };
const idlePool: PoolEntry[] = [];

async function listTables(client: PgliteClient): Promise<string> {
  const r = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename");
  return r.rows.map((x) => x.tablename).join(",");
}

const ident = (t: string) => `"${t.replaceAll('"', '""')}"`;
const literal = (t: string) => `'${t.replaceAll("'", "''")}'`;

async function poolEntry(client: PgliteClient): Promise<PoolEntry> {
  const tables = await listTables(client);
  const names = tables ? tables.split(",") : [];
  // One query that names the tables holding any row: a test touches a handful of the ~85 tables.
  const whichHaveRows = names.length ? `select t from (values ${names.map((t) => `(${literal(t)}, exists(select 1 from ${ident(t)}))`).join(", ")}) v(t, f) where f` : "";
  return { client, tables, whichHaveRows };
}

/**
 * Back to the migrated, empty state: no rows, sequences from the start (what `truncate ... restart identity cascade` gives).
 * BOS-1940: truncating all ~85 tables cost ~130 ms per test (each truncate swaps in new files for the table and its
 * indexes); deleting from only the tables that hold rows and vacuuming them costs ~12 ms. session_replication_role = replica turns off
 * foreign-key checks and ordinary triggers for the deletes, as truncate skips them, so the order doesn't matter.
 */
async function emptyTables(entry: PoolEntry): Promise<void> {
  const { client } = entry;
  if (entry.whichHaveRows) {
    const full = (await client.query<{ t: string }>(entry.whichHaveRows)).rows.map((r) => r.t);
    if (full.length) {
      await client.exec(`set session_replication_role = replica; ${full.map((t) => `delete from ${ident(t)};`).join(" ")} set session_replication_role = default;`);
      // Vacuum hands the emptied pages back (the tables end at 0 bytes, as after a truncate), so the next test's rows are
      // stored, and read back by an unordered select, in the order they were written. Without it a reused table's free
      // space put new rows out of order and a test reading two rows without "order by" failed (watchdog's review loop).
      await client.exec(`vacuum ${full.map(ident).join(", ")}`);
      // Vacuum also records "0 rows" (reltuples 0) for each table and index, where a truncate leaves "never counted" (-1).
      // The planner reads 0 as "really empty" and plans a few rows with seq scans; -1 makes it assume 10 pages and use the
      // indexes, as on a fresh copy. Put back the truncate's values so query-plan tests (run-query-performance) see the
      // plans they would on a fresh database. PGlite runs as superuser, so this test-only database may write pg_class.
      const oids = full.map((t) => `${literal(`public.${ident(t)}`)}::regclass`).join(", ");
      await client.exec(
        `update pg_class set reltuples = -1, relallvisible = 0 where oid in (${oids}) or oid in (select indexrelid from pg_index where indrelid in (${oids}))`,
      );
    }
  }
  // The schema has no sequences today (uuid ids); this keeps "restart identity" true if one is added, and costs ~1 ms.
  const used = await client.query<{ s: string }>("select sequencename as s from pg_sequences where schemaname = 'public' and last_value is not null");
  if (used.rows.length) await client.exec(used.rows.map((r) => `alter sequence public.${ident(r.s)} restart;`).join(" "));
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
export async function openPglite(dataDir?: string, opts: { logQuery?: (sql: string) => void; fresh?: boolean } = {}): Promise<{ db: Db; close: () => Promise<void>; empty: () => Promise<void> }> {
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
      entry = await poolEntry(client);
    }
    const parked = entry;
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
            await emptyTables(parked);
            idlePool.push(parked);
            return;
          }
        } catch {
          // Fall through and close it for real.
        }
      }
      await client.close();
    };
    return { db: drizzle(client, { schema, logger }) as unknown as Db, close, empty: () => emptyTables(parked) };
  }
  const client = new PGlite({ dataDir, extensions: { vector } });
  const db = drizzle(client, { schema, logger });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close(), empty: async () => emptyTables(await poolEntry(client)) };
}
