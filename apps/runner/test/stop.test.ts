// Stop must always end a run, even one the runner never started or has lost track of.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

function manager(resolveEnv: () => Promise<Record<string, string>>) {
  const events: RunnerEvent[] = [];
  const m = new SessionManager({ mcpUrl: "http://127.0.0.1:1/mcp", baseEnv: { PATH: process.env.PATH }, resolveEnv, emit: (e) => events.push(e), adapterBins: { claude: "/nonexistent/adapter", codex: "/nonexistent/adapter" } });
  return { m, events };
}

describe("stopping a run", () => {
  it("ends a run the runner doesn't know, so the server stops waiting on it", () => {
    const { m, events } = manager(async () => ({}));
    const runId = randomUUID();
    m.handle({ type: "run.cancel", runId });
    expect(events).toEqual([{ type: "run.ended", runId, stopReason: "cancelled", error: null }]);
  });

  it("ends a run stopped while it is still being set up, before its agent starts", async () => {
    let release!: () => void;
    const { m, events } = manager(() => new Promise((r) => (release = () => r({}))));
    const runId = randomUUID();
    m.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: mkdtempSync(path.join(tmpdir(), "bm-stop-")), prompt: "x", mcpToken: "bm_x" });
    m.handle({ type: "run.cancel", runId });
    expect(events).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([{ type: "run.ended", runId, stopReason: "cancelled", error: null }]);
  });
});
