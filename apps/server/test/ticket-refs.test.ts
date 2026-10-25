// Ticket references (PREFIX-number, one sequence per company): the migration's backfill and the insert trigger.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "../src/db/client.js";

describe("ticket numbers", () => {
  it("backfills imported tickets with their Paperclip number, numbers the rest after them, and continues the sequence", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    // The schema as it was just before ticket numbers, with tickets already in it.
    const before = mkdtempSync(path.join(tmpdir(), "bm-mig-"));
    cpSync(migrationsFolder, before, { recursive: true });
    const journalFile = path.join(before, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0056_ticket_refs"));
    writeFileSync(journalFile, JSON.stringify(journal));
    const pg = new PGlite({ extensions: { vector } });
    const db = drizzle(pg);
    await migrate(db, { migrationsFolder: before });

    const q = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
    const [hol] = await q<{ id: string }>(`insert into companies (name) values ('HolidayHours') returning id`);
    const [boss] = await q<{ id: string }>(`insert into companies (name) values ('Boss Man Co') returning id`);
    const project = async (c: string) => (await q<{ id: string }>(`insert into projects (company_id, name) values ($1, 'P') returning id`, [c]))[0]!.id;
    const [hp, bp] = [await project(hol!.id), await project(boss!.id)];
    const ticket = (c: string, p: string, title: string, body: string | null, at: string) => q(`insert into tickets (company_id, project_id, title, body, created_at) values ($1, $2, $3, $4, $5)`, [c, p, title, body, at]);
    await ticket(hol!.id, hp, "imported 7", "Do it.\n\nImported from HOL-7", "2026-01-02");
    await ticket(hol!.id, hp, "imported 3", "Imported from HOL-3", "2026-01-03");
    await ticket(hol!.id, hp, "made in Boss Man", "New work", "2026-01-01");
    await ticket(boss!.id, bp, "first", null, "2026-01-01");
    await ticket(boss!.id, bp, "second", null, "2026-01-02");

    await migrate(db, { migrationsFolder });
    const numbers = await q<{ title: string; number: number }>(`select title, number from tickets order by title`);
    expect(Object.fromEntries(numbers.map((r) => [r.title, r.number]))).toEqual({ "imported 7": 7, "imported 3": 3, "made in Boss Man": 8, first: 1, second: 2 });
    expect(await q(`select name, ticket_prefix, next_ticket_number from companies order by name`)).toEqual([
      { name: "Boss Man Co", ticket_prefix: "BOS", next_ticket_number: 3 },
      { name: "HolidayHours", ticket_prefix: "HOL", next_ticket_number: 9 },
    ]);

    // New tickets continue each company's own sequence; a given number moves it on, and a repeat is refused.
    const added = async (c: string, p: string, n?: number) => (await q<{ number: number }>(`insert into tickets (company_id, project_id, title, number) values ($1, $2, 'x', $3) returning number`, [c, p, n ?? null]))[0]!.number;
    expect(await added(hol!.id, hp)).toBe(9);
    expect(await added(boss!.id, bp)).toBe(3);
    expect(await added(hol!.id, hp, 20)).toBe(20);
    expect(await added(hol!.id, hp)).toBe(21);
    await expect(added(hol!.id, hp, 3)).rejects.toThrow(/tickets_company_number/);
    await pg.close();
  });
});
