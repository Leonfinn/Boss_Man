import { describe, expect, it } from "vitest";
import { shortValue } from "../src/session-manager.js";

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
