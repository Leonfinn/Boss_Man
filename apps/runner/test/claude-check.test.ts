// The setup-token check (R58): one tiny prompt in a session of its own, with tools refused.
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { startCanaryModel } from "../src/canary.js";
import { checkClaude } from "../src/claude-check.js";
import { SessionManager } from "../src/session-manager.js";
import { claudeAdapterBin } from "./claude-adapter.js";

describe("setup-token check (R58)", () => {
  // Claude Code lives in the Claude pack now (DR-050, BOS-972): a real Claude session runs only where a pack is pointed at.
  it.skipIf(!claudeAdapterBin() || !process.env.CLAUDE_CODE_EXECUTABLE)("passes when Claude Code answers, refusing the tool call the stand-in asks for", async () => {
    const model = await startCanaryModel();
    try {
      const r = await checkClaude({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stand-in", ANTHROPIC_BASE_URL: model.url, NO_PROXY: "127.0.0.1,localhost" }, { baseEnv: { PATH: process.env.PATH } });
      expect(r).toEqual({ ok: true, message: "Claude Code answered using the setup-token." });
      expect(model.requests()).toBeGreaterThan(0);
    } finally {
      await model.close();
    }
  }, 150_000);

  it("fails without a token, and when Claude Code can't start", async () => {
    expect((await checkClaude({ ANTHROPIC_API_KEY: "sk-ant-api03-x" })).ok).toBe(false);
    const r = await checkClaude({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }, { baseEnv: { PATH: process.env.PATH, CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude" }, timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
  }, 60_000);

  it("hands the check only the setup-token from the company's credentials", async () => {
    const replies: unknown[] = [];
    const given: Record<string, string>[] = [];
    const purposes: string[] = [];
    const manager = new SessionManager({
      mcpUrl: "http://127.0.0.1:9/mcp",
      emit: (_e: RunnerEvent) => {},
      resolveEnv: async () => ({}),
      resolveCompanyEnv: async (purpose) => (purposes.push(purpose), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-t", ANTHROPIC_API_KEY: "sk-ant-api03-k", GIT_TOKEN: "g" }),
      checkClaude: async (creds) => (given.push(creds), { ok: true, message: "fine" }),
      reply: (requestId, result) => replies.push({ requestId, ...result }),
    });
    manager.handle({ type: "credential.check", requestId: "r1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(purposes).toEqual(["check"]);
    expect(given).toEqual([{ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-t" }]);
    expect(replies).toEqual([{ requestId: "r1", ok: true, data: { ok: true, message: "fine" } }]);
    manager.shutdown();
  });
});
