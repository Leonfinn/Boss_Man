// Installs the new release's Claude pack before anything is swapped (design section 4): a one-shot container from the NEW
// runner image runs the runner's own installer against the pack volume, which writes /opt/bossman-claude/<hash> beside the
// old folder. The updater compares that folder's hash with the signed packHash. Not ready, a different hash, a non-zero exit or
// a timeout aborts here, before any create or alias call for the new release, so nothing live has changed.
import { UpdaterError, type Config } from "./config.js";
import type { Docker } from "./docker.js";
import { PACK_HASH_RE } from "./schema.js";

export const PACK_ROOT = "/opt/bossman-claude";
export const PACK_LABEL = "boss-man.updater-pack";

/** The installer container's spec: the runner image's own installer, one volume, no capability, no secret, no host folder. */
export function packInstallerSpec(cfg: Pick<Config, "installLabel" | "packVolume" | "network">, runnerRef: string) {
  const [key = "", value = ""] = cfg.installLabel.split("=", 2);
  return {
    Image: runnerRef,
    User: "1000:1000",
    Cmd: ["node_modules/.bin/tsx", "src/claude-pack-main.ts"],
    Env: [`BOSSMAN_CLAUDE_PACK=${PACK_ROOT}`, "BOSSMAN_CLAUDE_PACK_SOURCE=/opt/bossman-claude-pack"],
    Labels: { [key]: value, [PACK_LABEL]: "1" },
    HostConfig: {
      Mounts: [{ Type: "volume", Source: cfg.packVolume, Target: PACK_ROOT }],
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      PidMode: "",
      IpcMode: "private",
      Init: true,
      Memory: 2 * 1024 ** 3,
      PidsLimit: 512,
      RestartPolicy: { Name: "no" },
    },
  };
}

export type PackOptions = { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };

const fail = (code: string, what: string): never => {
  throw new UpdaterError(code, `${what} The install stays on its current release; nothing was changed.`);
};

/** The folder the installer reports ("[claude-pack] ready: /opt/bossman-claude/<24 hex> (Claude Code x)"), or null. */
export function readyFolder(logs: string): string | null {
  const m = /\[claude-pack\] ready: \/opt\/bossman-claude\/([0-9a-f]{24})(?:\s|$)/.exec(logs);
  return m?.[1] ?? null;
}

export async function installPack(docker: Docker, cfg: Pick<Config, "installLabel" | "packVolume" | "network" | "namePrefix">, runnerRef: string, packHash: string | null, opts: PackOptions): Promise<void> {
  if (!packHash || !PACK_HASH_RE.test(packHash)) return fail("pack_unknown", "This release does not say which Claude pack it needs (its release.json has no packHash).");
  const name = `${cfg.namePrefix}-pack`;
  // A leftover installer from a crash would clash on the name; it holds nothing worth keeping.
  await docker.remove(name);
  let id: string;
  try {
    id = await docker.create(name, packInstallerSpec(cfg, runnerRef));
  } catch (e) {
    if (e instanceof UpdaterError) throw e;
    return fail("pack_not_ready", `The Claude pack installer could not be created (${e instanceof Error ? e.message : "unknown error"}).`);
  }
  try {
    await docker.start(id);
    const { stopped, exitCode } = await docker.wait(id, opts.timeoutMs, opts.pollMs ?? 2_000, opts.sleep, opts.now);
    if (!stopped) return fail("pack_timeout", `The Claude pack did not finish installing in ${Math.round(opts.timeoutMs / 60_000)} minutes.`);
    const logs = await docker.logs(id).catch(() => "");
    if (exitCode !== 0) return fail("pack_not_ready", `The Claude pack could not be installed (the installer stopped with code ${exitCode ?? "unknown"}).`);
    const folder = readyFolder(logs);
    if (!folder) return fail("pack_not_ready", "The Claude pack installer finished but did not say its pack is ready.");
    if (folder !== packHash) return fail("pack_mismatch", "The Claude pack that was installed is not the one the signed release names.");
  } finally {
    await docker.remove(id).catch(() => undefined);
  }
}
