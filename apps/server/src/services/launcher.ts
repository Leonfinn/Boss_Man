// Company runners through the launcher (R55): the server issues the runner token and asks the
// launcher to start the container with it, so nobody copies tokens into files. The launcher
// is optional (BOSSMAN_LAUNCHER=1); without it the owner registers runners by hand as before.
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { and, eq, isNotNull, isNull, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, mcpServers, projects, runners, settings } from "../db/schema.js";
import { expectRestart } from "./runner-restarts.js";
import type { runnersService } from "./runners.js";

export type LauncherOptions = { url: string; keyFile: string };
/** `current`: running the image `boss-man-runner:current` points at now (absent from a launcher older than the server). */
export type LaunchedRunner = { slug: string; state: string; status: string; image: string; current?: boolean; guard?: "on" | "off" | "unavailable" | "down" };

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

/**
 * Boss Man's own services on the compose network (docker-compose.yml: db, server, launcher, netguard, and the
 * runner-* containers). A tool server aimed at one opens a direct path from the runner to it, whatever the port.
 * The deployer is a file inbox, not a network service, so it has no entry. Matched on the host name alone.
 */
const STACK_SERVICE_HOSTS = /^(db|server|server-blue|server-green|proxy|migrate|ntfy|tailscale|launcher|netguard|postgres|runner(-[a-z0-9-]+)?)$/;
export function isStackService(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return STACK_SERVICE_HOSTS.test(host);
  } catch {
    return false;
  }
}

/** True for loopback, private, link-local, CGNAT and unspecified addresses (IPv4, IPv6, and IPv4-mapped IPv6): where the stack's containers live. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^::ffff:/.test(l);
  }
  return false;
}

export type HostLookup = (host: string) => Promise<string[]>;
const systemLookup: HostLookup = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

/** A name meant for the LAN or the compose network: no dot (a container name), or a .local/.internal/.lan/.home/.docker/.localhost name. */
const STACK_LIKE_NAME = (host: string) => !host.includes(".") || /\.(local|internal|localhost|lan|home|docker)$/.test(host);

/** The URL's host name, lower-cased and without a trailing dot, or null if it isn't one the guard handles (a bad URL, an IPv6 literal). */
function guardHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host.startsWith("[") ? null : host;
  } catch {
    // An ssh scp-style git remote (git@host:path) isn't a URL; read its host the same way rawGitHostAddress does, so a
    // project's ssh git address is checked and trusted like any other (BOS-708).
    const scp = /^[\w.-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(url);
    return scp ? scp[1]!.toLowerCase().replace(/\.$/, "") : null;
  }
}

/**
 * Whether a tool server's URL could reach Boss Man's own services (best effort; the preview's host:port is the owner's real control).
 * Flags: the known service names, any name with no dot (a compose or container name such as boss-man-db-1, localhost),
 * .local/.internal/.localhost names, IP literals in private/loopback/link-local ranges (a LAN host is flagged too: the owner ticks to allow it),
 * and any name that resolves to such an address. A lookup that fails or takes over 3 s counts as flagged (fail closed).
 * The netguard re-resolves every 15 s, so a name can point somewhere else after the import.
 */
export async function reachesStack(url: string, lookup: HostLookup = systemLookup): Promise<boolean> {
  if (isStackService(url)) return true;
  const host = guardHost(url);
  if (host === null) return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (STACK_LIKE_NAME(host)) return true;
  try {
    const addrs = await Promise.race([lookup(host), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000).unref())]);
    return addrs.length === 0 || addrs.some(isPrivateAddress);
  } catch {
    return true;
  }
}

/**
 * Whether the owner meant a tool server to reach a private address, so the guard keeps private addresses for it (BOS-708).
 * Unlike the preview's reachesStack (fail closed so it flags generously), this decides trust so it fails closed the other way:
 * true only for a private IP literal (can't be re-pointed), a stack or LAN-style name (the owner typed a LAN host), or a name
 * that actually resolved with every address private. A lookup that errors, times out or comes back empty is not trusted, so a
 * public name can't be trusted by making its DNS fail at add time and then re-pointed at the stack.
 */
