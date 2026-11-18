import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { annotation, failureSummary } from "./annotate-vitest-failures.mjs";

const report = {
  testResults: [
    { name: "/w/apps/runner/test/a.test.ts", status: "passed", assertionResults: [{ status: "passed", title: "ok", failureMessages: [] }] },
    { name: "/w/apps/runner/test/b.test.ts", status: "failed", assertionResults: [{ status: "failed", title: "waits for it", failureMessages: ["AssertionError: expected 1 to be 2\n at x"] }] },
    { name: "/w/apps/runner/test/c.test.ts", status: "failed", assertionResults: [], message: "Error: cannot import\nstack" },
  ],
};

test("names each failing test and each file that failed to load, one line", () => {
  const s = failureSummary(report);
  assert.equal(s, "b.test.ts: waits for it: AssertionError: expected 1 to be 2 | c.test.ts: Error: cannot import");
});

test("writes an error annotation, and says so when no report exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "annot-"));
  const file = path.join(dir, "r.json");
  writeFileSync(file, JSON.stringify(report));
  assert.match(annotation(file, "runner tests failed"), /^::error title=runner tests failed::b\.test\.ts: waits for it/);
  assert.equal(annotation(path.join(dir, "missing.json"), "t"), "::error title=t::no JSON report was written");
});

test("still posts an annotation when the JSON has no testResults", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "annot-"));
  const file = path.join(dir, "r.json");
  writeFileSync(file, "{}");
  assert.equal(annotation(file, "t"), "::error title=t::the JSON report had no test results");
});
