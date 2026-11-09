// The Claude pack (DR-050, BOS-972). The runner image holds no Anthropic code: Claude Code and
// its ACP adapter are installed on a runner's first start from apps/runner/claude-pack into a
// content-addressed folder on a named volume, by a one-shot installer container. This module is
// the one copy of the rules both the runner and the installer follow. Pure and injectable, so a
// test drives every path (a missing pack, a tampered lock, a failed canary) without a real npm.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Where the named volume is mounted in the runner and the installer container. */
export const PACK_ROOT = "/opt/bossman-claude";
/** Where the image copies the pinned package.json and its lockfile (root-owned, read-only). */
export const PACK_SOURCE = "/opt/bossman-claude-pack";
/** The exact version this pack pins; an install whose `claude --version` disagrees is refused. */
export const PINNED_CLAUDE_CODE = "2.1.316";

export type PackReadiness = { ready: boolean; dir?: string; version?: string; reason?: string };
/** What the installer records once a folder has passed its checks. */
export type ReadyInfo = { version: string; hash: string; at: string };
/** Runs a command and returns its stdout; the installer injects the real one, a test a stub. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

/**
 * The folder name for a lockfile: the sha256 of its bytes, first 24 hex characters. Content-addressed,
 * so a bumped pin installs beside the old folder and a runner keeps working on the old one until the
 * new is ready. npm ci itself refuses any package whose bytes don't match the lock's integrity hash.
 */
export function lockHash(lockText: string | Buffer): string {
  return createHash("sha256").update(lockText).digest("hex").slice(0, 24);
}

/** The content-addressed folder for one pack under `root`. */
export function packDirFor(root: string, hash: string): string {
  if (!/^[0-9a-f]{24}$/.test(hash)) throw new Error(`bad pack hash: ${hash}`);
  return path.join(root, hash);
}

/** The versioned files a pack holds, as the installer lays them out: node_modules filled by npm ci. */
export const packPaths = (dir: string) => ({
  nodeModules: path.join(dir, "node_modules"),
  claudeBin: path.join(dir, "node_modules", ".bin", "claude"),
  adapterBin: path.join(dir, "node_modules", ".bin", "claude-agent-acp"),
  ready: path.join(dir, "READY"),
  packageJson: path.join(dir, "package.json"),
  lockfile: path.join(dir, "package-lock.json"),
});

/** The Claude Code executable and the ACP adapter executable inside a ready pack. */
export const claudeBin = (dir: string) => packPaths(dir).claudeBin;
export const adapterBin = (dir: string) => packPaths(dir).adapterBin;

/** Reads and parses the READY marker; null when there is none or it isn't ours. */
function readReady(marker: string): ReadyInfo | null {
  try {
    const j = JSON.parse(readFileSync(marker, "utf8")) as Partial<ReadyInfo>;
    return typeof j.version === "string" && typeof j.hash === "string" && typeof j.at === "string" ? { version: j.version, hash: j.hash, at: j.at } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the pack under `root` for `hash` is ready for a runner to use. Ready only when the folder's
 * READY marker exists (written by the installer only after `claude --version` and the canary passed)
 * AND its marker names this folder's hash AND both binaries are there. Anything else is "not ready":
 * a runner never starts on a half-installed pack, and never crashes because there isn't one.
 */
export function readPack(root: string, hash: string): PackReadiness {
  let dir: string;
  try {
    dir = packDirFor(root, hash);
  } catch (err) {
    return { ready: false, reason: String((err as Error)?.message ?? err) };
  }
  const p = packPaths(dir);
  const info = existsSync(p.ready) ? readReady(p.ready) : null;
  if (!info) return { ready: false, reason: "no READY marker: the pack hasn't been installed here yet" };
  if (info.hash !== hash) return { ready: false, reason: "READY marker is for a different pack" };
  if (!existsSync(p.claudeBin)) return { ready: false, reason: "the pack has a READY marker but no claude binary" };
  if (!existsSync(p.adapterBin)) return { ready: false, reason: "the pack has a READY marker but no Claude ACP adapter" };
  return { ready: true, dir, version: info.version };
}

/**
 * Marks a folder ready. Only the installer calls this, and only after `claude --version` matched the
 * pin and the canary passed. Written to a temporary file and renamed, so a runner never reads half a
 * marker and a crash mid-write leaves the folder not-ready, never wrongly ready.
 */
export function markReady(dir: string, info: { version: string; hash: string; at?: string }): ReadyInfo {
  mkdirSync(dir, { recursive: true });
  const body: ReadyInfo = { version: info.version, hash: info.hash, at: info.at ?? new Date().toISOString() };
  const marker = packPaths(dir).ready;
  const tmp = `${marker}.tmp`;
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, marker);
  return body;
}

/** Removes a folder that failed to install, so the next try starts clean. Never touches a READY one. */
export function discardDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** How old a folder without a READY marker must be before the installer removes it (a crashed install). */
export const STALE_PACK_MS = 60 * 60_000;

/**
 * Cleans up half-made pack folders beside a fresh install (a crash or an older installer left them), so the
 * volume doesn't grow without bound. Only folders whose names are a pack hash, that are NOT the folder just
 * installed, have no READY marker, and are older than `staleMs` are removed: a younger one may be another
 * installer's work in progress (BOS-972), so it is left alone. Never throws: a folder that can't be listed
 * (removed meanwhile, a stray file, permissions) is skipped, so a good install is never turned into a failure.
 * Returns the folders it removed.
 */
export function cleanStalePacks(root: string, keepDir: string, opts: { now?: number; staleMs?: number; log?: (msg: string) => void } = {}): string[] {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? STALE_PACK_MS;
  const log = opts.log ?? (() => {});
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{24}$/.test(name)) continue;
    const old = path.join(root, name);
    if (path.resolve(old) === path.resolve(keepDir)) continue;
    try {
      const st = statSync(old);
      if (!st.isDirectory()) continue;
      if (existsSync(path.join(old, "READY"))) continue;
      if (now - st.mtimeMs < staleMs) continue; // possibly another installer still building it
      discardDir(old);
      removed.push(old);
    } catch (err) {
      log(`couldn't check the pack folder ${old} for cleanup: ${String((err as Error)?.message ?? err)}`);
    }
  }
  return removed;
}

