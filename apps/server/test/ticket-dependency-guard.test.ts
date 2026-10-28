import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// BOS-86 round 12: every write to ticket_dependencies goes through the one guarded helper in
// services/ticket-links.ts. Rounds 8-11 each closed a different route; this keeps a future route
// from quietly adding a new writer and reopening the review-task hole.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("ticket dependencies have one guarded writer", () => {
  it("only services/ticket-links.ts inserts into ticket_dependencies", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcRoot)) {
      const text = await readFile(file, "utf8");
      const inserts = /\.insert\(\s*ticketDependencies\s*\)/.test(text);
      const rawSql = /\binsert\s+into\s+["`']?ticket_dependencies\b/i.test(text);
      if ((inserts || rawSql) && path.relative(srcRoot, file) !== path.join("services", "ticket-links.ts")) {
        offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
