// The launcher's API (R55): five calls, each about one company's runner, and nothing else.
// The server holds the key; Docker is reached only from here, with a spec the launcher builds.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DockerError, type Docker } from "./docker.js";
import { COMPANY_LABEL, companyDir, containerName, containerSpec, IMAGE, LABEL, PREVIOUS_IMAGE, MOUNTS, netguardDir, netguardName, netguardSpec, NETGUARD_IMAGE, NETGUARD_LABEL, NETGUARD_UNAVAILABLE_EXIT, parseAllow, SLUG, tokenFile, type LauncherConfig } from "./spec.js";

const TOKEN = /^bmr_[A-Za-z0-9_-]{20,200}$/;
const MAX_BODY = 4096;

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
 * "on": the guard is loaded; "off": turned off by BOSSMAN_NETGUARD=off; "unavailable": this host can't load the rules
 * (BOSSMAN_NETGUARD=auto lets the runner go without). DR-007: "retrying": the guard is being started again (the runner
 * keeps working when its rules are still in force, or is paused while they aren't); "frozen": it didn't come back
 * in time, so the runner stays paused (or stopped) with its work kept, until the guard works or the owner acts.
 */
export type GuardStatus = "on" | "off" | "unavailable" | "retrying" | "frozen";
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
    const c = await docker.inspect(containerName(slug));
    if (!c) return null;
    const labels = c.Config.Labels ?? {};
    if (labels[LABEL] !== "1" || labels[COMPANY_LABEL] !== slug) throw new LauncherError(409, `A container called ${containerName(slug)} exists that the launcher didn't make; it won't touch it.`);
    return c;
  }

  /** The slug's network guard, if there is one; a container of that name that isn't ours is refused. */
  async function guardOf(slug: string) {
    const g = await docker.inspect(netguardName(slug));
    if (!g) return null;
    const labels = g.Config.Labels ?? {};
    if (labels[NETGUARD_LABEL] !== "1" || labels[COMPANY_LABEL] !== slug) throw new LauncherError(409, `A container called ${netguardName(slug)} exists that the launcher didn't make; it won't touch it.`);
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
  /** Companies whose guard can't run on this host (auto mode); set when the guard exits with netguard.sh's "no nftables" code. */
  const unavailable = new Set<string>();

  /** Waits until the guard has loaded its rules (its healthcheck passes); throws if it stops first. */
  async function guardReady(slug: string) {
    const deadline = Date.now() + (cfg.guardReadyMs ?? 20_000);
    for (;;) {
      const g = await guardOf(slug);
      if (!g || g.State.Status === "exited" || g.State.Status === "dead") throw new GuardUnavailable(g?.State.ExitCode === NETGUARD_UNAVAILABLE_EXIT, `The network guard for ${slug} stopped (exit code ${g?.State.ExitCode ?? "unknown"}); see \`docker logs ${netguardName(slug)}\`.`);
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
    unavailable.delete(slug);
    if (mode === "off") return;
    try {
      // DR-007 row 3: check the guard can be made at all before taking the old one away. Without the
      // image the old guard stays, and so do the rules it loaded.
      if (!(await docker.imageId(NETGUARD_IMAGE))) throw new GuardUnavailable(false, `The network guard image ${NETGUARD_IMAGE} is missing on this host; run the runner update to build it.`);
      const old = await guardOf(slug);
      if (old) await removeSettled(docker, old.Id);
      mkdirSync(netguardDir(cfg, slug), { recursive: true, mode: 0o755 });
      await docker.start(await docker.create(netguardName(slug), netguardSpec(cfg, slug, runnerId)));
      await guardReady(slug);
      // Which runner start these rules belong to: a later check can then tell "guard gone, rules still in force"
      // (same start) from "runner restarted, new namespace with no rules" (a different start).
      const r = await ours(slug);
      if (r?.Id === runnerId && r.State.StartedAt) writeMarker(slug, r.State.StartedAt);
      trouble.delete(slug);
    } catch (err) {
      if (err instanceof GuardUnavailable && err.hostCannot && mode === "auto") {
        unavailable.add(slug);
        console.error(JSON.stringify({ at: new Date().toISOString(), msg: "network guard unavailable on this host; the runner is not guarded", slug }));
        return;
      }
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

  /** Writes the tool-server allow list the guard reads (host:port lines); the guard picks it up within 15 s. */
  function writeAllow(slug: string, hosts: string[]) {
    const dir = netguardDir(cfg, slug);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = path.join(dir, "allow.tmp");
    writeFileSync(tmp, hosts.map((h) => `${h}\n`).join(""), { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, path.join(dir, "allow"));
  }

  async function create(slug: string, image: string = IMAGE) {
    // Every bind source must exist first: Docker would make a missing one owned by root, which the runner can't write.
    for (const [sub] of MOUNTS) mkdirSync(path.join(companyDir(cfg, slug), sub), { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(netguardDir(cfg, slug), "allow"))) writeAllow(slug, []);
    const old = await ours(slug);
    if (old) await removeSettled(docker, old.Id);
    const id = await docker.create(containerName(slug), containerSpec(cfg, slug, image));
    await docker.start(id);
    try {
      await guard(slug, id);
    } catch (err) {
      // No guard, no runner: a runner that can reach the private networks must not be left running.
      await docker.remove(id).catch(() => undefined);
      throw err;
    }
    return id;
  }

  return {
    /** Writes the token, then creates (or recreates) and starts the runner. Data folders are kept. */
    put: (slug: string, token: string, allow?: string[]) => locked(slug, async () => {
      mkdirSync(companyDir(cfg, slug), { recursive: true, mode: 0o700 });
      // Written beside the target and renamed, so a runner never reads half a token.
      const tmp = `${tokenFile(cfg, slug)}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, tokenFile(cfg, slug));
      if (allow) writeAllow(slug, parseAllow(allow));
      const id = await create(slug);
      return { slug, id };
    }),

    /** Replaces the company's tool-server allow list (host:port); no restart, the guard re-reads it. */
    setAllow: (slug: string, allow: string[]) => locked(slug, async () => {
      writeAllow(slug, parseAllow(allow));
      return { slug, allow: parseAllow(allow) };
    }),

    restart: (slug: string) => locked(slug, async () => {
      const c = await ours(slug);
      if (!c) throw new LauncherError(404, "There's no runner for that company.");
      await docker.restart(c.Id);
      try {
        await guard(slug, c.Id);
      } catch (err) {
        // DR-007 row 4: the restart gave it a new namespace with no rules. Freeze it (stop if this host can't
        // pause) rather than remove it: its workspaces and sessions stay, and the guard check keeps retrying.
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
      unavailable.delete(slug);
      trouble.delete(slug);
      rmSync(tokenFile(cfg, slug), { force: true });
      return { slug, removed: !!c };
    }),

    async list(): Promise<RunnerStatus[]> {
      const all = await docker.list(`${LABEL}=1`);
      const current = await docker.imageId(IMAGE);
      return all
        .filter((c) => SLUG.test(c.Labels[COMPANY_LABEL] ?? "") && c.Names.includes(`/${containerName(c.Labels[COMPANY_LABEL]!)}`))
        .map((c) => {
          const slug = c.Labels[COMPANY_LABEL]!;
          const t = trouble.get(slug);
          const guard: GuardStatus = mode === "off" ? "off" : unavailable.has(slug) ? "unavailable" : t ? t.state : "on";
          return { slug, state: c.State, status: c.Status, image: c.Image, current: !!current && c.ImageID === current, guard, ...(t ? { guardReason: t.reason, guardSince: new Date(t.since).toISOString() } : {}) };
        });
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
        if ((r.state !== "running" && r.state !== "paused") || r.guard === "off" || r.guard === "unavailable") continue;
        await locked(r.slug, async () => {
          // Looked at again inside the lock: a create or restart may have just made a guard.
          const c = await ours(r.slug);
          const status = c?.State.Status;
          if (!c || (status !== "running" && status !== "paused")) return;
          const startedAt = c.State.StartedAt ?? "";
          const paused = status === "paused";
          const g = await guardOf(r.slug);
          const fresh = !paused && g && g.State.Status === "running" && new Date(g.State.StartedAt ?? 0).getTime() >= new Date(startedAt || 0).getTime();
          if (fresh) {
            // An install from before the marker: the running guard started after this runner, so its rules are this runner's.
            if (startedAt && readMarker(r.slug) !== startedAt) writeMarker(r.slug, startedAt);
            trouble.delete(r.slug);
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
          if (!sameStart && !paused) {
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
            await guard(r.slug, c.Id);
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
      if (!(await docker.imageId(PREVIOUS_IMAGE))) throw new LauncherError(409, `There is no previous runner image (${PREVIOUS_IMAGE}) to go back to.`);
      return { slug, id: await create(slug, PREVIOUS_IMAGE), image: PREVIOUS_IMAGE };
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

/** The { allow: ["host:port", …] } body of the tool-server allow list. */
function allowFrom(body: unknown): string[] {
  const allow = body && typeof body === "object" ? (body as { allow?: unknown }).allow : undefined;
  if (!Array.isArray(allow) || allow.length > 100 || !allow.every((a) => typeof a === "string")) throw new LauncherError(400, "Send { allow: [host:port, …] }.");
  try {
    return parseAllow(allow as string[]);
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

      if (url.pathname === "/runners") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, await api.list());
      }
      const m = /^\/runners\/([^/]+)(\/restart|\/recreate|\/previous|\/allow)?$/.exec(url.pathname);
      if (!m) throw new LauncherError(404, "Unknown call.");
      const slug = decodeURIComponent(m[1]!);
      if (!SLUG.test(slug)) throw new LauncherError(400, "Bad company slug.");
      entry.slug = slug;
      const body = await readJson(req);

      if (m[2] === "/allow") {
        if (req.method !== "PUT") throw new LauncherError(405, "Only PUT here.");
        return send(200, await api.setAllow(slug, allowFrom(body)));
      }
      if (m[2]) {
        if (req.method !== "POST") throw new LauncherError(405, "Only POST here.");
        if (body !== undefined && !(typeof body === "object" && body && Object.keys(body).length === 0)) throw new LauncherError(400, "Restart and recreate take no body.");
        return send(200, m[2] === "/recreate" ? await api.recreate(slug) : m[2] === "/previous" ? await api.rollback(slug) : await api.restart(slug));
      }
      if (req.method === "PUT") {
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new LauncherError(400, "Send { token }.");
        const keys = Object.keys(body);
        if (!keys.includes("token") || keys.some((k) => k !== "token" && k !== "allow")) throw new LauncherError(400, "Only { token, allow } is accepted.");
        const token = (body as { token: unknown }).token;
        if (typeof token !== "string" || !TOKEN.test(token)) throw new LauncherError(400, "That isn't a runner token.");
        return send(200, await api.put(slug, token, "allow" in body ? allowFrom({ allow: (body as { allow: unknown }).allow }) : undefined));
      }
      if (req.method === "DELETE") {
        if (body !== undefined) throw new LauncherError(400, "Delete takes no body.");
        return send(200, await api.remove(slug));
      }
      throw new LauncherError(405, "Use PUT, DELETE, or POST …/restart, …/recreate or …/previous.");
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
