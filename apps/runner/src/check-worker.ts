// Check worker daemon (DR-060, BOS-1435): the runner image started with BOSSMAN_ROLE=check-worker. It dials the server's
// /api/check-worker/connect with its own token and runs check jobs, nothing else: no agent sessions, no secrets
// (/api/runner/env is never called and would refuse its token), no merges, no journal. Part 2 (BOS-1436) teaches it to
// fetch the code; until it announces "check-bundle" the server sends it no jobs.
//
// Kept from the runner: the fence self-test (check jobs run fenced), the check slots, the pnpm stores, workspace
// housekeeping and the health marker. Every per-host value comes from the environment or the owner's settings.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORKER_FEATURES, type RunnerCommand, type WorkerRepos } from "@boss-man/shared";
import { bundleFetcher } from "./check-bundle-fetch.js";
import { downloadCheckBundle } from "./check-bundle-http.js";
import { CheckJobs } from "./check-jobs.js";
import { RunnerConnection } from "./connection.js";
import { readToolchain } from "./toolchain.js";
import { applyCheckSlots, pnpmStoreDir, pruneStores, sandboxSelfTest } from "./fence.js";
import { assertSeparateStore, gateStoreDir, storeEnv } from "./store.js";
import { safeWorkerToken } from "./token.js";
import { Workspaces } from "./workspace.js";

/** The commands a check worker acts on. Anything else is ignored (the connection drops it first; this is the backstop). */
export function workerHandles(command: RunnerCommand, jobs: Pick<CheckJobs, "run" | "cancel" | "acknowledge">): boolean {
  switch (command.type) {
    case "check.run":
      jobs.run(command);
      return true;
    case "check.cancel":
      jobs.cancel(command.jobId);
      return true;
    case "check.ack":
      jobs.acknowledge(command.jobId);
      return true;
    default:
      return false;
  }
}

/** The worker socket's address: BOSSMAN_URL, which must name /api/check-worker/connect (a runner URL is refused, not rewritten). */
export function workerUrl(raw: string | undefined): string {
  const url = (raw ?? "").trim();
  if (!/^wss?:\/\/.+\/api\/check-worker\/connect$/.test(url)) throw new Error("Set BOSSMAN_URL to the server's check worker socket, e.g. wss://bossman.example.com/api/check-worker/connect.");
  return url;
}

/** The server's HTTP address for the worker socket's URL (where the code bundles are fetched from, BOS-1436). */
export const workerHttpBase = (url: string) => url.replace(/^ws/, "http").replace(/\/api\/check-worker\/connect$/, "");

export async function startCheckWorker(env: NodeJS.ProcessEnv = process.env) {
  const log = (m: string) => console.log(`[check-worker] ${m}`);
  const url = workerUrl(env.BOSSMAN_URL);
  const token = safeWorkerToken(env);
  const dataDir = env.BOSSMAN_RUNNER_DATA ?? "/home/node/runner-data";
  mkdirSync(dataDir, { recursive: true });
  const workspacesRoot = env.BOSSMAN_WORKSPACES ?? "/home/node/workspaces";
  const coordDir = path.join(workspacesRoot, ".bossman-coord");
  mkdirSync(coordDir, { recursive: true });
  const sandbox = sandboxSelfTest();
  // The machine's real limit; told to the server in hello, which never gives it more (the owner's setting can lower it).
  const checkSlots = applyCheckSlots(coordDir, env.BOSSMAN_CHECK_SLOTS);
  const storeDir = pnpmStoreDir(workspacesRoot, env.PNPM_STORE_DIR);
  mkdirSync(storeDir, { recursive: true });
  const gateStore = gateStoreDir(storeDir);
  assertSeparateStore(storeDir, gateStore);
  mkdirSync(gateStore, { recursive: true });
  Object.assign(env, storeEnv(storeDir));
  const workspaces = new Workspaces(workspacesRoot, env, coordDir, gateStore, { level: sandbox.level, pnpmStore: storeDir });
  workspaces.fenceCloneGit = sandbox.level !== "unavailable";
  log(`agent fence: ${sandbox.level}; check slots: ${checkSlots}`);

  // BOS-1436: the code comes as a git bundle through the server (the worker has no GitHub login). What it holds per
  // project goes in every hello and after each fetch, so the runner's next bundle for it is thin.
  let repos: WorkerRepos = await workspaces.checkBundleHaves().catch(() => []);
  const httpBase = workerHttpBase(url);
  // eslint-disable-next-line prefer-const
  let connection: RunnerConnection;
  const prepare = bundleFetcher({
    workspaces,
    download: (jobId, file, want) => downloadCheckBundle(httpBase, token, jobId, file, want),
    send: (m) => connection.sendDirect(m),
    log,
    onRepos: (r) => (repos = r),
  });
  const checkJobs = new CheckJobs(workspaces, (m) => connection.sendDirect(m), log, prepare);
  connection = new RunnerConnection({
    url,
    token,
    runnerVersion: "0.0.0",
    imageVersion: env.BOSSMAN_IMAGE_VERSION ?? null,
    imageCommit: /^[0-9a-f]{40}$/i.test(env.BOSSMAN_IMAGE_COMMIT ?? "") ? env.BOSSMAN_IMAGE_COMMIT : undefined,
    toolchain: await readToolchain(),
    log,
    onCommand: (command) => {
      if (!workerHandles(command, checkJobs)) log(`ignored a ${command.type} command`);
    },
    runningChecks: () => checkJobs.running(),
    onWelcome: () => checkJobs.resend(),
    checkWorker: { slots: checkSlots, features: WORKER_FEATURES, repos: () => repos },
  });
  connection.start();

  // Workspace clean-up (R54) and the store prune, as on a runner; the disk report has nowhere to go, so it is only logged.
  const housekeeping = async () => {
    try {
      const report = await workspaces.housekeeping();
      if (report.removed.length) log(`removed ${report.removed.length} orphaned workspace folder(s)`);
    } catch (err) {
      log(`workspace clean-up failed: ${(err as Error).message}`);
    }
  };
  void housekeeping();
  const sweep = setInterval(() => void housekeeping(), 3_600_000);
  void pruneStores(storeDir, log);
  const prune = setInterval(() => void pruneStores(storeDir, log), 24 * 3_600_000);
  prune.unref();

  // The container healthcheck reads this file, as on a runner.
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
    clearInterval(prune);
    rmSync(marker, { force: true });
    connection.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
