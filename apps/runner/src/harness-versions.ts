// Which agent harnesses this runner holds and at what version, sent in hello (BOS-305).
// Claude Code is asked for its own version through CLAUDE_CODE_EXECUTABLE, which the runner points at
// the ready Claude pack (DR-050); its ACP adapter's version comes from the pack too. OpenCode is asked
// for its own version; Codex's ACP adapter is pinned exactly in package.json, so that is read. A harness
// that can't be read is left out: on a runner with no ready pack, Claude Code and its adapter are absent.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HarnessVersions } from "@boss-man/shared";

type Exec = (cmd: string, args: string[]) => Promise<string>;
const exec: Exec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/** "2.1.0 (Claude Code)" and "1.19.3" both give the number. */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(output)?.[0] ?? null;
}

export async function harnessVersions(
  opts: { claudePath?: string; run?: Exec; packageJson?: string; claudeAdapterVersion?: string } = {},
): Promise<HarnessVersions> {
  const run = opts.run ?? exec;
  const out: HarnessVersions = {};
  const ask = async (key: string, cmd: string) => {
    try {
      const v = parseVersion(await run(cmd, ["--version"]));
      if (v) out[key] = v;
    } catch {
      /* not installed or not answering: left out */
    }
  };
  await Promise.all([ask("claude-code", opts.claudePath ?? process.env.CLAUDE_CODE_EXECUTABLE ?? "claude"), ask("opencode", "opencode")]);
  try {
    const pkg = JSON.parse(readFileSync(opts.packageJson ?? new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    const adapters: Array<[string, string]> = [["codex-acp", "@agentclientprotocol/codex-acp"], ["claude-agent-acp", "@agentclientprotocol/claude-agent-acp"]];
    for (const [key, name] of adapters) if (pkg.dependencies?.[name]) out[key] = pkg.dependencies[name]!;
  } catch {
    /* no package.json beside the source */
  }
  // The Claude adapter is no longer a runner dependency: its version comes from the ready pack, and is
  // reported only when there is one. Without a pack, `claude-code` is left out too (no executable answers).
  if (opts.claudeAdapterVersion) out["claude-agent-acp"] = opts.claudeAdapterVersion;
  return out;
}
