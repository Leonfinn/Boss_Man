// Drives the same canary the image runs before it's promoted (R52): a session of each agent kind,
// plain and inside the agent fence (BOS-321), using the agents that ship with the runner.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.js";
import { levelFor, probeLandlock } from "../src/fence.js";

const level = levelFor(probeLandlock().abi).level;
const PLAIN = { sessionStarted: true, modelReached: true, permissionAsked: true, toolRan: true, answered: true, endedCleanly: true };
const FENCED = { ...PLAIN, fenced: true, fenceHeld: true };
const hasOpencode = spawnSync("sh", ["-c", "command -v opencode"]).status === 0;

describe("image canary (R52)", () => {
  it("runs a Claude session with a tool call against the stand-in model", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(PLAIN);
  }, 150_000);

  it("fails when Claude Code can't start", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(result.ok).toBe(false);
    expect(result.checks.answered).toBe(false);
  }, 60_000);

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

describe.skipIf(level === "unavailable")("image canary inside the agent fence (BOS-321)", () => {
  it.each(["claude", "codex", ...(hasOpencode ? ["opencode" as const] : [])] as const)("%s works fenced, and its command can't write outside its folder", async (agentKind) => {
    const result = await runCanary({ agentKind, fence: level, baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual(FENCED);
  }, 150_000);
});
