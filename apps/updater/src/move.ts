// One move: verify the signed release, pull every image by digest, install the Claude pack, and (when the install defines the swap's
// names, 941b) back up, migrate, bring up the idle colour, hand over, flip, soak, and stop the old colour as the standby; the updater
// replaces itself last (section 8). Without the swap settings a move stops at `ready-to-swap`, as 941a did. Every image reference
// comes from the verified release.json, never the request.
import { UpdaterError, type Config } from "./config.js";
import type { Docker } from "./docker.js";
import { moveHelpers } from "./helpers.js";
import { installPack, type PackOptions } from "./pack.js";
import { imageRef, pullByDigest, type PullOptions } from "./pull.js";
import { getVerifiedRelease, type ReleaseDeps } from "./release.js";
import { compareVersions, IMAGE_NAMES, type Instruction } from "./schema.js";
import { NEXT_SUFFIX, selfUpdate, type HandoverGate } from "./selfupdate.js";
import { checkLayout, colourName, frontAlias, LAYOUT, otherColour } from "./spec.js";
import type { StateStore } from "./state.js";
import { type Colours, digestOf, findColours, flipAlias, isSwap, liveColour, releaseOf, removeNewColour, soakAndFinish, switchBack, waitReady, runSwap, type Clock, type Probe, type SwapDeps } from "./swap.js";

export type MoveDeps = {
  cfg: Config;
  docker: Docker;
  state: StateStore;
  release?: ReleaseDeps;
  pull?: Partial<PullOptions>;
  pack?: Partial<PackOptions>;
  /** Tests: a virtual clock, a fake /api/ready, and what the updater does when the new updater has taken over. */
  clock?: Clock;
  probe?: Probe;
  gate?: HandoverGate;
  /** Tests: whether the launcher reports a run starting (GET /busy). */
  launcherBusy?: () => Promise<boolean>;
};

/** The release the install runs now: the live colour's label once a swap has run, else what was last recorded, else the setting. */
export async function currentVersion(deps: MoveDeps): Promise<string> {
  const { cfg, docker, state } = deps;
  if (isSwap(deps)) {
    const cols = await findColours(docker).catch((): Colours => ({}));
    const live = liveColour(cols, cfg.swap!.frontNetwork);
    const label = live ? releaseOf(cols[live]) : null;
    if (label) return label;
  }
  return state.get().currentVersion ?? cfg.currentVersion;
}

export async function runMove(deps: MoveDeps, ins: Instruction): Promise<void> {
  const { cfg, docker, state } = deps;
  try {
    const current = await currentVersion(deps);
    const cmp = compareVersions(ins.version, current);
    let restore = false;
    if (cmp === 0) throw new UpdaterError("already_current", `This install already runs ${ins.version}.`);
    if (cmp < 0) {
      // Downgrade defence: the only older release accepted is the one the standby colour is labelled with (section 7).
      if (isSwap(deps)) {
        const cols = await findColours(docker);
        const live = liveColour(cols, cfg.swap!.frontNetwork);
        const standby = live ? cols[otherColour(live)] : undefined;
        restore = !!standby && !standby.State.Running && releaseOf(standby) === ins.version && digestOf(standby) === ins.serverDigest;
      }
      if (!restore) throw new UpdaterError("downgrade", `${ins.version} is older than the release this install runs (${current}), so the move was refused.`);
    }
    const release = await getVerifiedRelease(cfg, ins.version, deps.release);
    const server = release.images["boss-man-server"];
    if (!server || server.digest !== ins.serverDigest) throw new UpdaterError("not_published", "The server image named in the request is not the one this signed release publishes, so the move was refused.");
    if (release.missing.length > 0) throw new UpdaterError("incomplete_release", `This release does not list every image the updater needs (missing: ${release.missing.join(", ")}), so the move was refused.`);
    if (!restore) {
      state.update({ stage: "pulling" });
      for (const name of IMAGE_NAMES) {
        const img = release.images[name]!;
        await pullByDigest(docker, cfg.registry, name, img.digest, { arch: cfg.arch, ...deps.pull });
      }
    }
    if (isSwap(deps) && release.installLayout !== null && release.installLayout > LAYOUT) {
      // A newer layout than this updater builds: update the updater first, which carries the move on (section 8), else refuse.
      if ((await selfUpdate(deps, release, { version: ins.version, serverDigest: ins.serverDigest })) === "handed-over") return;
      if (state.get().stage !== "failed") checkLayout(release.installLayout);
      return;
    }
    if (isSwap(deps)) checkLayout(release.installLayout);
    if (!restore) {
      state.update({ stage: "installing-pack" });
      const runner = release.images["boss-man-runner"]!;
      await installPack(docker, cfg, imageRef(cfg.registry, runner.name, runner.digest), release.packHash, { timeoutMs: cfg.packTimeoutMs, ...deps.pack });
    }
    if (!isSwap(deps)) {
      state.update({ stage: "ready-to-swap", report: { level: "info", text: `Release ${ins.version} is verified, downloaded and its Claude pack is installed. It is ready to switch to.`, at: new Date().toISOString(), acknowledged: false } });
      return;
    }
    state.update({ restore });
    await runSwap(deps, release, ins, restore);
    // BOS-1227: the whole release moves once the server is done and soaked. A rolled-back or restore move never writes release-current.
    if (state.get().stage === "done" && !restore) {
      const moved = await moveHelpers(deps, release);
      if (moved === "pending") state.update({ report: { level: "problem", text: `Updated to ${ins.version}. ${state.get().helpers.note ?? ""}`.trim(), at: new Date().toISOString(), acknowledged: false } });
      await selfUpdate(deps, release, null);
    }
  } catch (e) {
    const err = e instanceof UpdaterError ? e : new UpdaterError("move_failed", "The update stopped because of an unexpected problem. The version that was serving keeps serving.");
    state.fail(err);
  }
}

