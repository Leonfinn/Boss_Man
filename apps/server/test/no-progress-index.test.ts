// The no-progress sweep's trigger B read (BOS-593) must use the (company_id, created_at) index added
// in 0119 (BOS-611): it runs every minute, so a scan that grows with the table would never get cheaper.
import { afterEach, describe, expect, it } from "vitest";
import { and, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "../src/db/schema.js";
import { companies, failureSignatures } from "../src/db/schema.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("the no-progress trigger B query plans on the new index (BOS-611)", () => {
  it("failure_signatures_company_recent is chosen for (company_id in ..., created_at > ...) grouped by signature", async () => {
    // BOS-1926: a copy of the run's migrated template, not a fresh migration.
    const opened = await openPglite();
    const db = opened.db as unknown as ReturnType<typeof drizzle<typeof schema>>;
    const client = (db as unknown as { $client: PGlite }).$client;
    ctx = { close: opened.close };
    const [co] = await db.insert(companies).values({ name: "App Co", slug: "app-co" } as never).returning();
    const since = new Date(Date.now() - 3_600_000);
    const rows = Array.from({ length: 500 }, (_, i) => ({
      companyId: co!.id,
      signature: `sig-${i % 5}`,
      sample: "s",
      createdAt: new Date(since.getTime() - (i % 50) * 60_000),
    }));
    await db.insert(failureSignatures).values(rows);
    await client.query("analyze failure_signatures");

    const q = db
      .select({ companyId: failureSignatures.companyId, signature: failureSignatures.signature, n: sql<number>`count(*)::int` })
      .from(failureSignatures)
      .where(and(inArray(failureSignatures.companyId, [co!.id]), gt(failureSignatures.createdAt, since)))
      .groupBy(failureSignatures.companyId, failureSignatures.signature);
    const { sql: text, params } = new PgDialect().sqlToQuery(q.getSQL());
    const plan = ((await client.query(`explain ${text}`, params)).rows as Array<Record<string, string>>).map((r) => Object.values(r)[0]!).join("\n");
    expect(plan).toMatch(/failure_signatures_company_recent/);
    expect(plan).not.toMatch(/Seq Scan on failure_signatures/);
  });
});
