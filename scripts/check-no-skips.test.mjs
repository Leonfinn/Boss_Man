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

test("a skip passes only when its file is on the skip list with a reason (BOS-1729)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "no-skips-list-"));
  try {
    const rep = { numPassedTests: 1, testResults: [{ name: path.join(dir, "test/a.test.ts"), assertionResults: [{ status: "passed", fullName: "ok" }, { status: "skipped", fullName: "needs a browser" }] }] };
    const rf = path.join(dir, "r.json"); writeFileSync(rf, JSON.stringify(rep));
    const lf = path.join(dir, "list.txt");
    const run = (list) => { writeFileSync(lf, list); return spawnSync("node", [script, rf, "--root", dir, "--allow", lf], { encoding: "utf8" }); };
    assert.equal(run("# none\n").status, 1, "unlisted skip fails");
    assert.match(run("test/b.test.ts | other file\n").stderr, /test\/a\.test\.ts: needs a browser/);
    assert.equal(run("test/a.test.ts | needs a browser\n").status, 0, "listed skip passes");
    const noReason = run("test/a.test.ts\n");
    assert.equal(noReason.status, 1, "an entry with no reason fails");
    assert.match(noReason.stderr, /no reason/);
    assert.equal(spawnSync("node", [script, rf, "--root", dir, "--allow", path.join(dir, "gone.txt")], { encoding: "utf8" }).status, 1, "a missing list fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node:test junit report: a skipped file needs a list entry", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "no-skips-junit-"));
  try {
    const xf = path.join(dir, "r.xml"); writeFileSync(xf, "<testsuites>\n\t<!-- tests 2 -->\n\t<!-- skipped 1 -->\n\t<!-- todo 0 -->\n</testsuites>");
    const lf = path.join(dir, "list.txt");
    const run = (list) => { writeFileSync(lf, list); return spawnSync("node", [script, "--junit", xf, "--file", "x.test.mjs", "--allow", lf], { encoding: "utf8" }); };
    assert.equal(run("").status, 1);
    assert.equal(run("x.test.mjs | needs /proc\n").status, 0);
    writeFileSync(xf, "<!-- skipped 0 -->\n<!-- todo 0 -->");
    assert.equal(run("").status, 0, "no skip, no entry needed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
