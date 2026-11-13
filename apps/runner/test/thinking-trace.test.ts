import { describe, expect, it } from "vitest";
import { shortValue, traceToolFields } from "../src/session-manager.js";

// The Thinking trace's short input (BOS-1368): what the runner forwards for a tool call, before the
// server redacts and stores it. Kept tiny so a whole file pasted into a tool can't ride a run event.
describe("short tool input for the Thinking trace (BOS-1368)", () => {
  it("keeps a command or prompt as its words", () => {
    expect(shortValue({ command: "pnpm test", description: "Run the tests" }, 300)).toBe("pnpm test");
    expect(shortValue({ prompt: "Find the failing job" }, 300)).toBe("Find the failing job");
  });

  it("clips a long value so a whole file can't be carried", () => {
    const long = "x".repeat(500);
    const out = shortValue(long, 50)!;
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });

  it("comes through empty for no input", () => {
    expect(shortValue(null, 300)).toBeUndefined();
    expect(shortValue({}, 300)).toBeUndefined();
    expect(shortValue("   ", 300)).toBeUndefined();
  });
});

// The fields go into a run event, which the server stores whole in runner_events (BOS-1368 security
// review), so a fake token in a tool's output must never survive the runner.
describe("tool fields are redacted before they leave the runner (BOS-1368 security review)", () => {
  it("scrubs a token in a command's output", () => {
    const f = traceToolFields({ command: "cat .env" }, "GIT_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\nDB_PASSWORD=hunter2", "bash");
    expect(f.resultSummary!.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(f.resultSummary!.text).not.toContain("hunter2");
    expect(f.resultSummary!.text).toContain("redacted");
    expect(f.inputSummary).toBe("cat .env");
  });

  it("scrubs a token in the input and the title too", () => {
    const f = traceToolFields({ command: "curl -H 'Authorization: Bearer abc123secret' x" }, "ok", "run sk-abcdefghijklmnop");
    expect(f.inputSummary).not.toContain("abc123secret");
    expect(f.title).not.toContain("sk-abcdefghijklmnop");
  });
});
