// BOS-2222: the two lightweight merge-wait helpers. cardHeld is the wait for an open card on the ticket (BOS-919),
// and isSignoffPending tells that wait apart from an owner sign-off wait (BOS-471). No database, no clock.
import { describe, expect, it } from "vitest";
import { cardHeld, isSignoffPending, ReviewError, ReviewHeldError, SignoffPendingError } from "../src/services/review-common.js";

describe("cardHeld", () => {
  it("is a held merge that names the open card and its own message", () => {
    const err = cardHeld("card-123");
    expect(err).toBeInstanceOf(ReviewHeldError);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err.status).toBe(409);
    expect(err.message).toContain("card-123");
    expect(err.message).toMatch(/still open, so nothing was merged/);
    expect(err.retryable).toBe(false);
  });

  it("is a distinct hold from the reviewer-passed hold, told apart by its message", () => {
    expect(cardHeld("card-123").message).not.toBe(new ReviewHeldError().message);
    expect(isSignoffPending(cardHeld("card-123"))).toBe(false);
  });
});

describe("isSignoffPending", () => {
  it("is true for the sign-off wait", () => {
    expect(isSignoffPending(new SignoffPendingError())).toBe(true);
  });

  it("is false for the other waits and for anything that is not one", () => {
    expect(isSignoffPending(new ReviewHeldError())).toBe(false);
    expect(isSignoffPending(new ReviewError(500, "boom"))).toBe(false);
    expect(isSignoffPending(new Error("boom"))).toBe(false);
    expect(isSignoffPending(null)).toBe(false);
    expect(isSignoffPending(undefined)).toBe(false);
    expect(isSignoffPending("signoff pending")).toBe(false);
  });
});
