import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, compare } from "./check-test-lines.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-test-lines.mjs");
const rules = (src) => scanText(src).map((h) => `${h.rule}@${h.line}`);

test("flags the four shapes", () => {
  assert.deepEqual(rules("await new Promise((r) => setTimeout(r, 300));"), ["bare-sleep@1"]);
  assert.deepEqual(rules("await sleep(500);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("expect(elapsed).toBeLessThan(2000);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(Date.now() - t0).toBeLessThan(2000);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(row.at).toBe(Date.now() + 1000);"), ["fresh-date-sum@1"]);
  assert.deepEqual(rules('const head = readFileSync(join(dir, "a.log"), "utf8").slice(0, 200);'), ["fixed-length-read@1"]);
});

test("allows polling loops, helpers, yields, baselines and the marker", () => {
  assert.deepEqual(rules("while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));"), []);
  assert.deepEqual(rules("for (let i = 0; i < 50; i++) {\n  if (ok()) break;\n  await new Promise((r) => setTimeout(r, 100));\n}"), []);
  assert.deepEqual(rules("async function waitFor(f) {\n  await sleep(25);\n}"), []);
  assert.deepEqual(rules("await new Promise((r) => setTimeout(r, 0));"), []);
  assert.deepEqual(rules("const wait = (ms) => new Promise((r) => setTimeout(r, ms));"), []);
  assert.deepEqual(rules("expect(elapsed).toBeLessThan(LIMIT_MS);"), []);
  assert.deepEqual(rules("expect(elapsed).toBeLessThan(base * 3); // baseline run"), []);
  assert.deepEqual(rules("// test-lines-ok: the sleep is the thing under test\nawait sleep(500);"), []);
  assert.deepEqual(rules('const all = readFileSync(f, "utf8"); const x = all.slice(0, 5);'), []);
  assert.deepEqual(rules("expect(a).toBe(1); // Date.now()"), []);
});

test("compare: more than the baseline fails, fewer only reports", () => {
  const hit = { line: 1, text: "x" };
  const found = { "bare-sleep": { "a.test.ts": [hit, hit], "b.test.ts": [hit] } };
  const r = compare(found, { "bare-sleep": { "a.test.ts": 1, "b.test.ts": 3, "c.test.ts": 1 } });
  assert.deepEqual(r.failures.map((f) => f.file), ["a.test.ts"]);
  assert.deepEqual(r.lower.map((f) => f.file).sort(), ["b.test.ts", "c.test.ts"]);
});

test("end to end: a new hit in a tracked test file fails with file, line and the guide", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-lines-"));
  try {
    const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "pkg", "test"), { recursive: true });
    writeFileSync(path.join(dir, "pkg", "test", "a.test.ts"), "await sleep(100);\n");
    git("add", ".");
    const run = (...a) => spawnSync("node", [script, "--root", dir, ...a], { encoding: "utf8" });
    assert.equal(run("--update").status, 0);
    assert.equal(run().status, 0);
    writeFileSync(path.join(dir, "pkg", "test", "a.test.ts"), "await sleep(100);\nawait sleep(200);\n");
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pkg\/test\/a\.test\.ts:1: await sleep\(100\)/);
    assert.match(r.stderr, /pkg\/test\/a\.test\.ts:2: await sleep\(200\)/);
    assert.match(r.stderr, /Writing tests/);
    writeFileSync(path.join(dir, "pkg", "test", "a.test.ts"), "");
    const fewer = run();
    assert.equal(fewer.status, 0);
    assert.match(fewer.stdout, /--update/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