/**
 * Run once at start-up. A move found in a running stage means the updater was restarted in the middle of it (design test 9):
 *  - before anything live changed (verify to hand-over): what the move made is removed, the live colour leads, the move is failed;
 *  - flipping: finished forward if the new colour answers as the leader at the release's commit, else switched back;
 *  - soaking / stopping-old: carried on from the saved deadline, in the background (the returned promise);
 *  - updating-updater: the half-made `updater-next` is removed and the notice recorded.
 * The live colour is never removed, and the stopped standby is never started.
 */
export async function recover(deps: MoveDeps): Promise<Promise<void> | null> {
  const { cfg, docker, state } = deps;
  const s = state.load();
  const interrupted = () => state.fail(new UpdaterError("interrupted", "The updater was restarted in the middle of the update, so it stopped. The version that was serving keeps serving; the update can be started again."));
  if (s.stage === "verifying" || s.stage === "pulling" || s.stage === "installing-pack") {
    await docker.remove(`${cfg.namePrefix}-pack`).catch(() => undefined);
    state.fail(new UpdaterError("interrupted", "The updater was restarted in the middle of the update, so it stopped. Nothing was changed; the update can be started again."));
    return null;
  }
  if (!isSwap(deps) || !s.live || !s.idle) {
    if (s.stage !== "idle" && s.stage !== "done" && s.stage !== "failed" && s.stage !== "rolled-back" && s.stage !== "ready-to-swap") interrupted();
    return null;
  }
  const d: SwapDeps = deps;
  const live = s.live;
  const idle = s.idle;
  if (s.stage === "backing-up" || s.stage === "migrating" || s.stage === "starting-colour" || s.stage === "handing-over") {
    const cols = await findColours(docker);
    if (s.restore) await docker.stop(colourName(idle), d.cfg.swap.stopGraceSeconds).catch(() => undefined);
    else if (s.stage === "backing-up" || s.stage === "migrating") {
      // The idle colour here is still the previous release's stopped standby (the rollback target): only the migrate one-shot is ours.
      await docker.remove(`${cfg.namePrefix}-migrate`).catch(() => undefined);
    } else if (cols[idle] && releaseOf(cols[idle]) === s.version) await removeNewColour(d, idle);
    else await docker.remove(`${cfg.namePrefix}-migrate`).catch(() => undefined);
    const liveInfo = cols[live];
    if (liveInfo?.State.Running) await docker.signal(colourName(live), "SIGUSR2").catch(() => undefined);
    interrupted();
    return null;
  }
  const commit = s.commit;
  if (s.stage === "flipping") {
    const cols = await findColours(docker);
    const newOk = !!cols[idle]?.State.Running && !!commit && (await waitReady(d, frontAlias(idle), "leader", commit, 5));
    if (newOk) {
      await flipAlias(d, idle, live).catch(() => undefined);
      state.update({ stage: "soaking", soakUntil: new Date((d.clock?.now() ?? Date.now()) + d.cfg.swap.soakSeconds * 1000).toISOString() });
      return soakAndFinish(d, live, idle, commit!, s.version ?? "the new version").then(() => undefined);
    }
    const back = await switchBack(d, live, idle);
    state.finish("rolled-back", back ? "The updater was restarted while switching, and the new version was not answering, so the previous version leads again. Nothing is needed from you." : "The updater was restarted while switching and going back failed. Start the previous server container by hand (see the update notes).", "problem");
    return null;
  }
  if (s.stage === "soaking") return soakAndFinish(d, live, idle, commit ?? "", s.version ?? "the new version").then(() => undefined);
  if (s.stage === "stopping-old") {
    await docker.stop(colourName(live), d.cfg.swap.stopGraceSeconds).catch(() => undefined);
    state.finish("done", `Updated to ${s.version ?? "the new version"}. The previous version is kept stopped, ready to go back to.`, "info", { currentVersion: s.version, live: idle, idle: live, soakUntil: null });
    return null;
  }
  if (s.stage === "updating-updater" && !cfg.rawEnv["UPDATER_IS_NEXT"]) {
    await docker.remove(`${d.cfg.swap.selfName}${NEXT_SUFFIX}`).catch(() => undefined);
    state.finish("done", "Updater update failed: the updater was restarted while the new one was being started, so the new one was removed and this updater keeps running. Nothing live is affected.", "problem", { nextUpdater: null });
  }
  return null;
}
