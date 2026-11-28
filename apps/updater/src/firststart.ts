// First start and reconcile (design sections 5 and 8; BOS-1227). Compose now brings up only the database, the proxy, the updater and
// setup; the updater makes the first server colour and the launcher itself, from the release the install file pins, with no backup and no
// soak (nothing is serving yet). Reconcile runs at every start and after that: it finishes a half-done launcher replacement, retries a
// helper move that was deferred, and moves this updater to the release the state records when compose started an older one.
import { UpdaterError } from "./config.js";
import { findLaunchers, healthy, moveHelpers, recreateLauncher } from "./helpers.js";
import { imageRef, pullByDigest } from "./pull.js";
import { getVerifiedRelease } from "./release.js";
import { compareVersions } from "./schema.js";
import { selfUpdate } from "./selfupdate.js";
import { colourName, colourNetworks, colourSpec, frontAlias, LABEL_RELEASE, LIVE_ALIAS, updaterLink } from "./spec.js";
import { bareName, digestOf, findColours, httpProbe, isSwap, liveColour, realClock, releaseOf, runSwap, waitReady, type SwapDeps } from "./swap.js";
import type { MoveDeps } from "./move.js";

async function ensureImage(d: SwapDeps, name: string, digest: string) {
  if (await d.docker.imageInfo(imageRef(d.cfg.registry, name, digest))) return;
  await pullByDigest(d.docker, d.cfg.registry, name, digest, { arch: d.cfg.arch, ...d.pull });
}

async function waitDb(d: SwapDeps): Promise<boolean> {
  const clock = d.clock ?? realClock;
  const end = clock.now() + d.cfg.swap.helpers!.dbReadySeconds * 1000;
  for (;;) {
    const c = await d.docker.inspectOurs(d.cfg.swap.dbContainer).catch(() => null);
    if (c?.State.Running && (c.State.Health === undefined || c.State.Health.Status === "healthy")) return true;
    if (clock.now() >= end) return false;
    await clock.sleep(2000);
  }
}

/**
 * Makes what is missing from the pinned release: the launcher and the first server colour. Already there = adopted, never duplicated
 * (a colour or the launcher is found by label and name). Returns plain-words notes about what it did or could not do.
 */
export async function firstStart(d: MoveDeps): Promise<string[]> {
  if (!isSwap(d)) return [];
  const h = d.cfg.swap.helpers;
  const notes: string[] = [];
  if (!h || !h.first) return notes;
  const { docker, state } = d;
  // A launcher replacement the previous updater did not finish. If the old launcher is still there, the half-made one goes and the
  // old one runs again. If the old one is gone and the new one is healthy (the move died between the removal and the rename), the
  // new one is kept: it takes the name.
  // BOS-2804: found by label, under whatever name they have (the old fixed one or the project's).
  const found = await findLaunchers(docker);
  const nextC = found.next;
  if (nextC) {
    const oldC = found.current;
    if (!oldC && healthy(nextC)) {
      await docker.rename(bareName(nextC), h.launcherName);
      await docker.disconnect(d.cfg.swap.launcherNetwork, h.launcherName).catch(() => undefined);
      await docker.connect(d.cfg.swap.launcherNetwork, h.launcherName, [...new Set([h.launcherName, h.launcherAlias])]);
      notes.push("A launcher left half-way by an interrupted update was healthy, so it was kept.");
    } else {
      await docker.remove(bareName(nextC)).catch(() => undefined);
    }
  }
  const launcher = (await findLaunchers(docker)).current;
  if (launcher && !launcher.State.Running) await docker.start(bareName(launcher)).catch(() => undefined);
  const cols = await findColours(docker);
  const haveColour = !!(cols.blue || cols.green);
  if (launcher && haveColour) return notes;
  if (!(await waitDb(d))) {
    notes.push("The database was not ready in time, so the first start did not make the server yet. It is tried again at the next start of the updater.");
    return notes;
  }
  const version = d.cfg.currentVersion;
  try {
    const first = { ...h.first, version };
    // A launcher missing after the state already recorded a newer release than the install file pins: do not rebuild it from the
    // older install-time release. Mark the helpers pending; converge makes it from the recorded (signed) release.
    const recorded = state.get().currentVersion;
    const recordedNewer = !!recorded && compareVersions(recorded, version) > 0;
    if (!launcher && recordedNewer && haveColour) {
      state.update({ helpers: { release: state.get().helpers.release, status: "pending", note: "The launcher is missing; it is made from the recorded release." } });
      notes.push("The launcher is missing and the recorded release is newer than the install file, so it is made from the recorded release, not the older one.");
      return notes;
    }
    if (!launcher) {
      await ensureImage(d, "boss-man-launcher", first.launcher);
      await ensureImage(d, "boss-man-runner", first.runner);
      await ensureImage(d, "boss-man-netguard", first.netguard);
      const out = await recreateLauncher(d, first);
      notes.push(out === "failed" ? "The launcher did not become healthy at first start." : "The launcher was made at first start.");
    }
    if (!haveColour) {
      await ensureImage(d, "boss-man-server", first.server);
      const sw = d.cfg.swap;
      const blue = colourName("blue", sw.nameProject);
      await docker.createServer(blue, colourSpec(d.cfg, { colour: "blue", image: imageRef(d.cfg.registry, "boss-man-server", first.server), version, digest: first.server, role: "auto" }), "colour");
      for (const n of colourNetworks(d.cfg, "blue", true)) await docker.connect(n.network, blue, n.aliases);
      await docker.start(blue);
      const ok = await waitReady(d, frontAlias("blue"), "leader", null, sw.readySeconds);
      notes.push(ok ? "The first server was made at first start." : "The first server did not answer in time; it keeps trying and the next start of the updater checks it again.");
      state.update({ currentVersion: version, live: "blue", idle: "green" });
    }
    state.update({ helpers: { release: version, status: "moved", note: null } });
  } catch (e) {
    notes.push(e instanceof UpdaterError ? e.message : "The first start could not finish; it is tried again at the next start of the updater.");
  }
  return notes;
}

