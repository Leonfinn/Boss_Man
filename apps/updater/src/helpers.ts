// The whole release moves (design section 5, "The whole release moves"; BOS-1227). After a server move is done and soaked:
//  1. `release-current` is written, so every runner and network guard the launcher makes from now on is the release's;
//  2. the new guard image is checked (it starts and prints its ruleset);
//  3. the launcher is recreated from the release, once no run is starting (up to 10 minutes of waiting); one launcher at a time,
//     the old one kept (stopped) until the new one is healthy, and started again if the new one never is;
//  4. the previous release's runner and guard images are removed, but only the ones Docker says no container uses.
// Runners and guards are never restarted here: they are labelled and independent, and the launcher takes them over by label at start.
// A guard in a running runner's network namespace is replaced only when that runner next restarts (two guards in one namespace would
// fight over the rules); until then the old guard keeps guarding, so nothing opens.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { UpdaterError, type Config } from "./config.js";
import type { ContainerInfo, Docker } from "./docker.js";
import type { MoveDeps } from "./move.js";
import { imageRef } from "./pull.js";
import type { Release } from "./schema.js";
import { guardCheckSpec, launcherSpec, RELEASE_FILE_NAME, type HelperRelease } from "./spec.js";
import { isSwap, realClock, type SwapDeps } from "./swap.js";

export type LauncherBusy = () => Promise<boolean>;

/** GET /busy on the launcher with its key. A launcher that does not know /busy (older than this release), or does not answer, is "not busy". */
export function httpBusy(cfg: Config & { swap: NonNullable<Config["swap"]> }): LauncherBusy {
  return () =>
    new Promise((resolve) => {
      const h = cfg.swap.helpers;
      if (!h) return resolve(false);
      let key: string;
      try {
        key = readFileSync(h.launcherKeyFile, "utf8").trim();
      } catch {
        return resolve(false);
      }
      const req = http.get(`${h.launcherUrl}/busy`, { headers: { authorization: `Bearer ${key}` }, timeout: 5_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 && (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { busy?: unknown }).busy === true);
          } catch {
            resolve(false);
          }
        });
        res.on("error", () => resolve(false));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
}

const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})$/;
export const digestOfRef = (ref: string | undefined | null) => IMAGE_DIGEST.exec(ref ?? "")?.[1] ?? null;

export type ReleaseCurrent = { version: string; runner: string; netguard: string; at: string };

const releasePath = (cfg: Config) => path.join(cfg.stateDir, RELEASE_FILE_NAME);

/** The digests the last finished release put in `release-current`, or null. */
export function readReleaseCurrent(cfg: Config): ReleaseCurrent | null {
  try {
    const v = JSON.parse(readFileSync(releasePath(cfg), "utf8")) as Record<string, unknown>;
    const ref = (x: unknown) => (typeof x === "string" && /^[a-z0-9][a-z0-9./_:-]{0,200}@sha256:[0-9a-f]{64}$/.test(x) ? x : null);
    const runner = ref(v["runner"]);
    const netguard = ref(v["netguard"]);
    return runner && netguard && typeof v["version"] === "string" ? { version: v["version"], runner, netguard, at: String(v["at"] ?? "") } : null;
  } catch {
    return null;
  }
}

