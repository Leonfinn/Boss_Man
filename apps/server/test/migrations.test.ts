// A drizzle migration is applied only when its `when` is later than the last one applied
// (pg-core/dialect.js), so the journal's timestamps must strictly increase in order.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const journalPath = path.join(drizzleDir, "meta/_journal.json");

describe("drizzle migration journal", () => {
  it("lists migrations in order with strictly increasing `when` values", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entries = journal.entries;
    expect(entries.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      // idx may skip (BOS-519 set 0101's idx to 101 so generate names the next one 0102); the migrator ignores it.
      expect(cur.idx, `${cur.tag} idx`).toBeGreaterThan(prev.idx);
      expect(cur.when, `${cur.tag} must be later than ${prev.tag} or the migrator skips it`).toBeGreaterThan(prev.when);
    }
  });

  // BOS-519: `drizzle-kit generate` diffs schema.ts against the snapshot file that sorts last. If they
  // differ, a clean checkout would generate a migration: schema.ts changed without one, or a snapshot
  // is stale (main's 0101 lacked 0089's columns). The chain itself is checked by scripts/lint-migrations.mjs.
  it("schema.ts matches the newest snapshot, so drizzle-kit generate has nothing to write", async () => {
    const files = readdirSync(path.join(drizzleDir, "meta")).filter((f) => f.endsWith("_snapshot.json")).sort();
    const last = JSON.parse(readFileSync(path.join(drizzleDir, "meta", files.at(-1)!), "utf8"));
    const statements = await generateMigration(last, generateDrizzleJson(schema, last.id));
    expect(statements, `run pnpm db:generate: schema.ts differs from meta/${files.at(-1)}`).toEqual([]);
  });
});
