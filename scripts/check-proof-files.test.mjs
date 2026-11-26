// Guards BOS-2732: a branch may not add a core dump, a log file, a scratch-folder file or a screenshot/recording outside
// docs/ and the shipped image folders. check-quick runs scripts/check-proof-files.mjs on every branch; these tests keep it
// catching each shape, leaving the allowed ones alone, and never flagging a file main already has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProofFiles, proofProblem } from "./check-proof-files.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-proof-files.mjs");

test("a core dump, a log, a scratch folder and a stray screenshot are each named", () => {
  const files = ["core", "core.1234", "apps/x/core.42", "build.log", "apps/web/test/output.log", ".scratch/shots/1.txt", "apps/site/scratch/run.json", "shot.png", "apps/web/test/run.mp4"];
  assert.deepEqual(findProofFiles(files), [
    { file: "core", why: "a core dump" },
    { file: "core.1234", why: "a core dump" },
    { file: "apps/x/core.42", why: "a core dump" },
    { file: "build.log", why: "a log file" },
    { file: "apps/web/test/output.log", why: "a log file" },
    { file: ".scratch/shots/1.txt", why: "inside a scratch folder" },
    { file: "apps/site/scratch/run.json", why: "inside a scratch folder" },
    { file: "shot.png", why: "a screenshot or recording outside docs/ and the shipped image folders" },
    { file: "apps/web/test/run.mp4", why: "a screenshot or recording outside docs/ and the shipped image folders" },
  ]);
});

test("screenshots in docs/ or the shipped image folders, and ordinary code files, are fine", () => {
  for (const f of [
    "docs/img/shot.png",
    "docs/design/bos-779-website-v2/img/a.jpg",
    "docs/promo/boss-man-promo.mp4",
    "apps/web/public/app-icons/192.png",
    "apps/site/public/img/shot.webm",
    "apps/web/src/app.tsx",
    "scripts/core-utils.mjs",
    "README.core",
    "notes.log.md",
    "packages/shared/src/log.ts",
  ]) {
    assert.equal(proofProblem(f), null, f);
  }
});

test("only files the branch adds are flagged: a file main already has is left alone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "proof-files-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "old.png"), "x\n");
    writeFileSync(path.join(dir, "core"), "x\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-qb", "branch");
    writeFileSync(path.join(dir, "docs", "new.png"), "x\n");
    writeFileSync(path.join(dir, "trace.log"), "x\n");
    git("add", ".");
    git("commit", "-qm", "branch adds a good and a bad file");
    const run = () => spawnSync("node", [script, "origin/main"], { encoding: "utf8", cwd: dir });
    let r = run();
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /trace\.log: a log file/);
    assert.doesNotMatch(r.stderr, /core/, "a core dump main already has is not the branch's");
    assert.doesNotMatch(r.stderr, /docs\/new\.png/, "a screenshot under docs/ is allowed");
    git("rm", "-q", "trace.log");
    git("commit", "-qm", "remove the log");
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no core dumps, logs, scratch files or stray screenshots/);
    r = spawnSync("node", [script, "origin/does-not-exist"], { encoding: "utf8", cwd: dir });
    assert.equal(r.status, 1, "an unknown base is refused, not guessed at");
    assert.match(r.stderr, /cannot find the merge base/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
