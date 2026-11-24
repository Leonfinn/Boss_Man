import { describe, expect, it } from "vitest";
import { ticketSiblings } from "../src/run-siblings";
import type { RunRow } from "../src/api";

const row = (id: string, ticketId: string | null, startedAt: string): RunRow => ({ id, companyId: "c", agent: "A", agentId: "a", ticketId, ticket: "T", model: null, startedAt });

describe("ticketSiblings", () => {
  const rows = [row("r3", "t1", "2026-11-03T10:00:00Z"), row("x", "t2", "2026-11-02T10:00:00Z"), row("r1", "t1", "2026-11-01T10:00:00Z"), row("r2", "t1", "2026-11-02T10:00:00Z")];
  it("keeps only this ticket's runs, oldest first, with neighbours", () => {
    const s = ticketSiblings(rows, rows[3]!);
    expect(s.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(s.previous?.id).toBe("r1");
    expect(s.next?.id).toBe("r3");
  });
  it("has no previous at the start and no next at the end", () => {
    expect(ticketSiblings(rows, rows[2]!).previous).toBeNull();
    expect(ticketSiblings(rows, rows[0]!).next).toBeNull();
  });
  it("adds the current run when the list left it out, and drops duplicates", () => {
    const cur = row("r9", "t1", "2026-11-09T10:00:00Z");
    const s = ticketSiblings([...rows, rows[0]!], cur);
    expect(s.rows.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r9"]);
    expect(s.previous?.id).toBe("r3");
  });
  it("returns nothing for a run with no ticket", () => {
    expect(ticketSiblings(rows, row("n", null, "2026-11-01T00:00:00Z")).rows).toEqual([]);
  });
});
