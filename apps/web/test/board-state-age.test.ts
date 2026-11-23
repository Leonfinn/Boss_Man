import { describe, expect, it } from "vitest";
import { boardToCsv, oldestAge, stateAge } from "../src/pages/Board";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("stateAge", () => {
  it("shows hours under a day and days after", () => {
    expect(stateAge({ systemState: "in_progress", stateChangedAt: ago(5) }, NOW)?.label).toBe("in progress 5 h");
    expect(stateAge({ systemState: "review", stateChangedAt: ago(49) }, NOW)?.label).toBe("in Review 2 d");
  });
  it("marks cards past 3 days only", () => {
    expect(stateAge({ systemState: "review", stateChangedAt: ago(72) }, NOW)?.old).toBe(false);
    expect(stateAge({ systemState: "blocked", stateChangedAt: ago(73) }, NOW)?.old).toBe(true);
  });
  it("shows nothing for backlog, done or a missing time", () => {
    expect(stateAge({ systemState: "done", stateChangedAt: ago(100) }, NOW)).toBeNull();
    expect(stateAge({ systemState: "backlog", stateChangedAt: ago(100) }, NOW)).toBeNull();
    expect(stateAge({ systemState: "review" }, NOW)).toBeNull();
  });
});

describe("oldestAge", () => {
  it("names the longest-sitting card", () => {
    expect(oldestAge([{ systemState: "review", stateChangedAt: ago(5) }, { systemState: "review", stateChangedAt: ago(100) }], NOW)).toBe("oldest 4 d");
    expect(oldestAge([{ systemState: "done", stateChangedAt: ago(5) }], NOW)).toBeNull();
  });
});

describe("board CSV", () => {
  it("has a Days in state column", () => {
    const rows = boardToCsv([{ t: { id: "x", title: "T", systemState: "backlog" } as never, column: "Backlog", assignee: "", ref: "" }]).split("\r\n");
    expect(rows[0]!.endsWith(",Days in state")).toBe(true);
  });
});
