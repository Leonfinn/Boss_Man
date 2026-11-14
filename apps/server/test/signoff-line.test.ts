import { describe, expect, it } from "vitest";
import { signoffLine, type SignoffState } from "../src/services/signoff.js";

const since = new Date("2026-11-12T09:05:30Z");
const at = new Date("2026-11-12T09:05:30Z");

describe("signoffLine", () => {
  it("names the time, the card, Decisions and the Your review lane when waiting", () => {
    const state: SignoffState = { state: "waiting", cardId: "card-1", since };
    expect(signoffLine(state)).toBe(
      "Owner sign-off: waiting on the owner since 2026-11-12 09:05 UTC (card card-1, in their Decisions and the board's Your review lane).",
    );
  });

  it("names the time, says no card is open and that nothing merges meanwhile when the card is missing", () => {
    const state: SignoffState = { state: "missing", since, reviewer: "Rod", reviewerAgentId: null };
    const line = signoffLine(state);
    expect(line).toBe(
      "Owner sign-off: waiting on the owner since 2026-11-12 09:05 UTC, but no card is open; Boss Man raises it on its next sweep, and nothing merges it meanwhile.",
    );
    // Today's wording does not name the reviewer, even though the state carries their name. Pinned on purpose.
    expect(line).not.toContain("Rod");
  });

  it("gives the time, the short commit and that it merges next when signed off", () => {
    const state: SignoffState = { state: "signed_off", at, head: "abcdef0123456789" };
    expect(signoffLine(state)).toBe(
      "Owner sign-off: signed off at 2026-11-12 09:05 UTC for commit abcdef01; it merges next.",
    );
  });

  it("leaves out the commit when the signed-off head is unknown", () => {
    const state: SignoffState = { state: "signed_off", at, head: null };
    const line = signoffLine(state);
    expect(line).toBe("Owner sign-off: signed off at 2026-11-12 09:05 UTC; it merges next.");
    expect(line).not.toContain("for commit");
  });

  it("says it is not waiting when the sign-off is not needed or the reviews aren't all in", () => {
    const state: SignoffState = { state: "none" };
    expect(signoffLine(state)).toBe(
      "Owner sign-off: not waiting on it (not needed, or the reviews aren't all in).",
    );
  });

  it("starts every line with the same prefix", () => {
    const states: SignoffState[] = [
      { state: "waiting", cardId: "card-1", since },
      { state: "missing", since, reviewer: "Rod", reviewerAgentId: null },
      { state: "signed_off", at, head: "abcdef0123456789" },
      { state: "signed_off", at, head: null },
      { state: "none" },
    ];
    for (const state of states) expect(signoffLine(state).startsWith("Owner sign-off: ")).toBe(true);
  });
});
