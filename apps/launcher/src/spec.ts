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
};

export const containerName = (slug: string) => `boss-man-runner-${slug}`;
export const netguardName = (slug: string) => `boss-man-netguard-${slug}`;
export const companyDir = (cfg: LauncherConfig, slug: string) => path.join(cfg.dataRoot, "companies", slug);
export const tokenFile = (cfg: LauncherConfig, slug: string) => path.join(companyDir(cfg, slug), "runner.token");

/** The Docker create request for a company's runner. Snapshot-tested: change it on purpose only. */
export function containerSpec(cfg: LauncherConfig, slug: string) {
  if (!SLUG.test(slug)) throw new Error("bad slug");
  if (cfg.network === "host" || cfg.network === "none" || cfg.network.startsWith("container:")) throw new Error("bad network");
  const dir = companyDir(cfg, slug);
  return {
    Image: IMAGE,
    User: "1000:1000",
    Env: [`BOSSMAN_URL=${cfg.serverUrl}`, `BOSSMAN_RUNNER_TOKEN_FILE=${TOKEN_TARGET}`],
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
    Env: [`NETGUARD_ALLOW=${serverAddress(cfg.serverUrl)}`],
    Labels: { [NETGUARD_LABEL]: "1", [COMPANY_LABEL]: slug },
    HostConfig: {
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
