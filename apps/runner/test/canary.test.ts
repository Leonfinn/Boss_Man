// Drives the same canary the image runs before it's promoted (R52), using the Claude Code
// that ships with the adapter.
import { describe, expect, it } from "vitest";
import { runCanary } from "../src/canary.js";

describe("image canary (R52)", () => {
  it("runs a Claude session with a tool call against the stand-in model", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH } });
    expect(result.detail).toBe("all checks passed");
    expect(result.checks).toEqual({ sessionStarted: true, modelReached: true, permissionAsked: true, toolRan: true, answered: true, endedCleanly: true });
  }, 150_000);

  it("fails when Claude Code can't start", async () => {
    const result = await runCanary({ baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(result.ok).toBe(false);
    expect(result.checks.answered).toBe(false);
  }, 60_000);
});
