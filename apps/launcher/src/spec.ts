// The one container the launcher knows how to make (R55). Nothing here comes from a request:
// the slug picks the company's folder and the container's name, and everything else is fixed
// or set by the launcher's own environment when it starts.
import path from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LABEL = "boss-man.launcher";
export const COMPANY_LABEL = "boss-man.company";
/** The network guard (BOS-324): a sidecar in each runner's network namespace that blocks private networks. */
export const NETGUARD_IMAGE = "boss-man-netguard:current";
export const NETGUARD_LABEL = "boss-man.netguard";
/** The folders a runner keeps between restarts, and where the runner sees them. */
export const MOUNTS = [
  ["workspaces", "/home/node/workspaces"],
  ["runner-data", "/home/node/runner-data"],
  ["claude", "/home/node/.claude"],
  ["opencode", "/home/node/.local/share/opencode"],
] as const;
/**
 * The Claude pack's named volume, mounted read-only into every runner (DR-050, BOS-972). The installer
 * (claude-pack.ts) fills it before the runner starts; a runner on an empty/not-ready pack reports Claude
 * absent. Named, not a company folder, so all runners of a stack share one install and none may write it.
 */
export const CLAUDE_PACK_TARGET = "/opt/bossman-claude";
export const claudePackVolume = (stack?: string) => `${stack ? `boss-man-${stack}` : "boss-man"}-claude-pack`;
export const TOKEN_TARGET = "/run/secrets/runner_token";
/** Docker's default weight is 1024; runners get half, so the server and database win on a busy host. */
export const DEFAULT_CPU_SHARES = 512;
/** Container logs are capped (BOS-2161), like the compose files' x-logging: Docker's default keeps every line forever. */
export const LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

export type LauncherConfig = {
  /** BOSSMAN_DATA: the host folder, mounted at the same path in the launcher, so binds name real host paths. */
  dataRoot: string;
  /** BOSSMAN_STACK: names a second stack on this host (BOS-69). Unset = today's names, labels and images. */
  stack?: string;
  /** The compose network the server is on, e.g. boss-man_default. Never host. */
  network: string;
  /** Where runners dial the server. */
  serverUrl: string;
  memoryBytes: number;
  /** BOSSMAN_RUNNER_PIDS: process/thread ceiling per runner. */
  pidsLimit: number;
  /** BOSSMAN_RUNNER_CPU_SHARES: CPU weight against the default 1024 of the server and database (default 512). Only matters when the host is busy. */
  cpuShares?: number;
  /** BOSSMAN_RUNNER_CPUS: optional hard cap in CPUs (e.g. 4 or 1.5), shared by everything in the runner. Unset = no cap. */
  cpus?: number;
  /** The threads runners are confined to (CpusetCpus, e.g. "0-9"), worked out at start by cpu-layout.ts. Unset = all threads. */
  cpuset?: string;
  /** What the CPU reserve decided, for the status call (cpu-layout.ts planReserve). */
  cpuPlan?: import("./cpu-layout.js").CpuPlan;
  /** BOSSMAN_NETGUARD: "auto" (default) guards every runner, and lets a host that can't run the guard go without; "enforce" refuses runners there; "off" never guards. */
  guardMode?: GuardMode;
  /** BOSSMAN_NETGUARD_ALLOW: extra host:port entries every runner may reach on the private networks. */
  guardAllow?: string[];
  /** BOSSMAN_CHECK_SLOTS: full checks (merge gate and hand runs) a runner may run at once, 1 to 16. Unset = 1; the runner needs about 3 GB of its memory limit per extra slot. */
  checkSlots?: number;
  /** BOS-993: the "Checks at once" the owner set in Settings, pushed by the server (PUT /checks). Unset = nothing pushed yet, so `checkSlots` and `memoryBytes` (from .env) apply as before. */
  requestedSlots?: number;
  /** BOS-993: BOSSMAN_CHECK_SLOTS as an upper bound, only when .env sets it. */
  envSlotsCap?: number;
  /** BOS-993: BOSSMAN_RUNNER_MEMORY as an upper bound, only when .env sets it. */
  envMemoryCap?: number;
  /** BOS-993: the host's total memory in bytes (from /proc/meminfo), when known. */
  hostMemoryBytes?: number;
  /** BOS-1498: the most agents one company's runner can carry at once, pushed by the server with the slots. Unset = not sent yet, so the old 13 GB base applies. */
  requestedAgents?: number;
  /** BOS-1498: the memory runners already had when this launcher first heard the agents number, kept while neither setting is lowered. */
  kept?: KeptMemory;
  /** BOSSMAN_OPENCODE_SESSION_DAYS: the runner deletes OpenCode sessions untouched this many days (BOS-616). Unset = the runner's default (14); 0 = never. */
  opencodeSessionDays?: number;
  /** PNPM_STORE_DIR: the shared pnpm store inside the runner, a folder under the workspaces volume (default: its .pnpm-store). */
  pnpmStoreDir?: string;
  /** How long to wait for a new guard to load its rules (default 20 s). */
  guardReadyMs?: number;
  /** BOSSMAN_RUNNER_IMAGE (BOS-974): the runner image to start, e.g. ghcr.io/<owner>/boss-man-runner@sha256:... Unset = boss-man-runner:current, built on this host. */
  runnerImage?: string;
  /** BOSSMAN_NETGUARD_IMAGE (BOS-974): the same for the network guard. Unset = boss-man-netguard:current. */
  netguardImage?: string;
  /**
   * BOS-974: where `dataRoot` is on the Docker host, when the data folder is a named volume mounted into this container
   * (the image install). Binds given to runners must name host paths, so they use this; this container's own file work uses `dataRoot`.
   * Unset = `dataRoot` is the host path too (the build install).
   */
  hostDataRoot?: string;
  /** DR-007: how long a paused runner waits for its guard before it's reported frozen (default 2 min). For tests. */
  guardFreezeAfterMs?: number;
  /** The clock, for tests. */
  now?: () => number;
};

