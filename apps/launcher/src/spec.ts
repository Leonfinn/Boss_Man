// The one container the launcher knows how to make (R55). Nothing here comes from a request:
// the slug picks the company's folder and the container's name, and everything else is fixed
// or set by the launcher's own environment when it starts.
import path from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The runner image. The launcher never pulls: scripts/update-runner.sh builds and tags it. */
export const IMAGE = "boss-man-runner:current";
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
export const TOKEN_TARGET = "/run/secrets/runner_token";
/** Docker's default weight is 1024; runners get half, so the server and database win on a busy host. */
export const DEFAULT_CPU_SHARES = 512;

export type LauncherConfig = {
  /** BOSSMAN_DATA: the host folder, mounted at the same path in the launcher, so binds name real host paths. */
  dataRoot: string;
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
  /** BOSSMAN_NETGUARD: "auto" (default) guards every runner, and lets a host that can't run the guard go without; "enforce" refuses runners there; "off" never guards. */
  guardMode?: GuardMode;
  /** BOSSMAN_NETGUARD_ALLOW: extra host:port entries every runner may reach on the private networks. */
  guardAllow?: string[];
  /** BOSSMAN_CHECK_SLOTS: full checks (merge gate and hand runs) a runner may run at once, 1 to 16. Unset = 1; the runner needs about 3 GB of its memory limit per extra slot. */
  checkSlots?: number;
  /** BOSSMAN_OPENCODE_SESSION_DAYS: the runner deletes OpenCode sessions untouched this many days (BOS-616). Unset = the runner's default (14); 0 = never. */
  opencodeSessionDays?: number;
  /** How long to wait for a new guard to load its rules (default 20 s). */
  guardReadyMs?: number;
};

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

export const containerName = (slug: string) => `boss-man-runner-${slug}`;
export const netguardName = (slug: string) => `boss-man-netguard-${slug}`;
export const companyDir = (cfg: LauncherConfig, slug: string) => path.join(cfg.dataRoot, "companies", slug);
/** Where the launcher keeps a company's tool-server allow list; only the guard (read-only) mounts it, never the runner. */
export const netguardDir = (cfg: LauncherConfig, slug: string) => path.join(companyDir(cfg, slug), "netguard");
export const tokenFile = (cfg: LauncherConfig, slug: string) => path.join(companyDir(cfg, slug), "runner.token");

/** The Docker create request for a company's runner. Snapshot-tested: change it on purpose only. */
export function containerSpec(cfg: LauncherConfig, slug: string) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  if (cfg.network === "host" || cfg.network === "none" || cfg.network.startsWith("container:")) throw new Error("bad network");
  const dir = companyDir(cfg, slug);
  return {
    Image: IMAGE,
    User: "1000:1000",
    Env: [`BOSSMAN_URL=${cfg.serverUrl}`, `BOSSMAN_RUNNER_TOKEN_FILE=${TOKEN_TARGET}`, ...(cfg.checkSlots && cfg.checkSlots > 1 ? [`BOSSMAN_CHECK_SLOTS=${cfg.checkSlots}`] : []), ...(cfg.opencodeSessionDays !== undefined ? [`BOSSMAN_OPENCODE_SESSION_DAYS=${cfg.opencodeSessionDays}`] : [])],
    Labels: { [LABEL]: "1", [COMPANY_LABEL]: slug },
    HostConfig: {
      Binds: [...MOUNTS.map(([sub, target]) => `${path.join(dir, sub)}:${target}`), `${tokenFile(cfg, slug)}:${TOKEN_TARGET}:ro`],
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
      Memory: cfg.memoryBytes,
      // No swap on top of the limit, and the first to be killed if the host itself runs out (BOS-395).
      MemorySwap: cfg.memoryBytes,
      OomScoreAdj: 500,
      // Priority, not a cap (BOS-412): when the host is busy the server and database win; when idle, runners use every core.
      CpuShares: cfg.cpuShares ?? DEFAULT_CPU_SHARES,
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
    Image: NETGUARD_IMAGE,
    Env: [`NETGUARD_ALLOW=${serverAddress(cfg.serverUrl)}`, ...(cfg.guardAllow?.length ? [`NETGUARD_EXTRA=${cfg.guardAllow.join(" ")}`] : [])],
    // Healthy once the table is loaded: the launcher waits for it before it counts the runner as guarded.
    Healthcheck: { Test: ["CMD", "nft", "list", "table", "inet", "bossman_netguard"], Interval: 1_000_000_000, Timeout: 3_000_000_000, Retries: 3 },
    Labels: { [NETGUARD_LABEL]: "1", [COMPANY_LABEL]: slug },
    HostConfig: {
      Binds: [`${netguardDir(cfg, slug)}:/etc/netguard:ro`],
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
