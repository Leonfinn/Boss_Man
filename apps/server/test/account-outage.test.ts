import { describe, expect, it } from "vitest";
import { accountOutage } from "../src/services/loop-guards.js";

// BOS-1332: accountOutage decides whether an agent's error is the owner's account (a usage limit, a
// lost login or an empty balance) rather than the agent's own work. These pin which window and
// account name it reports, and that an ordinary 403 stays the agent's problem.

const OWNER = "The owner's account";

describe("accountOutage", () => {
  it("names the weekly limit without calling it a credential problem", () => {
    const outage = accountOutage("You've hit your weekly limit");
    expect(outage).toEqual({ fundingSourceId: "company", name: OWNER, window: "the weekly limit" });
    expect(outage).not.toHaveProperty("auth");
  });

  it("drops an Error: prefix and keeps the account name and the 5-hour window", () => {
    expect(accountOutage("Error: Max plan: 5-hour limit reached")).toEqual({ fundingSourceId: "company", name: "Max plan", window: "the 5-hour limit" });
  });

  it("lower-cases a rate limit it finds in capitals", () => {
    expect(accountOutage("RATE LIMIT exceeded")).toEqual({ fundingSourceId: "company", name: OWNER, window: "the rate limit" });
  });

  it("treats credential problems as auth, with no limit window", () => {
    expect(accountOutage("Invalid API key")).toEqual({ fundingSourceId: "company", name: OWNER, auth: true });
    for (const text of ["Unauthorised", "identity verification required", "please sign in again"]) {
      const outage = accountOutage(text);
      expect(outage, text).toMatchObject({ fundingSourceId: "company", name: OWNER, auth: true });
      expect(outage, text).not.toHaveProperty("window");
    }
  });

  it("reports both an empty credit balance and the login problem it causes", () => {
    expect(accountOutage("Your credit balance is too low")).toEqual({ fundingSourceId: "company", name: OWNER, window: "the credit balance", auth: true });
  });

  it("leaves an ordinary 403 and empty output to the agent", () => {
    expect(accountOutage("git push: 403 Forbidden")).toBeNull();
    expect(accountOutage("")).toBeNull();
  });

  it("falls back to the owner's account for a name it cannot use", () => {
    // One-character prefix.
    expect(accountOutage("X: rate limit")).toMatchObject({ name: OWNER, window: "the rate limit" });
    // Prefix over 40 characters.
    expect(accountOutage(`${"A".repeat(41)}: rate limit`)).toMatchObject({ name: OWNER, window: "the rate limit" });
    // A character outside letters, digits, space, dot, apostrophe and hyphen.
    expect(accountOutage("acct_1: rate limit")).toMatchObject({ name: OWNER, window: "the rate limit" });
  });
});
