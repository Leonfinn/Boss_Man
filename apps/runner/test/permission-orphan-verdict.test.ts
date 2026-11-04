import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

// BOS-334: an answer for a request nobody is waiting on used to vanish silently.
describe("a permission verdict nothing is waiting for", () => {
  it("is logged, so an answered card that never ran can be traced", () => {
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({ mcpUrl: "http://127.0.0.1:9/mcp", baseEnv: {}, resolveEnv: async () => ({}), emit: (e) => events.push(e) });
    manager.handle({ type: "permission.decide", runId: "run-1", requestId: "req-1", verdict: "allow" });
    expect(events).toEqual([expect.objectContaining({ type: "runner.log", level: "warn", message: expect.stringContaining("req-1") })]);
  });
});
