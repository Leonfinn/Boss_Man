// BOS-279: a stock OpenCode doesn't know Synthetic's Infinite mode (`ProviderModelNotFoundError`), so the
// runner adds its provider (`hf`, an OpenAI-compatible endpoint at api.synthetic.new) and launches the run as
// `hf/infinite:...`. Checked against the real OpenCode 1.19.3 behaviour recorded on the ticket.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { infiniteProviderConfig, opencodeEnv, SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");

async function run(opts: { model: string | null; secrets?: Record<string, string>; offered?: string[]; skills?: Array<{ name: string; files: Array<{ path: string; content: string }> }>; skillsRoot?: string }) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-oc-")), "dump.json");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    ...(opts.skillsRoot ? { skillsRoot: opts.skillsRoot } : {}),
    resolveEnv: async () => ({ DUMP: dump, ...(opts.skills?.length ? { FAKE_SKILL: opts.skills[0].name } : {}),...(opts.offered ? { FAKE_MODELS: JSON.stringify(opts.offered) } : {}), ...opts.secrets }),
    emit: (e) => (events.push(e), e.type === "run.ended" && done()),
  });
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: opts.model, cwd: mkdtempSync(path.join(tmpdir(), "bm-oc-ws-")), prompt: "hi", mcpToken: "t", ...(opts.skills ? { skills: opts.skills } : {}) } as never);
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

  it("hands the agent's skills to OpenCode through skills.paths, keeping the owner's paths, and removes them after the run (BOS-2264)", async () => {
    const skillsRoot = mkdtempSync(path.join(tmpdir(), "bm-oc-skills-"));
    const md = "---\nname: queued-lane\ndescription: Say when a queued ticket stays blocked.\n---\n\n# Queued lane\n";
    const { dump } = await run({
      model: "synthetic/infinite:small:vision",
      offered: ["hf/infinite:small:vision"],
      skillsRoot,
      skills: [{ name: "queued-lane", files: [{ path: "SKILL.md", content: Buffer.from(md).toString("base64") }] }],
    });
    expect(dump.config.skills.paths).toEqual([path.join(skillsRoot, "r1", ".claude", "skills")]);
    // The fake OpenCode read the skill's text from that folder while the run was live.
    expect(dump.skillText).toContain("# Queued lane");
    expect(existsSync(path.join(skillsRoot, "r1"))).toBe(false);
    // The Infinite provider and the permission settings are still there.
    expect(dump.config.provider.hf).toBeDefined();
    expect(dump.config.permission.bash).toBe("ask");
  });

  it("keeps skill folders the owner already granted", () => {
    const config = JSON.parse(opencodeEnv(JSON.stringify({ skills: { paths: ["/owner/skills"] } }), "ask", false, "/run/skills").OPENCODE_CONFIG_CONTENT!);
    expect(config.skills.paths).toEqual(["/owner/skills", "/run/skills"]);
  });

  it("gives OpenCode no skills setting when the agent has no skills", () => {
    expect(JSON.parse(opencodeEnv(undefined, "ask").OPENCODE_CONFIG_CONTENT!).skills).toBeUndefined();
    expect(JSON.parse(opencodeEnv(undefined, "ask", false, "/run/skills").OPENCODE_CONFIG_CONTENT!).skills).toEqual({ paths: ["/run/skills"] });
  });

  it("leaves a normal Synthetic model alone", async () => {
    const { dump } = await run({ model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", offered: ["synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"] });
    expect(dump.config.provider).toBeUndefined();
    expect(dump.model).toBe("synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });
});
