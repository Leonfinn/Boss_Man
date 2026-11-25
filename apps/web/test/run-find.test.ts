import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../src/api";
import { inShow, itemParts, parseRunShow, runSpots, shownItems } from "../src/run-find";

const item = (seq: number, type: string, event: Record<string, unknown>): TranscriptItem => ({ seq, type, at: "2026-01-01T00:00:00Z", event }) as TranscriptItem;
const say = (seq: number, text: string) => item(seq, "run.update", { update: { kind: "agent_message", text } });
const tool = (seq: number, title: string, status: string) => item(seq, "run.update", { update: { kind: "tool_call", title, status } });
const items = [
  say(1, "Looking at the build"),
  tool(2, "Run npm test", "completed"),
  tool(3, "Run npm build", "failed"),
  item(4, "run.permission_request", { title: "rm" }),
  item(5, "run.ended", { error: "boom" }),
  item(6, "run.update", { update: { kind: "message_delivered", text: "hello" } }),
];

describe("run find", () => {
  it("filters by show", () => {
    expect(shownItems(items, "all")).toHaveLength(6);
    expect(shownItems(items, "messages").map((i) => i.seq)).toEqual([1, 6]);
    expect(shownItems(items, "tools").map((i) => i.seq)).toEqual([2, 3]);
    expect(shownItems(items, "problems").map((i) => i.seq)).toEqual([3, 4, 5]);
    expect(inShow(items[0]!, "problems")).toBe(false);
  });
  it("reads the link", () => {
    expect(parseRunShow(new URLSearchParams("show=problems"))).toBe("problems");
    expect(parseRunShow(new URLSearchParams("show=nope"))).toBe("all");
  });
  it("builds the parts a row draws", () => {
    expect(itemParts(item(1, "run.started", {}))).toEqual(["Session started"]);
    expect(itemParts(say(2, "Keep foo_bar as it is"))).toEqual(["Agent", "Keep foo_bar as it is"]);
    expect(itemParts(tool(3, "Run npm test", "in_progress"))).toEqual(["Run npm test", "in progress"]);
    expect(itemParts(item(4, "run.ended", { error: "rate_limit_hit" }))).toEqual(["Failed", "rate_limit_hit"]);
  });
  it("counts matches only in what is shown", () => {
    expect(runSpots(items, "build")).toEqual([{ id: "1", n: 0 }, { id: "3", n: 0 }]);
    expect(runSpots(shownItems(items, "tools"), "build")).toEqual([{ id: "3", n: 0 }]);
    expect(runSpots(items, "")).toEqual([]);
    expect(runSpots(items, "failed")).toEqual([{ id: "3", n: 0 }, { id: "5", n: 0 }]);
  });
});