/** Reports mismatches; moves this updater to the recorded release when it is older (compose can start the pinned one again). */
export async function reconcile(d: MoveDeps): Promise<string[]> {
  if (!isSwap(d)) return [];
  const { docker, state, cfg } = d;
  const notes: string[] = [];
  const s = state.get();
  const current = s.currentVersion ?? cfg.currentVersion;
  const cols = await findColours(docker).catch(() => ({}) as Awaited<ReturnType<typeof findColours>>);
  const live = liveColour(cols, cfg.swap.frontNetwork);
  const liveRelease = live ? releaseOf(cols[live]) : null;
  if (live && liveRelease && liveRelease !== current) notes.push(`The serving server is release ${liveRelease} but the updater records ${current}.`);
  const h = cfg.swap.helpers;
  if (h) {
    const l = (await findLaunchers(docker)).current;
    const lr = l?.Config.Labels?.[LABEL_RELEASE];
    if (l && lr && lr !== current) {
      notes.push(`The launcher is release ${lr}, not ${current}; it is moved when no run is starting.`);
      if (s.helpers.status === "moved") state.update({ helpers: { release: lr, status: "pending", note: s.helpers.note } });
    }
    if (!l) notes.push("There is no launcher; the next start of the updater makes it.");
  }
  state.update({ reconcile: { at: new Date().toISOString(), notes } });
  return notes;
}

/** Env name the server reads its updater link from (spec.ts updaterLink). */
const LINK_ENV = "BOSSMAN_UPDATER_URL=";

/**
 * BOS-2717: a server colour made before the Install button existed has no link to this updater. When the install can give one
 * (its key folder is mounted by the updater) the serving release is made again beside the old one with the link and switched to,
 * with no backup or migration (same release, same data). Quiet: no owner report, a note in the log. A "not leader yet" answer is
 * retried at the next check; a real swap attempt is made once per updater start, so a failure is not repeated every five minutes. Never runs during another move.
 */
export async function relinkServer(d: MoveDeps, tried: { done: boolean }): Promise<string[]> {
  if (!isSwap(d) || tried.done || !updaterLink(d.cfg)) return [];
  const st = d.state.get();
  if (st.stage !== "idle" && st.stage !== "done" && st.stage !== "failed" && st.stage !== "rolled-back") return [];
  const cols = await findColours(d.docker);
  const live = liveColour(cols, d.cfg.swap.frontNetwork);
  const c = live ? cols[live] : undefined;
  const env = c?.Config.Env ?? [];
  const version = releaseOf(c);
  const digest = digestOf(c);
  // Only a server this updater made for an image install (it carries the release labels and the image-install flag).
  if (!c || !version || !digest || !env.includes("BOSSMAN_IMAGE_INSTALL=1") || env.some((e) => e.startsWith(LINK_ENV))) return [];
  const probe = await (d.probe ?? httpProbe)(LIVE_ALIAS);
  // Not leader yet (just started): do not mark tried, the next five-minute tick checks again.
  if (!probe?.ok || probe.role !== "leader" || !probe.commit) return ["The serving server has no link to the updater, but it is not answering as leader right now, so the link was not added. It is tried again at the next check."];
  tried.done = true;
  try {
    d.state.begin(version, digest);
    d.state.update({ stage: "starting-colour" });
    await runSwap(d, { commit: probe.commit }, { version, serverDigest: digest }, false, true);
  } catch (e) {
    d.state.update({ stage: "failed", error: null, report: null });
    return [`Adding the updater link to the serving server did not work (${e instanceof UpdaterError ? e.message : "unexpected problem"}). The serving server is unchanged; it is tried again at the next start of the updater.`];
  }
  const after = d.state.get().stage;
  // The owner is not told about this move: it is a repair, not a release.
  d.state.update({ report: null });
  return [after === "done" ? "The serving server was made again with a link to the updater, so the Install button works." : "Adding the updater link to the serving server was rolled back by itself; the previous server serves."];
}

/**
 * Work that needs the signed release of the recorded version, done after the updater is listening (a failed fetch only costs a retry):
 * a deferred helper move, and the updater's own move to the recorded release when compose started an older one.
 */
export async function converge(d: MoveDeps): Promise<void> {
  if (!isSwap(d)) return;
  const { state, cfg } = d;
  const s = state.get();
  if (s.stage !== "idle" && s.stage !== "done" && s.stage !== "failed" && s.stage !== "rolled-back") return;
  const current = s.currentVersion ?? cfg.currentVersion;
  const behind = compareVersions(current, cfg.currentVersion) > 0 && cfg.rawEnv["UPDATER_IS_NEXT"] !== "1";
  const helpersPending = !!cfg.swap.helpers && s.helpers.status === "pending";
  if (!behind && !helpersPending) return;
  const release = await getVerifiedRelease(cfg, current, d.release).catch(() => null);
  if (!release || release.missing.length > 0) return;
  if (helpersPending) {
    try {
      for (const n of ["boss-man-launcher", "boss-man-runner", "boss-man-netguard"]) await ensureImage(d, n, release.images[n]!.digest);
    } catch {
      return;
    }
    // Re-read after the pulls: another tick may have finished the move meanwhile.
    if (state.get().helpers.status === "pending") await moveHelpers(d, release);
  }
  if (behind) await selfUpdate(d, release, null);
}
