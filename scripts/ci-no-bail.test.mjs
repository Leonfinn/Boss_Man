// BOS-1661: CI reports every failing package in one run, so a fix isn't found out one fault per GitHub round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
// pnpm's own flags may sit between "pnpm" and the script name (--reporter-hide-prefix, BOS-1721).
const run = /pnpm (-r |--filter \S+ )?((?:--[\w-]+ )*)(typecheck|test)\b/;

test("every pnpm typecheck/test run in ci.yml is recursive with --no-bail", () => {
  const lines = ci.split("\n").filter((l) => !/^\s*#/.test(l) && run.test(l) && !/--filter/.test(l));
  assert.ok(lines.length >= 3, "expected the check job's two steps and the worker-image run");
  for (const l of lines) {
    const m = l.match(run);
    assert.equal(m[1], "-r ", `not recursive: ${l.trim()}`);
    assert.match(m[2], /--no-bail /, `missing --no-bail: ${l.trim()}`);
  }
});

test("the check job's test step still runs after a failed typecheck", () => {
  const i = ci.indexOf("run: pnpm -r --no-bail --reporter-hide-prefix test");
  assert.ok(i > 0);
  // The step's own header (id, if, env) sits above its run line; 200 chars covers it without reaching the previous step.
  assert.match(ci.slice(Math.max(0, i - 200), i), /if: \$\{\{ !cancelled\(\) \}\}/);
});