/** A Docker image reference: a name, with a tag or a sha256 digest. Anything else would be a way to start some other image. */
const IMAGE_REF = /^[a-z0-9][a-z0-9._/:-]{0,200}(@sha256:[0-9a-f]{64})?$/;
export function parseImageRef(name: string, v: string | undefined): string | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  if (!IMAGE_REF.test(s)) throw new Error(`${name} should be an image name with a tag or @sha256: digest, not ${v}`);
  return s;
}

export type GuardMode = "auto" | "enforce" | "off";
/** The exit code netguard.sh uses when the host can't load nftables rules. */
export const NETGUARD_UNAVAILABLE_EXIT = 3;
const ALLOW_ENTRY = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$/;

export function parseGuardMode(v: string | undefined): GuardMode {
  const m = (v ?? "auto").trim().toLowerCase();
  if (m !== "auto" && m !== "enforce" && m !== "off") throw new Error(`BOSSMAN_NETGUARD should be auto, enforce or off, not ${v}`);
  return m;
}

/** host:port entries, space or comma separated; anything else is an error, because it would silently not open the port. */
export function parseAllow(v: string | string[] | undefined): string[] {
  const list = Array.isArray(v) ? v : (v ?? "").split(/[\s,]+/).filter(Boolean);
  for (const e of list) if (!ALLOW_ENTRY.test(e) || Number(e.slice(e.lastIndexOf(":") + 1)) > 65535) throw new Error(`Not a host:port: ${e}`);
  return [...new Set(list)];
}

/**
 * The host:ports the owner trusted for private addresses (BOS-708): each is checked as an allow entry.
 * The guard keeps their private addresses, and drops any other entry's.
 */
export function parseTrusted(v: string[] | undefined): Set<string> {
  const list = parseAllow(v ?? []);
  return new Set(list);
}

