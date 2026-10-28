// A drizzle migration is applied only when its `when` is later than the last one applied
// (pg-core/dialect.js), so the journal's timestamps must strictly increase in order.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const journalPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/_journal.json");

describe("drizzle migration journal", () => {
  it("lists migrations in order with strictly increasing `when` values", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entries = journal.entries;
    expect(entries.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      expect(cur.idx, `${cur.tag} idx`).toBe(prev.idx + 1);
      expect(cur.when, `${cur.tag} must be later than ${prev.tag} or the migrator skips it`).toBeGreaterThan(prev.when);
    }
  });
});
