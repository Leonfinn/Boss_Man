// Runner daemon: one per company. Dials out to the Boss Man server, runs agents over ACP
// on its commands, and journals every event until the server has it (R31).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkClaude } from "./claude-check.js";
import { applyCheckSlots, pnpmStoreDir, runnerFence, sandboxSelfTest } from "./fence.js";
import { harnessVersions } from "./harness-versions.js";
import { Journal } from "./journal.js";
import { RunnerConnection } from "./connection.js";
import { SessionManager } from "./session-manager.js";
import { assertSeparateStore, gateStoreDir, storeEnv } from "./store.js";
import { safeRunnerToken } from "./token.js";
import { Workspaces } from "./workspace.js";

const env = process.env;
const wsUrl = env.BOSSMAN_URL ?? "ws://server:3100/api/runner/connect";
const httpBase = wsUrl.replace(/^ws/, "http").replace(/\/api\/runner\/connect$/, "");
// A token in the environment sits in /proc/<pid>/environ, which the kernel keeps for the life of the
// process and a session's fence can't take away without also taking /proc away from its tools
// (BOS-322). The file is the only route that stays out of a session's reach, so refuse rather than
// run with a token any session can read.
const token = safeRunnerToken(env);

const dataDir = env.BOSSMAN_RUNNER_DATA ?? "/home/node/runner-data";
mkdirSync(dataDir, { recursive: true });
const journal = new Journal(path.join(dataDir, "journal.jsonl"));
const log = (m: string) => console.log(`[runner] ${m}`);

const workspacesRoot = env.BOSSMAN_WORKSPACES ?? "/home/node/workspaces";
// check-all.sh's queue, slot locks and results: one folder that every session, fenced or not, and
// the merge check share, so checks still take turns (BOS-321).
const coordDir = path.join(workspacesRoot, ".bossman-coord");
mkdirSync(coordDir, { recursive: true });
const checkSlots = applyCheckSlots(coordDir, env.BOSSMAN_CHECK_SLOTS);
if (checkSlots > 1) console.log(`[runner] full checks: ${checkSlots} at a time (BOSSMAN_CHECK_SLOTS)`);
if (checkSlots > 1) {
  // Each extra full check peaks near 3 GB; warn when the container limit (cgroup v2 or v1) is lower than that.
  for (const f of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    if (!existsSync(f)) continue;
    const limit = Number(readFileSync(f, "utf8").trim());
    if (Number.isFinite(limit) && limit < checkSlots * 3 * 1024 ** 3 + 2 * 1024 ** 3 && limit < 2 ** 50)
      console.warn(`[runner] warning: memory limit is ${Math.round(limit / 1024 ** 3)} GB but ${checkSlots} full checks at once need about ${checkSlots * 3 + 2} GB; raise BOSSMAN_RUNNER_MEMORY or checks may be OOM-killed`);
    break;
  }
}
// One pnpm store for every install an agent's checks make (BOS-568): on the workspaces volume by default,
// or at PNPM_STORE_DIR. Without it pnpm starts a fresh store in each agent's $HOME (on the root disk) and
// the old ones are left behind.
const storeDir = pnpmStoreDir(workspacesRoot, env.PNPM_STORE_DIR);
mkdirSync(storeDir, { recursive: true });
// The merge gate runs unfenced, so it installs from a store of its own that the fence never grants (BOS-568 review):
// a poisoned package in the shared store must not run in the gate, as the runner's own user.
const gateStore = gateStoreDir(storeDir);
assertSeparateStore(storeDir, gateStore);
mkdirSync(gateStore, { recursive: true });
// The runner's own installs use the shared store too, so the runner's ~1.3 GB isn't in a second store on the root disk.
Object.assign(env, storeEnv(storeDir));
const workspaces = new Workspaces(workspacesRoot, process.env, coordDir, gateStore);
// What this host can fence agents with (DR-004, BOS-321): reported to the server below, and it
// decides whether a run asked to be fenced can be. Each agent's own home lives in the data volume.
const sandbox = sandboxSelfTest();
log(`agent fence: ${sandbox.level} (Landlock ABI ${sandbox.landlockAbi}${sandbox.errno ? `, ${sandbox.errno}` : ""}${sandbox.missing.length ? `; missing: ${sandbox.missing.join(", ")}` : ""})`);

let connection: RunnerConnection;
const sessions = new SessionManager({
  mcpUrl: env.BOSSMAN_MCP_URL ?? `${httpBase}/mcp`,
  emit: (event) => connection.emit(event),
  resolveEnv: async (runId) => {
    const res = await fetch(`${httpBase}/api/runner/env?runId=${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { env: Record<string, string> }).env;
  },
  stateFile: path.join(dataDir, "active-runs.json"),
  workspaces,
  reply: (requestId, result) => connection.reply(requestId, result),
  checkClaude: (credentials) => checkClaude(credentials),
  coordDir,
  fence: { ...runnerFence(sandbox.level, dataDir, workspacesRoot, env.PNPM_STORE_DIR), pnpmStore: storeDir },
  resolveCompanyEnv: async (purpose) => {
    const res = await fetch(`${httpBase}/api/runner/env?purpose=${purpose}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { env: Record<string, string> }).env;
  },
  log,
});

connection = new RunnerConnection({
  url: wsUrl,
  token,
  journal,
  runnerVersion: "0.0.0",
  imageVersion: env.BOSSMAN_IMAGE_VERSION ?? null,
  harnessVersions: await harnessVersions(),
  log,
  onCommand: (command) => sessions.handle(command),
  pendingPermissions: () => sessions.pendingPermissions(),
  liveRuns: () => sessions.liveRunIds(),
});

// Runs the previous process didn't finish go into the journal as interrupted before we connect (R42).
const interrupted = sessions.recoverInterrupted();
if (interrupted.length) log(`reported ${interrupted.length} interrupted run(s) for recovery`);
connection.start();
connection.emit({ type: "runner.sandbox", report: sandbox });

// Workspace clean-up and disk use (R54): at start-up, then hourly. The report is journalled
// like any event, so it reaches the server once the connection is up.
const housekeeping = async () => {
  try {
    const report = await workspaces.housekeeping();
    if (report.removed.length) log(`removed ${report.removed.length} orphaned workspace folder(s)`);
    connection.emit({ type: "runner.disk", ...report });
  } catch (err) {
    log(`workspace clean-up failed: ${(err as Error).message}`);
  }
};
void housekeeping();
const sweep = setInterval(() => void housekeeping(), 3_600_000);

// The container healthcheck reads this file: it's touched while the server connection is live.
const marker = path.join(dataDir, "connected");
const beat = setInterval(() => {
  try {
    if (connection.isLive) writeFileSync(marker, new Date().toISOString());
    else rmSync(marker, { force: true });
  } catch (err) {
    log(`couldn't update the health marker: ${(err as Error).message}`);
  }
}, 15_000);

const stop = () => {
  clearInterval(beat);
  clearInterval(sweep);
  rmSync(marker, { force: true });
  sessions.shutdown();
  connection.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
