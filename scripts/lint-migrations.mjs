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
  // The image updater (BOS-1226) migrates, flips, and keeps the old release as a standby it can start again: old code must run against the
  // new schema for the soak and after a going-back. A dropped default or a dropped object the old release uses breaks it like a DROP COLUMN.
  [/\bALTER\s+COLUMN\s+\S+\s+DROP\s+DEFAULT\b/i, "ALTER COLUMN ... DROP DEFAULT"],
  [/\bDROP\s+(SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TRIGGER|SEQUENCE|EXTENSION|RULE|POLICY)\b/i, "DROP of a schema object"],
  [/\bALTER\s+TYPE\s+\S+\s+(DROP|RENAME)\s+VALUE\b/i, "ALTER TYPE ... DROP/RENAME VALUE"],
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

/** Drizzle skips a migration whose "when" isn't above the latest one already applied, so each entry must beat the one before. */
export function lintJournal(journal) {
  const problems = [];
  const entries = journal.entries ?? [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1], cur = entries[i];
    if (cur.when > prev.when) continue;
    problems.push(`_journal.json: entry ${cur.idx} "${cur.tag}" has when=${cur.when}, not greater than entry ${prev.idx} "${prev.tag}" (when=${prev.when}). Existing databases would silently skip it; set its "when" to more than ${prev.when}.`);
  }
  return problems;
}

export function newMigrations(dir) {
  return readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > BASELINE).sort();
}

/** Matches a migration file name and anything after its number: "0075_name.sql", "drizzle/0075_name.sql". */
const MIGRATION_FILE = /(?:^|\/)(\d{4})_([^/]+)\.sql$/;

/**
 * What one set of migration files says: the highest number, the file names by number, and the
 * highest journal `when` (from `journalWhen`). Files come in as paths (a git name-status lists
 * "dir/0075_x.sql").
 */
export function migrationSet(files, journalWhen = []) {
  const byNumber = new Map();
  const byTag = new Map();
  let max = 0;
  for (const file of files) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) continue;
    const num = Number(m[1]);
    const tag = `${m[1]}_${m[2]}`;
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(tag);
    byTag.set(tag, num);
    if (num > max) max = num;
  }
  return { max, byNumber, byTag, maxWhen: journalWhen?.length ? Math.max(...journalWhen) : null };
}

/**
 * The migration numbers already taken for a branch's new migrations (BOS-219). `mine` is old or
 * changed migration files on the branch and `others` everything already on, or coming on, another
 * branch. A number is taken when another branch uses it for a different migration file (an edit to
 * the same file, like merging main in, is not a clash), or when the branch has a new journal entry
 * no higher than one already on the default branch (drizzle would silently skip it).
 */
export function migrationClashes(mine, others) {
  const clashes = [];
  const seen = new Set();
  const add = (number, why) => {
    const key = `${number}:${why}`;
    if (seen.has(key)) return;
    seen.add(key);
    clashes.push({ number, why });
  };
  const mineNums = migrationSet(mine.files, mine.when);
  const otherNums = migrationSet(others.files, others.when);
  for (const [num, tags] of mineNums.byNumber) {
    if (num === 0) continue;
    const theirTags = otherNums.byNumber.get(num) ?? [];
    for (const tag of tags) if (theirTags.some((t) => t !== tag)) add(num, `${tag} shares its number with ${theirTags.filter((t) => t !== tag).join(", ")}`);
  }
  if (mineNums.maxWhen != null && otherNums.maxWhen != null && mineNums.max > otherNums.max && mineNums.maxWhen <= otherNums.maxWhen) {
    // Another branch already has migrations the journal has applied: ours would sort beside them and be skipped.
    for (const [num, tags] of mineNums.byNumber) if (num > otherNums.max) for (const tag of tags) add(num, `${tag} would be skipped: the journal's "when" (${mineNums.maxWhen}) isn't later than the one already applied (${otherNums.maxWhen})`);
  }
  return clashes.sort((a, b) => a.number - b.number);
}

/** The lowest number at or above `from` that none of the given file sets uses. */
export function nextFreeNumber(sets, from) {
  const taken = new Set();
  for (const set of sets) for (const num of migrationSet(set.files, set.when).byNumber.keys()) taken.add(num);
  let n = Math.max(0, from);
  while (taken.has(n)) n++;
  return n;
}

/**
 * Two migration files with the same number can't both exist in one folder, but a merge can leave
 * the folder with one of them and the journal with both, or two entries on the same number: a real
 * clash to fix by hand (BOS-219). Returns "file: problem" strings.
 */
