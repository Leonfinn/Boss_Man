import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, compare } from "./check-test-lines.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-test-lines.mjs");
const rules = (src, opts) => scanText(src, opts).map((h) => `${h.rule}@${h.line}`);

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
  assert.deepEqual(rules("expect(elapsed).toBeLessThan(baselineMs * 3);"), []);
  assert.deepEqual(rules("// test-lines-ok: the sleep is the thing under test\nawait sleep(500);"), []);
  assert.deepEqual(rules("expect(a).toBe(1); // Date.now()"), []);
  assert.deepEqual(rules("async function pollUntil(f, ms) {\n  await sleep(ms);\n}"), []);
  assert.deepEqual(rules("const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));"), []);
  assert.deepEqual(rules("function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }"), []);
  assert.deepEqual(rules('const lines = readFileSync(f, "utf8").split("\\n"); const x = lines.slice(0, 5);'), []);
  assert.deepEqual(rules("expect(count).toBeLessThan(3);\nexpect(a - b).toBe(1);"), []);
  assert.deepEqual(rules('const s = "await sleep(500)";'), []);
});

test("catches the variants (BOS-1758): wrapped, function(), variable delay, for-of, subtraction, getTime, later slice", () => {
  assert.deepEqual(rules("await new Promise((resolve) =>\n  setTimeout(resolve, 300),\n);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("await new Promise(\n  (r) => {\n    setTimeout(r, 300);\n  },\n);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("await new Promise(function (r) { setTimeout(r, 300) });"), ["bare-sleep@1"]);
  assert.deepEqual(rules("await sleep(DELAY);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("await new Promise((r) => setTimeout(r, DELAY));"), ["bare-sleep@1"]);
  assert.deepEqual(rules("for (const x of xs) await sleep(50);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("expect(t1 - t0).toBeLessThan(500);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(\n  end - start,\n).toBeLessThan(500);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(ms).toBeLessThan(500);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(new Date().getTime() - t0).toBeLessThanOrEqual(500);"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("expect(row.at).toBe(new Date().getTime() + 1000);"), ["fresh-date-sum@1"]);
  assert.deepEqual(rules('const t = readFileSync(f, "utf8");\nexpect(1).toBe(1);\nconst h = t.slice(0, 200);'), ["fixed-length-read@3"]);
  assert.deepEqual(rules('const h = (await fs.readFile(p, "utf8")).slice(0, 200);'), ["fixed-length-read@1"]);
  assert.deepEqual(rules('const h = await fs.promises.readFile(p).then((b) => b.toString());\nh.slice(0, 5);'), ["fixed-length-read@2"]);
});

test("a comment never switches a rule off; only the marker does", () => {
  assert.deepEqual(rules("expect(elapsed).toBeLessThan(500); // baseline"), ["elapsed-limit@1"]);
  assert.deepEqual(rules("// LIMIT_MS\nexpect(elapsed).toBeLessThan(500);"), ["elapsed-limit@2"]);
  assert.deepEqual(rules("/* for (;;) */ await sleep(50);"), ["bare-sleep@1"]);
  assert.deepEqual(rules("// for (let i = 0; i < 3; i++)\nawait sleep(50);"), ["bare-sleep@2"]);
  assert.deepEqual(rules("/* test-lines-ok: waits for the debounce */\nawait sleep(50);"), []);
  assert.deepEqual(rules("await new Promise((r) =>\n  setTimeout(r, 50)); // test-lines-ok: x"), []);
  assert.deepEqual(rules("// test-lines-ok: x\nawait new Promise((r) =>\n  setTimeout(r, 50));"), []);
});

test("hidden-stderr: the five shapes, inside a string, and shell files (BOS-2794)", () => {
  for (const s of ["2>/dev/null", "2> /dev/null", "&>/dev/null", ">/dev/null 2>&1", "2>&-"]) {
    assert.deepEqual(rules('execSync("npx x ' + s + '");'), ["hidden-stderr@1"], s);
    assert.deepEqual(rules('r = x ' + s, { shell: true }), ["hidden-stderr@1"], s);
  }
  assert.deepEqual(rules('execSync("a 2>/dev/null && b 2>/dev/null");'), ["hidden-stderr@1"]);
  // a comment is not counted, in either language
  assert.deepEqual(rules("// run with 2>/dev/null\nexpect(ok()).toBe(true);"), []);
  assert.deepEqual(rules("# hide it: 2>/dev/null\necho hi", { shell: true }), []);
  assert.deepEqual(rules("echo hi # 2>/dev/null", { shell: true }), []);
  assert.deepEqual(rules('echo "# not a comment" 2>/dev/null', { shell: true }), ["hidden-stderr@1"]);
  // the escape works on the same line or the line above, in either comment style
  assert.deepEqual(rules("await run(); // test-lines-ok: the failure is asserted after\nawait run(null, 2>/dev/null);"), []);
  assert.deepEqual(rules("// test-lines-ok: expected to fail\nexecSync('x 2>/dev/null');"), []);
  assert.deepEqual(rules("# test-lines-ok: expected to fail\nx 2>/dev/null", { shell: true }), []);
  // a redirect without a hidden stderr is fine
  assert.deepEqual(rules("execSync('echo hi >/dev/null');"), []);
  assert.deepEqual(rules("execSync('cmd 2>&1');"), []);
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
    // a *.test.sh file is scanned too (BOS-2794)
    writeFileSync(path.join(dir, "scripts", "b.test.sh"), "echo hi 2>/dev/null\n");
    git("add", ".");
    const shellHit = run();
    assert.equal(shellHit.status, 1);
    assert.match(shellHit.stderr, /scripts\/b\.test\.sh:1: echo hi 2>\/dev\/null/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
