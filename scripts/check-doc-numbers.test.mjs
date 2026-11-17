// Guards BOS-1549: two guides in docs/ must never share a number (26-check-workers.md merged beside 26-skill-proposals.md).
// check-quick and check-all run scripts/check-doc-numbers.mjs; these tests keep it catching a clash in the tree, a clash
// with a page main added while the branch was open, and not flagging a branch's own rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findClashes } from "./check-doc-numbers.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-doc-numbers.mjs");
const run = (root, ...args) => spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, CHECK_DOC_NUMBERS_ROOT: root } });

test("findClashes names each number used twice, and ignores unnumbered files", () => {
  assert.deepEqual(findClashes(["26-skill-proposals.md", "26-check-workers.md", "27-netguard.md", "README.md"]), [
    "26: 26-check-workers.md, 26-skill-proposals.md",
  ]);
  assert.deepEqual(findClashes(["01-scope.md", "1-other.md"]), ["1: 01-scope.md, 1-other.md"]);
  assert.deepEqual(findClashes(["00-a.md", "01-b.md", "01-b.md"]), []);
});

test("this repo's docs/ has no two guides with the same number", () => {
  const r = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("with a base: fails on a page main added since the branch point, not on the branch's own rename", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "doc-numbers-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "26-old.md"), "x\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "branch");
    renameSync(path.join(dir, "docs", "26-old.md"), path.join(dir, "docs", "34-old.md"));
    writeFileSync(path.join(dir, "docs", "35-new.md"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "branch");

    // main still has 26-old.md, which the branch renamed: no clash.
    assert.equal(run(dir, "main").status, 0);

    git("checkout", "-q", "main");
    writeFileSync(path.join(dir, "docs", "35-other.md"), "x\n");
    git("add", ".");
    git("commit", "-qm", "main adds 35");
    git("checkout", "-q", "branch");

    assert.equal(run(dir).status, 0, "the branch's own tree has no clash");
    const r = run(dir, "main");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /35: 35-new\.md, 35-other\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
