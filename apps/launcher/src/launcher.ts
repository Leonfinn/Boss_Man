// The launcher's API (R55): five calls, each about one company's runner, and nothing else.
// The server holds the key; Docker is reached only from here, with a spec the launcher builds.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DockerError, type Docker } from "./docker.js";
import { COMPANY_LABEL, companyDir, containerName, containerSpec, IMAGE, LABEL, MOUNTS, netguardDir, netguardName, netguardSpec, NETGUARD_LABEL, NETGUARD_UNAVAILABLE_EXIT, parseAllow, parseTrusted, SLUG, tokenFile, type LauncherConfig } from "./spec.js";

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
export type RunnerStatus = { slug: string; state: string; status: string; image: string; current: boolean; guard: GuardStatus };
/** "on": the guard container is running and newer than the runner; "off": turned off by BOSSMAN_NETGUARD=off; "unavailable": this host can't load the rules (BOSSMAN_NETGUARD=auto lets the runner go without); "down": the guard is missing, stopped, unhealthy or older than the runner, so the runner is unguarded until reconcile repairs it. */
export type GuardStatus = "on" | "off" | "unavailable" | "down";

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
    if (mode === "off") return;
    try {
      const old = await guardOf(slug);
      if (old) await removeSettled(docker, old.Id);
      mkdirSync(netguardDir(cfg, slug), { recursive: true, mode: 0o755 });
      await docker.start(await docker.create(netguardName(slug), netguardSpec(cfg, slug, runnerId)));
      await guardReady(slug);
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

  async function create(slug: string) {
    // Every bind source must exist first: Docker would make a missing one owned by root, which the runner can't write.
    for (const [sub] of MOUNTS) mkdirSync(path.join(companyDir(cfg, slug), sub), { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(netguardDir(cfg, slug), "allow"))) writeAllow(slug, []);
    const old = await ours(slug);
    if (old) await removeSettled(docker, old.Id);
    const id = await docker.create(containerName(slug), containerSpec(cfg, slug));
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
    /** What the CPU reserve decided at start (cpu-layout.ts): on or off, which threads, and why. */
    cpu: () => cfg.cpuPlan ?? { on: false, reserved: [] as number[], runnerThreads: [] as number[], hostThreads: 0, reason: "Not worked out." },
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
      await docker.restart(c.Id);
      try {
        await guard(slug, c.Id);
      } catch (err) {
        // No guard, no runner (same as create).
        await docker.remove(c.Id).catch(() => undefined);
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
      rmSync(tokenFile(cfg, slug), { force: true });
      return { slug, removed: !!c };
    }),

    async list(): Promise<RunnerStatus[]> {
      const all = await docker.list(`${LABEL}=1`);
      const current = await docker.imageId(IMAGE);
      const mine = all.filter((c) => SLUG.test(c.Labels[COMPANY_LABEL] ?? "") && c.Names.includes(`/${containerName(c.Labels[COMPANY_LABEL]!)}`));
      return Promise.all(
        mine.map(async (c) => {
          const slug = c.Labels[COMPANY_LABEL]!;
          const info = mode === "off" ? null : await docker.inspect(containerName(slug)).catch(() => null);
          return { slug, state: c.State, status: c.Status, image: c.Image, current: !!current && c.ImageID === current, guard: await guardStatus(slug, info?.State.StartedAt) };
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
        if (r.state !== "running" || r.guard === "off" || r.guard === "unavailable") continue;
        await locked(r.slug, async () => {
          // Looked at again inside the lock: a create or restart may have just made a guard.
          const c = await ours(r.slug);
          if (!c || c.State.Status !== "running") return;
          const g = await guardOf(r.slug);
          const fresh = g && g.State.Status === "running" && new Date(g.State.StartedAt ?? 0).getTime() >= new Date(c.State.StartedAt ?? 0).getTime();
          if (fresh) return;
          try {
            await guard(r.slug, c.Id);
          } catch (err) {
            // No guard, no runner: don't leave it running in a namespace with no rules.
            await docker.remove(c.Id).catch(() => undefined);
            throw err;
          }
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
    recreate: (slug: string) => locked(slug, async () => {
      if (!(await ours(slug))) throw new LauncherError(404, "There's no runner for that company.");
      return { slug, id: await create(slug) };
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
      if (url.pathname === "/runners") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, await api.list());
      }
      if (url.pathname === "/wanted") {
        if (req.method !== "GET") throw new LauncherError(405, "Only GET here.");
        return send(200, await api.wanted());
      }
      const m = /^\/runners\/([^/]+)(\/restart|\/recreate|\/allow)?$/.exec(url.pathname);
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
        return send(200, m[2] === "/recreate" ? await api.recreate(slug) : await api.restart(slug));
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