/** Atomic: a temp file in the same folder, then a rename, so the launcher never reads half a file. */
export function writeReleaseCurrent(cfg: Config, release: Release, now: () => string = () => new Date().toISOString()): void {
  const runner = release.images["boss-man-runner"];
  const guard = release.images["boss-man-netguard"];
  if (!runner || !guard) throw new UpdaterError("incomplete_release", "The release does not list the runner and guard images.");
  mkdirSync(cfg.stateDir, { recursive: true });
  const file = releasePath(cfg);
  const body: ReleaseCurrent = { version: release.version, runner: imageRef(cfg.registry, "boss-man-runner", runner.digest), netguard: imageRef(cfg.registry, "boss-man-netguard", guard.digest), at: now() };
  writeFileSync(`${file}.tmp`, JSON.stringify(body, null, 2), { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

export const helperRelease = (release: Release): HelperRelease => {
  const d = (n: string) => release.images[n]!.digest;
  return { version: release.version, launcher: d("boss-man-launcher"), runner: d("boss-man-runner"), netguard: d("boss-man-netguard") };
};

/** Runs the new guard image once: it must start and print its ruleset. */
export async function checkGuard(d: SwapDeps, r: HelperRelease): Promise<void> {
  const name = `${d.cfg.namePrefix}-guardcheck`;
  await d.docker.remove(name);
  const id = await d.docker.createServer(name, guardCheckSpec(d.cfg, imageRef(d.cfg.registry, "boss-man-netguard", r.netguard), r.version), "migrate");
  try {
    await d.docker.start(id);
    const { stopped, exitCode } = await d.docker.wait(id, 60_000, 500, d.clock?.sleep, d.clock?.now);
    if (!stopped || exitCode !== 0) throw new UpdaterError("guard_check_failed", `The new network guard did not pass its check (${stopped ? `it exited with ${exitCode}` : "it did not finish"}), so the helpers were not moved. Runners keep the guard they have.`);
  } finally {
    await d.docker.remove(id).catch(() => undefined);
  }
}

/** Waits until the launcher reports no run starting, up to the configured time. Returns false when it stayed busy. */
export async function waitLauncherIdle(d: SwapDeps): Promise<boolean> {
  const h = d.cfg.swap.helpers!;
  const clock = d.clock ?? realClock;
  const busy = d.launcherBusy ?? httpBusy(d.cfg);
  const end = clock.now() + h.busyWaitSeconds * 1000;
  for (;;) {
    if (!(await busy())) return true;
    if (clock.now() >= end) return false;
    await clock.sleep(h.busyPollSeconds * 1000);
  }
}

export const healthy = (c: ContainerInfo) => c.State.Running === true && (c.State.Health === undefined || c.State.Health.Status === "healthy");

async function waitHealthy(d: SwapDeps, name: string, seconds: number): Promise<boolean> {
  const clock = d.clock ?? realClock;
  const end = clock.now() + seconds * 1000;
  for (;;) {
    const c = await d.docker.inspectOurs(name).catch(() => null);
    if (c && healthy(c)) return true;
    if (c && c.State.Running === false && c.State.ExitCode !== undefined && c.State.Status === "exited") return false;
    if (clock.now() >= end) return false;
    await clock.sleep(1000);
  }
}

export const NEXT = "-next";

/**
 * Replaces the launcher by the release's: new one created (not started) under a temporary name, the old one stopped, the new one
 * started and waited for; then the old one removed and the new one renamed. If the new one never becomes healthy it is removed and the
 * old one is started again. Only one launcher runs at a time (two would both manage the same guards).
 */
export async function recreateLauncher(d: SwapDeps, r: HelperRelease): Promise<"moved" | "current" | "failed"> {
  const { docker } = d;
  const h = d.cfg.swap.helpers!;
  const name = h.launcherName;
  const next = `${name}${NEXT}`;
  const old = await docker.inspectOurs(name).catch(() => null);
  if (old && digestOfRef(old.Config.Image) === r.launcher && old.State.Running) return "current";
  await docker.remove(next);
  await docker.createServer(next, launcherSpec(d.cfg, r), "launcher");
  if (old) await docker.stop(name, 30).catch(() => undefined);
  let startError = "";
  await docker.start(next).catch((e) => {
    startError = String((e as Error)?.message ?? e).slice(0, 300);
  });
  if (!(await waitHealthy(d, next, h.launcherReadySeconds))) {
    // Say why before the evidence is removed: the start error and the end of the new launcher's own log (no secrets in either).
    const tail = (await docker.logs(next, 8).catch(() => "")).replace(/\s+/g, " ").slice(-400);
    console.error(`launcher ${next} did not become healthy. start error: ${startError || "none"}; log: ${tail || "empty"}`);
    await docker.remove(next).catch(() => undefined);
    if (old) await docker.start(name).catch(() => undefined);
    return "failed";
  }
  if (old) await docker.remove(name);
  await docker.rename(next, name);
  // The launcher is reached by the name "launcher" on the launcher network; set the alias again after the rename, as the updater does.
  await docker.disconnect(d.cfg.swap.launcherNetwork, name);
  await docker.connect(d.cfg.swap.launcherNetwork, name, [name]);
  return "moved";
}

/** Removes the previous release's runner and guard images (and launcher image) that no container uses: Docker refuses the others. */
export async function removeOldImages(d: SwapDeps, previous: { launcher: string | null; runner: string | null; netguard: string | null }, keep: HelperRelease): Promise<string[]> {
  const removed: string[] = [];
  const pairs: [string, string | null, string][] = [
    ["boss-man-launcher", previous.launcher, keep.launcher],
    ["boss-man-runner", previous.runner, keep.runner],
    ["boss-man-netguard", previous.netguard, keep.netguard],
  ];
  for (const [n, digest, kept] of pairs) {
    if (!digest || digest === kept) continue;
    if (await d.docker.removeImage(imageRef(d.cfg.registry, n, digest)).catch(() => false)) removed.push(n);
  }
  return removed;
}

/** What the old launcher ran: its image and the runner and guard images in its environment. */
export function previousOf(old: ContainerInfo | null, file: ReleaseCurrent | null) {
  const env = old?.Config.Env ?? [];
  const fromEnv = (k: string) => digestOfRef(env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1));
  return {
    launcher: digestOfRef(old?.Config.Image),
    runner: digestOfRef(file?.runner) ?? fromEnv("BOSSMAN_RUNNER_IMAGE"),
    netguard: digestOfRef(file?.netguard) ?? fromEnv("BOSSMAN_NETGUARD_IMAGE"),
  };
}

/**
 * The whole helper move for a verified release whose images are already pulled. The guard is checked, then `release-current` is
 * written (so runners made from now on are the release's even if the launcher stays busy); a guard that fails its check leaves
 * release-current and the launcher as they were, and a busy launcher leaves the launcher; either marks the move "pending" for a retry.
 */
export async function moveHelpers(d: MoveDeps, release: Release): Promise<"moved" | "pending" | "skipped"> {
  if (!isSwap(d) || !d.cfg.swap.helpers) return "skipped";
  // One helper move at a time per updater: a retry tick that fires while a move still waits for the launcher must not start a second
  // one (both would build `launcher-next` and remove each other's new launcher).
  if (moving.has(d.state)) return "pending";
  moving.add(d.state);
  try {
    return await moveHelpersOnce(d, release);
  } finally {
    moving.delete(d.state);
  }
}

const moving = new WeakSet<object>();

async function moveHelpersOnce(d: SwapDeps, release: Release): Promise<"moved" | "pending" | "skipped"> {
  const { state, docker } = d;
  const r = helperRelease(release);
  const before = readReleaseCurrent(d.cfg);
  const old = await docker.inspectOurs(d.cfg.swap.helpers!.launcherName).catch(() => null);
  const previous = previousOf(old, before);
  const pending = (note: string): "pending" => {
    state.update({ helpers: { release: state.get().helpers.release, status: "pending", note } });
    return "pending";
  };
  try {
    // The guard is checked first: release-current names the guard every later runner start uses, so a guard that failed its check
    // must never be written there (guards fail closed, those runners would be removed).
    await checkGuard(d, r);
    writeReleaseCurrent(d.cfg, release);
    if (!(await waitLauncherIdle(d))) return pending("A run was starting for ten minutes, so the launcher was not replaced yet. It is tried again by itself; runners made now already use the new release.");
    const out = await recreateLauncher(d, r);
    if (out === "failed") return pending("The new launcher did not become healthy, so the previous launcher was started again. It is tried again by itself.");
    await removeOldImages(d, previous, r);
    state.update({ helpers: { release: release.version, status: "moved", note: null } });
    return "moved";
  } catch (e) {
    return pending(e instanceof UpdaterError ? e.message : "The helpers could not be moved; they keep running as they were. It is tried again by itself.");
  }
}
