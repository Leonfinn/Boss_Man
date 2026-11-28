import { SECRET_KINDS, type SecretKind } from "./secrets.js";

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
/** The harnesses that load an agent's skills: Claude Code and OpenCode (BOS-2264). Codex doesn't, so a skill given to a Codex agent does nothing. */
export const SKILL_HARNESSES: readonly string[] = ["claude", "opencode"];
export const harnessLoadsSkills = (value: string) => SKILL_HARNESSES.includes(value);
export const harnessLabel =(value: string) => HARNESSES.find((h) => h.value === value)?.label ?? value;

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

/**
 * The ways to connect a first agent, as the setup wizard lists them (BOS-2815): fixed by provider, a plan
 * and its API key next to each other, and nothing favoured. Each row opens its own short steps.
 * `from` names the funding.ts entry it is (the provider, plus the plan kind), so the list follows the
 * providers the server can pay; "other" is one row for Bedrock, Foundry and gateways, whose keys are
 * several values and so are set in Settings > Secrets (funding.ts says how).
 */
export type ConnectOption = {
  id: string;
  name: string;
  /** What it costs, in a few words. */
  cost: string;
  /** What the owner needs to hand: a browser, or one command on their own computer. */
  needs: "browser" | "command";
  kind: "subscription" | "api_payg";
  provider: FundingProvider;
  /** The secret kind and the variable an agent reads, when the wizard saves the value itself; null for "other". */
  secret: { kind: SecretKind; envName: string } | null;
  /** The harness its agents run on, so the runner reports the right models. */
  harness: Harness;
  /** The value's expected start, for the plain error under the box; null when Boss Man can't tell. */
  valueStarts: string | null;
  /** Who makes it on the web (shown with "confirmed on <date>" or "not yet confirmed" as the site changes it). */
  steps: { site: string; url: string; checked: string; note: string } | null;
  /** The command path: where the tool is installed from, and the command that prints the value. */
  command: { install: { mac: string; windows: string }; installUrl: string; run: string; makeUrl: string; checked: string; note: string } | null;
  /** A plan signed in to in its own tool, where the wizard saves nothing: what to do (install, sign in), and where. */
  signIn: { tool: string; installUrl: string; site: string; url: string; checked: string; note: string } | null;
  /** Where the website explains it. */
  guide: string;
};

