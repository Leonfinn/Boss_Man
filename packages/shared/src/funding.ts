/** Who a funding source pays: the provider labels cost and quota, and picks which API lists models for API-key sources. */
export const FUNDING_PROVIDERS = ["anthropic", "openai", "bedrock", "foundry", "gateway"] as const;
export type FundingProvider = (typeof FUNDING_PROVIDERS)[number];
export const FUNDING_KINDS = ["api_credit", "subscription", "usage_credits", "api_payg"] as const;

/** A subscription is a Claude or ChatGPT plan, so only those two providers can have one. */
export function fundingComboError(kind: string, provider: string): string | null {
  if (kind === "subscription" && provider !== "anthropic" && provider !== "openai") return "A subscription can only be Anthropic (Claude Pro/Max) or OpenAI (ChatGPT plan). Use an API kind for this provider.";
  return null;
}
