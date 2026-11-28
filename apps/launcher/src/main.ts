// Boss Man's runner launcher (R55). Configured only by its own environment:
//   BOSSMAN_DATA           host folder for company data, mounted at the same path here
//   BOSSMAN_RUNNER_NETWORK the compose network runners join (default boss-man_default)
//   BOSSMAN_RUNNER_URL     where runners reach the server (default ws://server:3100/api/runner/connect)
//   BOSSMAN_RUNNER_MEMORY  optional runner memory, e.g. 8g: an upper bound until the server sends Agents at once, then the size itself. Normally unset: "Agents at once" and "Checks at once" in Settings size it (BOS-993, BOS-1498)
//   BOSSMAN_RUNNER_PIDS    process and thread limit per runner (default 4096)
//   BOSSMAN_RUNNER_CPU_SHARES  CPU weight per runner against 1024 for the server and database (default 512)
//   BOSSMAN_CHECK_SLOTS         optional upper bound on the full checks a runner may run at once. Normally unset: "Checks at once" in Settings decides (BOS-993)
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dropToUnprivileged, hostPathOfMount, noteSocketGroup } from "./startup.js";
import { allowedThreads, formatCpuList, parseReservedThreads, planReserve, siblingsFromSysfs } from "./cpu-layout.js";
import { dockerClient } from "./docker.js";
import { watchGuardEvents } from "./guard-events.js";
import { CHECKS_FILE, launcher, launcherServer } from "./launcher.js";
import { releaseReader } from "./release-current.js";
import { checkSetup, explainError } from "./selfcheck.js";
import { listLabel, MAX_AGENTS, type KeptMemory, parseAllow, parseCheckSlots, parseCpuShares, parseCpus, parseGuardMode, parseImageRef, parseInstallLabel, parseMemory, parseOpencodeSessionDays, parsePids, parsePnpmStoreDir, parseStack, type LauncherConfig } from "./spec.js";