const INSTALL = { mac: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex" };

export const CONNECT_OPTIONS: readonly ConnectOption[] = [
  {
    id: "claude-plan",
    name: "Claude Pro or Max plan",
    cost: "Fixed monthly",
    needs: "command",
    kind: "subscription",
    provider: "anthropic",
    secret: { kind: "claude_oauth_token", envName: "CLAUDE_CODE_OAUTH_TOKEN" },
    harness: "claude",
    valueStarts: "sk-ant-oat01-",
    steps: null,
    command: { install: INSTALL, installUrl: "https://code.claude.com/docs/en/setup", run: "claude setup-token", makeUrl: "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token", checked: "27 November 2026", note: "Claude Code's setup and authentication pages; the command has not been run for this wizard." },
    signIn: null,
    guide: "connect-a-claude-account",
  },
  {
    id: "anthropic-key",
    name: "Anthropic API key",
    cost: "Pay as you go",
    needs: "browser",
    kind: "api_payg",
    provider: "anthropic",
    secret: { kind: "anthropic_api_key", envName: "ANTHROPIC_API_KEY" },
    harness: "claude",
    valueStarts: "sk-ant-api",
    steps: { site: "platform.claude.com: Billing (buy credit), then Spend limits (set a monthly cap), then API keys → Create key", url: "https://platform.claude.com/settings/keys", checked: "27 November 2026", note: "Anthropic's help pages; not yet walked through in a signed-in Console." },
    command: null,
    signIn: null,
    guide: "connect-a-claude-account",
  },
  {
    id: "chatgpt-plan",
    name: "ChatGPT plan",
    cost: "Fixed monthly",
    needs: "command",
    kind: "subscription",
    provider: "openai",
    secret: null,
    harness: "codex",
    valueStarts: null,
    steps: null,
    command: null,
    signIn: {
      tool: "Codex",
      installUrl: "https://github.com/openai/codex",
      site: "OpenAI's Codex page: install Codex, then run codex login and sign in with the ChatGPT account your plan is on",
      url: "https://chatgpt.com/codex",
      checked: "not yet confirmed",
      note: "Codex's install and login are set up on the computer the runner runs on; nothing is pasted into this page.",
    },
    guide: "agents-and-models",
  },
  {
    id: "openai-key",
    name: "OpenAI API key",
    cost: "Pay as you go",
    needs: "browser",
    kind: "api_payg",
    provider: "openai",
    secret: { kind: "openai_api_key", envName: "OPENAI_API_KEY" },
    harness: "codex",
    valueStarts: "sk-",
    steps: { site: "platform.openai.com: Billing (add credit and a monthly limit), then API keys → Create new secret key", url: "https://platform.openai.com/api-keys", checked: "not yet confirmed", note: "OpenAI changes this console often; check the page before following it." },
    command: null,
    signIn: null,
    guide: "agents-and-models",
  },
  {
    id: "ollama-plan",
    name: "Ollama Cloud plan",
    cost: "Fixed monthly",
    needs: "command",
    kind: "subscription",
    provider: "ollama",
    secret: null,
    harness: "opencode",
    valueStarts: null,
    steps: null,
    command: null,
    signIn: {
      tool: "Ollama",
      installUrl: "https://ollama.com/download",
      site: "ollama.com: install Ollama, then run ollama signin and sign in with the account your Cloud plan is on",
      url: "https://ollama.com/download",
      checked: "not yet confirmed",
      note: "Ollama's install and sign-in are set up on the computer the runner runs on; nothing is pasted into this page.",
    },
    guide: "agents-and-models",
  },
  {
    id: "ollama-key",
    name: "Ollama Cloud API key",
    cost: "Pay as you go",
    needs: "browser",
    kind: "api_payg",
    provider: "ollama",
    secret: { kind: "generic", envName: "OLLAMA_API_KEY" },
    harness: "opencode",
    valueStarts: null,
    steps: { site: "ollama.com: Settings → Keys → Create key", url: "https://ollama.com/settings/keys", checked: "not yet confirmed", note: "Ollama's own pages; not yet walked through in a signed-in account." },
    command: null,
    signIn: null,
    guide: "agents-and-models",
  },
  {
    id: "synthetic",
    name: "Synthetic",
    cost: "Pay as you go, or a fixed monthly plan",
    needs: "browser",
    kind: "api_payg",
    provider: "synthetic",
    secret: { kind: "generic", envName: "SYNTHETIC_API_KEY" },
    harness: "opencode",
    valueStarts: null,
    steps: { site: "synthetic.new: API keys → Create key", url: "https://synthetic.new/", checked: "not yet confirmed", note: "Synthetic's own pages; not yet walked through in a signed-in account." },
    command: null,
    signIn: null,
    guide: "agents-and-models",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    cost: "Pay as you go",
    needs: "browser",
    kind: "api_payg",
    provider: "openrouter",
    secret: { kind: "generic", envName: "OPENROUTER_API_KEY" },
    harness: "opencode",
    valueStarts: null,
    steps: { site: "openrouter.ai: Credits (buy credit and set a limit), then Keys → Create key", url: "https://openrouter.ai/keys", checked: "not yet confirmed", note: "OpenRouter's own pages; not yet walked through in a signed-in account." },
    command: null,
    signIn: null,
    guide: "agents-and-models",
  },
  {
    id: "other",
    name: "Other API provider",
    cost: "Pay as you go",
    needs: "browser",
    kind: "api_payg",
    provider: "gateway",
    secret: null,
    harness: "claude",
    valueStarts: null,
    steps: null,
    command: null,
    signIn: null,
    guide: "agents-and-models",
  },
];

/** The env variables the connect step can save: a plan's or key's own, and the others (each harness has a key it starts on). */
export const CONNECT_ENV_NAMES: readonly string[] = CONNECT_OPTIONS.flatMap((o) => (o.secret ? [o.secret.envName] : []));

/** The options whose secret is saved from the connect step. */
export const connectSaves = (o: ConnectOption): o is ConnectOption & { secret: NonNullable<ConnectOption["secret"]> } => o.secret !== null;

/**
 * An option with no value to paste, whose steps are already there, is not connected from this page: it is signed in
 * to in its own tool, and Boss Man is set up for it under Settings (BOS-2815). Only "Other API provider" is left,
 * whose keys are several values.
 */
export const connectSetsUpElsewhere = (o: ConnectOption): boolean => !connectSaves(o) && (o.signIn !== null || o.steps !== null);

/** A listed secret kind must be one the server stores, or its save must be refused before anything is written. */
for (const o of CONNECT_OPTIONS) if (o.secret && !SECRET_KINDS.includes(o.secret.kind)) throw new Error(`${o.id} names a secret kind the server doesn't have: ${o.secret.kind}`);

/** "sk-ant-api", not "sk-", in a sentence. */
const shownStart = (prefix: string) => prefix.replace(/-$/, "");

/**
 * Why a setup token or API key can't be saved, as the connect step says it (BOS-2815): what the value
 * looks like and what to do about it, not "Expected the value to start with". Null when nothing is wrong.
 */
export function connectValueProblem(option: ConnectOption, value: string): string | null {
  const v = value.replace(/\s+/g, "");
  if (!v) return "The box is empty. Paste the key here.";
  if (option.id === "claude-plan") {
    if (v.startsWith("sk-ant-api")) return "That's an API key, not a setup token. Go back and choose Anthropic API key, or run the command again for a setup token.";
    if (!v.startsWith("sk-ant-oat01-")) return 'That isn\'t a setup token: one starts with "sk-ant-oat01-". Copy the whole line the command printed and paste it again.';
    return null;
  }
  if (option.id === "anthropic-key") {
    if (v.startsWith("sk-ant-oat01-")) return "That's a setup token, not an API key. Go back and choose your Claude plan, or create an API key in the Console.";
    if (!v.startsWith("sk-ant-api")) return 'That isn\'t an Anthropic API key: one starts with "sk-ant-api". Copy the whole key from the Console and paste it again.';
    return null;
  }
  if (option.id === "openai-key") {
    if (!v.startsWith("sk-")) return 'That isn\'t an OpenAI API key: one starts with "sk-". Copy the whole key and paste it again.';
    return null;
  }
  return null;
}

/** The value's expected start, as the error names it, for the hint under the box. */
export function connectValueHint(option: ConnectOption): string | null {
  return option.secret && option.valueStarts ? `${option.secret.kind === "claude_oauth_token" ? "The token" : "The key"} starts with "${shownStart(option.valueStarts)}".` : null;
}

/** A subscription is a Claude, ChatGPT, Ollama Cloud or Synthetic plan, so only those providers can have one. */
export function fundingComboError(kind: string, provider: string): string | null {
  if (kind === "subscription" && provider !== "anthropic" && provider !== "openai" && provider !== "ollama" && provider !== "synthetic") return "A subscription can only be Anthropic (Claude Pro/Max), OpenAI (ChatGPT plan), Ollama (Ollama Cloud plan) or Synthetic (standard plan). Use an API kind for this provider.";
  return null;
}

/**
 * Synthetic's Infinite mode (BOS-279, Big plan): the model alias `infinite:small:vision` doesn't spend the
 * plan's credits but is slow and needs streaming. Agents on a model whose last path part starts
 * `infinite:` run in the background: no quota hold, their own run limit, a longer quiet-run limit, and no
 * usage estimate. Matched on the model id alone, so it holds however OpenCode spells the provider
 * (`synthetic/infinite:...`, `hf/infinite:...`).
 */
export const INFINITE_MODEL = "infinite:small:vision";
export function isInfiniteModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const id = model.trim().slice(model.lastIndexOf("/") + 1);
  return id.toLowerCase().startsWith("infinite:");
}

/** The same model, named as OpenCode launches it on the infinite provider (runner: session-manager.ts). */
export const infiniteLaunchModel = (model: string) => `hf/${model.slice(model.lastIndexOf("/") + 1)}`;

/** The model picker's entry for Infinite mode, offered to OpenCode agents paid from a Synthetic plan. */
export const INFINITE_MODEL_CHOICE = {
  value: `synthetic/${INFINITE_MODEL}`,
  name: "Infinite mode — free, slow (Synthetic Big plan)",
  description: "Doesn't spend the plan's credits, so it never waits for the quota. Much slower. Runs in the background slots, not the normal ones.",
} as const;
