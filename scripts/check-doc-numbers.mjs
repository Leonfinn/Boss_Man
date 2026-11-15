#!/usr/bin/env node
// Fails when two guides in docs/ share a number prefix (BOS-1549: 26-check-workers.md landed beside 26-skill-proposals.md).
//
//   node scripts/check-doc-numbers.mjs            the docs/ folder of this checkout
//   node scripts/check-doc-numbers.mjs <base>     also the docs main added since this branch left <base> (check-quick)
//
// With a base, a page main added after the branch point counts too: a branch adding 35-foo.md passes on its own tree, yet
// clashes with a 35-bar.md that merged while it was in review. Pages main had at the branch point are not added back, so a
// branch that renames 26-x.md to 34-x.md is not told it clashes with its own old name.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The clashes in a list of file names: one "<number>: a, b" line per number used by more than one file. */
export function findClashes(names) {
  const byNumber = new Map();
  for (const name of new Set(names)) {
    const m = /^(\d+)-/.exec(name);
    if (!m) continue;
    const n = String(Number(m[1]));
    byNumber.set(n, [...(byNumber.get(n) ?? []), name]);
  }
  return [...byNumber]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([n, files]) => `${n}: ${files.sort().join(", ")}`);
}

/** Pages under docs/ that <base> added since its merge-base with HEAD; empty when git can't tell. */
function addedOnBase(repo, base) {
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const mb = git("merge-base", "HEAD", base);
    return git("diff", "--name-only", "--diff-filter=A", mb, base, "--", "docs/")
      .split("\n")
      .filter((f) => f && path.dirname(f) === "docs")
      .map((f) => path.basename(f));
  } catch (e) {
    console.error(`check-doc-numbers: could not read the pages ${base} added (${e.message.split("\n")[0]}); checking this tree only`);
    return [];
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.env.CHECK_DOC_NUMBERS_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const base = process.argv[2];
  const names = readdirSync(path.join(repo, "docs")).filter((f) => f.endsWith(".md"));
  if (base) names.push(...addedOnBase(repo, base));
  const clashes = findClashes(names);
  if (clashes.length) {
    console.error("check-doc-numbers: two or more guides in docs/ share a number. Give the newer one the next free number and fix its links:");
    for (const c of clashes) console.error(`  ${c}`);
    process.exit(1);
  }
}
