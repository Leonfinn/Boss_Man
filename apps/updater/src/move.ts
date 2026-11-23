// One move, as far as 941a goes: verify the signed release, pull every image by digest, install the Claude pack, and stop at
// `ready-to-swap` (the swap itself is 941b). Every image reference comes from the verified release.json, never the request.
import { UpdaterError, type Config } from "./config.js";
import type { Docker } from "./docker.js";
import { installPack, type PackOptions } from "./pack.js";
import { imageRef, pullByDigest, type PullOptions } from "./pull.js";
import { getVerifiedRelease, type ReleaseDeps } from "./release.js";
import { compareVersions, IMAGE_NAMES, type Instruction } from "./schema.js";
import type { StateStore } from "./state.js";

export type MoveDeps = { cfg: Config; docker: Docker; state: StateStore; release?: ReleaseDeps; pull?: Partial<PullOptions>; pack?: Partial<PackOptions> };

export async function runMove(deps: MoveDeps, ins: Instruction): Promise<void> {
  const { cfg, docker, state } = deps;
  try {
    // Going to the same or an older release is refused (the standby colour's release is the one exception, added in 941b).
    if (compareVersions(ins.version, cfg.currentVersion) <= 0) {
      throw new UpdaterError(compareVersions(ins.version, cfg.currentVersion) === 0 ? "already_current" : "downgrade", compareVersions(ins.version, cfg.currentVersion) === 0 ? `This install already runs ${ins.version}.` : `${ins.version} is older than the release this install runs (${cfg.currentVersion}), so the move was refused.`);
    }
    const release = await getVerifiedRelease(cfg, ins.version, deps.release);
    const server = release.images["boss-man-server"];
    if (!server || server.digest !== ins.serverDigest) throw new UpdaterError("not_published", "The server image named in the request is not the one this signed release publishes, so the move was refused.");
    if (release.missing.length > 0) throw new UpdaterError("incomplete_release", `This release does not list every image the updater needs (missing: ${release.missing.join(", ")}), so the move was refused.`);
    state.update({ stage: "pulling" });
    // The updater is replaced last and only by the swap (941b), but it is pulled now with the rest so a failed pull stops everything early.
    for (const name of IMAGE_NAMES) {
      const img = release.images[name]!;
      await pullByDigest(docker, cfg.registry, name, img.digest, { arch: cfg.arch, ...deps.pull });
    }
    state.update({ stage: "installing-pack" });
    const runner = release.images["boss-man-runner"]!;
    await installPack(docker, cfg, imageRef(cfg.registry, runner.name, runner.digest), release.packHash, { timeoutMs: cfg.packTimeoutMs, ...deps.pack });
    state.update({ stage: "ready-to-swap", report: { level: "info", text: `Release ${ins.version} is verified, downloaded and its Claude pack is installed. It is ready to switch to.`, at: new Date().toISOString(), acknowledged: false } });
  } catch (e) {
    const err = e instanceof UpdaterError ? e : new UpdaterError("move_failed", "The update stopped because of an unexpected problem. Nothing was changed.");
    state.fail(err);
  }
}

/**
 * Run once at start-up. A move found in a running stage means the updater was restarted in the middle of it: the one-shot pack
 * installer (if it is still around) is removed and the move is marked failed with a plain reason, so the server can start it again.
 * Nothing live was changed by any stage before the swap, so cleaning up is all that is needed.
 */
export async function recover(deps: Pick<MoveDeps, "cfg" | "docker" | "state">): Promise<void> {
  const s = deps.state.load();
  if (s.stage !== "verifying" && s.stage !== "pulling" && s.stage !== "installing-pack") return;
  await deps.docker.remove(`${deps.cfg.namePrefix}-pack`).catch(() => undefined);
  deps.state.fail(new UpdaterError("interrupted", "The updater was restarted in the middle of the update, so it stopped. Nothing was changed; the update can be started again."));
}
