/**
 * Carry a passed merge across a main move (BOS-1762). The merge gate checked (and GitHub CI ran on) the merge of the ticket's
 * branch with main at `testedBase`. Main has since moved to a new tip. Instead of building and testing the merge again, the
 * runner may push the merge on the new tip when nothing the ticket changed was touched by main meanwhile, main touched nothing
 * that changes how the whole repo builds or tests, and the new merged tree differs from the tested one only in main's files.
 * Main's own CI after the push is the backstop for a clash between different files. Pure: callers pass git's file lists.
 */

/**
 * Paths whose change on main re-tests every waiting merge: dependencies, workspace and build config, CI, container builds,
 * the check scripts and database migrations. Generic for any repo, not tied to this one. Matched against the whole path.
 */
const ALWAYS_RETEST: RegExp[] = [
  // Manifests and lockfiles, at any depth.
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|Gemfile(\.lock)?|composer\.(json|lock))$/,
  // Workspace and build config.
  /(^|\/)(pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|\.tool-versions)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(vitest|vite|jest|playwright|webpack|rollup|babel|eslint)\.config\.[^/]+$/,
  /(^|\/)(vitest\.workspace|turbo|nx)\.[^/]+$/,
  // CI and container builds.
  /^\.github\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  // The check scripts themselves.
  /^scripts\/check-[^/]*$/,
  // Migrations (drizzle and the common folder name).
  /(^|\/)(migrations|drizzle)\//,
];

export function alwaysRetest(path: string): boolean {
  return ALWAYS_RETEST.some((r) => r.test(path));
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
  const global = p.theirs.filter(alwaysRetest).sort();
  if (global.length) return { ok: false, why: "main changed dependencies, build, CI or migration files", files: global };
  // Belt and braces: the landed tree may differ from the tested one only where main changed and the ticket didn't.
  const odd = p.drift.filter((f) => !theirs.has(f)).sort();
  if (odd.length) return { ok: false, why: "the new merge differs from the tested one outside main's changes", files: odd };
  return { ok: true };
}

/** git diff --name-only -z output to a list of paths. */
export function nameList(z: string): string[] {
  return z.split("\0").filter(Boolean);
}
