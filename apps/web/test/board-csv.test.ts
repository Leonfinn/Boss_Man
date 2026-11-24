import { describe, expect, it } from "vitest";
import { boardToCsv } from "../src/pages/Board";

const t = (o: Record<string, unknown>) => ({ id: "x", title: "T", ...o }) as never;

describe("boardToCsv", () => {
  it("writes the header and one row per ticket", () => {
    const csv = boardToCsv([
      { t: t({ title: "Fix, the \"thing\"", risk: "high", size: 3, featureTitle: "Export", urgentByOwner: true, lastActivityAt: "2026-11-20T10:00:00Z" }), column: "In progress", assignee: "Ada", ref: "BOS-1" },
      { t: t({ title: "=SUM(A1)" }), column: "Backlog", assignee: "", ref: "" },
    ]).split("\r\n");
    expect(csv[0]).toBe("Reference,Title,Column,Assignee,Risk,Size,Feature,Priority 1,Last activity,Days in state");
    expect(csv[1]).toBe('BOS-1,"Fix, the ""thing""",In progress,Ada,high,3,Export,yes,2026-11-20T10:00:00Z,');
    expect(csv[2]).toBe(",'=SUM(A1),Backlog,,,,,no,,");
  });
});
