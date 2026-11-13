import { describe, expect, it } from "vitest";
import { describeFailure, providerSaid } from "../src/services/second-opinion.js";

// BOS-1331: the words the owner reads when the second-opinion model fails. These pin how the provider's
// error body is read (providerSaid) and how the failure sentence is built (describeFailure) for the status
// codes and body shapes the whole-service tests on main don't reach. No database, network or app is needed.

const NOT_OPENROUTER = "https://api.example.com/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";

describe("providerSaid (BOS-1331)", () => {
  it("quotes a plain-text error body as it is", () => {
    expect(providerSaid("Bad gateway", null)).toEqual({ said: "Bad gateway", provider: null, upstream: false });
  });

  it("drops an HTML error page, even with leading spaces", () => {
    expect(providerSaid("<html><body>502 Bad Gateway</body></html>", null).said).toBeNull();
    expect(providerSaid("   \n <html><body>502 Bad Gateway</body></html>", null).said).toBeNull();
  });

  it("reads an error given as a plain string", () => {
    expect(providerSaid('{"error":"boom"}', null).said).toBe("boom");
  });

  it("prefers the upstream's raw words over the provider's message, and names the provider", () => {
    const body = JSON.stringify({ error: { message: "Provider returned error", metadata: { provider_name: "Groq", raw: "model overloaded" } } });
    expect(providerSaid(body, null)).toEqual({ said: "model overloaded", provider: "Groq", upstream: true });
  });

  it("reads raw given as an object, with error.message or message", () => {
    const withError = JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: { error: { message: "inner from error" } } } } });
    expect(providerSaid(withError, null).said).toBe("inner from error");
    const withMessage = JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: { message: "inner from message" } } } });
    expect(providerSaid(withMessage, null).said).toBe("inner from message");
  });

  it("calls it upstream only when a provider is named or the message says upstream", () => {
    expect(providerSaid(JSON.stringify({ error: { message: "rate-limited upstream" } }), null).upstream).toBe(true);
    expect(providerSaid(JSON.stringify({ error: { message: "Provider returned error" } }), null).upstream).toBe(false);
  });

  it("replaces the API key in the text with [key], and leaves a key shorter than 8 alone", () => {
    const body = JSON.stringify({ error: { message: "the key abcd1234 was refused" } });
    expect(providerSaid(body, "abcd1234").said).toBe("the key [key] was refused");
    const shortBody = JSON.stringify({ error: { message: "the key abc12 was refused" } });
    expect(providerSaid(shortBody, "abc12").said).toBe("the key abc12 was refused");
  });

  it("squashes runs of spaces and newlines into one space", () => {
    expect(providerSaid("  Bad \n\n  gateway \t  here  ", null).said).toBe("Bad gateway here");
  });

  it("cuts text over 200 characters to 199 plus an ellipsis, and keeps exactly 200 whole", () => {
    const long = "word ".repeat(60); // 300 characters, ending in a space
    const cut = providerSaid(JSON.stringify({ error: { message: long } }), null).said!;
    expect(cut).toBe(`${long.slice(0, 199)}…`);

    const exactly = `${"word ".repeat(40).slice(0, 199)}s`; // 200 characters, ending in a letter
    const kept = providerSaid(JSON.stringify({ error: { message: exactly } }), null).said!;
    expect(kept).toBe(exactly);
  });
});

describe("describeFailure (BOS-1331)", () => {
  it("says a 404 means the model isn't offered", () => {
    expect(describeFailure(404, "{}", null, NOT_OPENROUTER).text).toContain("doesn't offer this model (404)");
  });

  it("says a 200 means an error instead of an answer", () => {
    expect(describeFailure(200, "{}", null, NOT_OPENROUTER).text).toContain("sent an error instead of an answer");
  });

  it("says a 401 refused the key", () => {
    expect(describeFailure(401, "{}", null, NOT_OPENROUTER).text).toContain("refused the key (401)");
  });

  it("says any other code was the provider's answer", () => {
    expect(describeFailure(500, "{}", null, NOT_OPENROUTER).text).toContain("the provider answered 500");
  });

  it("leaves out the quote when the provider said nothing", () => {
    const { text } = describeFailure(500, "{}", null, NOT_OPENROUTER);
    expect(text).toBe("the provider answered 500");
    expect(text).not.toContain(': ""');
  });

  it("gives the key's limits hint only for OpenRouter on a 429", () => {
    const local = describeFailure(429, "{}", null, NOT_OPENROUTER).text;
    expect(local).not.toContain("openrouter.ai");
    expect(local).toContain("with the provider");
    expect(describeFailure(429, "{}", null, OPENROUTER).text).toContain("openrouter.ai/settings/keys");
  });

  it("gives the credit hint only for OpenRouter on a 402", () => {
    const local = describeFailure(402, "{}", null, NOT_OPENROUTER).text;
    expect(local).not.toContain("openrouter.ai");
    expect(local).toContain("Add credit with the provider");
    expect(describeFailure(402, "{}", null, OPENROUTER).text).toContain("openrouter.ai/settings/credits");
  });

  it("gives the spending-limit hint only for OpenRouter on 401 and 403", () => {
    for (const status of [401, 403]) {
      const local = describeFailure(status, "{}", null, NOT_OPENROUTER).text;
      expect(local).not.toContain("openrouter.ai");
      expect(describeFailure(status, "{}", null, OPENROUTER).text).toContain("openrouter.ai/settings/keys");
    }
  });

  it("doesn't mistake openrouter.ai.example.com for OpenRouter", () => {
    const { text } = describeFailure(402, "{}", null, "https://openrouter.ai.example.com/v1");
    expect(text).not.toContain("openrouter.ai/settings");
    expect(text).toContain("Add credit with the provider");
  });

  it("names no one for an upstream 429 without a provider name", () => {
    const body = JSON.stringify({ error: { message: "temporarily rate-limited upstream" } });
    const { text, upstream } = describeFailure(429, body, null, NOT_OPENROUTER);
    expect(upstream).toBe(true);
    expect(text).toContain("the company that runs this model for the provider is too busy");
  });
});
