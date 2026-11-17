// BOS-1733 (CI fix 2, design: engineering/architecture/bos-1721-fix-2-design-one-recorded-retry-for-a-flaky-github-failure).
// When GitHub CI fails a merge in a named test the branch didn't touch, the gate first runs that test again on the exact
// merge commit. Failing there too means the failure is real: the ticket goes back as before. Passing there buys one recorded
// GitHub retry of the failed jobs, at most RETRIES_PER_WEEK per test file in a company.
// Pure: no database, no network. review.ts gathers the facts and acts on the answer.

/** At most this many recorded retries per test file in a company in RETRY_WINDOW_MS; after that the file needs fixing. */
export const RETRIES_PER_WEEK = 3;
export const RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** More named files than this in one failure is not a one-off flake: no retry. */
export const MAX_FLAKY_FILES = 3;
/** check_results.kind of the row that records a gate re-run that passed and the GitHub retry it bought. */
export const FLAKE_RETRY_KIND = "ci_flake_retry";
/** First line of the gate re-run command, so the job is recognisable in the queue and its logs. */
export const GATE_RERUN_MARK = "# boss-man: re-run of tests GitHub CI failed (BOS-1733)";
/** The re-run command's exit code for "can't re-run this here" (not a vitest repo, file missing, nothing ran): no retry. */
export const CANT_RERUN_EXIT = 78;

/**
 * A repo-relative test file path that is safe to put in a shell command. The names come from annotations that the branch's
 * own tests write, so they are attacker-shaped: no quotes, spaces, `$`, backslashes, `..` or leading `/` are allowed, and
 * the path must end in a test file name. Anything else means no retry.
 */
export const SAFE_TEST_PATH = /^(?!.*\.\.)(?!\/)(?!-)[A-Za-z0-9_@.\/-]+\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** One failed GitHub job, as the gate read it: its name and the paths of its failure annotations (null: unreadable). */
export type FailedJobEvidence = { job: string; paths: string[] | null };

export type NamedTests = {
  /** Test files named by the failures, repo-relative, sorted, unique. */
  files: string[];
  /** Jobs whose failure named no test file (or named something else too): these make the whole failure unnamed. */
  unnamed: string[];
  /** Named paths refused by SAFE_TEST_PATH. */
  unsafe: string[];
};

/**
 * GitHub makes annotation paths repo-relative; a workspace-absolute one is cut back to that: hosted runners
 * (`/home/runner/work/<repo>/<repo>/…`), container jobs (`/__w/<repo>/<repo>/…`), self-hosted (`…/_work/<repo>/<repo>/…`)
 * and Docker actions (`/github/workspace/…`). Any other absolute path stays absolute, which SAFE_TEST_PATH refuses.
 */
export function repoRelative(p: string): string {
  if (p.startsWith("/github/workspace/")) return p.slice("/github/workspace/".length);
  const m = /^(?:\/home\/runner\/work|\/__w|\/.*\/_work)\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return m ? m[1]! : p;
}

/**
 * The test files the failed jobs name. A job counts as named only when every failure annotation it has points at a test file:
 * an annotation on a source file, an unhandled error, or no readable annotations at all leave the job unnamed, and then the
 * gate can't know it re-ran the right thing.
 */
export function namedTestFiles(jobs: FailedJobEvidence[]): NamedTests {
  const files = new Set<string>();
  const unnamed: string[] = [];
  const unsafe: string[] = [];
  for (const j of jobs) {
    const paths = (j.paths ?? []).map(repoRelative);
    if (!paths.length) {
      unnamed.push(j.job);
      continue;
    }
    let ok = true;
    for (const p of paths) {
      if (!/\.(test|spec)\.[a-z]+$/.test(p)) ok = false;
      else if (!SAFE_TEST_PATH.test(p)) {
        unsafe.push(p);
        ok = false;
      } else files.add(p);
    }
    if (!ok) unnamed.push(j.job);
  }
  return { files: [...files].sort(), unnamed, unsafe };
}

export type FlakeFacts = {
  /** GitHub refused to start jobs (billing): never a flake. */
  billing: boolean;
  named: NamedTests;
  /** Files the branch changes against the default branch; null when the diff couldn't be read. */
  changed: string[] | null;
  /** The project's main is red (projects.mainState, R28): the existing hold handles it. */
  mainRed: boolean;
  /** This merge commit already had its one retry. */
  retriedThisCommit: boolean;
  /** Recorded retries per test file in this company in the last RETRY_WINDOW_MS. */
  recent: Map<string, number>;
};

export type FlakeDecision = { act: "rerun_at_gate"; files: string[] } | { act: "bounce"; why: string };

