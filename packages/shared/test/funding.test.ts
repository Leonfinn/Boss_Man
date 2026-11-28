import { describe, expect, it } from "vitest";
import { CONNECT_OPTIONS, FUNDING_PROVIDERS, connectValueProblem, connectSetsUpElsewhere, connectSaves, HARNESSES, harnessLoadsSkills, isClaudeModel, modelFitProblem } from "../src/funding.js";

describe("the connect step's list of ways to pay (BOS-2815)", () => {
  it("covers every provider an agent can run on, with a plan and a key by each other where both exist", () => {
    // Bedrock, Foundry and gateways are one "Other API provider" row.
    const covered = new Set(CONNECT_OPTIONS.filter((o) => o.id !== "other").map((o) => o.provider));
    expect([...FUNDING_PROVIDERS].filter((p) => !["bedrock", "foundry", "gateway"].includes(p)).every((p) => covered.has(p))).toBe(true);
    expect(CONNECT_OPTIONS.filter((o) => o.id === "other").map((o) => o.provider)).toEqual(["gateway"]);
    // Each provider's plan comes straight before its API key, so neither is set apart.
    const ids = CONNECT_OPTIONS.map((o) => o.id);
    expect(ids).toEqual(["claude-plan", "anthropic-key", "chatgpt-plan", "openai-key", "ollama-plan", "ollama-key", "synthetic", "openrouter", "other"]);
  });

  it("every plan that needs a command has steps with a link, and the plans with no value say how to sign in", () => {
    // A plan whose row needs a command on a computer has an install-first link (Rex's must-fix on BOS-2815).
    for (const o of CONNECT_OPTIONS.filter((x) => x.needs === "command" && x.command)) {
      expect(o.command!.installUrl, o.id).toMatch(/^https:\/\//);
      expect(o.command!.run, o.id).toBeTruthy();
    }
    // ChatGPT and Ollama Cloud are signed in to in their own tool: install first, with a link, then sign in.
    for (const id of ["chatgpt-plan", "ollama-plan"]) {
      const o = CONNECT_OPTIONS.find((x) => x.id === id)!;
      expect(o.signIn, id).not.toBeNull();
      expect(o.signIn!.installUrl, id).toMatch(/^https:\/\//);
      expect(o.signIn!.tool, id).toBeTruthy();
      // They save no value here, so they are "set up elsewhere", not a box that would fail.
      expect(connectSaves(o), id).toBe(false);
      expect(connectSetsUpElsewhere(o), id).toBe(true);
    }
    // Every option is either savable here, set up in its own tool, or (only "other") set in Settings → Secrets.
    for (const o of CONNECT_OPTIONS) expect(connectSaves(o) || connectSetsUpElsewhere(o) || o.id === "other", o.id).toBe(true);
  });

  it("tells an owner what to do with a key that doesn't look like the provider's", () => {
    const claude = CONNECT_OPTIONS.find((o) => o.id === "claude-plan")!;
    const anthropic = CONNECT_OPTIONS.find((o) => o.id === "anthropic-key")!;
    expect(connectValueProblem(anthropic, "sk-ant-oat01-a-token")).toMatch(/That's a setup token, not an API key/);
    expect(connectValueProblem(anthropic, "sk-ant-api03-ok")).toBeNull();
    expect(connectValueProblem(anthropic, "nonsense")).toMatch(/isn't an Anthropic API key/);
    expect(connectValueProblem(claude, "sk-ant-api03-a-key")).toMatch(/That's an API key, not a setup token/);
    expect(connectValueProblem(claude, "sk-ant-oat01-ok")).toBeNull();
    expect(connectValueProblem(claude, "  sk-ant-oat01-with spaces ")).toBeNull();
    // A key Boss Man can't judge the shape of gets no made-up complaint.
    expect(connectValueProblem(CONNECT_OPTIONS.find((o) => o.id === "openrouter")!, "anything")).toBeNull();
    expect(connectValueProblem(claude, "")).toMatch(/empty/);
  });
});

describe("modelFitProblem (BOS-477)", () => {
  it("refuses a DeepSeek model on a Claude account, naming the field", () => {
    const problem = modelFitProblem("opencode", "anthropic", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017");
    expect(problem).toContain("Anthropic");
    expect(problem).toContain("Claude models only");
    expect(problem).toContain("DeepSeek-V4.1-Flash-1017");
    expect(problem).toContain("provider");
  });

  it("allows Claude models and aliases on Anthropic, in any harness", () => {
    for (const model of ["claude-opus-4-5", "claude-sonnet", "opus", "default", "claude.3"]) {
      expect(modelFitProblem("claude", "anthropic", model)).toBeNull();
      expect(modelFitProblem("opencode", "anthropic", model)).toBeNull();
    }
  });

  it("accepts the provider-prefixed names OpenCode uses for the chosen provider", () => {
    expect(modelFitProblem("opencode", "anthropic", "anthropic/claude-sonnet-4-5")).toBeNull();
    expect(modelFitProblem("opencode", "openai", "openai/gpt-5")).toBeNull();
    // A prefix for a different provider is not this account's model.
    expect(modelFitProblem("opencode", "anthropic", "openai/gpt-5")).toContain("Claude models only");
    expect(modelFitProblem("opencode", "openai", "anthropic/claude-sonnet-4-5")).toContain("OpenAI models only");
  });

  it("lets the agent move to a provider that serves a non-Claude model", () => {
    // The same DeepSeek model is fine on its own provider; only Claude Code says to change provider.
    expect(modelFitProblem("opencode", "synthetic", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBeNull();
    expect(modelFitProblem("claude", "anthropic", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toContain("provider");
  });

  it("refuses the wrong model family on OpenAI, Ollama and Synthetic", () => {
    expect(modelFitProblem("codex", "openai", "claude-opus-4-5")).toContain("OpenAI models only");
    expect(modelFitProblem("codex", "openai", "gpt-5")).toBeNull();
    expect(modelFitProblem("opencode", "ollama", "synthetic/hf:deepseek-ai/DeepSeek")).toContain("Ollama");
    expect(modelFitProblem("opencode", "ollama", "qwen3:8b")).toBeNull();
    expect(modelFitProblem("opencode", "ollama", "ollama/qwen3:8b")).toBeNull();
    expect(modelFitProblem("opencode", "synthetic", "hf:deepseek-ai/DeepSeek")).toContain("synthetic/");
  });

  it("judges Ollama and Synthetic by the real names the catalog lists", () => {
    // From the second-opinion presets and the runner's OpenCode list.
    expect(modelFitProblem("opencode", "ollama", "gpt-oss-safeguard:20b")).toBeNull();
    expect(modelFitProblem("opencode", "ollama", "qwen3:8b")).toBeNull();
    expect(modelFitProblem("opencode", "synthetic", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBeNull();
    // The same catalog names on the wrong provider.
    expect(modelFitProblem("opencode", "ollama", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toContain("Ollama");
    expect(modelFitProblem("opencode", "synthetic", "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toContain("synthetic/");
  });

  it("leaves providers that serve a mix to their reported model list", () => {
    expect(modelFitProblem("opencode", "gateway", "anthropic/claude-sonnet-4")).toBeNull();
    expect(modelFitProblem("opencode", "bedrock", "anything")).toBeNull();
    expect(modelFitProblem("opencode", "anthropic", "")).toBeNull();
  });

  it("knows Claude model IDs", () => {
    expect(isClaudeModel("claude-opus-4-5")).toBe(true);
    expect(isClaudeModel("synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(false);
  });
});

describe("harnessLoadsSkills (BOS-2354)", () => {
  it("says Claude Code and OpenCode load an agent's skills", () => {
    expect(harnessLoadsSkills("claude")).toBe(true);
    expect(harnessLoadsSkills("opencode")).toBe(true);
  });

  it("says Codex does not, since a skill given to a Codex agent does nothing", () => {
    expect(harnessLoadsSkills("codex")).toBe(false);
  });

  it("agrees with the harness list: every harness except Codex loads skills", () => {
    for (const { value } of HARNESSES) {
      expect(harnessLoadsSkills(value), value).toBe(value !== "codex");
    }
  });

  it("takes an exact harness name, so a misspelling or padding is not a skill harness", () => {
    for (const value of ["", " ", "Claude", "OPENCODE", "opencode ", " claude", "claude-code", "synthetic"]) {
      expect(harnessLoadsSkills(value), value).toBe(false);
    }
  });
});