const env = process.env;
// The image install (BOS-974) starts as root with SETUID/SETGID only; this joins the Docker socket's group and drops to uid 1000 before anything else.
console.log(JSON.stringify({ at: new Date().toISOString(), msg: "privileges", detail: dropToUnprivileged(env.DOCKER_SOCKET ?? "/var/run/docker.sock") }));
// Say so in the log if the socket's group is not the one the last start saw. Only a log line: a failure here never stops the launcher.
try {
  const sock = env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  const file = path.join(path.dirname(env.BOSSMAN_LAUNCHER_KEY_FILE ?? "/run/launcher/key"), "socket_gid");
  const line = noteSocketGroup(file, statSync(sock).gid, (f) => (existsSync(f) ? readFileSync(f, "utf8") : null), (f, b) => writeFileSync(f, b));
  if (line) console.log(JSON.stringify({ at: new Date().toISOString(), msg: "socket-group", detail: line }));
} catch {
  /* optional note only */
}
const dataRoot = env.BOSSMAN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) {
  console.error("Set BOSSMAN_DATA to an absolute host folder, mounted at the same path in this container.");
  process.exit(1);
}
/** The host's total memory (the container sees the host's /proc/meminfo), or undefined where it can't be read. */
function hostMemoryBytes(): number | undefined {
  try {
    const kb = Number(/^MemTotal:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
    return kb > 0 ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}
/** What the server last sent, kept in a file under the data folder: "Checks at once" (BOS-993), the agents number and the kept memory (BOS-1498). */
function saved(): { slots?: number; agents?: number; kept?: KeptMemory } {
  try {
    const v = JSON.parse(readFileSync(path.join(dataRoot!, CHECKS_FILE), "utf8")) as { slots?: unknown; agents?: unknown; kept?: { bytes?: unknown; slots?: unknown; agents?: unknown } };
    const whole = (x: unknown, lo: number, hi: number) => (typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi ? x : undefined);
    const slots = whole(v.slots, 1, 16);
    const agents = whole(v.agents, 0, MAX_AGENTS);
    const k = v.kept;
    const kept = k && whole(k.bytes, 1, Number.MAX_SAFE_INTEGER) !== undefined && whole(k.slots, 1, 16) !== undefined && whole(k.agents, 0, MAX_AGENTS) !== undefined ? (k as KeptMemory) : undefined;
    return { ...(slots ? { slots } : {}), ...(agents !== undefined ? { agents } : {}), ...(kept ? { kept } : {}) };
  } catch {
    return {};
  }
}
const savedChecks = saved();
const savedSlots = () => savedChecks.slots;
const cpuPlan = planReserve(parseReservedThreads(env.BOSSMAN_RESERVED_THREADS), allowedThreads(), siblingsFromSysfs);
console.log(JSON.stringify({ at: new Date().toISOString(), msg: "cpu reserve", on: cpuPlan.on, reason: cpuPlan.reason }));
const cfg: LauncherConfig = {
  cpuPlan,
  ...(cpuPlan.on ? { cpuset: formatCpuList(cpuPlan.runnerThreads) } : {}),
  dataRoot,
  stack: parseStack(env.BOSSMAN_STACK),
  installLabel: parseInstallLabel(env.BOSSMAN_INSTALL_LABEL),
  network: env.BOSSMAN_RUNNER_NETWORK ?? "boss-man_default",
  serverUrl: env.BOSSMAN_RUNNER_URL ?? "ws://server:3100/api/runner/connect",
  memoryBytes: parseMemory(env.BOSSMAN_RUNNER_MEMORY),
  pidsLimit: parsePids(env.BOSSMAN_RUNNER_PIDS),
  cpuShares: parseCpuShares(env.BOSSMAN_RUNNER_CPU_SHARES),
  checkSlots: parseCheckSlots(env.BOSSMAN_CHECK_SLOTS),
  // BOS-993: "Checks at once" in Settings decides the slots and the memory; these .env values (when set) are only upper bounds.
  ...(env.BOSSMAN_CHECK_SLOTS?.trim() ? { envSlotsCap: parseCheckSlots(env.BOSSMAN_CHECK_SLOTS) } : {}),
  ...(env.BOSSMAN_RUNNER_MEMORY?.trim() ? { envMemoryCap: parseMemory(env.BOSSMAN_RUNNER_MEMORY) } : {}),
  ...(hostMemoryBytes() ? { hostMemoryBytes: hostMemoryBytes() } : {}),
  // Nothing saved yet: the default setting (1) sizes the runner when the host has no .env slot or memory value (the cleaned-up
  // state), so a runner made before the server's first push is not left on the old 4 GB. With .env values, they apply as before.
  ...(savedSlots() ? { requestedSlots: savedSlots() } : env.BOSSMAN_CHECK_SLOTS?.trim() || env.BOSSMAN_RUNNER_MEMORY?.trim() ? {} : { requestedSlots: 1 }),
  // BOS-1498: the agents number and kept memory come only with saved slots, so a stray file can't size a runner on its own.
  ...(savedSlots() && savedChecks.agents !== undefined ? { requestedAgents: savedChecks.agents } : {}),
  ...(savedSlots() && savedChecks.kept ? { kept: savedChecks.kept } : {}),
  opencodeSessionDays: parseOpencodeSessionDays(env.BOSSMAN_OPENCODE_SESSION_DAYS),
  pnpmStoreDir: parsePnpmStoreDir(env.PNPM_STORE_DIR),
  cpus: parseCpus(env.BOSSMAN_RUNNER_CPUS),
  guardMode: parseGuardMode(env.BOSSMAN_NETGUARD),
  guardAllow: parseAllow(env.BOSSMAN_NETGUARD_ALLOW),
  runnerImage: parseImageRef("BOSSMAN_RUNNER_IMAGE", env.BOSSMAN_RUNNER_IMAGE),
  netguardImage: parseImageRef("BOSSMAN_NETGUARD_IMAGE", env.BOSSMAN_NETGUARD_IMAGE),
};
// BOS-1227: BOSSMAN_RELEASE_FILE names the updater's `release-current` file (a read-only volume); unset or missing = the environment images.
cfg.release = releaseReader(env.BOSSMAN_RELEASE_FILE?.trim() || undefined, { runner: cfg.runnerImage, netguard: cfg.netguardImage }, (msg) => console.error(JSON.stringify({ at: new Date().toISOString(), msg })));
const socketPath = env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const docker = dockerClient(socketPath);
// BOSSMAN_DATA_HOST=auto: the data folder is a named volume; ask Docker where it is on the host (BOS-974). A path = use that. Empty = BOSSMAN_DATA is a host path too.
if (env.BOSSMAN_DATA_HOST?.trim()) {
  cfg.hostDataRoot = env.BOSSMAN_DATA_HOST.trim() === "auto" ? hostPathOfMount(await docker.inspect(os.hostname()), dataRoot) : env.BOSSMAN_DATA_HOST.trim();
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: "data folder", inside: dataRoot, onHost: cfg.hostDataRoot }));
}
const api = launcher(cfg, docker);

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

