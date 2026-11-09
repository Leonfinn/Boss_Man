// The model list without a chat message: session/new only, no prompt.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { startCanaryModel } from "../src/canary.js";
import { probeModels } from "../src/models-probe.js";
import { SessionManager, defaultBin, withoutGitCredentials } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");
/** The real Claude ACP adapter now lives in the Claude pack (DR-050), not the runner's node_modules: run this
 * only where one is pointed at (a runner with a ready pack); otherwise there is no adapter to probe. */
const realClaudeAdapter = (() => {
  try {
    return defaultBin("claude", process.env.CLAUDE_AGENT_ACP_BIN);
  } catch {
    return null;
  }
})();

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

  it("starts OpenCode with a run's settings, so its hosted provider's models aren't listed", async () => {
    const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-env.mjs");
    const granted = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://192.168.1.2:11434/v1" } } } });
    const err = await probeModels("opencode", { OPENCODE_CONFIG_CONTENT: granted }, { adapterBin: bin, timeoutMs: 10_000 }).catch((e: Error) => e);
    const config = JSON.parse(String((err as Error).message).split("config=")[1]!);
    expect(config.disabled_providers).toEqual(["opencode"]);
    expect(config.provider.ollama.options.baseURL).toBe("http://192.168.1.2:11434/v1");
  });

  it("withholds the git credential from a probe too, in any form git reads it (BOS-322)", async () => {
    // The probe spawns the adapter with the run's secrets; the adapter reports the env it actually got.
    const report = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-env-report.mjs");
    const secrets = { GIT_TOKEN: "ghp_probe_token", GIT_USERNAME: "bot", GIT_CONFIG_COUNT: "1", GIT_CONFIG_VALUE_0: "Authorization: Basic x", GH_TOKEN: "gh_probe", GITHUB_TOKEN: "ghub_probe", ANTHROPIC_API_KEY: "sk-ant-probe" };
    const err = await probeModels("opencode", secrets, { adapterBin: report, timeoutMs: 10_000 }).catch((e: Error) => e);
    const line = String((err as Error).message).split("envnames=")[1]!.split("\n")[0]!;
    const [names, control] = line.split(";control=");
    // Every secret the filter withholds must be absent; the filter is the same one a run uses, so this can't drift.
    const kept = withoutGitCredentials(secrets);
    const withheld = Object.keys(secrets).filter((k) => !(k in kept));
    expect(withheld.length).toBeGreaterThan(0);
    expect(names!.split(",").filter((n) => withheld.includes(n))).toEqual([]);
    expect(control).toBe("set");
  });

  it("withholds a forge's own push or package token from a probe, by the same filter as a run (BOS-396)", async () => {
    const report = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-env-report.mjs");
    const secrets = { GITLAB_TOKEN: "glpat-1", GL_TOKEN: "glpat-2", BITBUCKET_TOKEN: "bb-3", NPM_TOKEN: "npm-4", NODE_AUTH_TOKEN: "npm-5", GITHUB_TOKEN_WORK: "ghp-6", ANTHROPIC_API_KEY: "sk-ant-probe" };
    const err = await probeModels("opencode", secrets, { adapterBin: report, timeoutMs: 10_000 }).catch((e: Error) => e);
    const line = String((err as Error).message).split("envnames=")[1]!.split("\n")[0]!;
    const [names, control] = line.split(";control=");
    const kept = withoutGitCredentials(secrets);
    const withheld = Object.keys(secrets).filter((k) => !(k in kept));
    expect(withheld).toContain("GITLAB_TOKEN");
    expect(names!.split(",").filter((n) => withheld.includes(n))).toEqual([]);
    expect(control).toBe("set");
  });

  it("reports why the agent died, not just that the connection closed", async () => {
    const crash = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-crash.mjs");
    await expect(probeModels("opencode", {}, { adapterBin: crash, timeoutMs: 10_000 })).rejects.toThrow(/exited \(code 1\)\. EACCES: permission denied, mkdir/);
  });

  it.skipIf(!realClaudeAdapter)("against the real claude-agent-acp, lists models and makes no model request", async () => {
    const model = await startCanaryModel();
    try {
      const models = await probeModels("claude", { ANTHROPIC_API_KEY: "sk-ant-stand-in", ANTHROPIC_BASE_URL: model.url, NO_PROXY: "127.0.0.1,localhost" }, { baseEnv: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost" }, adapterBin: realClaudeAdapter ?? undefined, timeoutMs: 120_000 });
      expect(models.length).toBeGreaterThan(0);
      expect(model.requests()).toBe(0);
    } finally {
      await model.close();
    }
  }, 150_000);
});
