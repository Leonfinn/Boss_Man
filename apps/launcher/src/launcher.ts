// The launcher's API (R55): five calls, each about one company's runner, and nothing else.
// The server holds the key; Docker is reached only from here, with a spec the launcher builds.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DockerError, type Docker } from "./docker.js";
import { COMPANY_LABEL, companyDir, containerName, containerSpec, IMAGE, LABEL, MOUNTS, SLUG, tokenFile, type LauncherConfig } from "./spec.js";

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
export type RunnerStatus = { slug: string; state: string; status: string; image: string; current: boolean };

export function launcher(cfg: LauncherConfig, docker: Docker) {
  /** The container for a slug, if the launcher made it; anything else under that name is refused. */
  async function ours(slug: string) {
    const c = await docker.inspect(containerName(slug));
    if (!c) return null;
    const labels = c.Config.Labels ?? {};
    if (labels[LABEL] !== "1" || labels[COMPANY_LABEL] !== slug) throw new LauncherError(409, `A container called ${containerName(slug)} exists that the launcher didn't make; it won't touch it.`);
    return c;
  }

  async function create(slug: string) {
    // Every bind source must exist first: Docker would make a missing one owned by root, which the runner can't write.
    for (const [sub] of MOUNTS) mkdirSync(path.join(companyDir(cfg, slug), sub), { recursive: true, mode: 0o700 });
    const old = await ours(slug);
    if (old) await docker.remove(old.Id);
    const id = await docker.create(containerName(slug), containerSpec(cfg, slug));
    await docker.start(id);
    return id;
  }

  return {
    /** Writes the token, then creates (or recreates) and starts the runner. Data folders are kept. */
    async put(slug: string, token: string) {
      mkdirSync(companyDir(cfg, slug), { recursive: true, mode: 0o700 });
      // Written beside the target and renamed, so a runner never reads half a token.
      const tmp = `${tokenFile(cfg, slug)}.tmp`;
      writeFileSync(tmp, token, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, tokenFile(cfg, slug));
      const id = await create(slug);
      return { slug, id };
    },

    async restart(slug: string) {
      const c = await ours(slug);
      if (!c) throw new LauncherError(404, "There's no runner for that company.");
      await docker.restart(c.Id);
      return { slug, id: c.Id };
    },

    /** Stops and removes the runner and its token. Its workspaces, journal and sessions stay. */
    async remove(slug: string) {
      const c = await ours(slug);
      if (c) await docker.remove(c.Id);
      rmSync(tokenFile(cfg, slug), { force: true });
      return { slug, removed: !!c };
    },

    async list(): Promise<RunnerStatus[]> {
      const all = await docker.list(`${LABEL}=1`);
      const current = await docker.imageId(IMAGE);
      return all
        .filter((c) => SLUG.test(c.Labels[COMPANY_LABEL] ?? "") && c.Names.includes(`/${containerName(c.Labels[COMPANY_LABEL]!)}`))
        .map((c) => ({ slug: c.Labels[COMPANY_LABEL]!, state: c.State, status: c.Status, image: c.Image, current: !!current && c.ImageID === current }));
    },

    /** One company's runner again on the current image, with its own token: how a drain swaps runners one by one. // leader-only (the server decides when) */
    async recreate(slug: string) {
      if (!(await ours(slug))) throw new LauncherError(404, "There's no runner for that company.");
      return { slug, id: await create(slug) };
    },

    /** For scripts/update-runner.sh --now: every runner again on the current image, with its own token. */
    async recreateAll() {
      const done: string[] = [];
      for (const r of await this.list()) {
        await create(r.slug);
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
      const m = /^\/runners\/([^/]+)(\/restart|\/recreate)?$/.exec(url.pathname);
      if (!m) throw new LauncherError(404, "Unknown call.");
      const slug = decodeURIComponent(m[1]!);
      if (!SLUG.test(slug)) throw new LauncherError(400, "Bad company slug.");
      entry.slug = slug;
      const body = await readJson(req);

      if (m[2]) {
        if (req.method !== "POST") throw new LauncherError(405, "Only POST here.");
        if (body !== undefined && !(typeof body === "object" && body && Object.keys(body).length === 0)) throw new LauncherError(400, "Restart and recreate take no body.");
        return send(200, m[2] === "/recreate" ? await api.recreate(slug) : await api.restart(slug));
      }
      if (req.method === "PUT") {
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new LauncherError(400, "Send { token }.");
        const keys = Object.keys(body);
        if (keys.length !== 1 || keys[0] !== "token") throw new LauncherError(400, "Only { token } is accepted.");
        const token = (body as { token: unknown }).token;
        if (typeof token !== "string" || !TOKEN.test(token)) throw new LauncherError(400, "That isn't a runner token.");
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
