// New-release watch for an install from the published images (BOS-2663). The updater installs a release it is told to; nothing
// else looked for one. This asks the install's own GitHub release list (the repo the updater was set up with, handed to the server
// as BOSSMAN_RELEASE_REPO), at least once a day, and tells the owner once per new version: a feed note, and the phone only when the
// owner turned that on. A source install has none of the three env values, so it is never offered an image release.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { NotifyInput } from "./notifications.js";

const KEY = "release-watch";
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DAY_MS = 24 * 3_600_000;
/** After a failed check, try again this soon, and say nothing. */
const RETRY_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
const SUMMARY_CHARS = 280;

/** Compares two release numbers; a pre-release is older than its release (0.1.0-beta.1 < 0.1.0). Same rule as the updater's. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", ...rest] = v.split("-");
    return { nums: core.split(".").map(Number), pre: rest.length ? rest.join("-").split(".") : null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export type FoundRelease = { version: string; url: string; summary: string; publishedAt: string | null; prerelease: boolean };

type Stored = {
  /** The owner's switch: tell me about new releases. On unless turned off. */
  enabled: boolean;
  /** The owner's second switch: also push it to the phone (needs ntfy set up). Off unless turned on. */
  ntfy: boolean;
  checkedAt: string | null;
  /** The last check could not reach GitHub (or got no usable answer). Cleared by the next good one. */
  couldntCheck: boolean;
  latest: FoundRelease | null;
  /** The newest version the owner was told about, so a version is announced once. */
  notified: string | null;
};
const EMPTY: Stored = { enabled: true, ntfy: false, checkedAt: null, couldntCheck: false, latest: null, notified: null };

export type ReleaseWatchView =
  | { active: false }
  | { active: true; current: string; channel: "beta" | "stable"; enabled: boolean; ntfy: boolean; checkedAt: string | null; couldntCheck: boolean; available: FoundRelease | null };

export type ReleaseWatchDeps = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  notify: (n: NotifyInput) => Promise<unknown>;
  /** Whether the owner has a phone push set up (ntfy), so the second switch only turns on when it can work. */
  hasNtfy: () => Promise<boolean>;
  /** Only the server in charge checks (two colours run during an update). */
  isLeader?: () => boolean;
  log?: (msg: string) => void;
};

