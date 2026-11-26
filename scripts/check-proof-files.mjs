#!/usr/bin/env node
// Proof files (BOS-2732, the BOS-2668 rules audit row 10): fails when a branch ADDS a core dump, a log file, a folder under
// .scratch/ or scratch/, or a screenshot or recording outside docs/ and the image folders the web app and website ship.
// "Never commit proofs, logs or screenshots to the repo" had no check; the secret scan catches a dump that holds a key, not
// the other proof files. Files that already exist on main are never flagged (only added paths against the base are read).
//
//   node scripts/check-proof-files.mjs                 base defaults to origin/main; reads base...HEAD
//   node scripts/check-proof-files.mjs <base>          another branch to compare with (check-quick passes BASE)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Folders a screenshot or recording may live in: docs/ and the image folders the web app and the website already ship.
const MEDIA_OK = [
  /^docs\//,
  /^apps\/web\/public\//,
  /^apps\/site\/public\//,
];

/** Why an added path is a proof file, or null when it is fine. */
export function proofProblem(file) {
  const base = path.posix.basename(file);
  const dirs = file.split("/").slice(0, -1);
  if (/^core(\.[0-9]+)?$/.test(base)) return "a core dump";
  if (/\.log$/i.test(base)) return "a log file";
  if (dirs.some((d) => d === ".scratch" || d === "scratch")) return "inside a scratch folder";
  if (/\.(png|jpe?g|webm|mp4)$/i.test(base) && !MEDIA_OK.some((re) => re.test(file))) return "a screenshot or recording outside docs/ and the shipped image folders";
  return null;
}

/** {problems: [{file, why}]} for a list of added paths. */
export function findProofFiles(files) {
  const problems = [];
  for (const f of files) {
    const why = proofProblem(f);
    if (why) problems.push({ file: f, why });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A base that is not a merged commit (the queue rebuilds the check on a merge preview) is refused rather than guessed at:
  // reading "added, so a problem" against it could flag files main already has.
  const base = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "origin/main";
  const cwd = process.env.CHECK_PROOF_FILES_ROOT ?? process.cwd();
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  let mergeBase;
  try {
    mergeBase = git("merge-base", "HEAD", base).trim();
  } catch {
    console.error(`check-proof-files: cannot find the merge base of HEAD and ${base}: is that branch a merged commit?`);
    process.exit(1);
  }
  const added = git("diff", "--name-only", "--diff-filter=A", mergeBase, "HEAD").split("\n").filter(Boolean);
  const problems = findProofFiles(added);
  if (!problems.length) {
    console.log(`check-proof-files: no core dumps, logs, scratch files or stray screenshots among the ${added.length} file(s) this branch adds`);
    process.exit(0);
  }
  console.error("check-proof-files: this branch adds proof files, which must not be committed (keep them in the ticket's scratch folder):");
  for (const { file, why } of problems) console.error(`  ${file}: ${why}`);
  process.exit(1);
}
