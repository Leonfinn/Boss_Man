import { describe, expect, it } from "vitest";
import { runTimeSplit, spanWords } from "../src/run-time-split";
import type { TranscriptItem } from "../src/api";

const T0 = Date.parse("2026-11-23T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const call = (s: number, id: string, kind: string, status: string, title = "do it"): TranscriptItem => ({ seq: ++seq, type: "run.update", at: at(s), event: { update: { kind: status === "in_progress" ? "tool_call" : "tool_call_update", toolCallId: id, toolKind: kind, title, status } } });
const ask = (s: number, id: string): TranscriptItem => ({ seq: ++seq, type: "run.permission_request", at: at(s), event: { toolCallId: id } });
const msg = (s: number): TranscriptItem => ({ seq: ++seq, type: "run.update", at: at(s), event: { update: { kind: "agent_message", text: "hi" } } });
const row = (items: TranscriptItem[], end: number | null, key: string, now = T0 + 1000_000) => runTimeSplit(items, end, now)!.rows.find((r) => r.key === key)?.ms;

describe("runTimeSplit", () => {
  it("splits by tool and puts the rest on the model", () => {
    const items = [msg(0), call(10, "a", "execute", "in_progress"), call(70, "a", "execute", "completed"), call(80, "b", "read", "in_progress"), call(90, "b", "read", "completed"), msg(100)];
    expect(row(items, T0 + 100_000, "tool:execute")).toBe(60_000);
    expect(row(items, T0 + 100_000, "tool:read")).toBe(10_000);
    expect(row(items, T0 + 100_000, "model")).toBe(30_000);
    expect(runTimeSplit(items, T0 + 100_000, 0)!.totalMs).toBe(100_000);
  });

  it("counts a call with no result up to the run's end and marks it", () => {
    const items = [msg(0), call(10, "a", "execute", "in_progress"), msg(20)];
    const split = runTimeSplit(items, T0 + 60_000, 0)!;
    expect(split.longest[0]).toMatchObject({ ms: 50_000, noResult: true });
  });

  it("shares overlapping calls so the rows still add up to the total", () => {
    const items = [msg(0), call(0, "a", "execute", "in_progress"), call(0, "b", "read", "in_progress"), call(40, "a", "execute", "completed"), call(40, "b", "read", "completed"), msg(40)];
    const split = runTimeSplit(items, T0 + 40_000, 0)!;
    expect(split.rows.reduce((n, r) => n + r.ms, 0)).toBe(40_000);
    expect(row(items, T0 + 40_000, "tool:execute")).toBe(20_000);
  });

  it("counts a permission wait on its own, not as the tool's time", () => {
    const items = [msg(0), call(10, "a", "execute", "in_progress"), ask(11, "a"), call(51, "a", "execute", "in_progress"), call(60, "a", "execute", "completed")];
    expect(row(items, T0 + 60_000, "permission")).toBe(40_000);
    expect(row(items, T0 + 60_000, "tool:execute")).toBe(10_000);
  });

  it("keeps the 5 longest calls, longest first", () => {
    const items: TranscriptItem[] = [msg(0)];
    for (let i = 0; i < 7; i++) items.push(call(i * 100, `c${i}`, "read", "in_progress", `file ${i}`), call(i * 100 + 5 + i, `c${i}`, "read", "completed"));
    const longest = runTimeSplit(items, null, T0 + 1_000_000)!.longest;
    expect(longest).toHaveLength(5);
    expect(longest[0]!.ms).toBe(11_000);
  });

  it("returns null when there are no timestamps", () => {
    expect(runTimeSplit([{ seq: 1, type: "run.update", at: "", event: {} }], null, 0)).toBeNull();
  });

  it("writes spans in words", () => {
    expect(spanWords(9_000)).toBe("9 s");
    expect(spanWords(252_000)).toBe("4 min 12 s");
    expect(spanWords(3_900_000)).toBe("1 h 5 min");
  });
});
