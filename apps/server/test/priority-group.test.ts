// BOS-2414: the pure `isFinished` helper behind the Priority 1 group. A member counts as finished once it
// has merged (a ticket riding along on another's merge has a commit but no mergedAt) or is done; anything
// still open keeps the group from paging the owner.
import { describe, expect, it } from "vitest";
import { isFinished } from "../src/services/priority-group.js";

const member = (state: string, mergedAt: Date | null = null, mergeCommit: string | null = null) => ({ state, mergedAt, mergeCommit });

describe("isFinished", () => {
  it("counts a done ticket as finished even with no merge", () => {
    expect(isFinished(member("done"))).toBe(true);
  });

  it("counts a ticket with a merge time as finished, whatever its state", () => {
    expect(isFinished(member("review", new Date("2026-11-24T09:00:00.000Z")))).toBe(true);
    expect(isFinished(member("in_progress", new Date("2026-11-24T09:00:00.000Z")))).toBe(true);
  });

  it("counts a ticket riding along on another's merge as finished: a commit but no merge time", () => {
    expect(isFinished(member("review", null, "b60eb78d28a1"))).toBe(true);
  });

  it("does not count a ticket that is still open", () => {
    expect(isFinished(member("backlog"))).toBe(false);
    expect(isFinished(member("ready"))).toBe(false);
    expect(isFinished(member("in_progress"))).toBe(false);
    expect(isFinished(member("blocked"))).toBe(false);
    expect(isFinished(member("review"))).toBe(false);
  });
});
