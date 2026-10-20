// Expand/contract guard for SQL migrations (rules: docs/10-migrations.md).
// Scans only migrations numbered above BASELINE (the highest one that existed when the lint
// arrived), so history is never re-judged. Flags statements that break "release N-1 runs on
// release N's schema" unless the statement, or the line above it, carries
//   -- contract-ok: <reason>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BASELINE = 42;

const RULES = [
  [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i, "DROP"],
  [/\bRENAME\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, "ALTER COLUMN ... TYPE"],
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, "DELETE FROM without WHERE"],
];
const ADD_COLUMN = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[^,(]|\([^)]*\))*)/gi;
const MARKER = /--\s*contract-ok:\s*\S/i;

/** Returns "file:line: problem" strings for one migration's SQL. */
export function lintSql(file, sql) {
  const lines = sql.split("\n");
  const problems = [];
  let stmt = { code: "", start: 0, end: 0 };
  const finish = () => {
    const { code, start, end } = stmt;
    stmt = { code: "", start: end + 1, end: end + 1 };
    if (!code.trim()) return;
    const found = RULES.filter(([re]) => re.test(code)).map(([, name]) => name);
    for (const m of code.matchAll(ADD_COLUMN)) if (/\bNOT\s+NULL\b/i.test(m[1]) && !/\bDEFAULT\b/i.test(m[1])) found.push("ADD COLUMN ... NOT NULL without DEFAULT");
    if (!found.length) return;
    const noted = lines.slice(Math.max(0, start - 1), end + 1).some((l) => MARKER.test(l));
    if (!noted) problems.push(`${file}:${start + 1}: ${[...new Set(found)].join(", ")} (add "-- contract-ok: <reason>" on or above the statement if this is a deliberate contract step)`);
  };
  lines.forEach((line, i) => {
    stmt.end = i;
    const code = line.replace(/--.*$/, "");
    if (!stmt.code.trim() && !code.trim()) return void (stmt.start = i + 1);
    stmt.code += code + "\n";
    if (/;\s*$/.test(code)) finish();
  });
  stmt.end = lines.length - 1;
  finish();
  return problems;
}

export function newMigrations(dir) {
  return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > BASELINE).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "apps/server/drizzle";
  const files = newMigrations(dir);
  const problems = files.flatMap((f) => lintSql(f, readFileSync(join(dir, f), "utf8")));
  if (problems.length) {
    console.error(`Migration lint failed:\n${problems.join("\n")}\nSee docs/10-migrations.md.`);
    process.exit(1);
  }
  console.log(`Migration lint ok (${files.length} new migration${files.length === 1 ? "" : "s"} above ${String(BASELINE).padStart(4, "0")}).`);
}
