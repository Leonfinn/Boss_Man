// The launcher's API (R55): five calls, each about one company's runner, and nothing else.
// The server holds the key; Docker is reached only from here, with a spec the launcher builds.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DockerError, type Docker } from "./docker.js";
import { ensurePack } from "./claude-pack.js";
import { COMPANY_LABEL, companyDir, containerName, containerSpec, guardImageOf, LABEL, listLabel, previousRunnerImage, runnerImageOf, MOUNTS, netguardDir, netguardName, netguardSpec, NETGUARD_LABEL, NETGUARD_UNAVAILABLE_EXIT, MAX_AGENTS, parseAllow, parseTrusted, planChecks, SLUG, tokenFile, type LauncherConfig } from "./spec.js";

const TOKEN = /^bmr_[A-Za-z0-9_-]{20,200}$/;
const MAX_BODY = 4096;
/** Where setChecks keeps the owner's "Checks at once", under the data folder. */
export const CHECKS_FILE = "launcher-checks.json";

export class LauncherError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `current` is true when the container runs the image `boss-man-runner:current` points at now. */
export type RunnerStatus = { slug: string; state: string; status: string; image: string; current: boolean; guard: GuardStatus; guardReason?: string; guardSince?: string };
/**
 * "on": the guard container is running and newer than the runner; "off": turned off by BOSSMAN_NETGUARD=off; "unavailable": this
 * host can't load the rules (BOSSMAN_NETGUARD=auto lets the runner go without); "down": the guard is missing, stopped, unhealthy or
 * older than the runner, so the runner is unguarded until reconcile repairs it. DR-007: "retrying": the guard is being started
 * again (the runner keeps working when its rules are still in force, or is paused while they aren't); "frozen": it didn't come
 * back in time, so the runner stays paused (or stopped) with its work kept, until the guard works or the owner acts.
 */
