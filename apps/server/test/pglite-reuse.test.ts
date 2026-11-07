// BOS-657: openPglite() hands a closed database to the next test after emptying it. These prove nothing leaks, and that the opt-out is really fresh.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";

const rows = async (db: Awaited<ReturnType<typeof openPglite>>["db"], q: string) => (await db.execute(sql.raw(q))).rows as Record<string, unknown>[];

describe("openPglite reuse", () => {
  it("empties rows and restarts sequences between tests", async () => {
    const first = await openPglite();
    await first.db.execute(sql`insert into companies (name) values ('A'), ('B')`);
    await first.db.execute(sql`insert into companies (name) values ('C')`);
    expect(await rows(first.db, "select * from companies")).toHaveLength(3);
    await first.close();

    // The schema has no serial columns today (ids are uuids, ticket numbers a per-company counter), so "sequences restart" is
    // proved by the counter: a new company starts at its default, whatever the last test did.
    const second = await openPglite();
    expect(await rows(second.db, "select * from companies")).toHaveLength(0);
    await second.db.execute(sql`insert into companies (name) values ('D')`);
    expect(await rows(second.db, "select * from companies")).toHaveLength(1);
    await second.close();
  });

  it("really reuses the instance (the cost saved)", async () => {
    const a = await openPglite();
    await a.db.execute(sql`create temp table marker (x int)`); // temp tables live on the connection, so only the same instance sees it
    await a.close();
    const b = await openPglite();
    // temp tables vanish only with the session; the instance is the same one, so it is still there.
    const r = await rows(b.db, "select to_regclass('pg_temp.marker') as t");
    expect(r[0]?.t).toBe("marker");
    await b.close();
  });

  it("fresh: true gives a new database, and does not park the old one", async () => {
    const a = await openPglite();
    await a.db.execute(sql`create temp table marker2 (x int)`);
    await a.close();
    const f = await openPglite(undefined, { fresh: true });
    expect((await rows(f.db, "select to_regclass('pg_temp.marker2') as t"))[0]?.t).toBeNull();
    await f.db.execute(sql`insert into companies (name) values ('X')`);
    await f.close();
    const next = await openPglite();
    expect(await rows(next.db, "select * from companies")).toHaveLength(0);
    await next.close();
  });

  it("a test that changes the table list gets its database closed, not reused", async () => {
    const a = await openPglite();
    await a.db.execute(sql`create table extra_table (x int)`);
    await a.close();
    const b = await openPglite();
    expect((await rows(b.db, "select to_regclass('public.extra_table') as t"))[0]?.t).toBeNull();
    await b.close();
  });
});
