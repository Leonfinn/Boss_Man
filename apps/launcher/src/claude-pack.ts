// The Claude pack installer (DR-050, BOS-972): before a runner starts, the launcher runs the runner image
// once more as a one-shot container that installs Claude Code into the bossman-claude named volume and marks
// it ready. The runner then mounts that volume read-only. If the installer fails (no internet, npm down), the
// runner still starts and reports Claude absent: OpenCode and Codex keep working. Nothing here is a bypass:
// the installer holds no extra capability and mounts no company data, only the shared pack volume.
import { type Docker } from "./docker.js";
import { CLAUDE_PACK_TARGET, LOG_CONFIG, claudePackVolume, runnerImage, type LauncherConfig } from "./spec.js";

/** Where the runner image copies the pinned package.json and lockfile (root-owned). */
export const PACK_SOURCE = "/opt/bossman-claude-pack";
/** Where the installer (and the runner, read-only) mounts the named volume. */
export const PACK_ROOT = CLAUDE_PACK_TARGET;

/**
 * The named volume holding the pack, stack-scoped so two stacks on a host don't share one (BOS-69).
 * Docker creates it on first mount, so there is no volume-create call to fail.
 */
export const packVolume = (stack?: string) => claudePackVolume(stack);
/** The one-shot installer container's name, stack- and company-scoped like the runner's. */
export const packContainerName = (slug: string, stack?: string) => `${stack ? `boss-man-${stack}` : "boss-man"}-claude-pack-${slug}`;

/** How long the installer may run before the launcher gives up on it (npm ci is slow on a fresh volume). */
export const PACK_INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * The Docker create request for the one-shot installer. It runs the runner image's own installer command,
 * mounts the pack volume read-write (the only thing it writes) and the image's pinned source read-only from
 * the image itself. It joins the stack network so npm ci can reach the registry (honouring a proxy/extra CA
 * the network already provides), and holds no capability. Snapshot-tested: change it on purpose only.
 */
export function packInstallerSpec(cfg: LauncherConfig, slug: string) {
  return {
    Image: runnerImage(cfg.stack),
    User: "1000:1000",
    Cmd: ["node_modules/.bin/tsx", "src/claude-pack-main.ts"],
    Env: [`BOSSMAN_CLAUDE_PACK=${PACK_ROOT}`, `BOSSMAN_CLAUDE_PACK_SOURCE=${PACK_SOURCE}`],
    Labels: { "boss-man.claude-pack": "1", "boss-man.company": slug, ...(cfg.stack ? { "boss-man.stack": cfg.stack } : {}) },
    HostConfig: {
      // A named volume: Docker makes it on first mount. No host folder is exposed, so no company data is.
      Mounts: [{ Type: "volume", Source: packVolume(cfg.stack), Target: PACK_ROOT }],
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Devices: [],
      PidMode: "",
      IpcMode: "private",
      Init: true,
      // Smaller than a runner: npm ci needs a couple of GB, not a runner's whole budget.
      Memory: Math.min(cfg.memoryBytes, 2 * 1024 ** 3),
      PidsLimit: 512,
      LogConfig: LOG_CONFIG,
      RestartPolicy: { Name: "no" },
    },
  };
}

/**
 * The install in flight per stack, so all companies on one host share ONE install of the shared pack
 * volume (BOS-972, Dougal/Freddy): two installer containers writing the same content-addressed folder
 * would wipe each other's half-done `npm ci` and can delete a finished pack a runner has mounted. The
 * second caller waits for the first and shares its result instead of starting another install.
 */
const installs = new Map<string, Promise<boolean>>();

/**
 * Runs the installer to make the pack ready, if it isn't already (the installer exits 0 at once for a ready
 * folder, so calling it on every create is cheap). Returns whether a ready pack is there afterwards: true on
 * exit 0, false on any failure, which the caller treats as "Claude absent", never as a reason to refuse the
 * runner. A failure is logged so the owner can see why Claude isn't available.
 *
 * Serialised per stack: one install at a time for the shared volume, however many companies start together.
 */
export function ensurePack(docker: Docker, cfg: LauncherConfig, slug: string, log: (msg: string) => void = () => {}): Promise<boolean> {
  const key = cfg.stack ?? "";
  const busy = installs.get(key);
  if (busy) return busy;
  const run = installPack(docker, cfg, slug, log).finally(() => installs.delete(key));
  installs.set(key, run);
  return run;
}

async function installPack(docker: Docker, cfg: LauncherConfig, slug: string, log: (msg: string) => void): Promise<boolean> {
  const name = packContainerName(slug, cfg.stack);
  // A leftover installer from a crash would clash on the name: remove it first (it holds nothing worth keeping).
  const old = await docker.inspect(name).catch(() => null);
  if (old) await docker.remove(old.Id).catch(() => undefined);
  let id: string;
  try {
    id = await docker.create(name, packInstallerSpec(cfg, slug));
  } catch (err) {
    log(`the Claude pack installer couldn't start for ${slug}: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
  try {
    await docker.start(id);
    const { stopped, exitCode } = await docker.wait(id, PACK_INSTALL_TIMEOUT_MS);
    if (!stopped) {
      log(`the Claude pack installer for ${slug} didn't finish in ${Math.round(PACK_INSTALL_TIMEOUT_MS / 60_000)} minutes; Claude will be absent until it can.`);
      return false;
    }
    if (exitCode !== 0) {
      log(`the Claude pack installer for ${slug} exited ${exitCode ?? "unknown"}; Claude will be absent until it can install (see \`docker logs ${name}\`).`);
      return false;
    }
    return true;
  } catch (err) {
    log(`the Claude pack installer for ${slug} failed: ${String((err as Error)?.message ?? err)}`);
    return false;
  } finally {
    // The one-shot container's job is done; its exit code is already read. Removal never fails the runner.
    await docker.remove(id).catch(() => undefined);
  }
}
