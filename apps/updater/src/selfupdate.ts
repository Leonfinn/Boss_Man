// How the updater gets updated (design section 8). Hand-over, not in place: the running updater creates `updater-next` from the new
// digest (restart policy unless-stopped), then waits up to 60 s for it to call POST /handover after its own checks. On the call the
// old updater sets its restart policy to "no", takes the name `<name>-old`, gives the new one its name and alias, records the result
// and exits. If the call never comes, the old updater removes `updater-next`, keeps running and records "updater update failed".
// Nothing live depends on the updater, so a failure costs a notice. The Docker daemon starts the new one, so it outlives the old.
import http from "node:http";
import { UpdaterError, type Config } from "./config.js";
import type { ContainerInfo } from "./docker.js";
import type { MoveDeps } from "./move.js";
import { imageRef } from "./pull.js";
import type { Release } from "./schema.js";
import { updaterSpec, type SwapReady } from "./spec.js";
import type { SwapDeps } from "./swap.js";

export const NEXT_SUFFIX = "-next";
export const OLD_SUFFIX = "-old";

/** The one place a /handover request is matched with what the old updater is waiting for. */
export type HandoverGate = { expecting: { digest: string; run: () => Promise<void> } | null };
export const newGate = (): HandoverGate => ({ expecting: null });

const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})$/;
/** The digest this updater's own container was made from (compose names it by digest), or null when it cannot be told. */
export function digestOfInfo(info: ContainerInfo | null): string | null {
  return IMAGE_DIGEST.exec(info?.Config.Image ?? "")?.[1] ?? null;
}

export type Next = { version: string; digest: string };

/**
 * Replaces this updater with the one the release names. Returns "skipped" (same digest, or it cannot be told), "handed-over" (the
 * process should exit; the server route does it after the answer is sent) or "failed" (the old updater keeps running).
 * `pending` is a move the new updater must carry on with (layout-first update).
 */
export async function selfUpdate(d: SwapDeps, release: Release, pending: { version: string; serverDigest: string } | null): Promise<"skipped" | "handed-over" | "failed"> {
  const { cfg, docker, state } = d;
  const entry = release.images["boss-man-updater"];
  const gate = d.gate;
  if (!entry || !gate) return "skipped";
  const self = cfg.swap.selfName;
  const mine = digestOfInfo(await docker.inspectOurs(self).catch(() => null));
  if (!mine || mine === entry.digest) return "skipped";
  const nextName = `${self}${NEXT_SUFFIX}`;
  const oldName = `${self}${OLD_SUFFIX}`;
  state.update({ stage: "updating-updater", nextUpdater: entry.digest, pending });
  try {
    await docker.remove(nextName);
    await docker.createServer(nextName, updaterSpec(cfg, imageRef(cfg.registry, "boss-man-updater", entry.digest), release.version, entry.digest), "updater");
    await docker.connect(cfg.swap.frontNetwork, nextName, []);
    await docker.start(nextName);
  } catch (e) {
    await docker.remove(nextName).catch(() => undefined);
    return failed(d, pending, e instanceof UpdaterError ? e.message : "The new updater could not be started.");
  }
  const outcome = await new Promise<"called" | "timeout" | "error">((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      gate.expecting = null;
      resolve("timeout");
    }, cfg.swap.handoverCallSeconds * 1000);
    gate.expecting = {
      digest: entry.digest,
      run: async () => {
        done = true;
        clearTimeout(timer);
        // Any daemon error before the swap settles the wait as "error", so the move never hangs in updating-updater.
        let renamed = false;
        try {
          await docker.remove(oldName).catch(() => undefined);
          await docker.setRestartNever(self);
          await docker.rename(self, oldName);
          renamed = true;
          await docker.rename(nextName, self);
          await docker.disconnect(cfg.swap.selfNetwork, self);
          await docker.connect(cfg.swap.selfNetwork, self, [self]);
        } catch (e) {
          if (renamed) await docker.rename(oldName, self).catch(() => undefined);
          await docker.setRestartUnlessStopped(self).catch(() => undefined);
          resolve("error");
          throw e;
        }
        state.update({ stage: "idle", nextUpdater: null, pending, ...(pending ? {} : { report: { level: "info", text: `The updater itself was updated to ${release.version}.`, at: new Date().toISOString(), acknowledged: false } }) });
        resolve("called");
      },
    };
  });
  if (outcome === "error") {
    await docker.remove(nextName).catch(() => undefined);
    return failed(d, pending, "The hand-over to the new updater failed, so it was removed and the current updater keeps running.");
  }
  if (outcome === "timeout") {
    await docker.remove(nextName).catch(() => undefined);
    return failed(d, pending, "The new updater did not report in within 60 seconds, so it was removed and the current updater keeps running.");
  }
  return "handed-over";
}

function failed(d: MoveDeps, pending: unknown, why: string): "failed" {
  const text = `Updater update failed: ${why} Nothing live is affected.`;
  if (pending) d.state.fail({ code: "updater_update_failed", message: `${text} The move that needed the newer updater was not started.` });
  else d.state.finish("done", text, "problem", { nextUpdater: null });
  return "failed";
}

/** The new updater's side: after its own checks, ask the old one to hand over. Retries until the deadline. */
export async function callHandover(cfg: Config & { swap: NonNullable<Config["swap"]> }, key: string, digest: string, deadlineMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), request = postHandover): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (await request(cfg.swap.selfName, cfg.port, key, digest)) return true;
    if (Date.now() >= end) return false;
    await sleep(2_000);
  }
}

export const postHandover = (host: string, port: number, key: string, digest: string): Promise<boolean> =>
  new Promise((resolve) => {
    const body = JSON.stringify({ digest });
    const req = http.request({ host, port, method: "POST", path: "/handover", timeout: 20_000, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });

export type { SwapReady };
