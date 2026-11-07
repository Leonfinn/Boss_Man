// A database restart drops the pool's idle connections. The server must log that and reconnect, never exit
// (BOS-458). Needs a real Postgres: runs when TEST_DATABASE_URL is set (CI provides it), skipped otherwise.
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { openPostgres } from "../src/db/client.js";

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)("main pool survives dropped connections (real Postgres)", () => {
  it("killing the pool's backends does not crash the process, and the next query reconnects", async () => {
    // A name only this pool uses, so killing its backends leaves other test files' connections alone.
    const app = `bb458-${process.pid}`;
    const u = new URL(URL_!);
    u.searchParams.set("application_name", app);
    const { db, close } = await openPostgres(u.toString());
    const admin = new Client({ connectionString: URL_ });
    // With no 'error' listener on the pool, the event below would be an uncaught exception.
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await admin.connect();
      await db.execute(sql`select 1`); // leaves an idle pooled connection
      const killed = await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()", [app]);
      expect(killed.rowCount).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 300)); // let the error event arrive
      expect(uncaught).toEqual([]);
      const rows = await db.execute(sql`select 1 as ok`); // a new connection is made
      expect((rows as unknown as { rows: unknown[] }).rows[0]).toEqual({ ok: 1 });
    } finally {
      process.off("uncaughtException", onUncaught);
      await admin.end();
      await close();
    }
  });
});