/** BOSSMAN_STACK (BOS-69): a short name for a second Boss Man on the same Docker host, e.g. "staging". Empty = the one and only stack. */
export const STACK_LABEL = "boss-man.stack";
const STACK = /^[a-z0-9][a-z0-9]{0,15}$/;
export function parseStack(v: string | undefined): string | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  if (!STACK.test(s)) throw new Error(`BOSSMAN_STACK should be 1 to 16 lowercase letters or digits, like staging, not ${v}`);
  // "runner" and "netguard" would make names that clash with the default stack's (boss-man-runner-runner-x).
  if (s === "runner" || s === "netguard") throw new Error(`BOSSMAN_STACK can't be ${s}; pick another name, like staging`);
  return s;
}
/** The prefix of everything this launcher makes: "boss-man" for the one stack, "boss-man-<stack>" for another, so two never share a name. */
const prefix = (stack?: string) => (stack ? `boss-man-${stack}` : "boss-man");
export const containerName = (slug: string, stack?: string) => `${prefix(stack)}-runner-${slug}`;
export const netguardName = (slug: string, stack?: string) => `${prefix(stack)}-netguard-${slug}`;
export const runnerImage = (stack?: string) => `${prefix(stack)}-runner:current`;
/** The image the runner ran before the last update (scripts/update-runner.sh keeps it): what a failed swap goes back to (BOS-382). */
export const previousRunnerImage = (stack?: string) => `${prefix(stack)}-runner:previous`;
export const guardImage = (stack?: string) => `${prefix(stack)}-netguard:current`;
/** What the launcher asks Docker to list: a named stack lists only its own containers; the default lists as before. */
export const listLabel = (stack?: string) => (stack ? `${STACK_LABEL}=${stack}` : `${LABEL}=1`);
const stackLabels = (stack?: string): Record<string, string> => (stack ? { [STACK_LABEL]: stack } : {});
export const companyDir = (cfg: LauncherConfig, slug: string) => path.join(cfg.dataRoot, "companies", slug);
/** The same folder as the Docker host sees it: what goes into a runner's Binds (BOS-974). */
const hostCompanyDir = (cfg: LauncherConfig, slug: string) => path.join(cfg.hostDataRoot ?? cfg.dataRoot, "companies", slug);
export const runnerImageOf = (cfg: LauncherConfig) => cfg.runnerImage ?? runnerImage(cfg.stack);
export const guardImageOf = (cfg: LauncherConfig) => cfg.netguardImage ?? guardImage(cfg.stack);
/** Where the launcher keeps a company's tool-server allow list; only the guard (read-only) mounts it, never the runner. */
export const netguardDir = (cfg: LauncherConfig, slug: string) => path.join(companyDir(cfg, slug), "netguard");
export const tokenFile = (cfg: LauncherConfig, slug: string) => path.join(companyDir(cfg, slug), "runner.token");

const GIB = 1024 ** 3;
/**
 * The old base, from before BOS-1498: 13 GB for every agent the company runs, plus 3 GB a check slot (1 slot = 16 GB).
 * It came from Boss Man building itself with many agents, so it now applies only while the launcher has not been told the
 * agents number (an older server, or the minute before the first push), so no runner shrinks on an upgrade alone.
 */
export const RUNNER_BASE_BYTES = 13 * GIB;
/** A full check peaks at about 3 GB (BOS-993's figure, unchanged). */
export const RUNNER_PER_SLOT_BYTES = 3 * GIB;
/**
 * BOS-1498: a runner is sized from what it carries. 2 GB for the runner itself, git and ripgrep and one owner chat (chats are
 * outside the run limits), plus 1 GB per agent at once, plus RUNNER_PER_SLOT_BYTES per check. Both figures are estimates: BOS-212
 * (research/infrastructure/hardware-sizing-and-docker-packaging-for-boss-man-unfinished-research) measured an idle runner at
 * 0.1 GiB and put an agent at 0.5 to 1 GB (more while it drives a browser) without measuring it yet; we take the top of that.
 * Update both here when BOS-212 measures them.
 */
