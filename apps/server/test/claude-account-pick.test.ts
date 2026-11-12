// BOS-1103: pickAccount() decides which of the owner's Claude subscriptions a new run goes to
// (BOS-383, BOS-463). It picks the preferred account with real room, spends extra usage only when
// no account has room, and returns null when no account may start a run (the quota hold applies).
import { describe, expect, it } from "vitest";
import { pickAccount, type AccountCandidate } from "../src/services/claude-accounts.js";

function account(name: string, rank: number, passes: boolean, hasRoom?: boolean): AccountCandidate<string> {
  return hasRoom === undefined ? { source: name, rank, passes } : { source: name, rank, passes, hasRoom };
}

describe("pickAccount", () => {
  it("picks the lowest rank with room even when the candidates come out of order", () => {
    const picked = pickAccount([account("third", 3, true), account("first", 1, true), account("second", 2, true)]);
    expect(picked).toBe("first");
  });

  it("skips an account that passes but has no room while a later one has room", () => {
    const picked = pickAccount([account("preferred-no-room", 1, true, false), account("later-with-room", 2, true, true)]);
    expect(picked).toBe("later-with-room");
  });

  it("picks the first that passes, spending extra usage, when none has room", () => {
    const picked = pickAccount([account("second", 2, true, false), account("first", 1, true, false)]);
    expect(picked).toBe("first");
  });

  it("returns null when no account may start a run", () => {
    const picked = pickAccount([account("first", 1, false, true), account("second", 2, false)]);
    expect(picked).toBeNull();
  });

  it("counts a missing hasRoom as room", () => {
    const picked = pickAccount([account("preferred-unstated", 1, true), account("later-with-room", 2, true, true)]);
    expect(picked).toBe("preferred-unstated");
  });

  it("returns null for an empty list", () => {
    expect(pickAccount<string>([])).toBeNull();
  });
});
