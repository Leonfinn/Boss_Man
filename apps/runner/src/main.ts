// Runner daemon: one per company. Dials out to the Boss Man server, runs agents over ACP
// on its commands, and journals every event until the server has it (R31).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkClaude } from "./claude-check.js";
import { adapterBin, claudeBin, lockHash, PACK_SOURCE, readPack } from "./claude-pack.js";
import { applyCheckSlots, pnpmStoreDir, pruneStores, runnerFence, sandboxSelfTest } from "./fence.js";
import { harnessVersions } from "./harness-versions.js";
import { CheckJobs } from "./check-jobs.js";
import { Journal } from "./journal.js";
import { DEFAULT_VACUUM_TIMEOUT_MS, keepDaysFrom, opencodeDataHomes, pruneOpencodeSessions } from "./opencode-prune.js";
import { RunnerConnection } from "./connection.js";
import { hostBootAt, markStopped, previousExit } from "./restart-info.js";
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
// How the last process ended, read before anything else can fail (BOS-594).
const restart = { previousExit: previousExit(dataDir), hostBootAt: hostBootAt() };
if (restart.previousExit) log(`previous runner process: ${restart.previousExit === "stopped" ? "stopped from outside" : "ended without being stopped (crash or out of memory)"}`);

const workspacesRoot = env.BOSSMAN_WORKSPACES ?? "/home/node/workspaces";
// check-all.sh's queue, slot locks and results: one folder that every session, fenced or not, and
// the merge check share, so checks still take turns (BOS-321).
const coordDir = path.join(workspacesRoot, ".bossman-coord");
mkdirSync(coordDir, { recursive: true });
const sandbox = sandboxSelfTest();
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
// the old ones are left behind. Refused when it is the workspaces volume's root or outside it (BOS-633).
const storeDir = pnpmStoreDir(workspacesRoot, env.PNPM_STORE_DIR);
mkdirSync(storeDir, { recursive: true });
// The merge gate runs unfenced, so it installs from a store of its own that the fence never grants (BOS-568 review):
// a poisoned package in the shared store must not run in the gate, as the runner's own user.
const gateStore = gateStoreDir(storeDir);
assertSeparateStore(storeDir, gateStore);
mkdirSync(gateStore, { recursive: true });
// The runner's own installs use the shared store too, so the runner's ~1.3 GB isn't in a second store on the root disk.
Object.assign(env, storeEnv(storeDir));
// The 4th argument is the unfenced merge gate's store, so it gets its own (gateStore); agents can write the
// shared store, and a poisoned package there must not run in the gate as the runner's user. Server-queued check
// jobs are fenced like agents, so they use the shared store (BOS-316, BOS-568).
const workspaces = new Workspaces(workspacesRoot, process.env, coordDir, gateStore, { level: sandbox.level, pnpmStore: storeDir });
// What this host can fence agents with (DR-004, BOS-321): reported to the server below, and it
// decides whether a run asked to be fenced can be. Each agent's own home lives in the data volume.
// The runner's own git in a ticket's clone runs fenced wherever the fence works (BOS-323).
workspaces.fenceCloneGit = sandbox.level !== "unavailable";
// A merge check asked to run fenced gets a home of its own beside the agents', and the shared pnpm store.
if (sandbox.level !== "unavailable") workspaces.checkFence = { home: path.join(dataDir, "agents", "merge-check"), pnpmStore: storeDir };
log(`agent fence: ${sandbox.level} (Landlock ABI ${sandbox.landlockAbi}${sandbox.errno ? `, ${sandbox.errno}` : ""}${sandbox.missing.length ? `; missing: ${sandbox.missing.join(", ")}` : ""})`);

let connection: RunnerConnection;
const checkJobs = new CheckJobs(workspaces, (m) => connection.sendDirect(m), log);
// The Claude pack (DR-050, BOS-972): the image ships no Anthropic code, so Claude Code and its ACP adapter
// come from a ready folder on the bossman-claude volume, mounted read-only. The launcher's installer container
// (or the compose claude-pack service) fills it before this process starts; here we only read it. Without a
// ready pack, Claude is absent: CLAUDE_CODE_EXECUTABLE is left unset, no Claude adapter bin is given, and a
// Claude run ends with a clear "not installed" message. Codex and OpenCode are unaffected.
const claudePackRoot = env.BOSSMAN_CLAUDE_PACK?.trim();
const claudePack = (() => {
  if (!claudePackRoot) return { ready: false as const, reason: "BOSSMAN_CLAUDE_PACK isn't set" };
  let hash: string;
  try {
    // The pack folder is named by the same lockfile hash the image ships and the installer used.
    hash = lockHash(readFileSync(path.join(env.BOSSMAN_CLAUDE_PACK_SOURCE ?? PACK_SOURCE, "package-lock.json")));
  } catch {
    return { ready: false as const, reason: "the image has no Claude pack lockfile to name the folder by" };
  }
  return readPack(claudePackRoot, hash);
})();
if (claudePack.ready && claudePack.dir) {
  env.CLAUDE_CODE_EXECUTABLE = claudeBin(claudePack.dir);
  log(`Claude Code: ready pack at ${claudePack.dir} (${claudePack.version ?? "version unread"})`);
} else {
  delete env.CLAUDE_CODE_EXECUTABLE;
  log(`Claude Code: absent on this runner (${"reason" in claudePack ? claudePack.reason : "no ready pack"}). Claude agents will say so; Codex and OpenCode keep working.`);
}
/** The Claude ACP adapter's version from the ready pack, for the harness report; undefined with no pack. */
function claudePackAdapterVersion(): string | undefined {
  if (!claudePack.ready || !claudePack.dir) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(claudePack.dir, "node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"), "utf8")) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}