/**
 * The ordered decision table (one row per condition, the first refusal wins). "bounce" means today's send-back, with `why`
 * added so the agent and the CEO can see what was considered.
 */
export function flakeDecision(f: FlakeFacts): FlakeDecision {
  if (f.billing) return { act: "bounce", why: "GitHub didn't start the jobs (billing)" };
  if (f.named.unsafe.length) return { act: "bounce", why: `a failure named a path Boss Man won't run (${f.named.unsafe[0]!.slice(0, 120)})` };
  if (f.named.unnamed.length || !f.named.files.length) return { act: "bounce", why: `the failure in ${f.named.unnamed.join(", ") || "the run"} doesn't name a test file, so Boss Man can't tell whether it was a one-off` };
  if (f.named.files.length > MAX_FLAKY_FILES) return { act: "bounce", why: `${f.named.files.length} test files failed, more than a one-off` };
  if (f.changed === null) return { act: "bounce", why: "Boss Man couldn't read which files the branch changes" };
  const changed = new Set(f.changed);
  const touched = f.named.files.filter((x) => changed.has(x));
  if (touched.length) return { act: "bounce", why: `the branch changes ${touched.join(", ")}` };
  if (f.mainRed) return { act: "bounce", why: "main is red" };
  if (f.retriedThisCommit) return { act: "bounce", why: "this merge commit already had its one GitHub retry" };
  const spent = f.named.files.find((x) => (f.recent.get(x) ?? 0) >= RETRIES_PER_WEEK);
  if (spent) return { act: "bounce", why: `${spent} has had ${RETRIES_PER_WEEK} retries in 7 days; no more retries for it until it is fixed` };
  return { act: "rerun_at_gate", files: f.named.files };
}

/** The files a ci_flake_retry row records (its detail: one path per line). */
export const retryRowFiles = (detail: string | null): string[] => (detail ?? "").split("\n").filter((x) => SAFE_TEST_PATH.test(x));

/** Retries per file from the company's recent ci_flake_retry rows. */
export function retryCounts(details: Array<string | null>): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of details) for (const f of new Set(retryRowFiles(d))) out.set(f, (out.get(f) ?? 0) + 1);
  return out;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One generic shell command that re-runs the named vitest files on a fresh checkout of the merge commit. Nothing here is
 * specific to Boss Man's repo: it installs with the repo's own lockfile, finds each file's nearest package.json and runs that
 * package's vitest on the file. Exit CANT_RERUN_EXIT means "can't re-run this here" (no lockfile, missing file, no vitest,
 * the file isn't a test vitest runs, or no test passed, e.g. all skipped without a browser): never read as a pass.
 */
export function gateRerunCommand(files: string[]): string {
  for (const f of files) if (!SAFE_TEST_PATH.test(f)) throw new Error(`unsafe test path: ${f}`);
  const cant = CANT_RERUN_EXIT;
  const lines = [
    GATE_RERUN_MARK,
    "set -u",
    `cant() { echo "boss-man re-run: $1"; exit ${cant}; }`,
    'root=$(pwd)',
    'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prefer-offline || cant "pnpm install failed";',
    'elif [ -f package-lock.json ]; then npm ci || cant "npm ci failed";',
    'else cant "no pnpm-lock.yaml or package-lock.json"; fi',
    // In the throwaway checkout, not $TMPDIR: a fenced job may not be allowed to write /tmp.
    'out="$root/.boss-man-rerun.out"',
    "rerun() {",
    '  f=$1; [ -f "$root/$f" ] || cant "$f is not in the merge commit"',
    '  dir=$(dirname "$root/$f")',
    '  while [ "$dir" != "$root" ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done',
    '  [ -f "$dir/package.json" ] || cant "no package.json above $f"',
    '  bin="$dir/node_modules/.bin/vitest"; [ -x "$bin" ] || bin="$root/node_modules/.bin/vitest"',
    '  [ -x "$bin" ] || cant "no vitest for $f"',
    '  rel=${f#"${dir#"$root"/}"/}; [ "$dir" = "$root" ] && rel=$f',
    '  echo "boss-man re-run: $f (in ${dir#"$root"}/)"',
    '  (cd "$dir" && "$bin" run "$rel") > "$out" 2>&1; rc=$?; cat "$out"',
    '  if grep -q "No test files found" "$out"; then cant "vitest found no test in $f"; fi',
    '  [ "$rc" -eq 0 ] || exit 1',
    '  grep -Eq "Tests +([0-9]+ [a-z]+ \\| )*[0-9]+ passed" "$out" || cant "no test in $f passed (skipped here?)"',
    "}",
    ...files.map((f) => `rerun ${sq(f)}`),
    'echo "boss-man re-run: passed"',
  ];
  return lines.join("\n");
}
