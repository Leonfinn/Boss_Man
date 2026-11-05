import { describe, expect, it } from "vitest";
import { isClaudeModel, modelFitProblem } from "../src/funding.js";

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
