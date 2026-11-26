// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashQuery } from "../src/hooks";
import { LINE_REFRESH, refreshNote } from "../src/components/DashboardPanels";

// Reset the address after each test so one case's query can't leak into the next.
beforeEach(() => {
  window.history.replaceState(null, "", "#");
});
afterEach(() => {
  window.history.replaceState(null, "", "#");
});

describe("hashQuery", () => {
  it("reads the query after the first ? in the hash", () => {
    window.location.hash = "#/board?state=ready&q=a%20b";
    const q = hashQuery();
    expect(q.get("state")).toBe("ready");
    expect(q.get("q")).toBe("a b");
  });

  it("gives no parameters when the hash has no ?", () => {
    window.location.hash = "#/board";
    expect([...hashQuery()]).toEqual([]);
  });

  it("gives no parameters for an empty hash", () => {
    window.location.hash = "";
    expect(window.location.hash).toBe("");
    expect([...hashQuery()]).toEqual([]);
  });

  it("treats everything after the first ? as the query, even a second ?", () => {
    window.location.hash = "#/runs?q=a?b&result=failed";
    const q = hashQuery();
    expect(q.get("q")).toBe("a?b");
    expect(q.get("result")).toBe("failed");
  });
});

describe("refreshNote", () => {
  it("names the merges line's own interval in words", () => {
    expect(refreshNote("merges")).toBe("Updates every 20 s.");
  });

  it("names each line's interval from LINE_REFRESH, so the words can't drift from the poll", () => {
    for (const key of Object.keys(LINE_REFRESH) as (keyof typeof LINE_REFRESH)[]) {
      expect(refreshNote(key)).toBe(`Updates every ${LINE_REFRESH[key]}.`);
    }
    expect(refreshNote("runner")).toBe(`Updates every ${LINE_REFRESH.runner}.`);
  });
});
