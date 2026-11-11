import { describe, expect, it } from "vitest";
import {
  columnProblems,
  DEFAULT_COLUMNS,
  defaultTicketPrefix,
  effectiveDueDate,
  stateNoteLine,
  TICKET_PREFIX,
  ticketRef,
  type ColumnSpec,
} from "../src/board.js";

const MIN = 60_000;
const H = 60 * MIN;

describe("columnProblems: the owner's custom board columns over the six system states (R17, BOS-1129)", () => {
  const withColumn = (systemState: ColumnSpec["systemState"], change: Partial<ColumnSpec>): ColumnSpec[] =>
    DEFAULT_COLUMNS.map((c) => (c.systemState === systemState ? { ...c, ...change } : c));

  it("has no problems with the default columns", () => {
    expect(columnProblems(DEFAULT_COLUMNS)).toEqual([]);
  });

  it("refuses a board with no columns at all", () => {
    expect(columnProblems([])).toContain("A board needs at least one column per state.");
  });

  it("refuses two names that differ only in case or spaces", () => {
    const columns = withColumn("ready", { name: " backlog " });
    expect(columnProblems(columns)).toContain('Two columns are called " backlog ".');
  });

  it("refuses a blank name", () => {
    const columns = withColumn("ready", { name: "   " });
    expect(columnProblems(columns)).toContain("Column names can't be empty.");
  });

  it("refuses a card limit of 0 or 1.5, and accepts none", () => {
    expect(columnProblems(withColumn("ready", { wipLimit: 0 }))).toContain('"Ready" needs a card limit of 1 or more, or none.');
    expect(columnProblems(withColumn("ready", { wipLimit: 1.5 }))).toContain('"Ready" needs a card limit of 1 or more, or none.');
    expect(columnProblems(withColumn("ready", { wipLimit: null }))).toEqual([]);
    expect(columnProblems(withColumn("ready", { wipLimit: 2 }))).toEqual([]);
  });

  it("names the state no column shows", () => {
    const columns = DEFAULT_COLUMNS.filter((c) => c.systemState !== "review");
    expect(columnProblems(columns)).toContain('No column shows the "review" state.');
  });
});

describe("effectiveDueDate: a ticket's own date, else its milestone's (R16, BOS-1129)", () => {
  it("prefers the ticket's own date", () => {
    expect(effectiveDueDate("2026-12-01", "2026-11-20")).toBe("2026-12-01");
  });

  it("falls back to the milestone's target date", () => {
    expect(effectiveDueDate(null, "2026-11-20")).toBe("2026-11-20");
  });

  it("is null when neither has a date", () => {
    expect(effectiveDueDate(null, null)).toBeNull();
  });
});

describe("stateNoteLine: the state note an agent reads, with its age (R85, BOS-123, BOS-1129)", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const note = (over: Partial<Parameters<typeof stateNoteLine>[0]> = {}) => ({
    stateNote: "Waiting on the owner to pick a colour.",
    stateNoteAt: new Date(now.getTime() - 2 * H),
    lastActivityAt: new Date(now.getTime() - 3 * H),
    ...over,
  });

  it("is null with no note or no note time", () => {
    expect(stateNoteLine(note({ stateNote: null }), now)).toBeNull();
    expect(stateNoteLine(note({ stateNoteAt: null }), now)).toBeNull();
  });

  it("counts minutes under an hour, hours under two days, then days", () => {
    expect(stateNoteLine(note({ stateNoteAt: new Date(now.getTime() - 59 * MIN) }), now)).toContain("(59m ago)");
    expect(stateNoteLine(note({ stateNoteAt: new Date(now.getTime() - 60 * MIN) }), now)).toContain("(1h ago)");
    expect(stateNoteLine(note({ stateNoteAt: new Date(now.getTime() - 47 * H) }), now)).toContain("(47h ago)");
    expect(stateNoteLine(note({ stateNoteAt: new Date(now.getTime() - 48 * H) }), now)).toContain("(2d ago)");
  });

  it("shows a note time in the future as 0m, never a negative age", () => {
    expect(stateNoteLine(note({ stateNoteAt: new Date(now.getTime() + 5 * MIN) }), now)).toContain("(0m ago)");
  });

  it("flags the note when the ticket moved after it was written", () => {
    expect(stateNoteLine(note(), now)).not.toContain("(may be out of date)");
    expect(stateNoteLine(note({ lastActivityAt: new Date(now.getTime() - H) }), now)).toContain("(may be out of date)");
  });

  it("flags the note when stateNoteStaleAt is after it, and not otherwise", () => {
    expect(stateNoteLine(note({ stateNoteStaleAt: new Date(now.getTime() - H) }), now)).toContain("(may be out of date)");
    expect(stateNoteLine(note({ stateNoteStaleAt: new Date(now.getTime() - 3 * H) }), now)).not.toContain("(may be out of date)");
  });
});

describe("defaultTicketPrefix: the prefix a new company starts with (BOS-1129)", () => {
  it("takes the first three letters or digits of the name", () => {
    expect(defaultTicketPrefix("Boss Man Co")).toBe("BOS");
    expect(defaultTicketPrefix("a1-b")).toBe("A1B");
  });

  it("falls back to TKT when the name has no letters or digits", () => {
    expect(defaultTicketPrefix("!!")).toBe("TKT");
  });
});

describe("ticketRef: how a ticket is referred to, as in BOS-12 (BOS-1129)", () => {
  it("joins the prefix and number", () => {
    expect(ticketRef("BOS", 12)).toBe("BOS-12");
  });

  it("uses T when there is no prefix", () => {
    expect(ticketRef(null, 12)).toBe("T-12");
  });

  it("is null for a ticket without a number yet", () => {
    expect(ticketRef("BOS", 0)).toBeNull();
    expect(ticketRef("BOS", null)).toBeNull();
  });
});

describe("TICKET_PREFIX: 1 to 10 capital letters or digits (BOS-1129)", () => {
  it("accepts a short capital prefix", () => {
    expect(TICKET_PREFIX.test("BOS")).toBe(true);
    expect(TICKET_PREFIX.test("A1")).toBe(true);
  });

  it("refuses lower case, empty and more than ten characters", () => {
    expect(TICKET_PREFIX.test("bos")).toBe(false);
    expect(TICKET_PREFIX.test("")).toBe(false);
    expect(TICKET_PREFIX.test("ABCDEFGHIJK")).toBe(false);
  });
});
