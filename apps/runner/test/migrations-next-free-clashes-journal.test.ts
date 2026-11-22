// BOS-1672: pin the pure migration helpers the merge gate uses to pick a free number and to
// judge the journal a merge would produce. No git, no files: the inputs are plain objects.
import { describe, expect, it } from "vitest";
import { JOURNAL_FUTURE_SLACK_MS, clashes, journalProblems, nextFree, type MigrationSet } from "../src/migrations.js";

const DR = "apps/server/drizzle";
const file = (n: number) => `${DR}/${String(n).padStart(4, "0")}_${`m${n}`}.sql`;
const set = (numbers: number[], when: number[] = []): MigrationSet => ({ files: numbers.map(file), when });

describe("nextFree", () => {
  it("returns from when no set uses a migration number", () => {
    expect(nextFree([], 7)).toBe(7);
    expect(nextFree([set([]), set([])], 7)).toBe(7);
  });

  it("skips numbers already taken, including a run of them", () => {
    expect(nextFree([set([3, 4, 5])], 3)).toBe(6);
    expect(nextFree([set([3]), set([4])], 3)).toBe(5);
  });

  it("never moves back below from, so a gap lower down is left alone", () => {
    expect(nextFree([set([3, 8])], 5)).toBe(5);
    expect(nextFree([set([3, 5])], 5)).toBe(6);
  });

  it("treats from as a whole number at least 0", () => {
    expect(nextFree([], 4.9)).toBe(4);
    expect(nextFree([], -5)).toBe(0);
  });

  it("only counts names shaped like a migration file", () => {
    const odd: MigrationSet = { files: [`${DR}/00001_five_digits.sql`, `${DR}/0006_.sql.in`, "notes/0007_readme.md", `${DR}/0008_eight.sql`], when: [] };
    expect(nextFree([odd], 0)).toBe(0);
    expect(nextFree([odd], 6)).toBe(6);
    expect(nextFree([odd], 8)).toBe(9);
  });
});

describe("clashes", () => {
  it("finds nothing when no other set uses the number", () => {
    expect(clashes(set([7]), [set([6]), set([8])])).toEqual([]);
  });

  it("names both files when a number is shared with another branch", () => {
    const other: MigrationSet = { files: [`${DR}/0007_theirs.sql`], when: [] };
    const mine: MigrationSet = { files: [`${DR}/0007_ours.sql`], when: [] };
    expect(clashes(mine, [other])).toEqual([
      { number: 7, why: ["0007_ours shares its number with 0007_theirs on another branch"] },
    ]);
  });

  it("does not call the same file on both branches a clash", () => {
    const mine: MigrationSet = { files: [`${DR}/0007_same.sql`], when: [] };
    expect(clashes(mine, [{ files: [`${DR}/0007_same.sql`], when: [] }])).toEqual([]);
  });

  it("reports each shared number once, sorted, even when several branches use it", () => {
    const mine = set([9, 7], []);
    const others: MigrationSet[] = [
      { files: [`${DR}/0009_a.sql`], when: [] },
      { files: [`${DR}/0009_b.sql`, `${DR}/0007_c.sql`], when: [] },
    ];
    const found = clashes(mine, others);
    expect(found.map((c) => c.number)).toEqual([7, 9]);
    expect(found[0]!.why).toEqual(["0007_m7 shares its number with 0007_c on another branch"]);
    expect(found[1]!.why).toEqual([
      "0009_m9 shares its number with 0009_a on another branch",
      "0009_m9 shares its number with 0009_b on another branch",
    ]);
  });

  it("flags a journal 'when' that is not later than the newest already applied", () => {
    const mine = set([7], [5000]);
    const other = set([], [5000]);
    expect(clashes(mine, [other])).toEqual([
      { number: 7, why: [`its journal entry's "when" (5000) isn't later than the one already applied (5000), so drizzle would skip it`] },
    ]);
  });

  it("says nothing about the journal when this branch's 'when' is later or one side has none", () => {
    expect(clashes(set([7], [6000]), [set([], [5000])])).toEqual([]);
    expect(clashes(set([7], [5000]), [set([], [])])).toEqual([]);
    expect(clashes(set([7], []), [set([], [5000])])).toEqual([]);
  });
});

