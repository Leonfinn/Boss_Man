// The model list without a chat message: session/new only, no prompt.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { startCanaryModel } from "../src/canary.js";
import { probeModels } from "../src/models-probe.js";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");

describe("models.probe", () => {
  it("emits runner.models from the session's config options and replies with them", async () => {
    const events: RunnerEvent[] = [];
    const replies: unknown[] = [];
    const purposes: string[] = [];
    const manager = new SessionManager({
      mcpUrl: "http://127.0.0.1:9/mcp",
      emit: (e) => events.push(e),
      resolveEnv: async () => ({}),
      resolveCompanyEnv: async (p) => (purposes.push(p), { ANTHROPIC_API_KEY: "k" }),
      adapterBins: { claude: fake },
      baseEnv: { PATH: process.env.PATH },
      reply: (requestId, result) => replies.push({ requestId, ...result }),
    });
    manager.handle({ type: "models.probe", requestId: "r1", agentKind: "claude" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => replies.length && (clearInterval(t), resolve()), 20);
    });
    const models = [{ value: "default", name: "Default", description: null }, { value: "sonnet", name: "Sonnet", description: "Fast" }];
    expect(events).toEqual([{ type: "runner.models", agentKind: "claude", models }]);
    expect(replies).toEqual([{ requestId: "r1", ok: true, data: { models } }]);
    expect(purposes).toEqual(["check"]);
    manager.shutdown();
  });

  it("reports an error when the adapter can't start", async () => {
    await expect(probeModels("claude", {}, { adapterBin: "/nonexistent/adapter", timeoutMs: 5000 })).rejects.toBeTruthy();
  });

  it("reports why the agent died, not just that the connection closed", async () => {
    const crash = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-crash.mjs");
    await expect(probeModels("opencode", {}, { adapterBin: crash, timeoutMs: 10_000 })).rejects.toThrow(/exited \(code 1\)\. EACCES: permission denied, mkdir/);
  });

  it("against the real claude-agent-acp, lists models and makes no model request", async () => {
    const model = await startCanaryModel();
    try {
      const models = await probeModels("claude", { ANTHROPIC_API_KEY: "sk-ant-stand-in", ANTHROPIC_BASE_URL: model.url, NO_PROXY: "127.0.0.1,localhost" }, { baseEnv: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost" }, timeoutMs: 120_000 });
      expect(models.length).toBeGreaterThan(0);
      expect(model.requests()).toBe(0);
    } finally {
      await model.close();
    }
  }, 150_000);
});
