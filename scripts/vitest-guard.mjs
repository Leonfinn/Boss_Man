// Keeps whole-suite vitest runs at the merge gate. Every package's vitest config calls guardVitest(), so it covers
// `pnpm test`, `pnpm --filter X test`, `vitest run` and `vitest related`, however they are started.
// Inside an agent session (CLAUDECODE, or BOSSMAN_AGENT_SESSION from the runner; the same test check-all.sh uses):
//  - a run with no test file named, or `vitest related` over app.ts / main.ts / mcp.ts, is refused (exit 2);
//  - a small run (`vitest run` with 1 to 3 test files named by path) goes the quick lane: it runs at once in one of
//    LIGHT_PLACES places of its own, one worker, under a 3 GB memory ceiling, when the runner has room (BOS-1608, below);
//  - any other run that names test files is re-run inside the merge gate's check line (check-all.sh waits for the slot),
//    so it queues behind gate runs; it first says why and how to run now. BOSSMAN_VITEST_NO_SLOT=1 skips every limit.
// The merge gate (BOSSMAN_MERGE_CHECK), check-all.sh / check-quick.sh's own runs (BOSSMAN_CHECK_CHILD), CHECK_ALL_FORCE=1 and humans are unaffected.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { freemem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cgroupFreeMemory } from "./check-threads.mjs";

// The quick lane (BOS-1608). Before it, a reviewer's one-file run waited behind every merge check (30 to 50 min each) and
// agents gave up, so reviews were approved without the tests running. What the check line protects is the runner's memory:
// a full check peaks at about 4.5 GB; one server test file at one worker peaks at about 1.6 GB (measured 15 Nov,
// hot-path-budget.test.ts). So a small run may skip the line when the runner has room for it AND for a full check still
// growing to its peak (LIGHT_NEED_BYTES), and at most LIGHT_PLACES such runs go at once (flock places beside the check
// lock, so a crashed run frees its place). One worker (BOSSMAN_TEST_WORKERS / BOSSMAN_CHECK_THREADS) and the same memory
// guard check-all uses, at LIGHT_CEILING_MB, keep one run inside what was measured. Names must be existing test files: a
// bare word is a filter that can match hundreds of files.
export const LIGHT_MAX_FILES = 3;
export const LIGHT_PLACES = 2;
export const LIGHT_CEILING_MB = 3072;
export const LIGHT_NEED_BYTES = 6.5 * 1024 ** 3; // 2 GB for this run + 4.5 GB, one full check's peak
const LIGHT_WAIT_SECONDS = 300; // both places busy: wait this long (quick runs take a minute or two), then join the line
const LIGHT_BUSY = 211; // the place script's "taken" exit; 212 = no flock here
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export const REFUSAL =
  "Run the test files your change touches, or scripts/check-quick.sh; the merge gate runs the full suite. (CHECK_ALL_FORCE=1 overrides if the CEO asked for a full run.)";

const COMMANDS = new Set(["run", "watch", "dev", "related", "list", "bench", "init", "typecheck"]);
// Options that take a separate value, so the value is not mistaken for a test file.
const VALUE_FLAGS = new Set([
  "-c", "--config", "-r", "--root", "--dir", "--project", "--reporter", "--outputFile", "--pool", "--maxWorkers",
  "--minWorkers", "--testTimeout", "--hookTimeout", "-t", "--testNamePattern", "--environment", "--shard", "--mode",
  "--browser", "--exclude", "--retry", "--sequence", "--logHeapUsage",
]);

export function isAgentSession(env = process.env) {
  return !env.BOSSMAN_CHECK_CHILD && !env.BOSSMAN_MERGE_CHECK && !env.CHECK_ALL_FORCE && !!(env.CLAUDECODE || env.BOSSMAN_AGENT_SESSION);
}

// args: what follows `vitest` on the command line. Returns { command, files, changed, info }.
export function parseArgs(args) {
  const positionals = [];
  let changed = false;
  let info = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h" || a === "--version" || a === "-v") info = true;
    if (a.startsWith("-")) {
      if (a === "--changed" || a.startsWith("--changed=")) changed = true;
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    positionals.push(a);
  }
  let command;
  if (positionals.length && COMMANDS.has(positionals[0])) command = positionals.shift();
  return { command, files: positionals, changed, info };
}

