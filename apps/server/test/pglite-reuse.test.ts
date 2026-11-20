// BOS-657: openPglite() hands a closed database to the next test after emptying it. These prove nothing leaks, and that the opt-out is really fresh.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";

const rows = async (db: Awaited<ReturnType<typeof openPglite>>["db"], q: string) => ((await db.execute(sql.raw(q))) as unknown as { rows: unknown }).rows as Record<string, unknown>[];

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

  // BOS-1940: close() deletes from the tables that hold rows (foreign-key checks off for the deletes) instead of truncating all of them.
  it("empties linked rows in any order, and the next test still has foreign keys and triggers on", async () => {
    const first = await openPglite();
    const [co] = await rows(first.db, "insert into companies (name) values ('A') returning id");
    const [pr] = await rows(first.db, `insert into projects (company_id, name) values ('${co!.id}', 'P') returning id`);
    await first.db.execute(sql.raw(`insert into tickets (company_id, project_id, title) values ('${co!.id}', '${pr!.id}', 'T')`));
    await first.close();

    const second = await openPglite();
    for (const t of ["companies", "projects", "tickets", "ticket_transitions"]) expect(await rows(second.db, `select 1 from ${t}`), t).toHaveLength(0);
    // The emptied tables hold no pages, as after a truncate, so new rows are stored (and read back unordered) in the order written.
    expect((await rows(second.db, "select sum(pg_relation_size(c.oid))::int as n from pg_class c where c.relname in ('companies', 'projects', 'tickets', 'ticket_transitions')"))[0]?.n).toBe(0);
    // The planner's row counts are "never counted" again (-1, as after a truncate), for the tables and their indexes, not the
    // vacuum's "0 rows": with 0 it plans seq scans and the query-plan tests (run-query-performance) see other plans.
    const counted = await rows(second.db, "select c.relname, c.reltuples from pg_class c where (c.relname in ('companies', 'projects', 'tickets') or c.oid in (select indexrelid from pg_index where indrelid = 'public.tickets'::regclass)) and c.reltuples <> -1");
    expect(counted).toEqual([]);
    // Foreign keys are enforced again: a project for a company that doesn't exist is refused.
    await expect(second.db.execute(sql`insert into projects (company_id, name) values (gen_random_uuid(), 'orphan')`)).rejects.toThrow();
    // Triggers are on again: a new ticket gets number 1 from its company's counter.
    const [co2] = await rows(second.db, "insert into companies (name) values ('B') returning id");
    const [pr2] = await rows(second.db, `insert into projects (company_id, name) values ('${co2!.id}', 'P') returning id`);
    const [t] = await rows(second.db, `insert into tickets (company_id, project_id, title) values ('${co2!.id}', '${pr2!.id}', 'T') returning number`);
    expect(t?.number).toBe(1);
    await second.close();
  });

  it("restarts a sequence a test used", async () => {
    const a = await openPglite();
    await a.db.execute(sql`create sequence if not exists reuse_probe_seq`);
    await a.db.execute(sql`select nextval('reuse_probe_seq'), nextval('reuse_probe_seq')`);
    await a.close();
    const b = await openPglite();
    expect((await rows(b.db, "select nextval('reuse_probe_seq')::int as n"))[0]?.n).toBe(1);
    await b.close();
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
