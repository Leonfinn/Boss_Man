// The blue/green swap through the Docker API (design section 5, steps 2 to 8, and section 7). Everything here goes through the
// allow-listed client (docker.ts) and builds create bodies from the colour spec (spec.ts); no compose, no host file, no Caddy
// reload. The handover calls are the host deployer's (scripts/host-deployer.sh do_deploy_bluegreen): demote the live colour with
// SIGUSR1, wait for it to report "standby", promote the new one with SIGUSR2, wait for "leader" at the release's commit.
// The flip is the network alias `server-live` on the private front network (the proxy dials it), new colour connected first.
// State is saved after each step (state.ts), so a restart resumes or cleans up (recover in move.ts).
import http from "node:http";
import { UpdaterError, type Config, type SwapConfig } from "./config.js";
import type { ContainerInfo, Docker } from "./docker.js";
import type { MoveDeps } from "./move.js";
import { imageRef } from "./pull.js";
import type { Release } from "./schema.js";
import { colourName, colourNetworks, colourSpec, frontAlias, LABEL_COLOUR, LABEL_DIGEST, LABEL_RELEASE, LIVE_ALIAS, migrateSpec, otherColour, type Colour, type SwapReady } from "./spec.js";

export type Ready = { ok: boolean; role?: string; commit?: string };
/** GET /api/ready of a name on the front network (a colour's own alias, or the live one). null = no answer. */
export type Probe = (host: string) => Promise<Ready | null>;
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export const httpProbe: Probe = (host) =>
  new Promise((resolve) => {
    const req = http.get({ host, port: 3100, path: "/api/ready", timeout: 5_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: boolean; role?: string; commit?: string };
          resolve({ ok: res.statusCode === 200 && j.ok === true, role: j.role, commit: j.commit });
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });

export type SwapDeps = MoveDeps & { cfg: SwapReady };
export const isSwap = (d: MoveDeps): d is SwapDeps => d.cfg.swap !== null;

const clockOf = (d: MoveDeps) => d.clock ?? realClock;
const probeOf = (d: MoveDeps) => d.probe ?? httpProbe;
const sw = (d: SwapDeps): SwapConfig => d.cfg.swap;
const fail = (code: string, text: string): never => {
  throw new UpdaterError(code, text);
};

// ---------------------------------------------------------------------------------------------------------------- finding colours

export type Colours = Partial<Record<Colour, ContainerInfo>>;

export async function findColours(docker: Docker): Promise<Colours> {
  const out: Colours = {};
  for (const c of await docker.listByLabel(LABEL_COLOUR)) {
    const col = c.Config.Labels?.[LABEL_COLOUR];
    if (col === "blue" || col === "green") out[col] = c;
  }
  return out;
}

const holdsLiveAlias = (c: ContainerInfo, front: string) => c.State.Running === true && (c.NetworkSettings?.Networks?.[front]?.Aliases ?? []).includes(LIVE_ALIAS);

/** The live colour: the running one holding the alias the proxy dials. With no alias holder, a lone running colour is live. */
export function liveColour(cols: Colours, front: string): Colour | null {
  const holders = (["blue", "green"] as const).filter((c) => cols[c] && holdsLiveAlias(cols[c]!, front));
  if (holders.length === 1) return holders[0]!;
  const running = (["blue", "green"] as const).filter((c) => cols[c]?.State.Running);
  return holders.length === 0 && running.length === 1 ? running[0]! : null;
}

/** The release a colour was made for (its label), or null. */
export const releaseOf = (c: ContainerInfo | undefined) => c?.Config.Labels?.[LABEL_RELEASE] ?? null;
export const digestOf = (c: ContainerInfo | undefined) => c?.Config.Labels?.[LABEL_DIGEST] ?? null;

// ---------------------------------------------------------------------------------------------------------------- waiting

/** Polls until the colour (a front-network name) answers ready with this role (and commit, when given). */
export async function waitReady(d: SwapDeps, host: string, role: string, commit: string | null, seconds: number): Promise<boolean> {
  const clock = clockOf(d);
  const end = clock.now() + seconds * 1000;
  for (;;) {
    const r = await probeOf(d)(host);
    if (r && r.ok && r.role === role && (commit === null || r.commit === commit)) return true;
    if (clock.now() >= end) return false;
    await clock.sleep(sw(d).pollSeconds * 1000);
  }
}

// ---------------------------------------------------------------------------------------------------------------- flip

/** Moves the live alias from `from` to `to`, new colour first. Safe to run again after a restart halfway. */
export async function flipAlias(d: SwapDeps, to: Colour, from: Colour): Promise<void> {
  const front = sw(d).frontNetwork;
  const docker = d.docker;
  await docker.disconnect(front, colourName(to));
  await docker.connect(front, colourName(to), [frontAlias(to), LIVE_ALIAS]);
  await docker.disconnect(front, colourName(from));
  await docker.connect(front, colourName(from), [frontAlias(from)]);
}

/** Leaves the live colour leading again after a failed handover or a restart in the middle of one. */
async function ensureLeader(d: SwapDeps, colour: Colour): Promise<boolean> {
  const host = frontAlias(colour);
  const r = await probeOf(d)(host);
  if (r?.ok && r.role === "leader") return true;
  await d.docker.signal(colourName(colour), "SIGUSR2").catch(() => undefined);
  return waitReady(d, host, "leader", null, sw(d).handoverSeconds);
}

/** Removes the colour the move made (and the migrate one-shot). Never touches the live colour. */
export async function removeNewColour(d: SwapDeps, colour: Colour): Promise<void> {
  await d.docker.remove(colourName(colour)).catch(() => undefined);
  await d.docker.remove(`${d.cfg.namePrefix}-migrate`).catch(() => undefined);
}

/**
 * Switch back (design section 5 step 7 and the rollback table): the old colour leads again, the alias goes back to it, and the
 * new colour is stopped (kept, so its logs can be read; the next move removes it).
 */
export async function switchBack(d: SwapDeps, to: Colour, from: Colour): Promise<boolean> {
  const docker = d.docker;
  try {
    const cols = await findColours(docker);
    if (!cols[to]?.State.Running) await docker.start(colourName(to));
    await docker.signal(colourName(from), "SIGUSR1").catch(() => undefined);
    await docker.signal(colourName(to), "SIGUSR2");
    if (!(await waitReady(d, frontAlias(to), "leader", null, sw(d).handoverSeconds))) return false;
    await flipAlias(d, to, from);
    await docker.stop(colourName(from), sw(d).stopGraceSeconds).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------- the steps

export const BACKUP_RE = /^bossman-[0-9]{8}-[0-9]{6}\.sql\.gz$/;

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
};

/** Step 2: pg_dump inside the database container into the `backups` volume (it is mounted there), keep the last N. Failure aborts. */
export async function backup(d: SwapDeps): Promise<string> {
  const file = `bossman-${stamp(clockOf(d).now())}.sql.gz`;
  if (!BACKUP_RE.test(file)) return fail("backup_failed", "The backup could not be named, so nothing was changed.");
  const script = `set -eo pipefail; umask 077; mkdir -p /backups; cd /backups; pg_dump -U bossman bossman | gzip > ${file}.partial; test -s ${file}.partial; gzip -t ${file}.partial; mv ${file}.partial ${file}; ls -1t bossman-*.sql.gz | tail -n +${sw(d).backupsKeep + 1} | xargs -r rm -f --; echo saved ${file}`;
  let r: { exitCode: number; output: string };
  try {
    r = await d.docker.exec(sw(d).dbContainer, ["bash", "-c", script], "0");
  } catch (e) {
    if (e instanceof UpdaterError) throw e;
    return fail("backup_failed", "The database backup could not be run, so nothing was changed. The current version keeps serving.");
  }
  if (r.exitCode !== 0 || !r.output.includes(`saved ${file}`)) return fail("backup_failed", "The database backup failed, so nothing was changed. The current version keeps serving.");
  return file;
}

/** Step 3: a one-shot container from the new server digest runs the migrations while the old colour still serves. */
export async function migrate(d: SwapDeps, image: string, version: string): Promise<void> {
  const name = `${d.cfg.namePrefix}-migrate`;
  await d.docker.remove(name);
  const id = await d.docker.createServer(name, migrateSpec(d.cfg, image, version), "migrate");
  try {
    await d.docker.start(id);
    const { stopped, exitCode } = await d.docker.wait(id, d.cfg.packTimeoutMs, 2_000, d.clock?.sleep, d.clock?.now);
    if (!stopped) return fail("migrate_failed", "The database update did not finish in time, so the update was stopped. The current version keeps serving.");
    if (exitCode !== 0) return fail("migrate_failed", "The database update failed (the database rolled it back), so the update was stopped. The current version keeps serving. A backup was made first.");
  } finally {
    await d.docker.remove(id).catch(() => undefined);
  }
}

/** Steps 4 and 5: create and start the idle colour, wait for the health gate, then the handover. Leaves the old colour leading on any failure. */
export async function bringUp(d: SwapDeps, live: Colour, idle: Colour, release: Pick<Release, "commit">, ins: { version: string; serverDigest: string }, restore: boolean): Promise<void> {
  const { docker, state } = d;
  const idleName = colourName(idle);
  const commit = release.commit;
  state.update({ stage: "starting-colour" });
  const cols = await findColours(docker);
  const cur = cols[idle];
  if (restore) {
    if (!cur || cur.State.Running || releaseOf(cur) !== ins.version || digestOf(cur) !== ins.serverDigest) fail("downgrade", `${ins.version} is older than the release this install runs, and it is not the release kept as the standby, so the move was refused.`);
    await docker.start(idleName);
  } else {
    if (cur) {
      // The colour before the standby: removed now, with its image, so at most two colours ever exist.
      await docker.remove(idleName);
      if (cur.Image) await docker.removeImage(cur.Image).catch(() => undefined);
    }
    const image = imageRef(d.cfg.registry, "boss-man-server", ins.serverDigest);
    await docker.createServer(idleName, colourSpec(d.cfg, { colour: idle, image, version: ins.version, digest: ins.serverDigest, role: "standby" }), "colour");
    for (const n of colourNetworks(d.cfg, idle, false)) await docker.connect(n.network, idleName, n.aliases);
    await docker.start(idleName);
  }
  if (!(await waitReady(d, frontAlias(idle), "standby", commit, sw(d).readySeconds))) {
    await removeOrStopNew(d, idle, restore);
    return fail("colour_unhealthy", `The new version did not become healthy within ${sw(d).readySeconds} seconds, so it was removed. The current version keeps serving; nothing was switched.`);
  }
  state.update({ stage: "handing-over" });
  let why = "";
  await docker.signal(colourName(live), "SIGUSR1").catch(() => (why = "The current version could not be told to step down."));
  if (!why && !(await waitReady(d, frontAlias(live), "standby", null, sw(d).handoverSeconds))) why = "The current version did not step down.";
  if (!why) await docker.signal(idleName, "SIGUSR2").catch(() => (why = "The new version could not be told to take over."));
  if (!why && !(await waitReady(d, frontAlias(idle), "leader", commit, sw(d).handoverSeconds))) why = "The new version did not take over.";
  if (why) {
    await ensureLeader(d, live);
    await removeOrStopNew(d, idle, restore);
    return fail("handover_failed", `${why} The current version leads again and keeps serving; nothing was switched.`);
  }
}

async function removeOrStopNew(d: SwapDeps, idle: Colour, restore: boolean) {
  if (restore) await d.docker.stop(colourName(idle), sw(d).stopGraceSeconds).catch(() => undefined);
  else await removeNewColour(d, idle);
}

/** Step 6 to 8 after the alias moved: soak, switch back by itself on a sustained failure, then stop the old colour. */
export async function soakAndFinish(d: SwapDeps, live: Colour, idle: Colour, commit: string, version: string): Promise<"done" | "rolled-back"> {
  const { state } = d;
  const clock = clockOf(d);
  const until = Date.parse(state.get().soakUntil ?? "") || clock.now() + sw(d).soakSeconds * 1000;
  if (state.get().stage !== "soaking") state.update({ stage: "soaking", soakUntil: new Date(until).toISOString() });
  let failingSince: number | null = null;
  while (clock.now() < until) {
    await clock.sleep(sw(d).soakPollSeconds * 1000);
    const r = await probeOf(d)(LIVE_ALIAS);
    const good = !!r && r.ok && r.role === "leader" && r.commit === commit;
    if (good) failingSince = null;
    else {
      failingSince ??= clock.now();
      if (clock.now() - failingSince >= sw(d).soakCheckSeconds * 1000) {
        const back = await switchBack(d, live, idle);
        state.finish("rolled-back", back ? `The new version (${version}) stopped answering after the switch, so the update went back to the previous version by itself. Nothing is needed from you; the new version is kept stopped so its log can be read.` : `The new version (${version}) stopped answering and going back to the previous version also failed. Boss Man may be down: start the previous server container by hand (see the update notes).`, "problem", { soakUntil: null });
        return "rolled-back";
      }
    }
  }
  state.update({ stage: "stopping-old" });
  const stopped = await d.docker.stop(colourName(live), sw(d).stopGraceSeconds).then(() => true, () => false);
  state.finish("done", stopped ? `Updated to ${version}. The previous version is kept stopped, ready to go back to.` : `Updated to ${version}. The previous version could not be stopped; it no longer serves and the next update will remove it.`, "info", { currentVersion: version, soakUntil: null, live: idle, idle: live });
  return "done";
}

/** Steps 2 to 8 for a normal move, or the standby-release move. The caller has verified the release and pulled the images. */
export async function runSwap(d: SwapDeps, release: Pick<Release, "commit">, ins: { version: string; serverDigest: string }, restore: boolean, sameRelease = false): Promise<void> {
  const { docker, state } = d;
  const cols = await findColours(docker);
  const live = liveColour(cols, sw(d).frontNetwork);
  if (!live) return fail("no_live_colour", "The updater cannot tell which server version is serving, so it changed nothing.");
  const idle = otherColour(live);
  const r = await probeOf(d)(LIVE_ALIAS);
  if (!r?.ok || r.role !== "leader") return fail("live_unhealthy", "The running version is not healthy right now, so the update was not started. Nothing was changed.");
  state.update({ live, idle, commit: release.commit });
  // BOS-2717: re-making the live release with the updater link changes no data, so no backup and no migration.
  if (!restore && !sameRelease) {
    state.update({ stage: "backing-up" });
    state.update({ backup: await backup(d) });
    state.update({ stage: "migrating" });
    await migrate(d, imageRef(d.cfg.registry, "boss-man-server", ins.serverDigest), ins.version);
  }
  await bringUp(d, live, idle, release, ins, restore);
  state.update({ stage: "flipping" });
  try {
    await flipAlias(d, idle, live);
  } catch {
    await switchBack(d, live, idle);
    return fail("flip_failed", "The switch did not work, so the previous version leads again. Nothing is needed from you.");
  }
  if (!(await waitReady(d, LIVE_ALIAS, "leader", release.commit, sw(d).handoverSeconds))) {
    const back = await switchBack(d, live, idle);
    state.finish("rolled-back", back ? "The new version did not answer after the switch, so the update went back to the previous version by itself. Nothing is needed from you." : "The new version did not answer after the switch and going back also failed. Start the previous server container by hand (see the update notes).", "problem");
    return;
  }
  await soakAndFinish(d, live, idle, release.commit, ins.version);
}