// "allow" | "refuse" | "slot"
export function decide(args, env = process.env) {
  if (!isAgentSession(env) || env.BOSSMAN_VITEST_LIGHT) return "allow";
  const { command, files, changed, info } = parseArgs(args);
  if (info) return "allow";
  if (command && !["run", "watch", "dev", "related"].includes(command)) return "allow";
  if (command === "related") {
    if (files.some((f) => /(^|\/)(app|main|mcp)\.ts$/.test(f))) return "refuse";
    return files.length ? (env.BOSSMAN_VITEST_NO_SLOT ? "allow" : "slot") : "refuse";
  }
  if (!files.length && !changed) return "refuse";
  return env.BOSSMAN_VITEST_NO_SLOT ? "allow" : "slot";
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function slotCommand(cwd, nodePath, script, args) {
  return `cd ${q(cwd)} && ${q(nodePath)} ${q(script)} ${args.map(q).join(" ")}`;
}

// Why a "slot" run can't take the quick lane, or "" when it can. isFile is injectable for the tests.
export function lightBlocker(args, cwd = process.cwd(), isFile = (p) => existsSync(p) && statSync(p).isFile()) {
  const { command, files, changed } = parseArgs(args);
  if (command && command !== "run") return `\`vitest ${command}\` is not a one-off run of named files`;
  if (changed) return "--changed can pick up any number of files";
  if (args.some((a) => /^--(maxWorkers|minWorkers|fileParallelism)\b/.test(a))) return "it sets its own worker count (the quick lane runs one worker)";
  if (files.length > LIGHT_MAX_FILES) return `it names ${files.length} files (the quick lane takes ${LIGHT_MAX_FILES} at most)`;
  const bad = files.find((f) => !TEST_FILE.test(f) || !isFile(resolve(cwd, f)));
  if (bad !== undefined) return `"${bad}" is not a test file path from this folder (a bare word is a filter that can match many files)`;
  return "";
}

// Free memory for the quick lane: the cgroup's (what the runner's limit still allows), else the machine's.
// BOSSMAN_CHECK_FREE_MEMORY (bytes) pins it, as for check-threads.mjs.
export function freeBytes(env = process.env) {
  if (/^\s*\d{1,15}\s*$/.test(env.BOSSMAN_CHECK_FREE_MEMORY ?? "")) return Number(env.BOSSMAN_CHECK_FREE_MEMORY);
  return cgroupFreeMemory() ?? freemem();
}

const gb = (b) => (b / 1024 ** 3).toFixed(1);

// Runs "$@" holding place $1 (flock -n on fd 9, inherited by vitest's workers so the place is held until they all end), under
// the memory guard $2. Exits LIGHT_BUSY when the place is taken, 212 when there is no flock, else the command's status.
const PLACE_SCRIPT = `command -v flock >/dev/null || exit 212
exec 9>"$1" || exit 212
flock -n 9 || exit ${LIGHT_BUSY}
guard=$2; shift 2
node "$guard" "$$" ${LIGHT_CEILING_MB} 9>&- &
exec "$@"`;

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The quick lane: returns the run's exit status, or a reason it could not run there.
function runLight(argv, args, env, say) {
  const free = freeBytes(env);
  if (free < LIGHT_NEED_BYTES) return { why: `the runner has ${gb(free)} GB free and a quick run needs ${gb(LIGHT_NEED_BYTES)} GB (its own 2 GB plus room for a merge check's peak)` };
  const lock = env.CHECK_ALL_LOCK || "/tmp/bossman-check-all";
  const guard = join(dirname(fileURLToPath(import.meta.url)), "check-mem-guard.mjs");
  const childEnv = { ...env, BOSSMAN_VITEST_LIGHT: "1", BOSSMAN_TEST_WORKERS: "1", BOSSMAN_CHECK_THREADS: "1" };
  const began = Date.now();
  let lastSaid = 0;
  for (;;) {
    for (let k = 1; k <= LIGHT_PLACES; k++) {
      const r = spawnSync("bash", ["-c", PLACE_SCRIPT, "vitest-light", `${lock}.light.${k}`, guard, process.execPath, argv[1], ...args], {
        stdio: "inherit",
        env: childEnv,
      });
      if (r.status === 212) return { why: "this machine has no flock" };
      if (r.status === LIGHT_BUSY) continue;
      return { status: r.status ?? 1 };
    }
    const waited = (Date.now() - began) / 1000;
    // BOSSMAN_VITEST_LIGHT_WAIT (seconds) shortens the wait for the tests.
    const limit = /^\d{1,5}$/.test(env.BOSSMAN_VITEST_LIGHT_WAIT ?? "") ? Number(env.BOSSMAN_VITEST_LIGHT_WAIT) : LIGHT_WAIT_SECONDS;
    if (waited >= limit) return { why: `both quick-run places stayed busy for ${Math.round(waited)} s` };
    if (Date.now() - lastSaid >= 15_000) {
      say(`vitest-guard: both quick-run places are busy (other agents' one-file runs, a minute or two each); waiting for one, up to ${LIGHT_WAIT_SECONDS / 60} min`);
      lastSaid = Date.now();
    }
    sleepMs(2000);
  }
}

export const lineBanner = (why) =>
  `vitest-guard: this run waits in the merge gate's check line because ${why}. ` +
  "Merge checks go first and take 30 to 50 min each; a progress line (\"check-all: waiting for a free check slot (place N of M)\") follows every 30 s. " +
  "A second waiting run from this folder replaces this one. " +
  `To run now instead: name at most ${LIGHT_MAX_FILES} test files by path, e.g. \`npx vitest run test/foo.test.ts\` from the package folder (CLAUDE.md, "Running one test file").`;

export function guardVitest(argv = process.argv, env = process.env) {
  // Only the vitest command line itself: its workers and other tools that load the config are left alone.
  if (!/^vitest(\.m?js)?$/.test(basename(argv[1] ?? ""))) return;
  const args = argv.slice(2);
  const verdict = decide(args, env);
  if (verdict === "refuse") {
    process.stderr.write(`${REFUSAL}\n`);
    process.exit(2);
  }
  if (verdict === "slot") {
    const say = (line) => process.stderr.write(`${line}\n`);
    let why = lightBlocker(args);
    if (!why) {
      const light = runLight(argv, args, env, say);
      if (light.status !== undefined) process.exit(light.status);
      why = light.why;
    }
    say(lineBanner(why));
    const checkAll = join(dirname(fileURLToPath(import.meta.url)), "check-all.sh");
    const r = spawnSync("bash", [checkAll], {
      stdio: "inherit",
      env: { ...env, BOSSMAN_CHECK_CHILD: "1", CHECK_ALL_SLOT_COMMAND: slotCommand(process.cwd(), process.execPath, argv[1], args) },
    });
    process.exit(r.status ?? 1);
  }
}
