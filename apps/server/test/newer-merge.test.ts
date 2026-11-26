// BOS-2726: newerMerge says whether a reopened ticket has a newer gate merge on main than the one recorded.
// Pure calls only, made-up shas and fixed dates, no database.
import { describe, expect, it } from "vitest";
import { newerMerge } from "../src/services/merge-status.js";

type MergeState = Parameters<typeof newerMerge>[0];

const MERGED_AT = new Date("2026-11-20T10:00:00.000Z");

function ticket(overrides: Partial<MergeState> = {}): MergeState {
  return {
    mergeCommit: "aaa111",
    mergedAt: MERGED_AT,
    systemState: "review",
    merges: [{ sha: "bbb222", at: "2026-11-21T10:00:00.000Z" }],
    ...overrides,
  };
}

describe("newerMerge", () => {
  it("returns false when no merge is recorded", () => {
    expect(newerMerge(ticket({ mergeCommit: null }))).toBe(false);
  });

  it.each(["done", "blocked"])("returns false when the ticket is %s, not review or in progress", (systemState) => {
    expect(newerMerge(ticket({ systemState }))).toBe(false);
  });

  it("returns false when the merges list is empty", () => {
    expect(newerMerge(ticket({ merges: [] }))).toBe(false);
  });

  it("returns false when the newest merge is the recorded one", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "aaa111", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(false);
  });

  it("compares shas without regard to case", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "AAA111", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(false);
    expect(newerMerge(ticket({ mergeCommit: "AAA111", merges: [{ sha: "aaa111", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(false);
  });

  it("returns true when the recorded merge is further down the list", () => {
    const merges = [
      { sha: "bbb222", at: "2026-11-22T10:00:00.000Z" },
      { sha: "aaa111", at: "2026-11-20T10:00:00.000Z" },
    ];
    expect(newerMerge(ticket({ merges }))).toBe(true);
  });

  it("returns true when the recorded merge is not in the list and nothing was recorded for mergedAt", () => {
    expect(newerMerge(ticket({ mergedAt: null, merges: [{ sha: "bbb222", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(true);
  });

  it("returns true when the newest merge is later than mergedAt", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "bbb222", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(true);
  });

  it("returns true for an in-progress ticket whose newest merge is later than mergedAt", () => {
    expect(newerMerge(ticket({ systemState: "in_progress", merges: [{ sha: "bbb222", at: "2026-11-21T10:00:00.000Z" }] }))).toBe(true);
  });

  it("returns false when the newest merge is earlier than mergedAt", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "bbb222", at: "2026-11-19T10:00:00.000Z" }] }))).toBe(false);
  });

  it("returns false when the newest merge is at exactly mergedAt", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "bbb222", at: MERGED_AT.toISOString() }] }))).toBe(false);
  });

  it("returns false when the newest merge's date cannot be parsed and mergedAt is set", () => {
    expect(newerMerge(ticket({ merges: [{ sha: "bbb222", at: "nope" }] }))).toBe(false);
  });
});
