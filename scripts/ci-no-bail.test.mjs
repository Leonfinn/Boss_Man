// BOS-1661: CI reports every failing package in one run, so a fix isn't found out one fault per GitHub round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("every pnpm typecheck/test run in ci.yml is recursive with --no-bail", () => {
  const lines = ci.split("\n").filter((l) => !/^\s*#/.test(l) && /pnpm\b.*\b(typecheck|test)\b/.test(l) && !/--filter|exec vitest/.test(l));
  assert.ok(lines.length >= 3, "expected the check job's two steps and the worker-image run");
  for (const l of lines) assert.match(l, /pnpm -r --no-bail (typecheck|test)/, `missing --no-bail: ${l.trim()}`);
});

test("the check job's test step still runs after a failed typecheck", () => {
  const i = ci.indexOf("run: pnpm -r --no-bail test");
  assert.ok(i > 0);
  assert.match(ci.slice(Math.max(0, i - 80), i), /if: \$\{\{ !cancelled\(\) \}\}/);
});
