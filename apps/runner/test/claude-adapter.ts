// Where the tests find the real Claude ACP adapter (DR-050, BOS-972). The runner image holds no
// Anthropic code: Claude Code and its adapter are installed on first start into a ready pack, so a
// plain checkout has neither. A test that drives a real Claude session runs only where one is pointed
// at, exactly as a runner does: the adapter from CLAUDE_AGENT_ACP_BIN (what a pack sets), else from a
// ready pack named by BOSSMAN_CLAUDE_PACK, else the suite is skipped. Nothing here downloads anything.
import { readFileSync } from "node:fs";
import { adapterBin, lockHash, readPack } from "../src/claude-pack.js";

/** The Claude adapter executable a real Claude test can use, or null when this checkout holds none. */
export function claudeAdapterBin(): string | null {
  const fromEnv = process.env.CLAUDE_AGENT_ACP_BIN?.trim();
  if (fromEnv) return fromEnv;
  const root = process.env.BOSSMAN_CLAUDE_PACK?.trim();
  const source = process.env.BOSSMAN_CLAUDE_PACK_SOURCE?.trim();
  if (!root) return null;
  try {
    // Same rules the runner uses: the folder is named by the pack lockfile's hash, and only a READY
    // folder (checks passed) counts.
    const hash = lockHash(readFileSync(`${source ?? "/opt/bossman-claude-pack"}/package-lock.json`));
    const pack = readPack(root, hash);
    return pack.ready && pack.dir ? adapterBin(pack.dir) : null;
  } catch {
    return null;
  }
}
