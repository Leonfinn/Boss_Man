import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { lintJournal, lintSql } from "./lint-migrations.mjs";
import { findUnannotated } from "./check-in-memory-state.mjs";

const bad = (sql) => lintSql("t.sql", sql);

test("allows expand-only SQL", () => {
  assert.deepEqual(bad('CREATE TABLE "a" ("id" uuid PRIMARY KEY);\n--> statement-breakpoint\nALTER TABLE "a" ADD COLUMN "b" text;\nALTER TABLE "a" ADD COLUMN "c" integer NOT NULL DEFAULT 0;\nALTER TYPE "s" ADD VALUE \'x\';\nCREATE INDEX "i" ON "a" ("b");'), []);
});

test("flags each contract statement", () => {
  for (const sql of [
    'DROP TABLE "a";',
    'ALTER TABLE "a" DROP COLUMN "b";',
    'DROP INDEX "i";',
    'DROP TYPE "t";',
    'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
    'ALTER TABLE "a" RENAME TO "z";',
    'ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE bigint;',
    'ALTER TABLE "a" ALTER COLUMN "b" TYPE bigint;',
    'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
    'ALTER TABLE "a" ADD COLUMN "b" text NOT NULL;',
    'ALTER TABLE "a" ADD COLUMN "x" text, ADD COLUMN "b" numeric(10,2) NOT NULL;',
    'TRUNCATE "a";',
    'DELETE FROM "a";',
  ]) assert.equal(bad(sql).length, 1, sql);
});

test("a contract-ok marker on the line, or the line above, clears it", () => {
  assert.deepEqual(bad('DROP INDEX "i"; -- contract-ok: recreated below'), []);
  assert.deepEqual(bad('-- contract-ok: recreated below\nDROP INDEX "i";'), []);
  assert.equal(bad('-- contract-ok:\nDROP INDEX "i";').length, 1); // a reason is required
  assert.equal(bad('-- contract-ok: x\n\nDROP INDEX "i";').length, 1); // not the line above
});

test("ignores words in comments, and judges statements one at a time", () => {
  assert.deepEqual(bad('-- we never DROP TABLE here\nALTER TABLE "a" ADD COLUMN "b" text;'), []);
  const p = bad('ALTER TABLE "a" ADD COLUMN "b" text;\n--> statement-breakpoint\nDROP TABLE "a";');
  assert.equal(p.length, 1);
  assert.match(p[0], /^t\.sql:3:/);
});

test("in-memory state check wants a note", () => {
  assert.equal(findUnannotated("f.ts", "const m = new Map<string, number>();").length, 1);
  assert.equal(findUnannotated("f.ts", "// shortcut: lost on restart\nconst m = new Map<string, number>();").length, 0);
  assert.equal(findUnannotated("f.ts", "const OK = new Set([1, 2]);\n    const local = new Map();").length, 0);
  assert.equal(findUnannotated("f.ts", "  const out = new Map(); // not state: built per call").length, 0);
});

test("in-memory state check also flags a top-level let (BOS-907)", () => {
  assert.equal(findUnannotated("f.ts", "let count = 0;").length, 1);
  assert.equal(findUnannotated("f.ts", "export let BASE = 60_000;").length, 1);
  assert.equal(findUnannotated("f.ts", "let resumed: Date | null = null;").length, 1);
  assert.equal(findUnannotated("f.ts", "  let local = 0;").length, 0); // inside a function or factory
  assert.equal(findUnannotated("f.ts", "// shortcut: per process\nlet count = 0;").length, 0);
  assert.equal(findUnannotated("f.ts", "let count = 0;\nlet other = 1;").length, 2);
  assert.equal(findUnannotated("f.ts", "let count = 0; // lost on restart, harmless because it is rebuilt on demand").length, 0);
  // A const stays a declaration the check only looks at when it holds a Map/Set.
  assert.equal(findUnannotated("f.ts", "const BASE = 60_000;").length, 0);
});

test("journal: flags a when value not later than the entry before it", () => {
  const e = (idx, tag, when) => ({ idx, tag, when });
  assert.deepEqual(lintJournal({ entries: [e(0, "0000_a", 10), e(1, "0001_b", 20)] }), []);
  for (const when of [20, 15]) {
    const [msg, ...rest] = lintJournal({ entries: [e(0, "0000_a", 10), e(1, "0001_b", 20), e(2, "0002_c", when)] });
    assert.equal(rest.length, 0);
    assert.match(msg, /0002_c/);
    assert.match(msg, /0001_b/);
    assert.match(msg, /more than 20/);
  }
});

// BOS-219: migration numbers are shared between branches, so a new one must not take a number
// another branch already has.
import { lintNumberClash, migrationClashes, migrationSet, nextFreeNumber } from "./lint-migrations.mjs";

const file = (n, name) => `drizzle/${String(n).padStart(4, "0")}_${name}.sql`;
const journalEntry = (n, name) => `${String(n).padStart(4, "0")}_${name}`;

test("migrationSet reads numbers, tags and the highest journal when from paths", () => {
  const set = migrationSet([file(75, "a"), file(76, "b"), "README.md", "drizzle/meta/_journal.json"], [100, 200]);
  assert.equal(set.max, 76);
  assert.deepEqual(set.byNumber.get(75), ["0075_a"]);
  assert.equal(set.maxWhen, 200);
});

test("a number taken on main is a clash", () => {
  const mine = { files: [file(75, "mine")] };
  const main = { files: ["0001_init.sql", file(75, "theirs")] };
  const clashes = migrationClashes(mine, main);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].number, 75);
  assert.match(clashes[0].why, /0075_mine/);
  assert.match(clashes[0].why, /0075_theirs/);
});

