/** Who a funding source pays: the provider labels cost and quota, and picks which API lists models for API-key sources. */
export const FUNDING_PROVIDERS = ["anthropic", "openai", "bedrock", "foundry", "gateway", "openrouter", "ollama", "synthetic"] as const;
export type FundingProvider = (typeof FUNDING_PROVIDERS)[number];
export const FUNDING_KINDS = ["api_credit", "subscription", "usage_credits", "api_payg"] as const;

/** The harnesses an agent can run on, with the names the Agents page shows. */
export const HARNESSES = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
] as const;
export type Harness = (typeof HARNESSES)[number]["value"];
export const harnessLabel = (value: string) => HARNESSES.find((h) => h.value === value)?.label ?? value;

/** The providers a funding source can pay, with the names the Agents page and Settings show. */
export const PROVIDER_LABELS: Record<FundingProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  bedrock: "Amazon Bedrock",
  foundry: "Microsoft Foundry",
  gateway: "LLM gateway",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  synthetic: "Synthetic",
};
export const providerLabel = (value: string) => PROVIDER_LABELS[value as FundingProvider] ?? value;

/** OpenCode names a model with its provider as a prefix (`anthropic/claude-sonnet-4-5`), so drop a
 * leading `<provider>/` before judging the family. Another provider's prefix is left in place. */
const withoutProviderPrefix = (model: string, provider: string) => {
  const id = model.trim().toLowerCase();
  return provider && id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
};

/** Whether a model ID is a Claude one, as Claude accounts and Claude Code expect. */
export const isClaudeModel = (model: string, provider = "") => {
  const id = withoutProviderPrefix(model, provider);
  return id === "default" || id === "opus" || id === "sonnet" || id === "haiku" || id === "fable" || /^claude[-.]/.test(id);
};

/**
 * Why this model can't run on this funding source, or null when nothing rules it out (BOS-477).
 * Anthropic (every Claude account) serves Claude models only, an OpenAI account serves OpenAI
 * models, and Ollama and Synthetic serve their own. Bedrock, Foundry and gateways serve a mix,
 * so their reported model list is the check.
 */
export function modelFitProblem(harness: string, provider: string, model: string): string | null {
  if (!model.trim()) return null;
  const id = model.trim().toLowerCase();
  const bare = withoutProviderPrefix(model, provider);
  const others = harness === "claude" ? "" : " You can also move the agent to a provider that serves this model.";
  if (provider === "anthropic" && !isClaudeModel(model, provider)) return `Anthropic serves Claude models only, so it can't run ${model}. Pick a Claude model, or a provider whose account serves it.${others}`;
  if (provider === "openai" && !/^(gpt-|o\d|codex|chatgpt)/.test(bare)) return `OpenAI serves OpenAI models only, so it can't run ${model}. Pick an OpenAI model.${others}`;
  // An Ollama model is a bare name or an "ollama/" one; another provider's prefix is never served.
  if (provider === "ollama" && id.includes("/") && !id.startsWith("ollama/")) return `Ollama serves the models it has pulled, so it can't run ${model}. Pick an Ollama model (its name has no "provider/" prefix).${others}`;
  if (provider === "synthetic" && !id.startsWith("synthetic/")) return `Synthetic serves its own models, so it can't run ${model}. Pick a model that starts with "synthetic/".${others}`;
  return null;
}

/** A subscription is a Claude, ChatGPT, Ollama Cloud or Synthetic plan, so only those providers can have one. */
export function fundingComboError(kind: string, provider: string): string | null {
  if (kind === "subscription" && provider !== "anthropic" && provider !== "openai" && provider !== "ollama" && provider !== "synthetic") return "A subscription can only be Anthropic (Claude Pro/Max), OpenAI (ChatGPT plan), Ollama (Ollama Cloud plan) or Synthetic (standard plan). Use an API kind for this provider.";
  return null;
}
