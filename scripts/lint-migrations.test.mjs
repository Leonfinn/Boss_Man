import assert from "node:assert/strict";
import { test } from "node:test";
import { lintSql } from "./lint-migrations.mjs";
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
});
