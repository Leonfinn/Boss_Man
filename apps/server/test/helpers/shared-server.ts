// One database and one app per test file instead of one per test (BOS-686, after BOS-663 and BOS-657).
// Building an app costs about 0.2 CPU-s a test; emptying every table costs about 0.08.
//
// Between tests the database is emptied: every table, ids restarted. So no row a test made is there for
// the next one, and each test still makes its own company, owner and agents. What stays across tests is
// only the app's in-memory state, which is keyed by ids that no later test can have.
import { sql } from "drizzle-orm";
import { closePglitePool, openPglite, type Db } from "../../src/db/client.js";

/** Open one in-process database; `reset()` empties it, `close()` releases it (a test file's afterAll). */
export async function sharedDatabase() {
  const { db, close } = await openPglite();
  let tables: string[] | undefined;
  const reset = async () => {
    tables ??= ((await db.execute(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`)) as unknown as { rows: Array<{ tablename: string }> }).rows.map((r) => r.tablename);
    if (tables.length) await db.execute(sql.raw(`truncate table ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
  };
  return {
    db: db as Db,
    reset,
    close: async () => {
      await close();
      await closePglitePool();
    },
  };
}

/** Apps built on the shared database, one per distinct set of options; every one is closed at the end. */
export function appCache<T extends { app: { close(): Promise<unknown> } }>() {
  const apps = new Map<string, Promise<T>>();
  return {
    get: (key: string, build: () => Promise<T>) => {
      let p = apps.get(key);
      if (!p) apps.set(key, (p = build()));
      return p;
    },
    closeAll: async () => {
      const all = [...apps.values()];
      apps.clear();
      for (const p of all) await (await p).app.close();
    },
  };
}
