// BOS-1141: the login guard (R45) counts failures per client address and per username over a
// rolling window. Past the limit, attempts are refused until the oldest counted failure leaves
// the window, even with the right password. The injectable clock keeps this off real timers.
import { describe, expect, it } from "vitest";
import { DEFAULT_LOGIN_LIMITS, loginLimiter, lockoutNoticeGate } from "../src/login-limit.js";

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

  // BOS-2177: the owner is told once when a lock starts.
  describe("lockout notice", () => {
    function withNotice(maxFailures = 3, windowMs = 60_000) {
      let t = 1_000_000;
      const events: Array<{ ip: string; at: number; byAddress: boolean; byUsername: boolean; ownerUsername: boolean }> = [];
      const limiter = loginLimiter({ maxFailures, windowMs }, () => t, (e) => events.push(e));
      return { limiter, events, advance: (ms: number) => (t += ms) };
    }

    it("fires once, on the failure that reaches the limit, and not below it", () => {
      const { limiter, events } = withNotice();
      limiter.failed("192.168.1.50", "guess-one");
      limiter.failed("192.168.1.50", "guess-two");
      expect(events).toEqual([]);
      limiter.failed("192.168.1.50", "guess-three");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ ip: "192.168.1.50", at: 1_000_000, byAddress: true, byUsername: false });
    });

    it("adds nothing for attempts refused while locked", () => {
      const { limiter, events } = withNotice();
      for (let i = 0; i < 3; i++) limiter.failed("192.168.1.50", "owner");
      expect(events).toHaveLength(1);
      // The route refuses on retryAfter and never calls failed again while locked.
      for (let i = 0; i < 5; i++) expect(limiter.retryAfter("192.168.1.50", "owner")).toBeGreaterThan(0);
      expect(events).toHaveLength(1);
    });

    it("tells again for a new window, and separately for another address", () => {
      const { limiter, events, advance } = withNotice();
      for (let i = 0; i < 3; i++) limiter.failed("192.168.1.50", "owner");
      advance(60_001);
      for (let i = 0; i < 3; i++) limiter.failed("192.168.1.50", "owner");
      expect(events).toHaveLength(2);
      for (let i = 0; i < 3; i++) limiter.failed("192.168.1.51", "someone");
      expect(events).toHaveLength(3);
    });

    it("tells once when address and username lock together, and says which", () => {
      const { limiter, events } = withNotice();
      for (let i = 0; i < 3; i++) limiter.failed("192.168.1.50", "owner");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ byAddress: true, byUsername: true });
    });

    it("tells for a username locked from changing addresses, and never carries the guess", () => {
      const { limiter, events } = withNotice();
      limiter.failed("192.168.1.50", "owner");
      limiter.failed("192.168.1.51", "owner");
      limiter.failed("192.168.1.52", "owner");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ ip: "192.168.1.52", byAddress: false, byUsername: true });
      expect(Object.keys(events[0]!).sort()).toEqual(["at", "byAddress", "byUsername", "ip", "ownerUsername"]);
      expect(events[0]!.ownerUsername).toBe(false);
    });

    it("BOS-2207: says whether the locked username is an owner's, from what the caller passes", () => {
      const { limiter, events } = withNotice();
      for (let i = 0; i < 3; i++) limiter.failed(`192.168.1.${60 + i}`, "owner", true);
      expect(events[0]).toMatchObject({ byUsername: true, ownerUsername: true });
    });

    it("a notice that throws doesn't change the lockout", () => {
      let t = 0;
      const limiter = loginLimiter({ maxFailures: 1, windowMs: 1000 }, () => t, () => {
        throw new Error("boom");
      });
      expect(() => limiter.failed("192.168.1.50", "owner")).not.toThrow();
      expect(limiter.retryAfter("192.168.1.50", "owner")).toBe(1000);
    });
  });

  // BOS-2207: a cap across addresses.
  describe("lockoutNoticeGate", () => {
    it("lets 3 notices through an hour, holds the rest and tells the count with the next one", () => {
      let t = 0;
      const gate = lockoutNoticeGate(3, 3_600_000, () => t);
      for (let i = 0; i < 3; i++) expect(gate.take()).toEqual({ send: true, held: 0 });
      for (let i = 0; i < 50; i++) expect(gate.take().send).toBe(false);
      t += 3_600_001;
      expect(gate.take()).toEqual({ send: true, held: 50 });
      expect(gate.take()).toEqual({ send: true, held: 0 });
    });

    it("asks for one summary on the first held lock, and flush hands over the count once", () => {
      let t = 0;
      const gate = lockoutNoticeGate(1, 1000, () => t);
      expect(gate.take().send).toBe(true);
      t += 400;
      expect(gate.take()).toEqual({ send: false, held: 1, summaryInMs: 600 });
      expect(gate.take()).toEqual({ send: false, held: 2 });
      expect(gate.flush()).toBe(2);
      expect(gate.flush()).toBe(0);
    });
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