export const RUNNER_AGENT_BASE_BYTES = 2 * GIB;
export const RUNNER_PER_AGENT_BYTES = 1 * GIB;
/** The most agents the server can send: 16 in a company plus 16 background (settings-limits.ts), with room to spare. */
export const MAX_AGENTS = 64;
/** BOS-1498: what runners had when the agents number first arrived, and the settings then. See planChecks. */
export type KeptMemory = { bytes: number; slots: number; agents: number };
/** The least a runner is given, even on a small host (the old default). */
export const RUNNER_MIN_BYTES = 4 * GIB;
/** Memory kept back on the host for the server, database and proxy when sizing a runner from the host's total. */
export const HOST_RESERVE_BYTES = 2 * GIB;

export type ChecksPlan = {
  /** What the owner set in Settings (null before the server has sent it). */
  requested: number | null;
  /** The slots a runner made now gets. */
  slots: number;
  memoryBytes: number;
  /** Why `slots` is lower than `requested`; null when it isn't. */
  reason: string | null;
  /** BOS-1498: the agents number the server sent (null before it has). */
  agents: number | null;
  /** BOS-1498: one plain line for the owner: what a runner made now is given and why. */
  why: string;
};

const gb = (b: number) => `${Math.round((b / GIB) * 10) / 10} GB`;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/**
 * The runner's check slots and memory (BOS-993, BOS-1498). The settings drive both and the host's memory limits what fits.
 * BOSSMAN_CHECK_SLOTS is an upper bound; BOSSMAN_RUNNER_MEMORY is an upper bound on the old path and the size itself once the
 * agents number is known. With no setting pushed yet the .env values apply as before.
 *
 * Memory = 2 GB + 1 GB per agent at once + 3 GB per check. Until the server sends the agents number, the old 13 GB base stands in.
 * `kept` (recorded by the launcher when the agents number first arrives and runners already exist) keeps those runners' memory
 * while neither setting is below what it was then: an upgrade alone never shrinks a runner, raising a setting only adds, and
 * only an owner who lowers one of the two settings moves to the smaller formula.
 */
