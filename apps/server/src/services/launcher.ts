// Company runners through the launcher (R55): the server issues the runner token and asks the
// launcher to start the container with it, so nobody copies tokens into files. The launcher
// is optional (BOSSMAN_LAUNCHER=1); without it the owner registers runners by hand as before.
import { readFile } from "node:fs/promises";
import { eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, mcpServers, settings } from "../db/schema.js";
import type { runnersService } from "./runners.js";

export type LauncherOptions = { url: string; keyFile: string };
/** `current`: running the image `boss-man-runner:current` points at now (absent from a launcher older than the server). */
export type LaunchedRunner = { slug: string; state: string; status: string; image: string; current?: boolean; guard?: "on" | "off" | "unavailable" };

export class LauncherError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SLUG_KEY = "runner-slug:";

/** A company name as a launcher slug: lower case, dashes, at most 40 characters. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34)
    .replace(/-+$/, "");
  return s || "company";
}

/** host:port of a tool server's URL, or null if it has none the network guard could allow (an IPv6 literal, a bad URL). */
export function toolServerAddress(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("[")) return null;
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

export function launcherService(db: Db, deps: { runners: ReturnType<typeof runnersService>; options?: LauncherOptions; fetch?: typeof fetch }) {
  const http = deps.fetch ?? fetch;
  const opts = deps.options;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!opts) throw new LauncherError(409, "The launcher isn't turned on (BOSSMAN_LAUNCHER=1).");
    let key: string;
    try {
      key = (await readFile(opts.keyFile, "utf8")).trim();
    } catch {
      throw new LauncherError(503, "The launcher's key isn't there yet. Is the launcher running?");
    }
    let res: Response;
    try {
      res = await http(`${opts.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new LauncherError(503, `Couldn't reach the launcher: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new LauncherError(res.status === 404 ? 404 : 502, json?.error ?? `The launcher answered ${res.status}.`);
    return json as T;
  }

  /** The company's slug, chosen once (from its name, made unique) and kept if it's renamed. */
  async function slugFor(companyId: string): Promise<string> {
    const [kept] = await db.select().from(settings).where(eq(settings.key, `${SLUG_KEY}${companyId}`));
    if (kept) return kept.value as string;
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    if (!c) throw new LauncherError(404, "No such company.");
    const taken = new Set((await db.select({ value: settings.value }).from(settings).where(like(settings.key, `${SLUG_KEY}%`))).map((r) => r.value as string));
    const base = slugify(c.name);
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    await db.insert(settings).values({ key: `${SLUG_KEY}${companyId}`, value: slug }).onConflictDoNothing();
    const [now] = await db.select().from(settings).where(eq(settings.key, `${SLUG_KEY}${companyId}`));
    return now!.value as string;
  }

  /** The company's tool servers as host:port: the runner's network guard keeps these reachable on private addresses. */
  async function allowFor(companyId: string): Promise<string[]> {
    const rows = await db.select({ url: mcpServers.url }).from(mcpServers).where(eq(mcpServers.companyId, companyId));
    return [...new Set(rows.map((r) => toolServerAddress(r.url)).filter((a): a is string => !!a))];
  }

  return {
    enabled: !!opts,

    /** Whether runners keep a core back for the server, database and proxy, and which threads. Null when the launcher is off or can't be reached. */
    async cpuReserve(): Promise<unknown> {
      if (!opts) return null;
      try {
        return await call<unknown>("GET", "/cpu");
      } catch {
        return null;
      }
    },

    /** Tells the launcher the company's tool servers again (after one is added or removed). Best effort: a launcher that is down picks them up at the next start. */
    async syncAllow(companyId: string) {
      if (!opts) return;
      try {
        await call("PUT", `/runners/${await slugFor(companyId)}/allow`, { allow: await allowFor(companyId) });
      } catch {
        /* the next runner start sends the list again */
      }
    },

    /** Starts the runner, or reconnects it: a new token, written by the launcher, and a fresh container. */
    async start(companyId: string) {
      const slug = await slugFor(companyId);
      // The launcher must answer before the token changes, or a working runner would be cut off for nothing.
      await call("GET", "/runners");
      const { token } = await deps.runners.register(companyId);
      await call("PUT", `/runners/${slug}`, { token, allow: await allowFor(companyId) });
      return { slug };
    },

    async restart(companyId: string) {
      const slug = await slugFor(companyId);
      await call("POST", `/runners/${slug}/restart`);
      return { slug };
    },

    /** Stops and removes the container; the company's workspaces and sessions stay on disk. */
    async stop(companyId: string) {
      const slug = await slugFor(companyId);
      await call("DELETE", `/runners/${slug}`);
      return { slug };
    },

    /** For the drain: every runner with its company (null if the server has no company for that slug). */
    async fleet() {
      const all = await call<LaunchedRunner[]>("GET", "/runners");
      const rows = await db.select().from(settings).where(like(settings.key, `${SLUG_KEY}%`));
      const company = new Map(rows.map((r) => [r.value as string, r.key.slice(SLUG_KEY.length)]));
      return all.map((r) => ({ slug: r.slug, companyId: company.get(r.slug) ?? null, current: r.current }));
    },

    /** One company's runner again on the current image; the launcher keeps its token and data. // leader-only */
    async recreate(slug: string) {
      await call("POST", `/runners/${slug}/recreate`);
    },

    async status(companyId: string): Promise<{ slug: string; container: LaunchedRunner | null; error?: string } | null> {
      if (!opts) return null;
      const slug = await slugFor(companyId);
      try {
        const all = await call<LaunchedRunner[]>("GET", "/runners");
        return { slug, container: all.find((r) => r.slug === slug) ?? null };
      } catch (err) {
        return { slug, container: null, error: (err as Error).message };
      }
    },
  };
}
