// Shows what the merge gate would do about a migration clash (BOS-690, DR-037): the same function
// the runner calls in tryMerge, run on a clone of the repo. Read-only: it writes git objects (the
// rebuilt tree) but no branch, no file and no commit.
//
//   node scripts/rebase-migrations.mjs [<branch>] [<main>]
//
// <branch> defaults to HEAD and <main> to origin/main. Prints "none", "refused: <why>" or the
// renames and the rebuilt tree id. Exit 0 for none/rebuilt, 1 for refused, 2 for a usage problem.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const git = (args, env) => {
  try {
    return { code: 0, stdout: execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { code: typeof err.status === "number" ? err.status : 1, stdout: String(err.stdout ?? "") };
  }
};

const [branchArg = "HEAD", mainArg = "origin/main"] = process.argv.slice(2);
const sha = (ref) => {
  const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
};
const branch = sha(branchArg);
const main = sha(mainArg);
if (!branch || !main) {
  console.error(`Couldn't find ${!branch ? branchArg : mainArg}. Usage: node scripts/rebase-migrations.mjs [<branch>] [<main>]`);
  process.exit(2);
}
const base = git(["merge-base", main, branch]).stdout.trim();
if (!base) {
  console.error("The two have no common history.");
  process.exit(2);
}

// The function is TypeScript in the runner; tsx (a runner dependency) loads it.
const { register } = await import(pathToFileURL(createRequire(new URL("../apps/runner/package.json", import.meta.url)).resolve("tsx/esm/api")).href);
register();
const { rebaseMigrations } = await import("../apps/runner/src/migrations.ts");

const result = await rebaseMigrations(async (args, env) => git(args, env), { base, branch, main });
if (result.status === "none") console.log("none: nothing to renumber.");
else if (result.status === "refused") {
  console.log(`refused: ${result.reason}`);
  process.exit(1);
} else {
  for (const r of result.renamed) console.log(`${r.from} -> ${r.to}`);
  if (!result.renamed.length) console.log("no rename; the journal `when` was lifted.");
  console.log(`rebuilt tree: ${result.tree}`);
}
