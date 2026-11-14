import { describe, expect, it } from "vitest";
import { TRACE_CAP } from "@boss-man/shared";
import { chatTraceService, type TraceUpdate } from "../src/services/chat-trace.js";

const tool = (over: Partial<TraceUpdate>): TraceUpdate => ({ kind: "tool_call", title: "mcp__bossman__tickets", toolKind: null, status: null, ...over });

describe("the Thinking trace service (BOS-1368)", () => {
  it("records the steps in order, joining reasoning chunks into one step", () => {
    const t = chatTraceService();
    t.begin("run-1");
    t.onUpdate("run-1", { kind: "reasoning", text: "I should look " });
    t.onUpdate("run-1", { kind: "reasoning", text: "at the ticket first." });
    t.onUpdate("run-1", tool({ toolCallId: "c1", inputSummary: "BOS-1276", resultSummary: "BOS-1276 · Build the loader", traceKind: "look" }));
    t.onUpdate("run-1", tool({ toolCallId: "c1", kind: "tool_call_update", status: "completed", resultSummary: "BOS-1276 · Build the loader", traceKind: "look" }));
    const body = t.take("run-1");
    expect(body?.steps.map((s) => s.kind)).toEqual(["reasoning", "look"]);
    expect(body?.steps[0]?.input).toBe("I should look at the ticket first.");
  });

  it("never stores a fake token: a secret in a tool result is redacted", () => {
    const t = chatTraceService();
    t.begin("run-2");
    t.onUpdate("run-2", tool({ toolCallId: "c1", traceKind: "command", toolKind: "execute", inputSummary: "curl -H 'Authorization: Bearer sk-abcdef1234567890' https://api", resultSummary: "ok; used sk-abcdef1234567890 and secret=topsecretvalue" }));
    const body = t.take("run-2");
    const all = JSON.stringify(body);
    expect(all).not.toContain("sk-abcdef1234567890");
    expect(all).not.toContain("topsecretvalue");
    expect(all).toContain("[redacted]");
  });

  it("caps the steps per message and keeps a count of what was dropped", () => {
    const t = chatTraceService();
    t.begin("run-3");
    for (let i = 0; i < TRACE_CAP.steps + 5; i++) t.onUpdate("run-3", tool({ toolCallId: `c${i}`, inputSummary: `n${i}`, traceKind: "look" }));
    const body = t.take("run-3");
    expect(body?.steps.length).toBe(TRACE_CAP.steps);
    expect(body?.dropped).toBe(5);
    // The capped body fits the byte cap too.
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(TRACE_CAP.bytes);
  });

  it("saves nothing for a reply with no steps", () => {
    const t = chatTraceService();
    t.begin("run-4");
    expect(t.take("run-4")).toBeNull();
  });

  it("splits steps between two replies from one run, each with its own", () => {
    const t = chatTraceService();
    t.begin("run-5");
    t.onUpdate("run-5", tool({ toolCallId: "a", inputSummary: "one", traceKind: "look" }));
    const first = t.take("run-5");
    t.onUpdate("run-5", tool({ toolCallId: "b", inputSummary: "two", traceKind: "look" }));
    const second = t.take("run-5");
    expect(first?.steps).toHaveLength(1);
    expect(second?.steps).toHaveLength(1);
    expect(second?.steps[0]?.input).toBe("two");
  });

  it("says when a run stopped", () => {
    const t = chatTraceService();
    t.begin("run-6");
    t.onUpdate("run-6", tool({ toolCallId: "a", inputSummary: "one", traceKind: "look" }));
    expect(t.stopped("run-6")?.stopped).toBe(true);
  });

  it("gives the live steps so far without clearing them", () => {
    const t = chatTraceService();
    t.begin("run-7");
    t.onUpdate("run-7", tool({ toolCallId: "a", inputSummary: "one", traceKind: "look" }));
    expect(t.live("run-7")?.steps).toHaveLength(1);
    expect(t.live("run-7")?.steps).toHaveLength(1);
    expect(t.take("run-7")?.steps).toHaveLength(1);
  });
});
