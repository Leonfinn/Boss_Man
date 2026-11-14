// BOS-1141: the login guard (R45) counts failures per client address and per username over a
// rolling window. Past the limit, attempts are refused until the oldest counted failure leaves
// the window, even with the right password. The injectable clock keeps this off real timers.
import { describe, expect, it } from "vitest";
import { DEFAULT_LOGIN_LIMITS, loginLimiter } from "../src/login-limit.js";

function setup(maxFailures = 3, windowMs = 60_000) {
  let t = 1_000_000;
  const limiter = loginLimiter({ maxFailures, windowMs }, () => t);
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe("loginLimiter", () => {
  it("allows attempts below the limit and refuses at it, for as long as the oldest failure counts", () => {
    const { limiter, advance } = setup();
    limiter.failed("10.0.0.1", "owner");
    limiter.failed("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);

    limiter.failed("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(60_000);

    advance(30_000);
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(30_000);

    advance(30_000);
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);
  });

  it("counts failures per address and per username, so neither one alone gets around the lockout", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.failed("10.0.0.1", "owner");

    expect(limiter.retryAfter("10.0.0.1", "owner")).toBeGreaterThan(0);
    // The same username from a new address is still refused.
    expect(limiter.retryAfter("10.0.0.2", "owner")).toBeGreaterThan(0);
    // A new username from the refused address is still refused.
    expect(limiter.retryAfter("10.0.0.1", "someone-else")).toBeGreaterThan(0);
    // A fresh address and username together is allowed again.
    expect(limiter.retryAfter("10.0.0.2", "someone-else")).toBe(0);
  });

  it("shares one count between usernames that differ only in case", () => {
    const { limiter } = setup();
    limiter.failed("10.0.0.1", "Owner");
    limiter.failed("10.0.0.1", "oWnEr");
    expect(limiter.retryAfter("10.0.0.1", "OWNER")).toBe(0);

    limiter.failed("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "OwNeR")).toBeGreaterThan(0);
  });

  it("lets a slow trickle of failures through because old ones leave the window", () => {
    const { limiter, advance } = setup();
    limiter.failed("10.0.0.1", "owner");
    advance(30_000);
    limiter.failed("10.0.0.1", "owner");
    advance(30_000);
    limiter.failed("10.0.0.1", "owner");
    // The oldest failure is now exactly one window old, so only two still count.
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);

    advance(30_000);
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);
  });

  it("clears both counts on a success for that address and username, leaving another user's count alone", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) {
      limiter.failed("10.0.0.1", "owner");
      limiter.failed("10.0.0.1", "alice");
    }
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBeGreaterThan(0);
    expect(limiter.retryAfter("10.0.0.1", "alice")).toBeGreaterThan(0);

    limiter.succeeded("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);
    // Alice's username count is untouched, even though the address count was cleared.
    expect(limiter.retryAfter("10.0.0.1", "alice")).toBeGreaterThan(0);
  });

  it("clears a mixed-case success from the same shared username count", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.failed("10.0.0.1", "Owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBeGreaterThan(0);

    limiter.succeeded("10.0.0.1", "OWNER");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);
  });

  it("defaults to 10 failures in 15 minutes", () => {
    expect(DEFAULT_LOGIN_LIMITS).toEqual({ maxFailures: 10, windowMs: 15 * 60_000 });

    let t = 1_000_000;
    const limiter = loginLimiter(DEFAULT_LOGIN_LIMITS, () => t);
    for (let i = 0; i < 9; i++) limiter.failed("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);

    limiter.failed("10.0.0.1", "owner");
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(15 * 60_000);

    t += 15 * 60_000;
    expect(limiter.retryAfter("10.0.0.1", "owner")).toBe(0);
  });
});
