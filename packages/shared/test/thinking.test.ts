import { describe, expect, it } from "vitest";
import { clipField, TRACE_CAP, traceHeadline, traceKindOf, traceSentence, traceTime } from "../src/thinking.js";

describe("Thinking trace kinds (BOS-1368)", () => {
  it("maps the ACP tool kind, and falls back to the tool's name where there is none", () => {
    expect(traceKindOf("read", "Read file")).toBe("look");
    expect(traceKindOf("search", "grep")).toBe("look");
    expect(traceKindOf("execute", "bash")).toBe("command");
    expect(traceKindOf("edit", "apply_patch")).toBe("action");
    expect(traceKindOf("think", "plan")).toBe("reasoning");
    // MCP tools carry no protocol kind: their name decides.
    expect(traceKindOf(null, "mcp__bossman__tickets")).toBe("look");
    expect(traceKindOf(null, "mcp__bossman__create_ticket")).toBe("action");
    expect(traceKindOf(null, "mcp__bossman__notify_owner")).toBe("action");
    expect(traceKindOf(undefined, "mcp__other__thing")).toBe("other");
    // Codex and OpenCode's native names, where no kind comes with them.
    expect(traceKindOf(undefined, "read_file")).toBe("look");
    expect(traceKindOf(undefined, "web_search")).toBe("look");
    expect(traceKindOf(undefined, "bash")).toBe("command");
    expect(traceKindOf(undefined, "apply_patch")).toBe("action");
  });
});

describe("Thinking trace sentences (BOS-1368)", () => {
  it("names the ticket when a tickets reply says one, never the tool id", () => {
    const s = traceSentence({ kind: "look", input: "find", output: "BOS-1276 · Build the shared loader" }, "mcp__bossman__tickets", "mcp__bossman__tickets");
    expect(s).toContain("BOS-1276");
    expect(s.toLowerCase()).not.toContain("mcp__");
  });

  it("shows a command as its words", () => {
    expect(traceSentence({ kind: "command", input: "pnpm test" }, "bash", "bash")).toBe("Ran pnpm test");
  });

  it("uses the first sentence of reasoning, with an ellipsis when longer", () => {
    const long = "I should read the ticket first. Then I will look at the code and make the change carefully.";
    const s = traceSentence({ kind: "reasoning", input: long }, null);
    expect(s).toBe("I should read the ticket first.");
  });
});

describe("Thinking trace header (BOS-1368)", () => {
  it("says the time and step count, and drops the count for reasoning only", () => {
    expect(traceHeadline({ secs: 42, steps: [{ kind: "look", summary: "a" }, { kind: "command", summary: "b" }] })).toBe("Thought for 42 s · 2 steps");
    expect(traceHeadline({ secs: 8, steps: [{ kind: "reasoning", summary: "a" }] })).toBe("Thought for 8 s");
    expect(traceHeadline({ secs: 31, steps: [{ kind: "look", summary: "a" }], stopped: true })).toBe("Stopped after 31 s · 1 step");
  });

  it("reads times the way the design says", () => {
    expect(traceTime(400)).toBe("under 1 s");
    expect(traceTime(42_000)).toBe("42 s");
    expect(traceTime(134_000)).toBe("2 min 14 s");
    expect(traceTime(120_000)).toBe("2 min");
  });
});

describe("Thinking trace caps (BOS-1368)", () => {
  it("clips a field and says it was cut", () => {
    expect(clipField("short", 10)).toEqual({ text: "short", cut: false });
    expect(clipField("a long value", 4)).toEqual({ text: "a lo", cut: true });
  });

  it("keeps the per-message cap in one place", () => {
    expect(TRACE_CAP.steps).toBeGreaterThan(0);
    expect(TRACE_CAP.bytes).toBeGreaterThan(0);
  });
});
