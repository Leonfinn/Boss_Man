// Migrations as a step of their own (docs/10-migrations.md, docs/09-self-deploy.md "Phase 3, part 1").
// Imports only pg and drizzle-orm, so migrate.ts bundles into a tiny dist/migrate.js.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** Advisory-lock key for "a migration is running". The leader lock uses the next number (leader.ts). */
export const MIGRATE_LOCK_KEY = 5_141_440_002;

/** Applies pending migrations while holding the migrate lock; a second runner waits up to lockTimeoutMs, then fails. */
export async function runMigrations(url: string, opts: { folder: string; lockTimeoutMs?: number }): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const wait = Math.trunc(opts.lockTimeoutMs ?? 60_000);
    // lock_timeout also bounds the wait for an advisory lock.
    await client.query(`set lock_timeout = ${wait}`);
    try {
      await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    } catch (err) {
      throw new Error(`Another migration has held the migrate lock for ${wait / 1000}s; not migrating. (${(err as Error).message})`);
    }
    await client.query("set lock_timeout = 0");
    await migrate(drizzle(client), { migrationsFolder: opts.folder });
  } finally {
    await client.end(); // closing the session releases the lock
  }
}

/** Throws when the database has not had all of this release's migrations applied. A NEWER database is fine (expand/contract: N-1 runs on N's schema). */
export async function assertMigrated(url: string, folder: string): Promise<void> {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: { when: number }[] };
  const wanted = Math.max(0, ...journal.entries.map((e) => e.when));
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    let have = 0;
    try {
      const r = await client.query<{ m: string | null }>("select max(created_at) as m from drizzle.__drizzle_migrations");
      have = Number(r.rows[0]?.m ?? 0);
    } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err; // no migrations table yet: nothing applied
    }
    if (have < wanted) throw new Error("The database is older than this server: its migrations have not been applied. Run `node dist/migrate.js` (docker compose run --rm migrate) first, or start with BOSSMAN_MIGRATE_ON_START=1.");
  } finally {
    await client.end();
  }
}