export function lintNumberClash(files, journal) {
  const problems = [];
  const nums = new Map();
  for (const f of files) {
    const m = MIGRATION_FILE.exec(f);
    if (!m) continue;
    const num = m[1];
    if (!nums.has(num)) nums.set(num, []);
    nums.get(num).push(f);
  }
  for (const [num, list] of nums) if (list.length > 1) problems.push(`${list.join(", ")}: number ${num} is used twice`);
  const tagsByNum = new Map();
  for (const e of journal.entries ?? []) {
    const m = /^(\d{4})_/.exec(e.tag ?? "");
    if (!m) continue;
    if (!tagsByNum.has(m[1])) tagsByNum.set(m[1], []);
    tagsByNum.get(m[1]).push(e.tag);
  }
  for (const [num, tags] of tagsByNum) if (tags.length > 1) problems.push(`_journal.json: number ${num} is used twice (${tags.join(", ")})`);
  // The journal must list every migration above the baseline, or the server never applies one of them.
  const onDisk = new Set([...nums.entries()].filter(([num]) => Number(num) > BASELINE).map(([, list]) => list[0].replace(/^.*\//, "").slice(0, -4)));
  for (const e of journal.entries ?? []) if (Number((e.tag ?? "").slice(0, 4)) > BASELINE && !onDisk.has(e.tag)) problems.push(`_journal.json: entry "${e.tag}" has no ${e.tag}.sql`);
  for (const tag of onDisk) if (!(journal.entries ?? []).some((e) => e.tag === tag)) problems.push(`${tag}.sql: not listed in _journal.json`);
  return problems;
}

const NO_PARENT = "00000000-0000-0000-0000-000000000000";

/**
 * drizzle-kit's snapshot chain (BOS-519). `drizzle-kit generate` diffs schema.ts against the
 * snapshot file that sorts last, refuses to run when two snapshots share a prevId, and names the
 * new migration after the last journal entry's idx + 1, so every entry needs its own
 * `meta/NNNN_snapshot.json` chained to the entry before it, and the last idx must be at least the
 * highest migration number. `snapshots` maps file name ("0101_snapshot.json") to parsed JSON.
 * Whether the last snapshot matches schema.ts is apps/server/test/migrations.test.ts's job.
 */
export function lintSnapshots(journal, snapshots) {
  const problems = [];
  const entries = journal.entries ?? [];
  const fix = "To fix: merge origin/main, delete your migration's .sql, snapshot and journal entry, and run pnpm db:generate again.";
  const byPrev = new Map();
  for (const [file, s] of snapshots) {
    if (!byPrev.has(s.prevId)) byPrev.set(s.prevId, []);
    byPrev.get(s.prevId).push(file);
  }
  for (const [prevId, files] of byPrev) if (files.length > 1) problems.push(`${files.sort().join(", ")}: share prevId ${prevId}, so drizzle-kit generate refuses to run. ${fix}`);
  const listed = new Set();
  let prev = null;
  for (const e of entries) {
    const file = `${String(e.tag).split("_")[0]}_snapshot.json`;
    listed.add(file);
    const s = snapshots.get(file);
    if (prev && !(e.idx > prev.idx)) problems.push(`_journal.json: entry "${e.tag}" has idx ${e.idx}, not greater than "${prev.tag}" (${prev.idx}).`);
    if (!s) problems.push(`_journal.json: entry "${e.tag}" has no meta/${file}. ${fix}`);
    else {
      const want = prev ? prev.id : NO_PARENT;
      if (want !== undefined && s.prevId !== want) problems.push(`${file}: prevId is ${s.prevId}, but the entry before it ("${prev?.tag ?? "none"}") has snapshot id ${want}. ${fix}`);
    }
    prev = { tag: e.tag, idx: e.idx, id: s?.id };
  }
  for (const file of snapshots.keys()) if (!listed.has(file)) problems.push(`meta/${file}: no journal entry uses it.`);
  const highest = Math.max(-1, ...entries.map((e) => Number(String(e.tag).slice(0, 4))).filter(Number.isFinite));
  if (prev && prev.idx < highest) problems.push(`_journal.json: the last entry "${prev.tag}" has idx ${prev.idx}, below the highest migration number ${highest}, so drizzle-kit generate would name the next migration ${String(prev.idx + 1).padStart(4, "0")}. Set the last entry's idx to its own number.`);
  return problems;
}

/** Every `meta/NNNN_snapshot.json` in a drizzle folder, by file name. */
export function readSnapshots(dir) {
  const meta = join(dir, "meta");
  return new Map(readdirSync(meta).filter((f) => f.endsWith("_snapshot.json")).map((f) => [f, JSON.parse(readFileSync(join(meta, f), "utf8"))]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "apps/server/drizzle";
  const files = newMigrations(dir);
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
  const problems = files.flatMap((f) => lintSql(f, readFileSync(join(dir, f), "utf8")));
  problems.push(...lintJournal(journal));
  problems.push(...lintNumberClash(files, journal));
  problems.push(...lintSnapshots(journal, readSnapshots(dir)));
  if (problems.length) {
    console.error(`Migration lint failed:\n${problems.join("\n")}\nSee docs/10-migrations.md.`);
    process.exit(1);
  }
  console.log(`Migration lint ok (${files.length} new migration${files.length === 1 ? "" : "s"} above ${String(BASELINE).padStart(4, "0")}).`);
}
