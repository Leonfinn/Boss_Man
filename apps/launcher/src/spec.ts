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
 * A runner's memory: this much for everything the company's agents run at once (they all live in the one runner; the live runner
 * needed 16 GB with one check slot), plus one allowance per check slot (a full check peaks at about 3 GB).
 * So 1 slot = 16 GB, 2 = 19 GB, 3 = 22 GB (13 GB plus 3 GB a slot). It is always cut down to what the host has (see HOST_RESERVE_BYTES).
 */
export const RUNNER_BASE_BYTES = 13 * GIB;
export const RUNNER_PER_SLOT_BYTES = 3 * GIB;
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
};

const gb = (b: number) => `${Math.round((b / GIB) * 10) / 10} GB`;

/**
 * The runner's check slots and memory (BOS-993). The setting drives both; .env values are upper bounds and the host's
 * memory limits what fits. With no setting pushed yet the .env values apply as before.
 */
export function planChecks(cfg: LauncherConfig): ChecksPlan {
  if (cfg.requestedSlots === undefined) return { requested: null, slots: cfg.checkSlots ?? 1, memoryBytes: cfg.memoryBytes, reason: null };
  const want = cfg.requestedSlots;
  const hostCeiling = cfg.hostMemoryBytes ? Math.max(cfg.hostMemoryBytes - HOST_RESERVE_BYTES, RUNNER_MIN_BYTES) : Infinity;
  const ceiling = Math.max(Math.min(cfg.envMemoryCap ?? Infinity, hostCeiling), RUNNER_MIN_BYTES);
  const fits = Number.isFinite(ceiling) ? Math.max(1, Math.floor((ceiling - RUNNER_BASE_BYTES) / RUNNER_PER_SLOT_BYTES)) : Infinity;
  const slots = Math.min(want, cfg.envSlotsCap ?? Infinity, fits);
  const memoryBytes = Math.min(RUNNER_BASE_BYTES + RUNNER_PER_SLOT_BYTES * slots, ceiling);
  let reason: string | null = null;
  if (slots < want) {
    if (cfg.envSlotsCap !== undefined && slots === cfg.envSlotsCap) reason = `The host's .env caps it at ${slots} (BOSSMAN_CHECK_SLOTS).`;
    else if (cfg.envMemoryCap !== undefined && slots === fits && cfg.envMemoryCap <= hostCeiling) reason = `The host's .env caps runner memory at ${gb(cfg.envMemoryCap)} (BOSSMAN_RUNNER_MEMORY), which fits ${slots}.`;
    else reason = `Not enough free memory for ${want}: this host has ${cfg.hostMemoryBytes ? gb(cfg.hostMemoryBytes) : "too little"}, which fits ${slots}.`;
  }
  return { requested: want, slots, memoryBytes, reason };
}

/** The Docker create request for a company's runner. Snapshot-tested: change it on purpose only. */
export function containerSpec(cfg: LauncherConfig, slug: string, image?: string) {
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
