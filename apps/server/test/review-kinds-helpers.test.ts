import { describe, expect, it } from "vitest";
import { activeRows, endedNormally, evaluate, reviewTicketsOf, type ReviewRow } from "../src/services/review-kinds.js";

// Only status and seq matter to these helpers; the rest of a review request row is irrelevant here.
const row = (seq: number, status: string) => ({ seq, status } as unknown as ReviewRow);

const ID_A = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ID_B = "abcdef01-2345-4abc-8def-0123456789ab";
const ID_C = "98765432-10ab-4cde-8f01-23456789abcd";

describe("endedNormally", () => {
  it("is false when there is no outcome", () => {
    expect(endedNormally(null)).toBe(false);
    expect(endedNormally(undefined)).toBe(false);
    expect(endedNormally("")).toBe(false);
  });

  it("is false for a run cut off by a restart or given up on", () => {
    expect(endedNormally("interrupted")).toBe(false);
    expect(endedNormally("lost: runner gone")).toBe(false);
  });

  it("is true for a run that ended on its own", () => {
    expect(endedNormally("completed")).toBe(true);
    expect(endedNormally("failed")).toBe(true);
    expect(endedNormally("stopped: run time limit (60 min)")).toBe(true);
  });

  it("matches on the exact wording, so a capital or a missing colon still counts as normal", () => {
    expect(endedNormally("Interrupted")).toBe(true);
    expect(endedNormally("lost")).toBe(true);
  });
});

describe("reviewTicketsOf", () => {
  it("gives nothing for a missing or empty note", () => {
    expect(reviewTicketsOf(null)).toEqual([]);
    expect(reviewTicketsOf(undefined)).toEqual([]);
    expect(reviewTicketsOf("")).toEqual([]);
  });

  it("gives every ticket the note lists, in the order it lists them", () => {
    const note = [`- ${ID_A} "First ticket": review the diff`, `- ${ID_B} "Second ticket": review the diff`].join("\n");
    expect(reviewTicketsOf(note)).toEqual([ID_A, ID_B]);
  });

  it("only picks up a lower-case id at the very start of a line with a space after it", () => {
    const notAtStart = `please look at - ${ID_A} "Ticket"`;
    const noSpace = `- ${ID_B}"Ticket"`;
    const upperCase = `- ${ID_C.toUpperCase()} "Ticket"`;
    const starBullet = `* ${ID_C} "Ticket"`;
    expect(reviewTicketsOf(notAtStart)).toEqual([]);
    expect(reviewTicketsOf(noSpace)).toEqual([]);
    expect(reviewTicketsOf(upperCase)).toEqual([]);
    expect(reviewTicketsOf(starBullet)).toEqual([]);
  });

  it("still finds the good lines among the bad ones", () => {
    const note = [`* ${ID_C} "Starred"`, `- ${ID_A} "Kept"`, `text - ${ID_B} "Not at the start"`].join("\n");
    expect(reviewTicketsOf(note)).toEqual([ID_A]);
  });
});

describe("activeRows", () => {
  it("makes every seq 0 row active at once and lets none hold back a numbered one", () => {
    const rows = [row(0, "pending"), row(0, "pending"), row(1, "pending"), row(2, "pending")];
    expect(activeRows(rows).map((r) => r.seq)).toEqual([0, 0, 1]);
  });

  it("never lets a seq 0 pending row hold back seq 1", () => {
    const rows = [row(0, "pending"), row(1, "pending")];
    expect(activeRows(rows).map((r) => r.seq)).toEqual([0, 1]);
  });

  it("holds a seq 2 row while the seq 1 row is pending", () => {
    const rows = [row(1, "pending"), row(2, "pending")];
    expect(activeRows(rows).map((r) => r.seq)).toEqual([1]);
  });

  it("holds a seq 2 row while the seq 1 row asks for changes", () => {
    const rows = [row(1, "changes_requested"), row(2, "pending")];
    expect(activeRows(rows)).toEqual([]);
  });

  it("releases a seq 2 row once the seq 1 row is approved or overruled", () => {
    expect(activeRows([row(1, "approved"), row(2, "pending")]).map((r) => r.seq)).toEqual([2]);
    expect(activeRows([row(1, "overruled"), row(2, "pending")]).map((r) => r.seq)).toEqual([2]);
  });

  it("leaves out rows that are not pending", () => {
    const rows = [row(0, "approved"), row(1, "pending")];
    expect(activeRows(rows).map((r) => r.seq)).toEqual([1]);
  });

  it("pins today's behaviour: a skipped lower row still holds back a later pending one", () => {
    const rows = [row(0, "approved"), row(1, "skipped"), row(2, "pending")];
    expect(activeRows(rows)).toEqual([]);
  });
});

describe("evaluate", () => {
  it("is waiting while someone still has to review", () => {
    expect(evaluate([row(0, "pending"), row(1, "approved")])).toBe("waiting");
    expect(evaluate([row(1, "pending"), row(2, "pending")])).toBe("waiting");
  });

  it("is failed when a change was requested and nobody is active", () => {
    expect(evaluate([row(0, "approved"), row(1, "changes_requested")])).toBe("failed");
    expect(evaluate([row(1, "changes_requested"), row(2, "pending")])).toBe("failed");
  });

  it("is passed when every row is approved or overruled", () => {
    expect(evaluate([row(0, "approved"), row(1, "overruled")])).toBe("passed");
  });

  it("is waiting while a skipped row sits beside approved ones", () => {
    expect(evaluate([row(0, "approved"), row(1, "skipped")])).toBe("waiting");
  });
});