// BOS-1892: check the set-up at start and name each fix in the log; the compose healthcheck (dist/check.js) shows it in `docker compose ps`.
const setup = { dataRoot, socketPath };
// BOS-1227: a fresh data volume has no `companies` folder (the first launcher the updater makes starts on an empty one, and its health check
// wants the folder). Make it; an existing one is left alone, and a folder it cannot make is reported by the check just below.
try {
  mkdirSync(path.join(dataRoot, "companies"), { recursive: true, mode: 0o755 });
} catch {
  /* checkSetup names the problem */
}
for (const p of checkSetup(setup)) console.error(JSON.stringify({ at: new Date().toISOString(), msg: "launcher set-up problem", problem: p.what, fix: p.message }));
const server = launcherServer(api, key, undefined, (err) => explainError(err, setup));
server.listen(Number(env.PORT ?? 3105), "0.0.0.0", () => console.log(JSON.stringify({ at: new Date().toISOString(), msg: "launcher listening", network: cfg.network })));
// The network guard (BOS-324) must be in the runner's namespace. BOS-335: the 5 s timer is the backstop, and Docker's
// own events make the common case (a runner restarted by itself) re-guard at once. Checks never overlap: one is
// always the same work (reconcileGuards), so a second request while one runs is folded into one more run afterwards.
let reconciling = false;
let again = false;
const reconcile = (why: string) => {
  if (reconciling) {
    again = true;
    return;
  }
  reconciling = true;
  api
    .reconcileGuards()
    .then(
      (fixed) => fixed.length && console.log(JSON.stringify({ at: new Date().toISOString(), msg: "network guard started again", companies: fixed, why })),
      (err: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "network guard check failed", error: String((err as Error)?.message ?? err), why })),
    )
    .finally(() => {
      reconciling = false;
      if (again) {
        again = false;
        reconcile("again");
      }
    });
};
// The fast path: a runner start, restart or die from Docker runs reconcile at once (it reconciles once at start too).
// The timer stays: events can be missed (a reconnect, a Docker restart), and it is the slow backstop.
const guardWatch = watchGuardEvents({
  docker,
  // The filter matches the runner containers' own label (`boss-man.launcher=1`), not just its name, so nothing else that
  // happens to carry the key is watched (BOS-335).
  label: listLabel(cfg.stack),
  reconcile,
  log: (level, entry) => console[level](JSON.stringify({ at: new Date().toISOString(), ...entry })),
});
setInterval(() => reconcile("timer"), 5_000).unref();
// Self-heal (BOS-467): a runner removed because its guard failed is made again, with a growing wait between tries.
const heal = () =>
  api.healMissing().then(
    (healed) => healed.length && console.log(JSON.stringify({ at: new Date().toISOString(), msg: "runner made again after it was removed", companies: healed })),
    (err: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "could not make runner again; will retry", error: String((err as Error)?.message ?? err) })),
  );
setInterval(() => void heal(), 5_000).unref();
const stop = () => {
  guardWatch.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
