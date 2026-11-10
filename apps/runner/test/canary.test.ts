// Drives the same canary the image runs before it's promoted (R52): a session of each agent kind,
// plain and inside the agent fence (BOS-321), using the agents that ship with the runner.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.js";
import { levelFor, probeLandlock } from "../src/fence.js";
import { claudeAdapterBin } from "./claude-adapter.js";

const level = levelFor(probeLandlock().abi).level;
const PLAIN = { sessionStarted: true, modelReached: true, permissionAsked: true, toolRan: true, answered: true, endedCleanly: true };
const FENCED = { ...PLAIN, fenced: true, fenceHeld: true };
const hasOpencode = spawnSync("sh", ["-c", "command -v opencode"]).status === 0;
/** The real Claude adapter and Claude Code now live in the Claude pack (DR-050), not the runner's node_modules:
 * a real Claude session runs only where a pack is pointed at (a runner with a ready pack). */
const hasClaude = !!claudeAdapterBin() && !!process.env.CLAUDE_CODE_EXECUTABLE;

describe("image canary (R52)", () => {
  it.skipIf(!hasClaude)("runs a Claude session with a tool call against the stand-in model", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(PLAIN);
  }, 150_000);

  it("fails when Claude Code can't start", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(result.ok).toBe(false);
    expect(result.checks.answered).toBe(false);
  }, 60_000);

  // BOS-972: the installer's canary must use the pack's adapter. Without the adapterBin option the
  // session fell through to defaultBin("claude") and always said "isn't installed", so the pack never became ready.
  it("uses the adapter it is given for Claude, instead of reporting Claude as not installed", async () => {
    const given = await runCanary({ adapterBin: "/nonexistent/claude-agent-acp", baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(given.ok).toBe(false);
    expect(given.detail).not.toContain("isn't installed");
    const none = await runCanary({ baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(none.detail).toContain("isn't installed");
  }, 90_000);

  it("runs a Codex session through its own approval, against a Responses-API stand-in", async () => {
    const result = await runCanary({ agentKind: "codex", baseEnv: { PATH: process.env.PATH } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(PLAIN);
  }, 150_000);

  it.skipIf(!hasOpencode)("runs an OpenCode session against the stand-in model", async () => {
    const result = await runCanary({ agentKind: "opencode", baseEnv: { PATH: process.env.PATH } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(PLAIN);
  }, 150_000);
});

const fencedKinds: Array<"claude" | "codex" | "opencode"> = (["claude", "codex", ...(hasOpencode ? (["opencode"] as const) : [])] as const).filter((k) => k !== "claude" || hasClaude);
describe.skipIf(level === "unavailable")("image canary inside the agent fence (BOS-321)", () => {
  it.each(fencedKinds)("%s works fenced, and its command can't write outside its folder", async (agentKind) => {
    const result = await runCanary({ agentKind, fence: level, baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(FENCED);
  }, 150_000);
});
