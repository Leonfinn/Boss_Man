import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { summarize } from "./test-times.mjs";

test("summarize: vitest files and shell tests, slowest first", () => {
  const d = mkdtempSync(path.join(tmpdir(), "test-times-"));
  writeFileSync(path.join(d, "vitest-server.json"), JSON.stringify({ testResults: [
    { name: "/w/repo/apps/server/test/a.test.ts", startTime: 1000, endTime: 1500 },
    { name: "/w/repo/apps/server/test/b.test.ts", startTime: 1000, endTime: 4200 },
    { name: "/w/repo/apps/server/test/c.test.ts", assertionResults: [{ duration: 100 }, { duration: 50 }] },
  ] }));
  writeFileSync(path.join(d, "shell.tsv"), "scripts/a.test.sh\t4\t0\nscripts/b.test.sh\t30\t0\n");
  const s = summarize(d);
  assert.deepEqual(Object.entries(s.vitest.server), [["apps/server/test/b.test.ts", 3.2], ["apps/server/test/a.test.ts", 0.5], ["apps/server/test/c.test.ts", 0.15]]);
  assert.deepEqual(Object.entries(s.shell), [["scripts/b.test.sh", 30], ["scripts/a.test.sh", 4]]);
});

test("summarize: missing or broken input gives empty sections", () => {
  const d = mkdtempSync(path.join(tmpdir(), "test-times-"));
  writeFileSync(path.join(d, "vitest-server.json"), "{not json");
  assert.deepEqual(summarize(d), { vitest: {}, shell: {} });
  assert.deepEqual(summarize(path.join(d, "nope")), { vitest: {}, shell: {} });
});