describe("journalProblems", () => {
  const now = 1_000_000;
  const base = [
    { idx: 0, when: 100, tag: "0001_init" },
    { idx: 1, when: 200, tag: "0002_users" },
  ];
  const fixLine = (target = "main") => `merge origin/${target} into your branch`;

  it("accepts a new entry whose 'when' is later than the newest on the target", () => {
    expect(journalProblems(base, [...base, { idx: 2, when: 300, tag: "0003_add" }], now)).toEqual([]);
  });

  it("ignores entries whose tag the target already has, however odd their 'when'", () => {
    expect(journalProblems(base, [...base, { idx: 2, when: "soon", tag: "0002_users" }], now)).toEqual([]);
  });

  it("refuses a 'when' that is equal to or older than the newest already applied", () => {
    for (const when of [200, 150]) {
      const problems = journalProblems(base, [...base, { idx: 2, when, tag: "0003_add" }], now);
      expect(problems[0]).toBe(`0003_add: its journal "when" (${when}) isn't later than the newest one on main (200), so drizzle would silently skip it.`);
      expect(problems.at(-1)).toContain(fixLine());
    }
  });

  it("refuses an entry with no usable 'when'", () => {
    const problems = journalProblems(base, [...base, { idx: 2, when: "soon", tag: "0003_add" }], now);
    expect(problems[0]).toBe(`0003_add: its journal entry has no usable "when".`);
    expect(problems.at(-1)).toContain(fixLine());
  });

  it("refuses a 'when' more than 10 minutes in the future, but allows the exact edge", () => {
    const future = now + JOURNAL_FUTURE_SLACK_MS + 1;
    expect(journalProblems(base, [...base, { idx: 2, when: future, tag: "0003_add" }], now)[0]).toBe(
      `0003_add: its journal "when" (${future}) is more than 10 minutes in the future, so every later migration would be skipped.`,
    );
    expect(journalProblems(base, [...base, { idx: 2, when: now + JOURNAL_FUTURE_SLACK_MS, tag: "0003_add" }], now)).toEqual([]);
  });

  it("catches a journal idx used twice when one of them is new", () => {
    const merged = [...base, { idx: 5, when: 300, tag: "0003_a" }, { idx: 5, when: 400, tag: "0004_b" }];
    expect(journalProblems(base, merged, now)[0]).toBe("Journal idx 5 is used by 0003_a and 0004_b.");
  });

  it("catches a migration number used twice when one of them is new", () => {
    const merged = [...base, { idx: 2, when: 300, tag: "0003_a" }, { idx: 3, when: 400, tag: "0003_b" }];
    expect(journalProblems(base, merged, now)[0]).toBe("Migration number 0003 is used by 0003_a and 0003_b.");
  });

  it("names the target branch in its message and fix wording", () => {
    const problems = journalProblems(base, [...base, { idx: 2, when: 100, tag: "0003_add" }], now, "trunk");
    expect(problems[0]).toContain("isn't later than the newest one on trunk (200)");
    expect(problems.at(-1)).toContain(fixLine("trunk"));
  });

  it("adds the fix line once, at the end, however many problems there are", () => {
    const merged = [...base, { idx: 2, when: "soon", tag: "0003_a" }, { idx: 2, when: 50, tag: "0004_b" }];
    const problems = journalProblems(base, merged, now);
    expect(problems.length).toBe(4);
    expect(problems.filter((p) => p.includes("To fix:"))).toHaveLength(1);
    expect(problems.at(-1)).toContain("To fix:");
  });
});
