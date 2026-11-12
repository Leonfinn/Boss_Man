import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarise } from "./check-no-skips.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-no-skips.mjs");
const report = (statuses) => ({
  numPassedTests: statuses.filter((s) => s === "passed").length,
  testResults: [{ name: "a.test.ts", assertionResults: statuses.map((status, i) => ({ status, fullName: `t${i}` })) }],
});

test("summarise counts skipped and todo tests, not failed ones", () => {
  const r = summarise(report(["passed", "skipped", "failed", "todo", "pending"]));
  assert.equal(r.passed, 1);
  assert.deepEqual(r.skipped.map((s) => s.split(": ")[1]), ["t1", "t3", "t4"]);
});

test("exits 0 when everything passed, 1 on a skip or an empty run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "no-skips-"));
  try {
    const run = (r) => { const f = path.join(dir, "r.json"); writeFileSync(f, JSON.stringify(r)); return spawnSync("node", [script, f], { encoding: "utf8" }); };
    assert.equal(run(report(["passed", "passed"])).status, 0);
    const skipped = run(report(["passed", "skipped"]));
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /a\.test\.ts: t1/);
    assert.equal(run(report([])).status, 1);
    assert.equal(spawnSync("node", [script, path.join(dir, "missing.json")], { encoding: "utf8" }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
