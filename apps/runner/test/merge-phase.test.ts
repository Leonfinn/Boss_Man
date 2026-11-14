// BOS-1070: which merge step a workspace.merge request names. A step missing what it needs is refused, never run as a
// plain merge (which pushes to the target unchecked), and the CI publish steps reach the workspace as themselves.
import { describe, expect, it } from "vitest";
import type { RunnerCommand } from "@boss-man/shared";
import { mergePhaseOf } from "../src/session-manager.js";

const base = { type: "workspace.merge", requestId: "r", projectId: "11111111-1111-4111-8111-111111111111", ticketId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", target: "main", message: "m" } as const;
const of = (extra: Partial<Extract<RunnerCommand, { type: "workspace.merge" }>>) => mergePhaseOf({ ...base, ...extra });

describe("mergePhaseOf", () => {
  it("maps each step and refuses one without its commit", () => {
    expect(of({})).toBeNull();
    expect(of({ phase: "prepare" })).toEqual({ phase: "prepare" });
    expect(of({ phase: "finish", commit: "c".repeat(40), tree: "t".repeat(40) })).toEqual({ phase: "finish", commit: "c".repeat(40), tree: "t".repeat(40) });
    expect(of({ phase: "publish", commit: "c".repeat(40) })).toEqual({ phase: "publish", commit: "c".repeat(40) });
    expect(of({ phase: "unpublish" })).toEqual({ phase: "unpublish" });
    expect(of({ phase: "finish", commit: "c".repeat(40) })).toBe("invalid");
    expect(of({ phase: "publish" })).toBe("invalid");
  });

  it("passes the merge train's base and expectBase through (BOS-1366)", () => {
    const sha = "a".repeat(40);
    expect(of({ phase: "prepare", base: sha })).toEqual({ phase: "prepare", base: sha });
    expect(of({ phase: "finish", commit: "c".repeat(40), tree: "t".repeat(40), expectBase: sha })).toEqual({ phase: "finish", commit: "c".repeat(40), tree: "t".repeat(40), expectBase: sha });
  });
});