export type GuardStatus = "on" | "off" | "unavailable" | "down" | "retrying" | "frozen";
/** The file beside the allow list that records which runner start (StartedAt) the guard's rules were last loaded for. */
export const GUARDED_FOR = "guarded-for";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Removes a container. `docker.remove` already treats a concurrent removal ("removal … is already
 * in progress") as success-in-progress: it waits for that one to finish and only fails if the
 * container is still there afterwards.
 */
async function removeSettled(docker: Docker, id: string) {
  await docker.remove(id);
}

/** The guard didn't come up. `hostCannot`: it said so itself (exit code 3), so retrying won't help. */
class GuardUnavailable extends Error {
  constructor(
    readonly hostCannot: boolean,
    message: string,
  ) {
    super(message);
  }
}

export function launcher(cfg: LauncherConfig, docker: Docker) {
  /** The container for a slug, if the launcher made it; anything else under that name is refused. */
  async function ours(slug: string) {
    const c = await docker.inspect(containerName(slug, cfg.stack));
    if (!c) return null;
    const labels = c.Config.Labels ?? {};
    if (labels[LABEL] !== "1" || labels[COMPANY_LABEL] !== slug) throw new LauncherError(409, `A container called ${containerName(slug, cfg.stack)} exists that the launcher didn't make; it won't touch it.`);
    return c;
  }

  /** The slug's network guard, if there is one; a container of that name that isn't ours is refused. */
  async function guardOf(slug: string) {
    const g = await docker.inspect(netguardName(slug, cfg.stack));
    if (!g) return null;
    const labels = g.Config.Labels ?? {};
    if (labels[NETGUARD_LABEL] !== "1" || labels[COMPANY_LABEL] !== slug) throw new LauncherError(409, `A container called ${netguardName(slug, cfg.stack)} exists that the launcher didn't make; it won't touch it.`);
    return g;
  }

  /** Runs one slug's work after the previous work for that slug: guards are removed and made by name, so two at once would collide. */
  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(slug: string, work: () => Promise<T>): Promise<T> {
    const run = (chains.get(slug) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    chains.set(slug, tail);
    void tail.then(() => chains.get(slug) === tail && chains.delete(slug));
    return run;
  }

  const mode = cfg.guardMode ?? "auto";
  /** Companies whose runner the launcher removed (guard failure) and will make again: a token file without a container. Backoff per company. */
  const healing = new Map<string, { fails: number; nextAt: number }>();
  /** Companies the guard can't ever run for on this host (enforce mode, exit 3): retrying won't help. */
  const noRetry = new Set<string>();
  /**
   * The guard's real state, read from Docker each time (a launcher restart or a guard that died
   * later can't leave a stale answer). "unavailable": auto mode and the guard exited with
   * netguard.sh's "no nftables" code; "on": the guard is running, started after the runner (same
   * network namespace) and isn't unhealthy; anything else is "down".
   */
  async function guardStatus(slug: string, runnerStartedAt: string | undefined): Promise<GuardStatus> {
    if (mode === "off") return "off";
    const g = await guardOf(slug).catch(() => null);
    if (!g) return "down";
    const s = g.State.Status;
    if (s === "exited" && g.State.ExitCode === NETGUARD_UNAVAILABLE_EXIT && mode === "auto") return "unavailable";
    if (s !== "running" || g.State.Health?.Status === "unhealthy") return "down";
    return new Date(g.State.StartedAt ?? 0).getTime() >= new Date(runnerStartedAt ?? 0).getTime() ? "on" : "down";
  }

  /** Waits until the guard has loaded its rules (its healthcheck passes); throws if it stops first. */
  async function guardReady(slug: string) {
    const deadline = Date.now() + (cfg.guardReadyMs ?? 20_000);
    for (;;) {
      const g = await guardOf(slug);
      if (!g || g.State.Status === "exited" || g.State.Status === "dead") throw new GuardUnavailable(g?.State.ExitCode === NETGUARD_UNAVAILABLE_EXIT, `The network guard for ${slug} stopped (exit code ${g?.State.ExitCode ?? "unknown"}); see \`docker logs ${netguardName(slug, cfg.stack)}\`.`);
      if (g.State.Health?.Status === "healthy") return;
      if (Date.now() > deadline) throw new GuardUnavailable(false, `The network guard for ${slug} didn't load its rules in time.`);
      await sleep(250);
    }
  }

  /**
   * (Re)starts the guard in the runner's network namespace and waits for its rules. It must follow
   * every runner start, because a restart makes a new namespace. Throws unless the runner is guarded,
   * or (auto mode) the host can't run the guard at all, which is then reported as "unavailable".
   */
  async function guard(slug: string, runnerId: string) {
    if (mode === "off") return;
    try {
      // DR-007 row 3: check the guard can be made at all before taking the old one away. Without the
      // image the old guard stays, and so do the rules it loaded.
      if (!(await docker.imageId(guardImageOf(cfg)))) throw new GuardUnavailable(false, `The network guard image ${guardImageOf(cfg)} is missing on this host; run the runner update to build it.`);
      const old = await guardOf(slug);
      if (old) await removeSettled(docker, old.Id);
      mkdirSync(netguardDir(cfg, slug), { recursive: true, mode: 0o755 });
      await docker.start(await docker.create(netguardName(slug, cfg.stack), netguardSpec(cfg, slug, runnerId)));
      await guardReady(slug);
      // Which runner start these rules belong to: a later check can then tell "guard gone, rules still in force"
      // (same start) from "runner restarted, new namespace with no rules" (a different start).
      const r = await ours(slug);
      if (r?.Id === runnerId && r.State.StartedAt) writeMarker(slug, r.State.StartedAt);
      trouble.delete(slug);
    } catch (err) {
      if (err instanceof GuardUnavailable && err.hostCannot && mode === "auto") {
        console.error(JSON.stringify({ at: new Date().toISOString(), msg: "network guard unavailable on this host; the runner is not guarded", slug }));
        return;
      }
      if (err instanceof GuardUnavailable && err.hostCannot) noRetry.add(slug);
      if (err instanceof GuardUnavailable) throw new LauncherError(502, `${err.message}${err.hostCannot ? " This host can't load firewall rules; set BOSSMAN_NETGUARD=auto to run runners without the guard, or off to turn it off." : ""}`);
      throw err;
    }
  }

  function readMarker(slug: string): string | null {
    try {
      return readFileSync(path.join(netguardDir(cfg, slug), GUARDED_FOR), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  function writeMarker(slug: string, startedAt: string) {
    const dir = netguardDir(cfg, slug);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = path.join(dir, `${GUARDED_FOR}.tmp`);
    writeFileSync(tmp, `${startedAt}\n`, { mode: 0o644 });
    renameSync(tmp, path.join(dir, GUARDED_FOR));
  }

  /** DR-007: a guard that is being started again (retrying) or that didn't come back in time (frozen), per company. */
  const trouble = new Map<string, { state: "retrying" | "frozen"; reason: string; since: number; tries: number; next: number }>();
  const freezeAfterMs = cfg.guardFreezeAfterMs ?? 120_000;
  const backoff = (tries: number) => Math.min(60_000, 5_000 * 2 ** Math.max(0, tries - 1));
  const now = () => (cfg.now ? cfg.now() : Date.now());

  /**
   * Writes the tool-server allow list the guard reads (host:port lines, plus a `private` marker on the entries the
   * owner trusted for private addresses); the guard picks it up within 15 s.
   */
  function writeAllow(slug: string, hosts: string[], trusted: Set<string> = new Set()) {
    const dir = netguardDir(cfg, slug);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = path.join(dir, "allow.tmp");
    writeFileSync(tmp, hosts.map((h) => `${h}${trusted.has(h) ? " private" : ""}\n`).join(""), { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, path.join(dir, "allow"));
  }

  /**
   * Network hold (BOS-576): the runner is off its network while its guard loads, so it never has a moment in which
   * it can reach the private networks unguarded. Docker starts a container that is on no network with loopback only.
   * Not with BOSSMAN_NETGUARD=off, where there is no guard to wait for.
   */
  const hold = mode !== "off";
  async function holdNetwork(id: string) {
    if (hold) await docker.disconnect(cfg.network, id);
  }
  /** Puts the guarded runner on its network, then wakes the guard to look its allowed names up now (they only resolve once the runner is on the network). */
  async function releaseNetwork(slug: string, id: string) {
    if (!hold) return;
    await docker.connect(cfg.network, id);
    const g = await guardOf(slug).catch(() => null);
    // An older guard image ignores USR1 (it is PID 1 with no handler) and looks again within 15 s instead.
    if (g?.State.Status === "running") await docker.signal(g.Id, "USR1").catch(() => undefined);
  }
  const onNetwork = (c: { NetworkSettings?: { Networks?: Record<string, unknown> | null } }) => !hold || !!c.NetworkSettings?.Networks?.[cfg.network];

  /** Guard, then network; on any failure the runner is removed (no guard, no runner), and it never had a network. */
  async function guardThenRelease(slug: string, id: string) {
    try {
      await guard(slug, id);
      await releaseNetwork(slug, id);
    } catch (err) {
      await docker.remove(id).catch(() => undefined);
      throw err;
    }
  }

  async function create(slug: string, image?: string) {
    // Every bind source must exist first: Docker would make a missing one owned by root, which the runner can't write.
    for (const [sub] of MOUNTS) mkdirSync(path.join(companyDir(cfg, slug), sub), { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(netguardDir(cfg, slug), "allow"))) writeAllow(slug, []);
    // The Claude pack (DR-050): install it into the shared named volume before the runner starts. It never
    // blocks the runner: a failure means Claude is absent on this runner, and OpenCode and Codex keep working.
    const packReady = await ensurePack(docker, cfg, slug, (msg) => console.error(JSON.stringify({ at: new Date().toISOString(), msg, slug })));
    if (!packReady) console.error(JSON.stringify({ at: new Date().toISOString(), msg: `Claude Code will be absent on ${slug}'s runner until its pack can install`, slug }));
    const old = await ours(slug);
    if (old) await removeSettled(docker, old.Id);
    // A daemon that won't say (or a fake in a test) just means "unknown" in the runner's platform fingerprint.
    const host = await docker.hostInfo().catch(() => null);
    const id = await docker.create(containerName(slug, cfg.stack), containerSpec(cfg, slug, image, host));
    try {
      await holdNetwork(id);
      await docker.start(id);
    } catch (err) {
      await docker.remove(id).catch(() => undefined);
      throw err;
    }
    await guardThenRelease(slug, id);
    return id;
  }

  return {
    /** What the CPU reserve decided at start (cpu-layout.ts): on or off, which threads, and why. */
    cpu: () => cfg.cpuPlan ?? { on: false, reserved: [] as number[], runnerThreads: [] as number[], hostThreads: 0, reason: "Not worked out." },
    /** The guard mode and the BOSSMAN_NETGUARD_ALLOW entries this launcher started with (host:port only), so the owner can see them (BOS-770). */
    netguard: () => ({ mode, allow: [...(cfg.guardAllow ?? [])] }),
    /**
     * BOS-993: the owner's "Checks at once". Remembered in a file under the data folder (so a launcher restart keeps it)
     * and used for every runner made from now on; running runners change when they are recreated.
     */
    async setChecks(slots: number, agents?: number) {
      if (!Number.isInteger(slots) || slots < 1 || slots > 16) throw new LauncherError(400, "Slots must be a whole number from 1 to 16.");
      if (agents !== undefined && (!Number.isInteger(agents) || agents < 0 || agents > MAX_AGENTS)) throw new LauncherError(400, `Agents must be a whole number from 0 to ${MAX_AGENTS}.`);
      // BOS-1498: the first agents number this launcher hears. Runners made before it were sized on the old 13 GB base; their
      // memory is kept (planChecks) so the upgrade alone never shrinks one. A fresh install has no runners yet, so nothing is kept.
      if (agents !== undefined && cfg.requestedAgents === undefined && !cfg.kept) {
        let most = 0;
        for (const r of await this.list()) most = Math.max(most, (await docker.inspect(containerName(r.slug, cfg.stack)).catch(() => null))?.HostConfig?.Memory ?? 0);
        if (most > 0) cfg.kept = { bytes: most, slots, agents };
      }
      // The owner lowered a setting: from now on the formula applies, also if they raise it again later.
      if (cfg.kept && (slots < cfg.kept.slots || (agents ?? cfg.requestedAgents ?? cfg.kept.agents) < cfg.kept.agents)) cfg.kept = undefined;
      // The number is taken first: the launcher container's root is read-only and only companies/ is mounted, so the file
      // may not be writable. The server sends the setting again every minute (BOS-1152), so a launcher that cannot
      // remember it across a restart still ends up on the right number.
      cfg.requestedSlots = slots;
      if (agents !== undefined) cfg.requestedAgents = agents;
      try {
        const file = path.join(cfg.dataRoot, CHECKS_FILE);
        const saved = { slots, ...(cfg.requestedAgents !== undefined ? { agents: cfg.requestedAgents } : {}), ...(cfg.kept ? { kept: cfg.kept } : {}) };
        writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.warn(JSON.stringify({ at: new Date().toISOString(), msg: "could not save Checks at once; the server will send it again after a restart", error: String((e as Error)?.message ?? e) }));
      }
      return this.plannedChecks();
    },

    /** What a runner made now gets, and why it is below the setting if it is. */
    plannedChecks: () => planChecks(cfg),

    /** The plan, and what each running runner was made with (read from its container), so the panel shows the limit in force. */
    async checks() {
      const plan = planChecks(cfg);
      const runners: { slug: string; slots: number; memoryBytes: number }[] = [];
      for (const r of await this.list()) {
        const c = await docker.inspect(containerName(r.slug, cfg.stack)).catch(() => null);
        if (!c) continue;
        const slots = Number((c.Config.Env ?? []).find((e) => e.startsWith("BOSSMAN_CHECK_SLOTS="))?.split("=")[1] ?? 1) || 1;
        runners.push({ slug: r.slug, slots, memoryBytes: c.HostConfig?.Memory ?? 0 });
      }
      return { ...plan, runners };
    },

    /** Writes the token, then creates (or recreates) and starts the runner. Data folders are kept. */
    put: (slug: string, token: string, allow?: string[], trusted: Set<string> = new Set()) => locked(slug, async () => {
      mkdirSync(companyDir(cfg, slug), { recursive: true, mode: 0o700 });
      // Written beside the target and renamed, so a runner never reads half a token.
      const tmp = `${tokenFile(cfg, slug)}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, tokenFile(cfg, slug));
      if (allow) writeAllow(slug, parseAllow(allow), trusted);
      healing.delete(slug);
      noRetry.delete(slug);
      const id = await create(slug);
      return { slug, id };
    }),

    /** Replaces the company's tool-server allow list (host:port); no restart, the guard re-reads it. */
    setAllow: (slug: string, allow: string[], trusted: Set<string> = new Set()) => locked(slug, async () => {
      writeAllow(slug, parseAllow(allow), trusted);
      return { slug, allow: parseAllow(allow) };
    }),

    restart: (slug: string) => locked(slug, async () => {
      const c = await ours(slug);
      if (!c) throw new LauncherError(404, "There's no runner for that company.");
      // Off the network first (BOS-576), so the restarted runner comes back with loopback only until its guard is in.
      await holdNetwork(c.Id);
      await docker.restart(c.Id);
      try {
        await guard(slug, c.Id);
        await releaseNetwork(slug, c.Id);
      } catch (err) {
        // DR-007 row 4: the restart gave it a new namespace with no rules. Freeze it (stop if this host can't
        // pause) rather than remove it: its workspaces and sessions stay, and the guard check keeps retrying.
        // It stays off its network (BOS-576), so it never ran unguarded.
        const frozen = await docker.pause(c.Id).then(() => false, async () => (await docker.stop(c.Id).catch(() => undefined), true));
        const reason = String((err as Error)?.message ?? err);
        trouble.set(slug, { state: frozen ? "frozen" : "retrying", reason, since: now(), tries: 1, next: now() + backoff(1) });
        throw err;
      }
      return { slug, id: c.Id };
    }),

    /** Stops and removes the runner and its token. Its workspaces, journal and sessions stay. */
    remove: (slug: string) => locked(slug, async () => {
      const c = await ours(slug);
      const g = await guardOf(slug);
      if (g) await docker.remove(g.Id);
      if (c) await removeSettled(docker, c.Id);
      healing.delete(slug);
      noRetry.delete(slug);
      trouble.delete(slug);
      rmSync(tokenFile(cfg, slug), { force: true });
      return { slug, removed: !!c };
    }),

    async list(): Promise<RunnerStatus[]> {
      const all = await docker.list(listLabel(cfg.stack));
      const current = await docker.imageId(runnerImageOf(cfg));
      const mine = all.filter((c) => SLUG.test(c.Labels[COMPANY_LABEL] ?? "") && c.Names.includes(`/${containerName(c.Labels[COMPANY_LABEL]!, cfg.stack)}`));
      return Promise.all(
        mine.map(async (c) => {
          const slug = c.Labels[COMPANY_LABEL]!;
          const info = mode === "off" ? null : await docker.inspect(containerName(slug, cfg.stack)).catch(() => null);
          const read = await guardStatus(slug, info?.State.StartedAt);
          // DR-007: a guard being started again, or one that didn't come back, is named as such; the owner sees why.
          const t = read === "off" || read === "unavailable" || read === "on" ? undefined : trouble.get(slug);
          return { slug, state: c.State, status: c.Status, image: c.Image, current: !!current && c.ImageID === current, guard: t ? t.state : read, ...(t ? { guardReason: t.reason, guardSince: new Date(t.since).toISOString() } : {}) };
        }),
      );
    },

    /**
     * The companies this launcher means to keep running: a runner container exists, or a token file
     * is left (the self-heal will make it again). Stop deletes the token and the container, so a
     * stopped, removed or never-started company is not listed. The server's runner watch uses this
     * to tell a runner that should be back from one that was set aside on purpose.
     */
    async wanted(): Promise<string[]> {
      const slugs = new Set((await this.list()).map((r) => r.slug));
      let dirs: string[] = [];
      try {
        dirs = readdirSync(path.join(cfg.dataRoot, "companies"));
      } catch {
        /* no company directory yet: nothing is wanted beyond what runs */
      }
      for (const d of dirs) if (SLUG.test(d) && existsSync(tokenFile(cfg, d))) slugs.add(d);
      return [...slugs].sort();
    },

    /**
     * Makes sure every running runner has a running guard that started after it. A runner that
     * restarted on its own (a crash, Docker coming back) has a new network namespace the old
     * guard isn't in. Returns the companies whose guard it started again. Runs at start and then on a timer.
     */
    async reconcileGuards() {
      const fixed: string[] = [];
      const errors: string[] = [];
      for (const r of await this.list()) {
        // "down" (missing, stopped, unhealthy or older than the runner) is what this repairs; the
        // re-check inside the lock decides again. After a reboot the runner (unless-stopped) is back
        // before the guard (no restart policy), so this runs at once at start and every 5 s.
        if ((r.state !== "running" && r.state !== "paused") || r.guard === "off") continue;
        await locked(r.slug, async () => {
          // Looked at again inside the lock: a create or restart may have just made a guard.
          const c = await ours(r.slug);
          const status = c?.State.Status;
          if (!c || (status !== "running" && status !== "paused")) return;
          const startedAt = c.State.StartedAt ?? "";
          const paused = status === "paused";
          const g = await guardOf(r.slug);
          const fresh = !paused && g && g.State.Status === "running" && new Date(g.State.StartedAt ?? 0).getTime() >= new Date(startedAt || 0).getTime();
          // A runner left off its network (the launcher stopped between hold and release, BOS-576) is put back once guarded.
          if (r.guard === "unavailable" || fresh) {
            if (fresh) {
              // An install from before the marker: the running guard started after this runner, so its rules are this runner's.
              if (startedAt && readMarker(r.slug) !== startedAt) writeMarker(r.slug, startedAt);
              trouble.delete(r.slug);
            }
            if (onNetwork(c)) return;
            await releaseNetwork(r.slug, c.Id);
            fixed.push(r.slug);
            return;
          }
          // DR-007: no automatic path removes a runner that may hold work. Same start as the last good guard:
          // the namespace and its rules are still there (row 1). A different start: a new namespace with no
          // rules, so freeze it until the guard is back (rows 2 and 11).
          const sameStart = !!startedAt && readMarker(r.slug) === startedAt;
          const t = trouble.get(r.slug);
          if ((sameStart || paused) && t && now() < t.next) return; // backing off
          const failed = (err: unknown, frozen: boolean) => {
            const since = t?.since ?? now();
            const tries = (t?.tries ?? 0) + 1;
            const reason = String((err as Error)?.message ?? err);
            const state = frozen || (!sameStart && now() - since >= freezeAfterMs) ? "frozen" : "retrying";
            trouble.set(r.slug, { state, reason, since, tries, next: now() + backoff(tries) });
            console.error(JSON.stringify({ at: new Date(now()).toISOString(), msg: `network guard ${state}`, slug: r.slug, reason, runnerKept: true }));
          };
          let held = false;
          if (!sameStart && !paused) {
            // Off the network first: if this host refuses both pause and stop, the runner must not sit with its network and no rules.
            await holdNetwork(c.Id).catch(() => undefined);
            held = true;
            try {
              await docker.pause(c.Id);
            } catch (pauseErr) {
              // This host can't freeze containers (some rootless or LXC set-ups): stop it instead, which keeps its
              // data and workspaces but cuts its runs, and say so. It never runs with no rules.
              await docker.stop(c.Id);
              const err = new Error(`The runner's network rules were gone after it restarted, and this host refused to pause it (${String((pauseErr as Error)?.message ?? pauseErr)}), so it was stopped with its work kept. Start it again once the guard works.`);
              failed(err, true);
              throw err;
            }
          }
          try {
            // Off the network while the guard loads (BOS-576); a runner whose rules are still in force (same start) keeps its network.
            if (!sameStart && !held) await holdNetwork(c.Id).catch(() => undefined);
            await guard(r.slug, c.Id);
            if (!sameStart || !onNetwork(c)) await releaseNetwork(r.slug, c.Id);
          } catch (err) {
            failed(err, false);
            throw err;
          }
          if (!sameStart || paused) await docker.unpause(c.Id).catch((err: unknown) => {
            // Already running (it was never paused, or someone unpaused it): nothing to undo.
            if ((err as DockerError)?.status !== 409) throw err;
          });
          fixed.push(r.slug);
        }).catch((err: unknown) => errors.push(`${r.slug}: ${String((err as Error)?.message ?? err)}`));
      }
      if (errors.length) throw new Error(errors.join("; "));
      return fixed;
    },

    /**
     * Self-heal: a company with a token file but no runner container is one the launcher removed
     * (its guard failed, "no guard, no runner") and the owner didn't stop (Stop deletes the token).
     * Makes it again, with a wait that doubles from 10 s up to 5 min between failed tries. Skips a
     * host that can't load the guard rules at all. Runs on the same timer as reconcileGuards.
     * Returns the companies it brought back; throws with each failure.
     */
    async healMissing(now = Date.now()) {
      const healed: string[] = [];
      const errors: string[] = [];
      let slugs: string[];
      try {
        slugs = readdirSync(path.join(cfg.dataRoot, "companies"));
      } catch {
        return healed;
      }
      const present = new Set((await this.list()).map((r) => r.slug));
      for (const slug of slugs) {
        if (!SLUG.test(slug) || present.has(slug) || noRetry.has(slug) || !existsSync(tokenFile(cfg, slug))) continue;
        if (now < (healing.get(slug)?.nextAt ?? 0)) continue;
        await locked(slug, async () => {
          // Looked at again inside the lock: a put, remove or restart may have just run.
          if (!existsSync(tokenFile(cfg, slug)) || (await ours(slug))) return;
          try {
            await create(slug);
            healing.delete(slug);
            healed.push(slug);
          } catch (err) {
            const fails = (healing.get(slug)?.fails ?? 0) + 1;
            healing.set(slug, { fails, nextAt: now + Math.min(10_000 * 2 ** (fails - 1), 300_000) });
            throw err;
          }
        }).catch((err: unknown) => errors.push(`${slug}: ${String((err as Error)?.message ?? err)}`));
      }
      if (errors.length) throw new Error(errors.join("; "));
      return healed;
    },

    /** One company's runner again on the current image, with its own token: how a drain swaps runners one by one. // leader-only (the server decides when) */
    // A failed earlier try may have left no container (create removes the old one first), so a company that still has its
    // token counts as ours: the drain retries it (BOS-382). Stop removes the token, so a stopped company is still refused.
    recreate: (slug: string) => locked(slug, async () => {
      if (!(await ours(slug)) && !existsSync(tokenFile(cfg, slug))) throw new LauncherError(404, "There's no runner for that company.");
      return { slug, id: await create(slug) };
    }),

    /** BOS-382: the swap to the new image failed, so this company's runner goes back on the image it ran before. // leader-only */
    rollback: (slug: string) => locked(slug, async () => {
      if (!(await ours(slug)) && !existsSync(tokenFile(cfg, slug))) throw new LauncherError(404, "There's no runner for that company.");
      const previous = previousRunnerImage(cfg.stack);
      if (!(await docker.imageId(previous))) throw new LauncherError(409, `There is no previous runner image (${previous}) to go back to.`);
      return { slug, id: await create(slug, previous), image: previous };
    }),

    /** For scripts/update-runner.sh --now: every runner again on the current image, with its own token. */
    async recreateAll() {
      const done: string[] = [];
      for (const r of await this.list()) {
        await locked(r.slug, () => create(r.slug));
        done.push(r.slug);
      }
      return done;
    },
  };
}

type Api = ReturnType<typeof launcher>;
type Log = (entry: Record<string, unknown>) => void;

function sameKey(given: string, key: Buffer) {
  const g = Buffer.from(given);
  return g.length === key.length && timingSafeEqual(g, key);
}

/**
 * The { allow: ["host:port", …], private?: ["host:port", …] } body of the tool-server allow list.
 * `private` names the entries the owner trusted for private addresses (BOS-708); an older server sends only `allow`.
 */
function allowFrom(body: unknown): { allow: string[]; trusted: Set<string> } {
  const b = body && typeof body === "object" ? (body as { allow?: unknown; private?: unknown }) : {};
  const allow = b.allow;
  if (!Array.isArray(allow) || allow.length > 100 || !allow.every((a) => typeof a === "string")) throw new LauncherError(400, "Send { allow: [host:port, …] }.");
  const priv = b.private;
  if (priv !== undefined && (!Array.isArray(priv) || priv.length > 100 || !priv.every((a) => typeof a === "string"))) throw new LauncherError(400, "Send { private: [host:port, …] }.");
  try {
    const list = parseAllow(allow as string[]);
    const trusted = parseTrusted(priv as string[] | undefined);
    // A trusted entry not in the allow list would do nothing; ignore it rather than open a port.
    for (const t of trusted) if (!list.includes(t)) trusted.delete(t);
    return { allow: list, trusted };
  } catch (err) {
    throw new LauncherError(400, (err as Error).message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new LauncherError(413, "Too big.");
    chunks.push(c);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LauncherError(400, "The body isn't JSON.");
  }
}

/** The HTTP server: a bearer key on every call, the five routes, and an audit line per call. */
export function launcherServer(api: Api, key: Buffer, log: Log = (e) => console.log(JSON.stringify(e))) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://launcher");
    const entry: Record<string, unknown> = { at: new Date().toISOString(), method: req.method, path: url.pathname };
    const send = (status: number, body: unknown) => {
      entry.status = status;
      log(entry);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    try {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !sameKey(auth.slice(7), key)) return send(401, { error: "unauthorized" });
      if (url.search) throw new LauncherError(400, "No query parameters.");

      if (url.pathname === "/cpu") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, api.cpu());
      }
      if (url.pathname === "/netguard") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, api.netguard());
      }
      if (url.pathname === "/runners") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, await api.list());
      }
      if (url.pathname === "/checks") {
        if (req.method === "GET") return send(200, await api.checks());
        if (req.method !== "PUT") throw new LauncherError(405, "Only GET or PUT here.");
        const body = await readJson(req);
        // { slots } from an older server, { slots, agents } since BOS-1498; nothing else.
        const b = body as { slots?: unknown; agents?: unknown };
        const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
        if (!keys || typeof b.slots !== "number" || !keys.every((k) => k === "slots" || k === "agents") || (keys.includes("agents") && typeof b.agents !== "number")) throw new LauncherError(400, "Send { slots } or { slots, agents }.");
        return send(200, await api.setChecks(b.slots, b.agents as number | undefined));
      }
      if (url.pathname === "/wanted") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, await api.wanted());
      }
      const m = /^\/runners\/([^/]+)(\/restart|\/recreate|\/previous|\/allow)?$/.exec(url.pathname);
      if (!m) throw new LauncherError(404, "Unknown call.");
      const slug = decodeURIComponent(m[1]!);
      if (!SLUG.test(slug)) throw new LauncherError(400, "Bad company slug.");
      entry.slug = slug;
      const body = await readJson(req);

      if (m[2] === "/allow") {
        if (req.method !== "PUT") throw new LauncherError(405, "Only PUT here.");
        const { allow, trusted } = allowFrom(body);
        return send(200, await api.setAllow(slug, allow, trusted));
      }
      if (m[2]) {
        if (req.method !== "POST") throw new LauncherError(405, "Only POST here.");
        if (body !== undefined && !(typeof body === "object" && body && Object.keys(body).length === 0)) throw new LauncherError(400, "Restart and recreate take no body.");
        return send(200, m[2] === "/recreate" ? await api.recreate(slug) : m[2] === "/previous" ? await api.rollback(slug) : await api.restart(slug));
      }
      if (req.method === "PUT") {
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new LauncherError(400, "Send { token }.");
        const keys = Object.keys(body);
        if (!keys.includes("token") || keys.some((k) => k !== "token" && k !== "allow" && k !== "private")) throw new LauncherError(400, "Only { token, allow, private } is accepted.");
        const token = (body as { token: unknown }).token;
        if (typeof token !== "string" || !TOKEN.test(token)) throw new LauncherError(400, "That isn't a runner token.");
        if ("allow" in body) {
          const { allow, trusted } = allowFrom({ allow: (body as { allow: unknown }).allow, private: (body as { private?: unknown }).private });
          return send(200, await api.put(slug, token, allow, trusted));
        }
        return send(200, await api.put(slug, token));
      }
      if (req.method === "DELETE") {
        if (body !== undefined) throw new LauncherError(400, "Delete takes no body.");
        return send(200, await api.remove(slug));
      }
      throw new LauncherError(405, "Use PUT, DELETE, or POST …/restart or …/recreate.");
    } catch (err) {
      if (err instanceof LauncherError) return send(err.status, { error: err.message });
      if (err instanceof DockerError) {
        entry.error = err.message;
        return send(502, { error: err.message });
      }
      entry.error = String((err as Error)?.message ?? err);
      return send(500, { error: "The launcher failed; see its log." });
    }
  });
}