export async function allowsPrivate(url: string, lookup: HostLookup = systemLookup): Promise<boolean> {
  const host = guardHost(url);
  if (host === null) return false;
  if (isIP(host)) return isPrivateAddress(host);
  if (STACK_LIKE_NAME(host)) return true;
  try {
    const addrs = await Promise.race([lookup(host), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000).unref())]);
    return addrs.length > 0 && addrs.every(isPrivateAddress);
  } catch {
    return false;
  }
}

/**
 * Whether a git remote is a LAN host by its address alone: a private IP literal or a LAN-style name (the rule reachesStack
 * uses), with no DNS. A git host is trusted for private addresses only then, because whoever runs a public name's DNS (an
 * expired domain, a small forge) could point it at the stack network later (BOS-777). An ssh git@host:path remote counts too.
 */
export function isLanHost(url: string): boolean {
  const host = guardHost(url);
  if (host === null) return false;
  return isIP(host) ? isPrivateAddress(host) : STACK_LIKE_NAME(host);
}

/** The launcher's own check for an allow entry (apps/launcher/src/spec.ts): one bad entry makes it refuse the whole list, so never send one it would refuse. */
const LAUNCHER_ALLOW_ENTRY = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$/;
/** The host:port the guard would be told to allow for a tool server's URL, or null. */
export const sendableAddress = (url: string): string | null => sendable(toolServerAddress(url));

/**
 * One host:port the guard may open. `private` means the owner let it resolve to private addresses on purpose (an import tick,
 * a tool server they added on the LAN, or a LAN git host they set), so the guard keeps private addresses for it (BOS-708).
 */
export type AllowEntry = { addr: string; private: boolean };
function sendable(addr: string | null): string | null {
  if (!addr || !LAUNCHER_ALLOW_ENTRY.test(addr)) return null;
  const [host, port] = [addr.slice(0, addr.lastIndexOf(":")), Number(addr.slice(addr.lastIndexOf(":") + 1))];
  return port >= 1 && port <= 65535 && !host.endsWith(".") ? addr : null;
}

/** host:port of a project's git remote (http 80, https 443, ssh 22 unless it names a port), or null for a local path or anything the guard or launcher can't allow. */
export function gitHostAddress(repoUrl: string): string | null {
  return sendable(rawGitHostAddress(repoUrl));
}

