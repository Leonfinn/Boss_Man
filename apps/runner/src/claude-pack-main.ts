// `tsx src/claude-pack-main.ts`: the one-shot installer container (DR-050, BOS-972). Mounts the
// bossman-claude volume read-write at PACK_ROOT, reads the pinned package.json and lockfile from
// the image at PACK_SOURCE, and installs the pack into a content-addressed folder: npm ci (integrity
// hashes checked), `claude --version` (must match the pin), the canary (a real Claude session against
// a local stand-in model, no network), and only then the READY marker. Exits 0 when a ready pack is
// there afterwards, non-zero otherwise, so the launcher knows whether to mount the volume read-only.
// Idempotent: a ready folder is left alone, and an update installs beside the old one.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACK_ROOT, PACK_SOURCE, PINNED_CLAUDE_CODE, claudeBin, cleanStalePacks, installPack, sourceLockHash, type Exec } from "./claude-pack.js";
import { runCanary } from "./canary.js";

const run = promisify(execFile);
const exec: Exec = (cmd, args) => run(cmd, args, { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);
const log = (m: string) => console.log(`[claude-pack] ${m}`);

/** The two files npm ci needs; copied from the root-owned source into the folder before the install. */
function copySource(dir: string) {
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(path.join(PACK_SOURCE, name), path.join(dir, name));
}

/** `npm ci` in the folder: every package's bytes must match the lockfile's integrity hash. */
async function npmCi(dir: string) {
  await run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dir, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}

/** `claude --version` from the folder's own node_modules (npm may resolve Windows/musl variants: this is linux). */
const claudeVersion = (dir: string) => exec(claudeBin(dir), ["--version"]);

/**
 * The canary: a real Claude session through the pack's adapter and Claude Code, against the local
 * stand-in model. It needs no credentials and no network, so the pack is proven here even offline.
 */
async function canary(dir: string) {
  const r = await runCanary({ agentKind: "claude", baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: claudeBin(dir) } });
  log(`canary: ${r.ok ? "passed" : `failed (${r.detail})`}`);
  return r.ok;
}

async function main() {
  let hash: string;
  try {
    hash = sourceLockHash();
  } catch (err) {
    log(String((err as Error)?.message ?? err));
    process.exit(1);
  }
  const version = PINNED_CLAUDE_CODE;
  try {
    const result = await installPack({ root: PACK_ROOT, hash, version, steps: { copySource, npmCi, claudeVersion, canary }, log });
    log(`ready: ${result.dir} (Claude Code ${result.version})`);
    // A crash may have left half-made folders beside ours: remove only STALE ones (older than an hour), so
    // one won't delete another installer's work in progress, and never the folder we just used.
    const swept = cleanStalePacks(PACK_ROOT, result.dir, { log });
    if (swept.length) log(`removed ${swept.length} stale pack folder(s)`);
    process.exit(0);
  } catch (err) {
    log(`the Claude pack couldn't be installed: ${String((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
}

void main();

export { copySource, npmCi, claudeVersion, canary };
