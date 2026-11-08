// BOS-279: a stock OpenCode doesn't know Synthetic's Infinite mode (`ProviderModelNotFoundError`), so the
// runner adds its provider (`hf`, an OpenAI-compatible endpoint at api.synthetic.new) and launches the run as
// `hf/infinite:...`. Checked against the real OpenCode 1.19.3 behaviour recorded on the ticket.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { infiniteProviderConfig, opencodeEnv, SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");

async function run(opts: { model: string | null; secrets?: Record<string, string>; offered?: string[] }) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-oc-")), "dump.json");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    resolveEnv: async () => ({ DUMP: dump, ...(opts.offered ? { FAKE_MODELS: JSON.stringify(opts.offered) } : {}), ...opts.secrets }),
    emit: (e) => (events.push(e), e.type === "run.ended" && done()),
  });
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: opts.model, cwd: mkdtempSync(path.join(tmpdir(), "bm-oc-ws-")), prompt: "hi", mcpToken: "t" } as never);
  await ended;
  manager.shutdown();
  return { events, dump: JSON.parse(readFileSync(dump, "utf8")) };
}

describe("Synthetic Infinite mode on OpenCode (BOS-279)", () => {
  it("adds no provider for a normal model", () => {
    const env = opencodeEnv(undefined, "ask");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider).toBeUndefined();
  });

  it("adds the hf provider only for an infinite model, keeping the owner's own providers", () => {
    const env = opencodeEnv(JSON.stringify({ provider: { ollama: { options: { baseURL: "http://127.0.0.1:11434/v1" } } } }), "ask", true);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.provider.ollama).toBeDefined();
    expect(config.provider.hf).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.synthetic.new/openai/v1", apiKey: "{env:SYNTHETIC_API_KEY}" } });
    expect(Object.keys(config.provider.hf.models)).toEqual(["infinite:small:vision"]);
    // The key comes from the company's secret at run time, never from the config text.
    expect(config.provider.hf.options.apiKey).not.toMatch(/sk-/);
  });

  it("keeps a provider the owner already set up under that name", () => {
    const mine = { hf: { npm: "custom", options: { baseURL: "https://elsewhere.example/v1" } } };
    expect(infiniteProviderConfig(mine)).toBe(mine);
  });

  it("launches the run as hf/infinite:... and says so on run.started", async () => {
    // As the runner reports it: the model list holds the launch id (the provider it adds).
    const { events, dump } = await run({ model: "synthetic/infinite:small:vision", offered: ["hf/infinite:small:vision"] });
    expect(dump.config.provider.hf.options.baseURL).toBe("https://api.synthetic.new/openai/v1");
    expect(dump.model).toBe("hf/infinite:small:vision");
    expect(events.find((e) => e.type === "run.started")).toMatchObject({ model: "hf/infinite:small:vision" });
  });

  it("leaves a normal Synthetic model alone", async () => {
    const { dump } = await run({ model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", offered: ["synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"] });
    expect(dump.config.provider).toBeUndefined();
    expect(dump.model).toBe("synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });
});