export function planChecks(cfg: LauncherConfig): ChecksPlan {
  if (cfg.requestedSlots === undefined) {
    const why = `${gb(cfg.memoryBytes)}: ${cfg.envMemoryCap !== undefined ? "set by BOSSMAN_RUNNER_MEMORY in the host's .env" : "the starting size, until Boss Man sends your settings"}.`;
    return { requested: null, slots: cfg.checkSlots ?? 1, memoryBytes: cfg.memoryBytes, reason: null, agents: null, why };
  }
  const want = cfg.requestedSlots;
  const agents = cfg.requestedAgents;
  const sized = agents !== undefined;
  const base = sized ? RUNNER_AGENT_BASE_BYTES + RUNNER_PER_AGENT_BYTES * agents : RUNNER_BASE_BYTES;
  // Before the agents number (the old path, unchanged): never below 4 GB, and .env is only an upper bound.
  // With it (BOS-1498, the CEO's rules): a size the owner wrote in .env is used as it is, and on a small machine the host's limit
  // wins over the 4 GB floor, so the runner never takes the memory the server needs; the line then says it is under 4 GB.
  // The 1 GB floor only stops a nonsense limit on a host under 3 GB.
  const hostCeiling = cfg.hostMemoryBytes ? Math.max(cfg.hostMemoryBytes - HOST_RESERVE_BYTES, sized ? GIB : RUNNER_MIN_BYTES) : Infinity;
  const envWins = sized && cfg.envMemoryCap !== undefined;
  const ceiling = envWins ? cfg.envMemoryCap! : sized ? hostCeiling : Math.max(Math.min(cfg.envMemoryCap ?? Infinity, hostCeiling), RUNNER_MIN_BYTES);
  const fits = Number.isFinite(ceiling) ? Math.max(1, Math.floor((ceiling - base) / RUNNER_PER_SLOT_BYTES)) : Infinity;
  const slots = Math.min(want, cfg.envSlotsCap ?? Infinity, fits);
  const need = base + RUNNER_PER_SLOT_BYTES * slots;
  const kept = sized && cfg.kept && want >= cfg.kept.slots && agents >= cfg.kept.agents ? cfg.kept.bytes : 0;
  const target = Math.max(need, kept);
  const memoryBytes = envWins ? cfg.envMemoryCap! : Math.min(target, ceiling);
  const what = sized ? `${n(agents, "agent", "agents")} at once and ${n(slots, "check", "checks")}` : `the earlier fixed size for ${n(slots, "check", "checks")} at once (13 GB plus 3 GB a check)`;
  const machine = cfg.hostMemoryBytes ? `this ${gb(cfg.hostMemoryBytes)} machine` : "this machine";
  let why: string;
  if (envWins) why = `${gb(memoryBytes)}: set by BOSSMAN_RUNNER_MEMORY in the host's .env (${what} would need ${gb(target)}).`;
  else if (memoryBytes < target)
    why =
      cfg.envMemoryCap !== undefined && cfg.envMemoryCap <= hostCeiling
        ? `${gb(memoryBytes)}: ${what} would need ${gb(target)}, but BOSSMAN_RUNNER_MEMORY in the host's .env caps it.`
        : `${gb(memoryBytes)}: ${what} would need ${gb(target)}; ${machine} keeps ${gb(HOST_RESERVE_BYTES)} for the server and database.` +
          (memoryBytes < RUNNER_MIN_BYTES ? ` That is under the ${gb(RUNNER_MIN_BYTES)} a runner should have, so expect slow or failed runs: lower Agents at once or use a bigger machine.` : "");
  else if (kept > need) why = `${gb(memoryBytes)}: kept from before (${what} need ${gb(need)}). Lower Agents at once or Checks at once to use the smaller size.`;
  else if (!sized) why = `${gb(memoryBytes)}: ${what}, until Boss Man sends your Agents at once.`;
  else why = `${gb(memoryBytes)}: ${what}${cfg.hostMemoryBytes ? `, on a ${gb(cfg.hostMemoryBytes)} machine` : ""}.`;
  let reason: string | null = null;
  if (slots < want) {
    if (cfg.envSlotsCap !== undefined && slots === cfg.envSlotsCap) reason = `The host's .env caps it at ${slots} (BOSSMAN_CHECK_SLOTS).`;
    else if (cfg.envMemoryCap !== undefined && slots === fits && (envWins || cfg.envMemoryCap <= hostCeiling)) reason = `The host's .env caps runner memory at ${gb(cfg.envMemoryCap)} (BOSSMAN_RUNNER_MEMORY), which fits ${slots}.`;
    else reason = `Not enough free memory for ${want}: this host has ${cfg.hostMemoryBytes ? gb(cfg.hostMemoryBytes) : "too little"}, which fits ${slots}.`;
  }
  return { requested: want, slots, memoryBytes, reason, agents: agents ?? null, why };
}

