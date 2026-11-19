/**
 * Carry a passed merge across a main move (BOS-1762). The merge gate checked (and GitHub CI ran on) the merge of the ticket's
 * branch with main at `testedBase`. Main has since moved to a new tip. Instead of building and testing the merge again, the
 * runner may push the merge on the new tip when nothing the ticket changed was touched by main meanwhile, main touched nothing
 * that changes how this merge builds or is checked, and the new merged tree differs from the tested one only in main's files.
 * Main's own CI after the push is the backstop for a clash between different files. Pure: callers pass git's file lists.
 *
 * BOS-1925 narrowed "how this merge builds or is checked" from one always-re-test list to a table with three scopes (DR on
 * the ticket). The test for every row: could main's change alone make this merge's own check fail, where an ordinary code
 * change on main (already carried, backstopped by main's CI) could not?
 */

type Scope =
  /** Main changing it re-tests every waiting merge: it changes how the whole repo installs, builds or is checked. */
  | "global"
  /**
   * Re-tests only a merge that changes the same folder too. A migration on main acts on a merge's tests exactly as the
   * schema change it ships with (an ordinary, carried file); the gate's check picks its steps from the merge's own files,
   * so the migration lint and its renumbering only matter when both sides add one. Same for CI workflows: the gate's own
   * check never reads them (actionlint runs only on the merge's own workflow changes), and a new rule on code ships as a
   * check script, which stays global.
   */
  | "same-folder"
  /**
   * One package's own build or test config (two folders deep or more): re-tests only a merge that touches that package, or
   * anything outside its sibling packages (shared code, root files), since only those can build or test differently.
   * A config one folder deep or at the root stays global: its siblings are the whole repo.
   */
  | "package";

const RULES: { scope: Scope; what: string; match: RegExp }[] = [
  // Manifests and lockfiles, at any depth: a dependency change can break anything (hoisting, a shared lockfile).
  { scope: "global", what: "dependencies", match: /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|Gemfile(\.lock)?|composer\.(json|lock))$/ },
  // Workspace and toolchain config.
  { scope: "global", what: "workspace or toolchain config", match: /(^|\/)(pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|\.tool-versions)$/ },
  // Container builds.
  { scope: "global", what: "container builds", match: /(^|\/)Dockerfile[^/]*$/ },
  { scope: "global", what: "container builds", match: /(^|\/)docker-compose[^/]*\.ya?ml$/ },
  // The check scripts themselves: the gate's own check and its rules.
  { scope: "global", what: "check scripts", match: /^scripts\/check-[^/]*$/ },
  // Build and test config: global at the root or one folder deep, else scoped to its package.
  { scope: "package", what: "build or test config", match: /(^|\/)tsconfig[^/]*\.json$/ },
  { scope: "package", what: "build or test config", match: /(^|\/)(vitest|vite|jest|playwright|webpack|rollup|babel|eslint)\.config\.[^/]+$/ },
  { scope: "package", what: "build or test config", match: /(^|\/)(vitest\.workspace|turbo|nx)\.[^/]+$/ },
  // Migrations (drizzle and the common folder name) and CI.
  { scope: "same-folder", what: "migrations", match: /(^|\/)(migrations|drizzle)\// },
  { scope: "same-folder", what: "CI workflows", match: /^\.github\// },
];

function ruleOf(path: string) {
  return RULES.find((r) => r.match.test(path));
}

/** Whether main changing `path` re-tests every waiting merge, whatever the merge changes. */
export function alwaysRetest(path: string): boolean {
  const scope = ruleOf(path)?.scope;
  return scope === "global" || (scope === "package" && path.split("/").length < 3);
}

/** The folder a same-folder rule compares: everything up to the end of the matched folder name (`apps/server/drizzle/`). */
function folderOf(path: string, match: RegExp): string {
  const m = match.exec(path);
  return m ? path.slice(0, m.index + m[0].length) : path;
}

/**
 * Whether a package config at `path` can change how `mine` builds or tests. Its package is the config's folder D; a merge
 * file is clear of it only when it lies in a sibling folder of D (same parent, other name, and a folder, not a file).
 */
function packageReaches(path: string, mine: string[]): boolean {
  const dir = path.split("/").slice(0, -1);
  if (dir.length < 2) return true;
  const parent = dir.slice(0, -1).join("/") + "/";
  const name = dir[dir.length - 1];
  return mine.some((f) => {
    if (!f.startsWith(parent)) return true;
    const rest = f.slice(parent.length);
    const slash = rest.indexOf("/");
    return slash < 0 || rest.slice(0, slash) === name;
  });
}

/** Main's files (`theirs`) that re-test a merge changing `mine`, with the rule's name, in path order. */
export function retestFiles(mine: string[], theirs: string[]): { files: string[]; what: string[] } {
  const files: string[] = [];
  const what = new Set<string>();
  for (const f of [...theirs].sort()) {
    const r = ruleOf(f);
    if (!r) continue;
    const hit = r.scope === "global" || (r.scope === "same-folder" ? mine.some((m) => m.startsWith(folderOf(f, r.match))) : packageReaches(f, mine));
    if (!hit) continue;
    files.push(f);
    what.add(r.scope === "same-folder" ? `${r.what} (this ticket changes them too)` : r.what);
  }
  return { files, what: [...what] };
}

export type CarryVerdict = { ok: true } | { ok: false; why: string; files?: string[] };

/**
 * mine: files the ticket changes on top of the tested base (tested base → tested merge commit).
 * theirs: files main changed since the tested base (tested base → main's new tip).
 * drift: files where the new merged tree differs from the tested tree.
 */
export function carryVerdict(p: { mine: string[]; theirs: string[]; drift: string[] }): CarryVerdict {
  const theirs = new Set(p.theirs);
  const shared = p.mine.filter((f) => theirs.has(f)).sort();
  if (shared.length) return { ok: false, why: "main changed files this ticket changes", files: shared };
  const retest = retestFiles(p.mine, p.theirs);
  if (retest.files.length) return { ok: false, why: `main changed ${retest.what.join(", ")}`, files: retest.files };
  // Belt and braces: the landed tree may differ from the tested one only where main changed and the ticket didn't.
  const odd = p.drift.filter((f) => !theirs.has(f)).sort();
  if (odd.length) return { ok: false, why: "the new merge differs from the tested one outside main's changes", files: odd };
  return { ok: true };
}

/** git diff --name-only -z output to a list of paths. */
export function nameList(z: string): string[] {
  return z.split("\0").filter(Boolean);
}
