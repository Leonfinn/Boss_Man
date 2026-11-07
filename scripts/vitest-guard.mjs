// Keeps whole-suite vitest runs at the merge gate. Every package's vitest config calls guardVitest(), so it covers
// `pnpm test`, `pnpm --filter X test`, `vitest run` and `vitest related`, however they are started.
// Inside an agent session (CLAUDECODE, or BOSSMAN_AGENT_SESSION from the runner; the same test check-all.sh uses):
//  - a run with no test file named, or `vitest related` over app.ts / main.ts / mcp.ts, is refused (exit 2);
//  - a run that names test files is re-run inside the merge gate's one-slot check lock (check-all.sh waits for the slot),
//    so it queues behind gate runs. BOSSMAN_VITEST_NO_SLOT=1 skips the queueing.
// The merge gate (BOSSMAN_MERGE_CHECK), check-all.sh / check-quick.sh's own runs (BOSSMAN_CHECK_CHILD), CHECK_ALL_FORCE=1 and humans are unaffected.
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  if (!isAgentSession(env)) return "allow";
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
    const checkAll = join(dirname(fileURLToPath(import.meta.url)), "check-all.sh");
    const r = spawnSync("bash", [checkAll], {
      stdio: "inherit",
      env: { ...env, BOSSMAN_CHECK_CHILD: "1", CHECK_ALL_SLOT_COMMAND: slotCommand(process.cwd(), process.execPath, argv[1], args) },
    });
    process.exit(r.status ?? 1);
  }
}