test("two open branches with the same number are told apart from one another", () => {
  const mine = { files: [file(76, "a")] };
  const other = { files: [file(76, "b")] };
  const second = { files: [file(76, "c")] };
  assert.deepEqual(migrationClashes(mine, other).map((c) => c.number), [76]);
  assert.deepEqual(migrationClashes(mine, second).map((c) => c.number), [76]);
  // The same file on both branches is not a clash: it is one migration that was merged in.
  assert.deepEqual(migrationClashes(mine, { files: [file(76, "a")] }), []);
});

test("a new journal entry no later than the one on main would be skipped", () => {
  const mine = { files: [file(76, "mine")], when: [500] };
  const main = { files: [file(75, "theirs")], when: [500] };
  const clashes = migrationClashes(mine, main);
  assert.equal(clashes.length, 1);
  assert.match(clashes[0].why, /skipped/);
  // A journal that is later than main's is fine, even on a number main doesn't use.
  assert.deepEqual(migrationClashes({ files: [file(76, "mine")], when: [501] }, main), []);
  // A branch that only merged main in (no number above main's) has nothing to say.
  assert.deepEqual(migrationClashes({ files: [file(75, "theirs")], when: [400] }, main), []);
});

test("nextFreeNumber skips every number any branch or main uses", () => {
  const sets = [{ files: [file(75, "a"), file(77, "b")] }, { files: [file(76, "c")] }];
  assert.equal(nextFreeNumber(sets, 75), 78);
  assert.equal(nextFreeNumber(sets, 80), 80);
});

test("the lint fails two files, or two journal entries, on one number", () => {
  const entries = (tags) => ({ entries: tags.map((tag, idx) => ({ idx, tag, when: 100 + idx })) });
  assert.deepEqual(lintNumberClash([file(75, "a"), file(75, "b")], entries([journalEntry(75, "a")])), [`${file(75, "a")}, ${file(75, "b")}: number 0075 is used twice`]);
  const [msg] = lintNumberClash([file(75, "a")], entries([journalEntry(75, "a"), journalEntry(75, "b")]));
  assert.match(msg, /number 0075 is used twice \(0075_a, 0075_b\)/);
  assert.deepEqual(lintNumberClash([file(75, "a")], entries([journalEntry(75, "a")])), []);
  assert.match(lintNumberClash([file(75, "a")], entries([]))[0], /not listed in _journal.json/);
  assert.match(lintNumberClash([], entries([journalEntry(75, "a")]))[0], /has no 0075_a.sql/);
});

// BOS-519: main's snapshot chain forked and lost snapshots, so drizzle-kit generate misnumbered migrations.
import { lintSnapshots, readSnapshots } from "./lint-migrations.mjs";

test("snapshots: a linear chain passes, and every way it broke on main fails", () => {
  const Z = "00000000-0000-0000-0000-000000000000";
  const journal = (...pairs) => ({ entries: pairs.map(([idx, num]) => ({ idx, tag: `${String(num).padStart(4, "0")}_x${num}`, when: 100 + idx })) });
  const snaps = (...pairs) => new Map(pairs.map(([num, id, prevId]) => [`${String(num).padStart(4, "0")}_snapshot.json`, { id, prevId }]));
  const ok = journal([0, 0], [1, 3], [7, 7]);
  assert.deepEqual(lintSnapshots(ok, snaps([0, "a", Z], [3, "b", "a"], [7, "c", "b"])), []);
  // two snapshots on one parent (generate refuses to run)
  assert.ok(lintSnapshots(ok, snaps([0, "a", Z], [3, "b", "a"], [7, "c", "a"])).some((p) => /0003_snapshot.json, 0007_snapshot.json: share prevId a/.test(p)));
  // a journal entry without a snapshot
  assert.match(lintSnapshots(ok, snaps([0, "a", Z], [7, "c", "b"])).join("\n"), /"0003_x3" has no meta\/0003_snapshot.json/);
  // a snapshot chained to something other than the entry before it
  assert.match(lintSnapshots(ok, snaps([0, "a", Z], [3, "b", "a"], [7, "c", "zzz"])).join("\n"), /0007_snapshot.json: prevId is zzz, but the entry before it \("0003_x3"\) has snapshot id b/);
  // a snapshot no entry uses
  assert.match(lintSnapshots(ok, snaps([0, "a", Z], [3, "b", "a"], [7, "c", "b"], [9, "d", "c"])).join("\n"), /meta\/0009_snapshot.json: no journal entry uses it/);
  // last idx below the highest number: generate would name the next migration 0003
  const low = journal([0, 0], [1, 3], [2, 7]);
  assert.match(lintSnapshots(low, snaps([0, "a", Z], [3, "b", "a"], [7, "c", "b"])).join("\n"), /idx 2, below the highest migration number 7, so drizzle-kit generate would name the next migration 0003/);
  // idx going backwards
  assert.match(lintSnapshots(journal([0, 0], [5, 3], [4, 7]), snaps([0, "a", Z], [3, "b", "a"], [7, "c", "b"])).join("\n"), /idx 4, not greater than "0003_x3" \(5\)/);
});

test("snapshots: the repo's own drizzle folder is a clean chain", () => {
  const dir = new URL("../apps/server/drizzle/", import.meta.url).pathname;
  const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, "utf8"));
  assert.deepEqual(lintSnapshots(journal, readSnapshots(dir)), []);
});
