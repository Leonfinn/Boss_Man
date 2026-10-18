// The one container the launcher knows how to make (R55). Nothing here comes from a request:
// the slug picks the company's folder and the container's name, and everything else is fixed
// or set by the launcher's own environment when it starts.
import path from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The runner image. The launcher never pulls: scripts/update-runner.sh builds and tags it. */
export const IMAGE = "boss-man-runner:current";
export const LABEL = "boss-man.launcher";
export const COMPANY_LABEL = "boss-man.company";
/** The folders a runner keeps between restarts, and where the runner sees them. */
export const MOUNTS = [
  ["workspaces", "/home/node/workspaces"],
  ["runner-data", "/home/node/runner-data"],
  ["claude", "/home/node/.claude"],
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
};

export const containerName = (slug: string) => `boss-man-runner-${slug}`;
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
      PidsLimit: 1024,
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