/** The first plain sentence or two of a release's notes, with Markdown marks and links removed. */
export function summarize(body: unknown): string {
  if (typeof body !== "string") return "";
  const text = body
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((l) => l.trim() && !/^\s*#{1,6}\s*$/.test(l))
    .map((l) => l.replace(/^\s*(#{1,6}|[-*+>])\s*/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`;
}

export function releaseWatchService(db: Db, deps: ReleaseWatchDeps) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const repo = env.BOSSMAN_RELEASE_REPO?.trim() ?? "";
  const current = env.BOSSMAN_VERSION?.trim() ?? "";
  // The API address is a setting, not a constant, so another host (or a test) can stand in; the default is GitHub's.
  const apiBase = (env.BOSSMAN_RELEASE_API?.trim() || "https://api.github.com").replace(/\/$/, "");
  const active = env.BOSSMAN_IMAGE_INSTALL === "1" && REPO_RE.test(repo) && VERSION_RE.test(current);
  // A beta install (its own version has a pre-release part) sees pre-releases; a stable one sees stable releases only.
  const channel: "beta" | "stable" = current.includes("-") ? "beta" : "stable";

  async function load(): Promise<Stored> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return { ...EMPTY, ...((row?.value as Partial<Stored> | undefined) ?? {}) };
  }
  async function save(next: Stored) {
    await db.insert(settings).values({ key: KEY, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
  }

  /** The newest release newer than this install, with a signed release.json, on this install's channel. Null: none. Throws: no usable answer. */
  async function fetchNewest(): Promise<FoundRelease | null> {
    const res = await doFetch(`${apiBase}/repos/${repo}/releases?per_page=30`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "boss-man-release-watch" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) throw new Error("GitHub's answer was not a list of releases");
    let best: FoundRelease | null = null;
    for (const r of list as Array<Record<string, unknown>>) {
      if (!r || r.draft === true) continue;
      const tag = typeof r.tag_name === "string" ? r.tag_name : "";
      const version = tag.startsWith("v") ? tag.slice(1) : tag;
      if (!VERSION_RE.test(version)) continue;
      const prerelease = r.prerelease === true || version.includes("-");
      if (prerelease && channel === "stable") continue;
      const assets = Array.isArray(r.assets) ? (r.assets as Array<{ name?: unknown }>) : [];
      if (!assets.some((a) => a?.name === "release.json")) continue; // the updater installs only a signed release.json
      if (compareVersions(version, current) <= 0) continue;
      if (best && compareVersions(version, best.version) <= 0) continue;
      const url = typeof r.html_url === "string" && r.html_url.startsWith("https://") ? r.html_url : `https://github.com/${repo}/releases/tag/${tag}`;
      best = { version, url, summary: summarize(r.body), publishedAt: typeof r.published_at === "string" ? r.published_at : null, prerelease };
    }
    return best;
  }

  /** One check. Safe to call at any time; it never throws and never tells the owner about a failure. */
  async function check(opts: { force?: boolean } = {}): Promise<ReleaseWatchView> {
    if (!active) return { active: false };
    let s = await load();
    if (s.enabled || opts.force) {
      let found: FoundRelease | null = null;
      let ok = true;
      try {
        found = await fetchNewest();
      } catch (err) {
        ok = false;
        deps.log?.(`release check: could not reach the release list (${(err as Error).message.slice(0, 120)}); will retry`);
      }
      s = { ...s, checkedAt: now().toISOString(), couldntCheck: !ok, ...(ok ? { latest: found } : {}) };
      if (ok && found && s.enabled && s.notified !== found.version) {
        const body = `${found.summary ? `${found.summary}\n\n` : ""}Open Settings → Server and runner → Updates to see it. Release notes: ${found.url}`;
        const phone = s.ntfy && (await deps.hasNtfy().catch(() => false));
        // The note is marked as told only once it was saved, so a failure here is tried again at the next check.
        await deps.notify({ companyId: null, agentId: null, level: "note", title: `Boss Man ${found.version} is available`, body, link: "#/settings/updates", ...(phone ? { phoneOptIn: "You asked for new releases on your phone" } : { noPush: true }) });
        s = { ...s, notified: found.version };
      }
      await save(s);
    }
    return view(s);
  }

  function view(s: Stored): ReleaseWatchView {
    if (!active) return { active: false };
    // A stored "latest" the install has since caught up with (an update ran) is not offered.
    const available = s.latest && compareVersions(s.latest.version, current) > 0 ? s.latest : null;
    return { active: true, current, channel, enabled: s.enabled, ntfy: s.ntfy, checkedAt: s.checkedAt, couldntCheck: s.couldntCheck, available };
  }

  /** What the Updates panel shows. Reads the stored result only; it never calls GitHub. */
  async function status(): Promise<ReleaseWatchView> {
    return active ? view(await load()) : { active: false };
  }

  /** The owner's two switches. */
  async function setOptions(patch: { enabled?: boolean; ntfy?: boolean }): Promise<ReleaseWatchView> {
    if (!active) return { active: false };
    const s = { ...(await load()), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.ntfy !== undefined ? { ntfy: patch.ntfy } : {}) };
    await save(s);
    return view(s);
  }

  /** Whether a check is due: never checked, a day since the last good one, or an hour since a failed one. */
  async function due(): Promise<boolean> {
    const s = await load();
    if (!s.enabled || !s.checkedAt) return s.enabled;
    return now().getTime() - Date.parse(s.checkedAt) >= (s.couldntCheck ? RETRY_MS : DAY_MS);
  }

  /** Starts the timers: a first look a few minutes after start, then an hourly look at whether a check is due. Returns the stop. */
  function start(opts: { firstMs?: number; everyMs?: number } = {}): () => void {
    if (!active) return () => undefined;
    const tick = () => {
      if (deps.isLeader && !deps.isLeader()) return;
      void due().then((d) => (d ? check() : undefined)).catch((e) => deps.log?.(`release check failed: ${(e as Error).message}`));
    };
    const first = setTimeout(tick, opts.firstMs ?? 3 * 60_000);
    const every = setInterval(tick, opts.everyMs ?? 3_600_000);
    first.unref();
    every.unref();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  return { active, channel, check, status, setOptions, start, due };
}
