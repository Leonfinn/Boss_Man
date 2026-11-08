// Boss Man's runner launcher (R55). Configured only by its own environment:
//   BOSSMAN_DATA           host folder for company data, mounted at the same path here
//   BOSSMAN_RUNNER_NETWORK the compose network runners join (default boss-man_default)
//   BOSSMAN_RUNNER_URL     where runners reach the server (default ws://server:3100/api/runner/connect)
//   BOSSMAN_RUNNER_MEMORY  memory limit per runner, e.g. 4g
//   BOSSMAN_RUNNER_PIDS    process and thread limit per runner (default 4096)
//   BOSSMAN_RUNNER_CPU_SHARES  CPU weight per runner against 1024 for the server and database (default 512)
//   BOSSMAN_CHECK_SLOTS         full checks a runner may run at once (default 1; each extra one needs about 3 GB of runner memory)
//   BOSSMAN_OPENCODE_SESSION_DAYS  days a runner keeps OpenCode sessions (default 14, 0 = never delete)
//   PNPM_STORE_DIR         shared pnpm store for every agent install, a folder under the workspaces volume (default: its .pnpm-store)
//   BOSSMAN_RUNNER_CPUS    optional hard CPU cap per runner, e.g. 4 (default none)
//   BOSSMAN_RESERVED_THREADS  threads kept back for the server, database and proxy: off (default), auto (2 on hosts with 6+ threads), or a number
//   BOSSMAN_NETGUARD       auto (default), enforce or off: the network guard that keeps runners off private networks
//   BOSSMAN_NETGUARD_ALLOW extra host:port entries (space separated) every runner may reach on the private networks
//   BOSSMAN_LAUNCHER_KEY_FILE  the key the server sends; made on first start if missing
// `node dist/main.js recreate-all` puts every runner on the current image at once, cutting runs off (scripts/update-runner.sh --now).
// For a setting change use scripts/update-runner.sh --settings, which drains first (BOS-594).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { allowedThreads, formatCpuList, parseReservedThreads, planReserve, siblingsFromSysfs } from "./cpu-layout.js";
import { dockerClient } from "./docker.js";
import { launcher, launcherServer } from "./launcher.js";
import { parseAllow, parseCheckSlots, parseCpuShares, parseCpus, parseGuardMode, parseMemory, parseOpencodeSessionDays, parsePids, parsePnpmStoreDir, type LauncherConfig } from "./spec.js";

const env = process.env;
const dataRoot = env.BOSSMAN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) {
  console.error("Set BOSSMAN_DATA to an absolute host folder, mounted at the same path in this container.");
  process.exit(1);
}
const cpuPlan = planReserve(parseReservedThreads(env.BOSSMAN_RESERVED_THREADS), allowedThreads(), siblingsFromSysfs);
console.log(JSON.stringify({ at: new Date().toISOString(), msg: "cpu reserve", on: cpuPlan.on, reason: cpuPlan.reason }));
const cfg: LauncherConfig = {
  cpuPlan,
  ...(cpuPlan.on ? { cpuset: formatCpuList(cpuPlan.runnerThreads) } : {}),
  dataRoot,
  network: env.BOSSMAN_RUNNER_NETWORK ?? "boss-man_default",
  serverUrl: env.BOSSMAN_RUNNER_URL ?? "ws://server:3100/api/runner/connect",
  memoryBytes: parseMemory(env.BOSSMAN_RUNNER_MEMORY),
  pidsLimit: parsePids(env.BOSSMAN_RUNNER_PIDS),
  cpuShares: parseCpuShares(env.BOSSMAN_RUNNER_CPU_SHARES),
  checkSlots: parseCheckSlots(env.BOSSMAN_CHECK_SLOTS),
  opencodeSessionDays: parseOpencodeSessionDays(env.BOSSMAN_OPENCODE_SESSION_DAYS),
  pnpmStoreDir: parsePnpmStoreDir(env.PNPM_STORE_DIR),
  cpus: parseCpus(env.BOSSMAN_RUNNER_CPUS),
  guardMode: parseGuardMode(env.BOSSMAN_NETGUARD),
  guardAllow: parseAllow(env.BOSSMAN_NETGUARD_ALLOW),
};
const api = launcher(cfg, dockerClient(env.DOCKER_SOCKET ?? "/var/run/docker.sock"));

if (process.argv[2] === "recreate-all") {
  const done = await api.recreateAll();
  console.log(done.length ? `Recreated: ${done.join(", ")}` : "No runners to recreate.");
  process.exit(0);
}

const keyFile = env.BOSSMAN_LAUNCHER_KEY_FILE ?? "/run/launcher/key";
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
const key = Buffer.from(readFileSync(keyFile, "utf8").trim());
if (key.length < 32) {
  console.error(`The key in ${keyFile} is too short.`);
  process.exit(1);
}

const server = launcherServer(api, key);
server.listen(Number(env.PORT ?? 3105), "0.0.0.0", () => console.log(JSON.stringify({ at: new Date().toISOString(), msg: "launcher listening", network: cfg.network })));
// The network guard (BOS-324) must be in the runner's namespace: check at start and every 5 seconds.
const reconcile = () =>
  api.reconcileGuards().then(
    (fixed) => fixed.length && console.log(JSON.stringify({ at: new Date().toISOString(), msg: "network guard started again", companies: fixed })),
    (err: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "network guard check failed", error: String((err as Error)?.message ?? err) })),
  );
void reconcile();
setInterval(() => void reconcile(), 5_000).unref();
// Self-heal (BOS-467): a runner removed because its guard failed is made again, with a growing wait between tries.
const heal = () =>
  api.healMissing().then(
    (healed) => healed.length && console.log(JSON.stringify({ at: new Date().toISOString(), msg: "runner made again after it was removed", companies: healed })),
    (err: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "could not make runner again; will retry", error: String((err as Error)?.message ?? err) })),
  );
setInterval(() => void heal(), 5_000).unref();
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