const sessions = new SessionManager({
  mcpUrl: env.BOSSMAN_MCP_URL ?? `${httpBase}/mcp`,
  mcpPreflightMs: Number(env.BOSSMAN_MCP_PREFLIGHT_MS ?? 20_000),
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
  checkJobs,
  // The Claude adapter comes from the ready pack, not the runner's node_modules (DR-050).
  ...(claudePack.ready && claudePack.dir ? { adapterBins: { claude: adapterBin(claudePack.dir) } } : {}),
  fence: { ...runnerFence(sandbox.level, dataDir, workspacesRoot), pnpmStore: storeDir },
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
  imageCommit: /^[0-9a-f]{40}$/i.test(env.BOSSMAN_IMAGE_COMMIT ?? "") ? env.BOSSMAN_IMAGE_COMMIT : undefined,
  harnessVersions: await harnessVersions({ claudeAdapterVersion: claudePackAdapterVersion() }),
  log,
  onCommand: (command) => sessions.handle(command),
  pendingPermissions: () => sessions.pendingPermissions(),
  restart,
  runningChecks: () => checkJobs.running(),
  onWelcome: () => checkJobs.resend(),
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
  await pruneOpencode();
};

// OpenCode never deletes its old sessions (BOS-616): drop ones untouched for
// BOSSMAN_OPENCODE_SESSION_DAYS (default 14, 0 = off), 50 per database per pass, then give the
// space back (one VACUUM per database while no OpenCode run is live, small steps after that).
// Each database is backed up and checked into runner-data/opencode-prune before its first delete.
const opencodeKeepDays = keepDaysFrom(env.BOSSMAN_OPENCODE_SESSION_DAYS, log);
let pruning = false;
const pruneOpencode = async () => {
  if (pruning || opencodeKeepDays <= 0) return;
  pruning = true;
  try {
    const agentsRoot = path.join(dataDir, "agents");
    const r = await pruneOpencodeSessions({
      keepDays: opencodeKeepDays,
      dataHomes: opencodeDataHomes(env, agentsRoot),
      agentsRoot,
      stateDir: path.join(dataDir, "opencode-prune"),
      activeSessionIds: () => sessions.activeSessionIds(),
      // The prune kills its VACUUM at 30 minutes (BOS-622); the hold lets go 5 minutes later whatever happens.
      whileOpencodeIdle: (fn) => sessions.whileOpencodeIdle(fn, DEFAULT_VACUUM_TIMEOUT_MS + 5 * 60_000),
      onVacuumCut: (cut) => connection.emit({ type: "runner.opencode_vacuum_cut", heldSeconds: Math.round(cut.heldMs / 1000), bytes: cut.bytes, agentHome: cut.agentHome }),
      log,
    });
    if (r.deleted || r.failed || r.reclaimedBytes > 0)
      log(`OpenCode sessions older than ${opencodeKeepDays} days: ${r.deleted} deleted, ${r.failed} failed, ${Math.round(r.reclaimedBytes / 1024 ** 2)} MB given back`);
  } catch (err) {
    log(`OpenCode session prune failed: ${(err as Error).message}`);
  } finally {
    pruning = false;
  }
};
void housekeeping();
const sweep = setInterval(() => void housekeeping(), 3_600_000);
// The pnpm stores only grow as lockfiles change (BOS-633). Pruned once at start-up and then daily: pnpm's store lock
// makes each prune safe beside a running install, and it only drops packages no install references any more. The
// prune runs asynchronously, so start-up and the daily tick never wait on it, and a slow prune can't stall
// the connection or live sessions; it never rejects.
void pruneStores(storeDir, log);
const prune = setInterval(() => void pruneStores(storeDir, log), 24 * 3_600_000);
prune.unref();

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
  markStopped(dataDir);
  clearInterval(beat);
  clearInterval(sweep);
  clearInterval(prune);
  rmSync(marker, { force: true });
  sessions.shutdown();
  connection.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
