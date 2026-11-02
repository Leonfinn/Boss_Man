// Runner daemon: one per company. Dials out to the Boss Man server, runs agents over ACP
// on its commands, and journals every event until the server has it (R31).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkClaude } from "./claude-check.js";
import { Journal } from "./journal.js";
import { RunnerConnection } from "./connection.js";
import { SessionManager } from "./session-manager.js";
import { Workspaces } from "./workspace.js";

const env = process.env;
const wsUrl = env.BOSSMAN_URL ?? "ws://server:3100/api/runner/connect";
const httpBase = wsUrl.replace(/^ws/, "http").replace(/\/api\/runner\/connect$/, "");
// The token comes from a file (a Docker secret) or the environment.
const token = env.BOSSMAN_RUNNER_TOKEN_FILE ? readFileSync(env.BOSSMAN_RUNNER_TOKEN_FILE, "utf8").trim() : env.BOSSMAN_RUNNER_TOKEN?.trim();
if (!token) throw new Error("Set BOSSMAN_RUNNER_TOKEN_FILE or BOSSMAN_RUNNER_TOKEN to the token from POST /api/companies/:id/runner.");

const dataDir = env.BOSSMAN_RUNNER_DATA ?? "/home/node/runner-data";
mkdirSync(dataDir, { recursive: true });
const journal = new Journal(path.join(dataDir, "journal.jsonl"));
const log = (m: string) => console.log(`[runner] ${m}`);

const workspacesRoot = env.BOSSMAN_WORKSPACES ?? "/home/node/workspaces";
// check-all.sh's queue, slot locks and results: one folder that every session, fenced or not, and
// the merge check share, so checks still take turns (BOS-321).
const coordDir = path.join(workspacesRoot, ".bossman-coord");
mkdirSync(coordDir, { recursive: true });
const workspaces = new Workspaces(workspacesRoot, process.env, coordDir);
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
  log,
  onCommand: (command) => sessions.handle(command),
  pendingPermissions: () => sessions.pendingPermissions(),
});

// Runs the previous process didn't finish go into the journal as interrupted before we connect (R42).
const interrupted = sessions.recoverInterrupted();
if (interrupted.length) log(`reported ${interrupted.length} interrupted run(s) for recovery`);
connection.start();

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