/** The Docker create request for a company's runner. Snapshot-tested: change it on purpose only. */
export function containerSpec(cfg: LauncherConfig, slug: string, image?: string, host?: { dockerVersion: string; osType: string } | null) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const plan = planChecks(cfg);
  if (cfg.network === "host" || cfg.network === "none" || cfg.network.startsWith("container:")) throw new Error("bad network");
  const dir = hostCompanyDir(cfg, slug);
  return {
    Image: image ?? runnerImageOf(cfg),
    User: "1000:1000",
    Env: [
      `BOSSMAN_URL=${cfg.serverUrl}`,
      `BOSSMAN_RUNNER_TOKEN_FILE=${TOKEN_TARGET}`,
      // The Claude pack (DR-050): the runner reads it read-only and points CLAUDE_CODE_EXECUTABLE at it.
      `BOSSMAN_CLAUDE_PACK=${CLAUDE_PACK_TARGET}`,
      ...(plan.slots > 1 ? [`BOSSMAN_CHECK_SLOTS=${plan.slots}`] : []),
      ...(cfg.opencodeSessionDays !== undefined ? [`BOSSMAN_OPENCODE_SESSION_DAYS=${cfg.opencodeSessionDays}`] : []),
      ...(cfg.pnpmStoreDir ? [`PNPM_STORE_DIR=${cfg.pnpmStoreDir}`] : []),
      // The runner has no Docker socket; it reports these with its kernel as the platform fingerprint (DR-049 point 1).
      ...(host ? [`BOSSMAN_HOST_DOCKER=${host.dockerVersion}`, `BOSSMAN_HOST_OS=${host.osType}`] : []),
    ],
    Labels: { [LABEL]: "1", [COMPANY_LABEL]: slug, ...stackLabels(cfg.stack) },
    HostConfig: {
      Binds: [...MOUNTS.map(([sub, target]) => `${path.join(dir, sub)}:${target}`), `${path.join(dir, "runner.token")}:${TOKEN_TARGET}:ro`, `${claudePackVolume(cfg.stack)}:${CLAUDE_PACK_TARGET}:ro`],
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      PidsLimit: cfg.pidsLimit,
      // An init as PID 1 reaps the zombies agents' tools leave, which would otherwise fill the pid limit.
      Init: true,
      Memory: plan.memoryBytes,
      // No swap on top of the limit, and the first to be killed if the host itself runs out (BOS-395).
      MemorySwap: plan.memoryBytes,
      OomScoreAdj: 500,
      LogConfig: LOG_CONFIG,
      // Priority, not a cap (BOS-412): when the host is busy the server and database win; when idle, runners use every core.
      CpuShares: cfg.cpuShares ?? DEFAULT_CPU_SHARES,
      // A core kept back for the server, database and proxy (BOS-586): runners never run on the reserved threads.
      ...(cfg.cpuset ? { CpusetCpus: cfg.cpuset } : {}),
      ...(cfg.cpus ? { NanoCpus: Math.round(cfg.cpus * 1e9) } : {}),
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}

/** "4g", "512m" or bytes, as in compose's mem_limit. */
export function parseMemory(v: string | undefined, fallback = 4 * 1024 ** 3): number {
  if (!v) return fallback;
  const m = /^(\d+)([kmg]?)b?$/i.exec(v.trim());
  if (!m) throw new Error(`BOSSMAN_RUNNER_MEMORY should look like 4g or 512m, not ${v}`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  return Number(m[1]) * unit;
}

/** A positive whole number of processes and threads, as in compose's pids_limit. */
export function parsePids(v: string | undefined, fallback = 4096): number {
  if (!v) return fallback;
  if (!/^\d+$/.test(v.trim()) || Number(v) < 64) throw new Error(`BOSSMAN_RUNNER_PIDS should be a whole number of at least 64, not ${v}`);
  return Number(v);
}

/** How many full checks may run at once: a whole number from 1 to 16 (unset = 1). */
export function parseCheckSlots(v: string | undefined): number {
  if (!v || v.trim() === "") return 1;
  if (!/^\d{1,2}$/.test(v.trim()) || Number(v) < 1 || Number(v) > 16) throw new Error(`BOSSMAN_CHECK_SLOTS should be a whole number from 1 to 16, not ${v}`);
  return Number(v);
}

/** Days an OpenCode session is kept on a runner: a whole number from 0 (never delete) to 3650; unset = the runner's default. */
export function parseOpencodeSessionDays(v: string | undefined): number | undefined {
  if (!v || v.trim() === "") return undefined;
  if (!/^\d{1,4}$/.test(v.trim()) || Number(v) > 3650) throw new Error(`BOSSMAN_OPENCODE_SESSION_DAYS should be a whole number of days from 0 to 3650, not ${v}`);
  return Number(v);
}

/** The only writable volume a runner keeps between restarts, where the shared pnpm store must live. */
const WORKSPACES_MOUNT = MOUNTS.find(([sub]) => sub === "workspaces")![1];

/**
 * The shared pnpm store's path inside the runner (BOS-568). Empty means the workspaces volume's .pnpm-store,
 * which every host has. A set value must be a folder under the workspaces volume: the volume's root itself is
 * refused, because the fence would then grant agents the whole volume (other agents' copies, the merge gate's
 * results) and the merge gate's store (<dir>-gate) would land on the runner's root disk (BOS-633).
 */
export function parsePnpmStoreDir(v: string | undefined): string | undefined {
  const p = (v ?? "").trim();
  if (!p) return undefined;
  if (!p.startsWith("/") || p.includes("\0") || p.split("/").includes("..")) throw new Error(`PNPM_STORE_DIR should be an absolute path inside the runner, like ${WORKSPACES_MOUNT}/.pnpm-store, not ${v}`);
  const resolved = path.posix.normalize(p).replace(/\/+$/, "") || "/";
  if (resolved === WORKSPACES_MOUNT) throw new Error(`PNPM_STORE_DIR must be a folder under ${WORKSPACES_MOUNT}, not the volume's root itself (the fence would grant the whole volume), like ${WORKSPACES_MOUNT}/.pnpm-store`);
  if (!resolved.startsWith(`${WORKSPACES_MOUNT}/`)) throw new Error(`PNPM_STORE_DIR must be under ${WORKSPACES_MOUNT} (the runner's only writable volume), not ${v}`);
  return resolved;
}

/** A CPU weight from 2 to 262144, as in compose's cpu_shares. */
export function parseCpuShares(v: string | undefined, fallback = DEFAULT_CPU_SHARES): number {
  if (!v || !v.trim()) return fallback;
  if (!/^\d+$/.test(v.trim()) || Number(v) < 2 || Number(v) > 262144) throw new Error(`BOSSMAN_RUNNER_CPU_SHARES should be a whole number from 2 to 262144, not ${v}`);
  return Number(v);
}

/** A hard CPU cap such as 4 or 1.5, as in compose's cpus. Empty or 0 means no cap. */
/** 0 or empty = no cap. Docker rejects less than 0.01 CPU, so that is refused up front. */
export function parseCpus(v: string | undefined): number | undefined {
  if (!v || !v.trim()) return undefined;
  const n = Number(v.trim());
  if (!/^\d+(\.\d+)?$/.test(v.trim()) || !Number.isFinite(n) || n > 1024 || (n !== 0 && n < 0.01)) throw new Error(`BOSSMAN_RUNNER_CPUS should be a number of CPUs such as 4 or 1.5, not ${v}`);
  return n === 0 ? undefined : n;
}

/** host:port of the server in a runner URL such as ws://server:3100/api/runner/connect. */
export function serverAddress(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.hostname}:${u.port || (u.protocol === "wss:" || u.protocol === "https:" ? "443" : "80")}`;
}

/**
 * The Docker create request for a runner's network guard. It shares the runner's network
 * namespace, so the rules it installs bind every process in the runner; the runner itself keeps
 * no capability. Snapshot-tested.
 */
export function netguardSpec(cfg: LauncherConfig, slug: string, runnerId: string) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runnerId)) throw new Error("bad runner id");
  return {
    Image: guardImageOf(cfg),
    Env: [`NETGUARD_ALLOW=${serverAddress(cfg.serverUrl)}`, ...(cfg.guardAllow?.length ? [`NETGUARD_EXTRA=${cfg.guardAllow.join(" ")}`] : [])],
    // Healthy once the table is loaded: the launcher waits for it before it counts the runner as guarded.
    Healthcheck: { Test: ["CMD", "nft", "list", "table", "inet", "bossman_netguard"], Interval: 1_000_000_000, Timeout: 3_000_000_000, Retries: 3 },
    Labels: { [NETGUARD_LABEL]: "1", [COMPANY_LABEL]: slug, ...stackLabels(cfg.stack) },
    HostConfig: {
      Binds: [`${path.join(hostCompanyDir(cfg, slug), "netguard")}:/etc/netguard:ro`],
      NetworkMode: `container:${runnerId}`,
      CapDrop: ["ALL"],
      CapAdd: ["NET_ADMIN"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      PidMode: "",
      IpcMode: "private",
      ReadonlyRootfs: true,
      PidsLimit: 32,
      Memory: 64 * 1024 ** 2,
      RestartPolicy: { Name: "no" },
    },
  };
}