/**
 * The lockfile hash the image shipped in `source`, or a clear error when it is missing. The installer
 * reads this first; if the file is there the image is the one the launcher expects.
 */
export function sourceLockHash(source: string = PACK_SOURCE): string {
  const lock = path.join(source, "package-lock.json");
  let text: Buffer;
  try {
    text = readFileSync(lock);
  } catch {
    throw new Error(`the Claude pack source has no lockfile at ${lock}`);
  }
  return lockHash(text);
}

/** Parses "2.1.316 (Claude Code)" from `claude --version`, or null. */
export function parseClaudeVersion(output: string): string | null {
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(output)?.[0] ?? null;
}

/** The steps the installer runs, in order; a test drives each one through this type. */
export type InstallSteps = {
  /** Copies the pinned package.json and lockfile into the folder. */
  copySource: (dir: string) => void;
  /** Runs `npm ci` inside the folder (integrity hashes checked against the lockfile). */
  npmCi: (dir: string) => Promise<void>;
  /** Runs `claude --version` and returns its output. */
  claudeVersion: (dir: string) => Promise<string>;
  /** Runs the canary against the pack; true only when a real session worked. */
  canary: (dir: string) => Promise<boolean>;
};

/**
 * Installs the pack into `root` for `hash` unless a ready folder is already there (idempotent, so a
 * re-run is cheap and an update installs beside the old folder). The order is fixed by DR-050: copy,
 * npm ci, `claude --version` (must match the pin), the canary, and only then the READY marker. Any
 * failure discards the half-made folder and throws, so a runner never starts on a pack that isn't ready.
 */
export async function installPack(opts: {
  root: string;
  hash: string;
  version: string;
  steps: InstallSteps;
  log?: (msg: string) => void;
  now?: () => string;
}): Promise<{ installed: boolean; dir: string; version: string }> {
  const { root, hash, version, steps, log = () => {} } = opts;
  const dir = packDirFor(root, hash);
  if (readPack(root, hash).ready) {
    log(`the Claude pack ${hash} is already ready`);
    return { installed: false, dir, version };
  }
  mkdirSync(root, { recursive: true });
  // A previous try that died mid-install leaves a folder without READY: start it clean.
  discardDir(dir);
  mkdirSync(dir, { recursive: true });
  try {
    log(`installing the Claude pack ${hash} into ${dir}`);
    steps.copySource(dir);
    await steps.npmCi(dir);
    const got = parseClaudeVersion(await steps.claudeVersion(dir));
    if (got !== version) throw new Error(`the pack installed Claude Code ${got ?? "an unknown version"}, but ${version} is pinned`);
    if (!(await steps.canary(dir))) throw new Error("the Claude pack's canary failed");
    markReady(dir, { version, hash, ...(opts.now ? { at: opts.now() } : {}) });
    log(`the Claude pack ${hash} is ready (Claude Code ${version})`);
    return { installed: true, dir, version };
  } catch (err) {
    discardDir(dir);
    throw err;
  }
}

/**
 * The environment the pack needs so a real tool run can find it. `CLAUDE_CODE_EXECUTABLE` points the
 * adapter at the pack's Claude Code; without a ready pack it is left unset and Claude is absent.
 */
export function packEnv(pack: PackReadiness): NodeJS.ProcessEnv {
  return pack.ready && pack.dir ? { CLAUDE_CODE_EXECUTABLE: claudeBin(pack.dir), BOSSMAN_CLAUDE_PACK: pack.dir } : {};
}