function rawGitHostAddress(repoUrl: string): string | null {
  const scp = /^[\w.-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(repoUrl);
  if (scp) return `${scp[1]}:22`;
  try {
    const u = new URL(repoUrl);
    if (!["http:", "https:", "ssh:"].includes(u.protocol) || !u.hostname || u.hostname.startsWith("[")) return null;
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : u.protocol === "ssh:" ? "22" : "80")}`;
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

  /** The company's slug if it has one, else the one it would get; never saves one, so looking doesn't make a company launcher-run (BOS-497). */
  async function peekSlug(companyId: string): Promise<string> {
    const [kept] = await db.select().from(settings).where(eq(settings.key, `${SLUG_KEY}${companyId}`));
    if (kept) return kept.value as string;
    const [c] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    if (!c) throw new LauncherError(404, "No such company.");
    const taken = new Set((await db.select({ value: settings.value }).from(settings).where(like(settings.key, `${SLUG_KEY}%`))).map((r) => r.value as string));
    let slug = slugify(c.name);
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(c.name)}-${i}`;
    return slug;
  }

  /**
   * The company's tool servers and git remotes as host:port, each saying whether the owner allowed it on a private address.
   * A tool server the owner marked (import tick or a LAN host they added) and a LAN git host they set are trusted for private;
   * anything else is not, so the guard drops a private address a name may resolve to later (BOS-708).
   */
  async function allowFor(companyId: string): Promise<AllowEntry[]> {
    const rows = await db.select({ url: mcpServers.url, allowPrivate: mcpServers.allowPrivate }).from(mcpServers).where(eq(mcpServers.companyId, companyId));
    // The company's own git remotes: each project's host and port only, so its runner can clone and fetch from a LAN git server.
    // Only a project the owner (or a ticked import) let reach private addresses is trusted, so a git address that arrives in
    // a package can't open the stack network by resolving private (BOS-708).
    const repos = await db.select({ url: projects.repoUrl, allowPrivate: projects.allowPrivate }).from(projects).where(and(eq(projects.companyId, companyId), isNotNull(projects.repoUrl), isNull(projects.archivedAt)));
    const entries = [
      ...rows.map((r) => ({ addr: sendable(toolServerAddress(r.url)), private: r.allowPrivate })),
      // A public git name is never trusted, even with the project's flag on (rows saved before BOS-777 have it on for any host).
      ...repos.map((r) => ({ addr: gitHostAddress(r.url!), private: r.allowPrivate && isLanHost(r.url!) })),
    ];
    // Same host:port twice: keep it trusted if either source trusts it.
    const byAddr = new Map<string, boolean>();
    for (const e of entries) if (e.addr) byAddr.set(e.addr, (byAddr.get(e.addr) ?? false) || e.private);
    return [...byAddr].map(([addr, priv]) => ({ addr, private: priv }));
  }

  /**
   * The launcher body for a company's allow list: `allow` is plain host:port (an older launcher reads only that), `private`
   * names the entries the owner trusted for private addresses, so the guard keeps their private addresses (BOS-708).
   */
  async function allowBody(companyId: string): Promise<{ allow: string[]; private: string[] }> {
    const entries = await allowFor(companyId);
    return { allow: entries.map((e) => e.addr), private: entries.filter((e) => e.private).map((e) => e.addr) };
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

    /** The guard mode and the BOSSMAN_NETGUARD_ALLOW entries the launcher started with (BOS-770). Null when the launcher is off, can't be reached, or is older. */
    async netguardConfig(): Promise<{ mode: string; allow: string[] } | null> {
      if (!opts) return null;
      try {
        const r = await call<{ mode?: unknown; allow?: unknown }>("GET", "/netguard");
        if (typeof r?.mode !== "string" || !Array.isArray(r.allow)) return null;
        return { mode: r.mode, allow: r.allow.filter((a): a is string => typeof a === "string" && LAUNCHER_ALLOW_ENTRY.test(a)) };
      } catch {
        return null;
      }
    },

    /** What Boss Man already lets every company's runner reach, across all companies: tool servers and project git hosts (BOS-770). */
    async ownAllows(): Promise<{ toolServers: string[]; gitHosts: string[] }> {
      const rows = await db.select({ url: mcpServers.url }).from(mcpServers);
      const repos = await db.select({ url: projects.repoUrl }).from(projects).where(and(isNotNull(projects.repoUrl), isNull(projects.archivedAt)));
      const only = (a: (string | null)[]) => [...new Set(a.filter((x): x is string => !!x))];
      return { toolServers: only(rows.map((r) => sendable(toolServerAddress(r.url)))), gitHosts: only(repos.map((r) => gitHostAddress(r.url!))) };
    },

    /** Tells the launcher the company's tool servers again (after one is added or removed). Best effort: a launcher that is down picks them up at the next start. */
    async syncAllow(companyId: string) {
      if (!opts) return;
      try {
        await call("PUT", `/runners/${await slugFor(companyId)}/allow`, await allowBody(companyId));
      } catch {
        /* the next runner start sends the list again */
      }
    },

    /**
     * At server start (leader only): sends every launched company's runner its allow list once, so a runner that outlived a deploy gets the git hosts without a restart.
     * A launcher that is still coming up (503/502) is tried again; a company with no runner (404) is skipped. Best effort: never throws.
     * A slug whose company no longer exists has its runner and token removed instead (and the slug forgotten), so the launcher's
     * self-heal stops making a runner nobody can use again and again (BOS-497).
     */
    async syncAll(retryMs = 15_000, attempts = 4) {
      if (!opts) return;
      const rows = await db.select().from(settings).where(like(settings.key, `${SLUG_KEY}%`)).catch(() => []);
      const live = new Set((await db.select({ id: companies.id }).from(companies).catch(() => null))?.map((c) => c.id) ?? rows.map((r) => r.key.slice(SLUG_KEY.length)));
      for (const row of rows) {
        const companyId = row.key.slice(SLUG_KEY.length);
        const gone = !live.has(companyId);
        for (let i = 0; i < attempts; i++) {
          try {
            if (gone) {
              await call("DELETE", `/runners/${row.value as string}`);
              await db.delete(settings).where(eq(settings.key, row.key));
            } else await call("PUT", `/runners/${row.value as string}/allow`, await allowBody(companyId));
            break;
          } catch (err) {
            if (!(err instanceof LauncherError) || err.status === 404 || i === attempts - 1) break;
            await new Promise((r) => setTimeout(r, retryMs));
          }
        }
      }
    },

    /** Starts the runner, or reconnects it: a new token, written by the launcher, and a fresh container. */
    async start(companyId: string) {
      const slug = await slugFor(companyId);
      // The launcher must answer before the token changes, or a working runner would be cut off for nothing.
      await call("GET", "/runners");
      await expectRestart(db, companyId, "owner restart");
      const { token } = await deps.runners.register(companyId);
      const body = await allowBody(companyId);
      // Keep the token body to { token, allow }: an older launcher refuses the unknown `private` key with a 400, and the
      // token was already rotated, which would cut the runner off until the launcher is rebuilt (BOS-708). The private list
      // goes in a second call that an older launcher accepts, so a refusal there does no harm.
      await call("PUT", `/runners/${slug}`, { token, allow: body.allow });
      await call("PUT", `/runners/${slug}/allow`, body);
      return { slug };
    },

    async restart(companyId: string) {
      const slug = await slugFor(companyId);
      await expectRestart(db, companyId, "owner restart");
      await call("POST", `/runners/${slug}/restart`);
      return { slug };
    },

    /** Stops and removes the container; the company's workspaces and sessions stay on disk. */
    async stop(companyId: string) {
      const slug = await slugFor(companyId);
      await call("DELETE", `/runners/${slug}`);
      // A deliberate stop is not an outage: forget when it was last seen so the runner watch stays quiet.
      await db.update(runners).set({ lastSeenAt: null }).where(eq(runners.companyId, companyId));
      // Run by the launcher from now on, not by hand (runner-watch.ts HAND_RUN_KEY).
      await db.delete(settings).where(eq(settings.key, `runner-hand:${companyId}`));
      return { slug };
    },

    /** For the drain: every runner with its company (null if the server has no company for that slug). */
    async fleet() {
      const all = await call<LaunchedRunner[]>("GET", "/runners");
      const rows = await db.select().from(settings).where(like(settings.key, `${SLUG_KEY}%`));
      const company = new Map(rows.map((r) => [r.value as string, r.key.slice(SLUG_KEY.length)]));
      return all.map((r) => ({ slug: r.slug, companyId: company.get(r.slug) ?? null, current: r.current }));
    },

    /**
     * The company ids whose runner the launcher means to keep running (a container or a token file),
     * plus every company the launcher was never given (no slug: its runner, if any, was registered by
     * hand, so it counts, BOS-497). Null when that can't be known: no launcher (runners are registered
     * by hand), the launcher is down, or it is older than this server. Null means "treat every runner as wanted".
     */
    async wantedCompanies(): Promise<Set<string> | null> {
      if (!opts) return null;
      try {
        const slugs = new Set(await call<string[]>("GET", "/wanted"));
        const rows = await db.select().from(settings).where(like(settings.key, `${SLUG_KEY}%`));
        const launched = new Set(rows.map((r) => r.key.slice(SLUG_KEY.length)));
        const never = (await db.select({ id: companies.id }).from(companies)).map((c) => c.id).filter((id) => !launched.has(id));
        return new Set([...rows.filter((r) => slugs.has(r.value as string)).map((r) => r.key.slice(SLUG_KEY.length)), ...never]);
      } catch {
        return null;
      }
    },

    /** One company's runner again on the current image; the launcher keeps its token and data. // leader-only */
    async recreate(slug: string) {
      await call("POST", `/runners/${slug}/recreate`);
    },

    async status(companyId: string): Promise<{ slug: string; container: LaunchedRunner | null; error?: string } | null> {
      if (!opts) return null;
      const slug = await peekSlug(companyId);
      try {
        const all = await call<LaunchedRunner[]>("GET", "/runners");
        return { slug, container: all.find((r) => r.slug === slug) ?? null };
      } catch (err) {
        return { slug, container: null, error: (err as Error).message };
      }
    },
  };
}
