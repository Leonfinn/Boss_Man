// BOS-1147: fundingComboError is what the owner sees when Settings -> Funding pairs a subscription with a
// provider that has no subscription plan.
import { describe, expect, it } from "vitest";
import { FUNDING_KINDS, FUNDING_PROVIDERS, fundingComboError } from "../src/funding.js";

const SUBSCRIPTION_PROVIDERS: readonly string[] = ["anthropic", "openai", "ollama", "synthetic"];

describe("fundingComboError", () => {
  it("accepts a subscription on each provider that has a subscription plan", () => {
    for (const provider of SUBSCRIPTION_PROVIDERS) expect(fundingComboError("subscription", provider)).toBeNull();
  });

  it("refuses a subscription on every other provider, naming all four plans", () => {
    const others = FUNDING_PROVIDERS.filter((provider) => !SUBSCRIPTION_PROVIDERS.includes(provider));
    for (const provider of [...others, "google", ""]) {
      const problem = fundingComboError("subscription", provider);
      expect(problem).toContain("A subscription can only be");
      for (const name of ["Anthropic", "OpenAI", "Ollama", "Synthetic"]) expect(problem).toContain(name);
    }
  });

  it("accepts every non-subscription kind for every provider, including unknown ones", () => {
    const kinds = FUNDING_KINDS.filter((kind) => kind !== "subscription");
    for (const kind of kinds) {
      for (const provider of [...FUNDING_PROVIDERS, "google", "", "made-up"]) {
        expect(fundingComboError(kind, provider)).toBeNull();
      }
    }
  });

  // The UI may send only lower case today, so a capitalised provider is still refused; this fails until it is normalised.
  it.fails("accepts a capitalised provider name", () => {
    expect(fundingComboError("subscription", "Anthropic")).toBeNull();
  });
});
