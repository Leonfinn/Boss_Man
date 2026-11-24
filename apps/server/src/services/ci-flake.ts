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
 * and Docker actions (`/github/workspace/…`). BOS-2448: also a repo mounted at `/work` for a `docker run -w /work` step
 * (run 45323213260 named `/work/apps/launcher/test/docker.test.ts`), the usual mount in Docker's own docs; a wrong cut can
 * only name a file the merge commit lacks, which the gate re-run refuses (CANT_RERUN_EXIT). Any other absolute path stays
 * absolute, which SAFE_TEST_PATH refuses.
 */
export function repoRelative(p: string): string {
  if (p.startsWith("/github/workspace/")) return p.slice("/github/workspace/".length);
  if (p.startsWith("/work/")) return p.slice("/work/".length);
  const m = /^(?:\/home\/runner\/work|\/__w|\/.*\/_work)\/[^/]+\/[^/]+\/(.+)$/.exec(p);
  return m ? m[1]! : p;
}

/**
 * The test files the failed jobs name. A job counts as named only when every failure annotation it has points at a test file:
 * an annotation on a source file, an unhandled error, or no readable annotations at all leave the job unnamed, and then the
 * gate can't know it re-ran the right thing.
 */
export function namedTestFiles(jobs: FailedJobEvidence[]): NamedTests {
  // not state: a local of this pure function, built per call.
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

/**
 * BOS-2082: a slow GitHub machine fails many test files at once with timeouts (BOS-2066: the web-browser step took 698 s
 * against its usual 209 to 343 s, and 4 browser files timed out). A failed step that took more than SLOW_FACTOR times its
 * median over at least MIN_BASELINE_RUNS recent green runs of the same job, where every failure is a timeout, gets one
 * GitHub retry of the failed jobs (GitHub runs them on a fresh machine) without the gate re-run, whatever the file count.
 * A branch that really made the step slow fails the retry too and goes back as before.
 */
export const SLOW_FACTOR = 1.6;
export const MIN_BASELINE_RUNS = 3;
/** Green runs of the job read for its usual step time. */
export const BASELINE_RUNS = 8;
/** Slow-machine retries per job name in a company in RETRY_WINDOW_MS; past it, GitHub's machines (or the job) need looking at. */
export const SLOW_RETRIES_PER_WEEK = 5;
/** A ci_flake_retry row's detail line for a slow-machine retry: this prefix, then the job's name. */
export const SLOW_ROW_PREFIX = "slow machine: ";

/** One failed GitHub job as the slow-machine row reads it. */
export type SlowEvidence = {
  job: string;
  /** The failed step's name, null when GitHub named none. */
  step: string | null;
  /** How long that step ran, null when GitHub gave no times. */
  seconds: number | null;
  /** The same job's same step in recent green runs, in seconds. */
  baseline: number[];
  /** Every failure annotation was readable and says a timeout. */
  timeoutsOnly: boolean;
};
export type SlowJob = { job: string; step: string; seconds: number; median: number; runs: number };

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The failed jobs, when every one of them ran on a slow machine; null when any one doesn't qualify (or there are none). */
export function slowJobs(ev: SlowEvidence[]): SlowJob[] | null {
  if (!ev.length) return null;
  // not state: a local of this pure function, built per call.
  const out: SlowJob[] = [];
  for (const e of ev) {
    if (!e.timeoutsOnly || !e.step || e.seconds === null || e.baseline.length < MIN_BASELINE_RUNS) return null;
    const m = median(e.baseline);
    if (!(e.seconds > SLOW_FACTOR * m)) return null;
    out.push({ job: e.job, step: e.step, seconds: Math.round(e.seconds), median: Math.round(m), runs: e.baseline.length });
  }
  return out;
}

/** Slow-machine retries per job name from the company's recent ci_flake_retry rows. */
export function slowRetryCounts(details: Array<string | null>): Map<string, number> {
  // not state: a local of this pure function, built per call.
  const out = new Map<string, number>();
  for (const d of details) {
    const jobs = new Set((d ?? "").split("\n").filter((x) => x.startsWith(SLOW_ROW_PREFIX)).map((x) => x.slice(SLOW_ROW_PREFIX.length)));
    for (const j of jobs) out.set(j, (out.get(j) ?? 0) + 1);
  }
  return out;
}

/** One line per slow job, for the ticket's activity and the bounce text. */
export const describeSlow = (jobs: SlowJob[]): string =>
  jobs.map((j) => `${j.job}'s "${j.step}" step took ${j.seconds} s against a usual ${j.median} s (median of ${j.runs} green runs)`).join("; ");

export type FlakeFacts = {
  /** GitHub refused to start jobs (billing): never a flake. */
  billing: boolean;
  /** BOS-2082: every failed job ran on a slow machine (slowJobs), or null. */
  slow?: SlowJob[] | null;
  /** Recorded slow-machine retries per job name in this company in the last RETRY_WINDOW_MS. */
  slowRecent?: Map<string, number>;
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

export type FlakeDecision = { act: "rerun_at_gate"; files: string[] } | { act: "retry_slow"; jobs: SlowJob[] } | { act: "bounce"; why: string };

/**
 * The ordered decision table (one row per condition, the first refusal wins). "bounce" means today's send-back, with `why`
 * added so the agent and the CEO can see what was considered. "retry_slow" (BOS-2082) asks GitHub for the one retry
 * straight away: a slow machine is not a test to re-run at the gate, and it fails more than MAX_FLAKY_FILES by nature.
 */
export function flakeDecision(f: FlakeFacts): FlakeDecision {
  if (f.billing) return { act: "bounce", why: "GitHub didn't start the jobs (billing)" };
  if (f.named.unsafe.length) return { act: "bounce", why: `a failure named a path Boss Man won't run (${f.named.unsafe[0]!.slice(0, 120)})` };
  if (f.slow?.length) {
    if (f.mainRed) return { act: "bounce", why: "main is red" };
    if (f.retriedThisCommit) return { act: "bounce", why: "this merge commit already had its one GitHub retry" };
    const spent = f.slow.find((j) => (f.slowRecent?.get(j.job) ?? 0) >= SLOW_RETRIES_PER_WEEK);
    if (spent) return { act: "bounce", why: `${describeSlow([spent])}, but ${spent.job} has had ${SLOW_RETRIES_PER_WEEK} slow-machine retries in 7 days; no more until someone looks at why` };
    return { act: "retry_slow", jobs: f.slow };
  }
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
  // not state: a local of this pure function, built per call.
  const out = new Map<string, number>();
  for (const d of details) for (const f of new Set(retryRowFiles(d))) out.set(f, (out.get(f) ?? 0) + 1);
  return out;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Reads vitest's JSON report (argv[1]) and prints how many tests passed: 0 when any failed, the run wasn't a success or the
 * report is unreadable (then it exits 1). BOS-2082: the pass is read from here, never from vitest's terminal summary, which
 * is coloured on the check runner ("Tests ESC[22m ESC[1mESC[32m59 passed"), so BOS-1733's grep never matched.
 */
const READ_JSON_RESULT =
  'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const n=Number(r.numPassedTests)||0;process.stdout.write(String(r.numFailedTests===0&&r.success!==false?n:0))';

/**
 * One generic shell command that re-runs the named vitest files on a fresh checkout of the merge commit. Nothing here is
 * specific to Boss Man's repo: it installs with the repo's own lockfile, finds each file's nearest package.json and runs that
 * package's vitest on the file. Exit CANT_RERUN_EXIT means "can't re-run this here" (no lockfile, missing file, no vitest,
 * the file isn't a test vitest runs, no JSON result, or no test passed, e.g. all skipped without a browser): never read as a
 * pass. Whether tests passed comes from vitest's JSON reporter (BOS-2082); the terminal output is only shown.
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
    'json="$root/.boss-man-rerun.json"',
    "rerun() {",
    '  f=$1; [ -f "$root/$f" ] || cant "$f is not in the merge commit"',
    '  dir=$(dirname "$root/$f")',
    '  while [ "$dir" != "$root" ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done',
    '  [ -f "$dir/package.json" ] || cant "no package.json above $f"',
    '  bin="$dir/node_modules/.bin/vitest"; [ -x "$bin" ] || bin="$root/node_modules/.bin/vitest"',
    '  [ -x "$bin" ] || cant "no vitest for $f"',
    '  rel=${f#"${dir#"$root"/}"/}; [ "$dir" = "$root" ] && rel=$f',
    '  echo "boss-man re-run: $f (in ${dir#"$root"}/)"',
    '  rm -f "$json"',
    '  (cd "$dir" && NO_COLOR=1 FORCE_COLOR=0 "$bin" run "$rel" --reporter=default --reporter=json --outputFile.json="$json") > "$out" 2>&1; rc=$?; cat "$out"',
    // tr drops any ESC left (a config that forces colour), so the phrase reads whole.
    `  if tr -d '\\033' < "$out" | grep -q "No test files found"; then cant "vitest found no test in $f"; fi`,
    '  [ "$rc" -eq 0 ] || exit 1',
    '  [ -s "$json" ] || cant "vitest wrote no JSON result for $f"',
    `  passed=$(node -e '${READ_JSON_RESULT}' "$json") || cant "vitest's JSON result for $f is unreadable"`,
    '  [ "${passed:-0}" -gt 0 ] 2>/dev/null || cant "no test in $f passed (skipped here?)"',
    '  echo "boss-man re-run: $f: $passed passed (vitest JSON result)"',
    "}",
    ...files.map((f) => `rerun ${sq(f)}`),
    'echo "boss-man re-run: passed"',
  ];
  return lines.join("\n");
}
