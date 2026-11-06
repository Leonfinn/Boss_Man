import { describe, expect, it } from "vitest";
import { MERGE_MISSED_AFTER_MS, VERIFY_ASK_TIMEOUT_MS, VERIFY_QUEUE_CEILING_MS, VERIFY_QUEUE_MAX_MS, VERIFY_TIMEOUT_MS } from "../src/protocol.js";

// The gate's full check overran 30 minutes on a slower host (BOS-523): the run limit is an hour, and everything derived from it follows.
describe("merge check timing constants", () => {
  it("gives a check an hour once it holds its slot", () => {
    expect(VERIFY_TIMEOUT_MS).toBe(60 * 60_000);
  });
  it("derives the server's wait and the stalled-merge marker from the run limit", () => {
    expect(VERIFY_ASK_TIMEOUT_MS).toBe(VERIFY_QUEUE_CEILING_MS + VERIFY_TIMEOUT_MS + 60_000);
    expect(MERGE_MISSED_AFTER_MS).toBe(VERIFY_TIMEOUT_MS + 60_000 + 5 * 60_000);
    expect(MERGE_MISSED_AFTER_MS).toBeGreaterThan(VERIFY_TIMEOUT_MS);
  });
  it("lets the server wait out a full queue wait plus a full run", () => {
    expect(VERIFY_ASK_TIMEOUT_MS).toBeGreaterThan(VERIFY_QUEUE_MAX_MS + VERIFY_TIMEOUT_MS);
  });
});
