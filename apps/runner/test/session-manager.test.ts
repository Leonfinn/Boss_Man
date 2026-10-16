// Drives the real claude-agent-acp adapter (and its bundled Claude Code) against the
// scripted stub model, so no credentials are used. Same scenario as spike S2.
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";
import { startStubAnthropic, type StubLogEntry } from "./stub-model.js";
import { startMcpServer, type McpCall } from "./mcp-server.js";

let stub: Awaited<ReturnType<typeof startStubAnthropic>>;
let mcp: Awaited<ReturnType<typeof startMcpServer>>;
const stubLog: StubLogEntry[] = [];
const mcpCalls: McpCall[] = [];

beforeEach(async () => {
  stubLog.length = 0;
  mcpCalls.length = 0;
  stub = await startStubAnthropic(stubLog);
  mcp = await startMcpServer(mcpCalls);
});
afterEach(async () => {
  await stub.close();
  await mcp.close();
});

function harness(model: string | null) {
  const events: RunnerEvent[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "bm-runner-home-"));
  const fundingSourceId = randomUUID();
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager: SessionManager = new SessionManager({
    mcpUrl: mcp.url,
    baseEnv: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_PROXY: "127.0.0.1,localhost" },
    // Stands in for the company's granted secrets.
    resolveEnv: async () => ({ ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key", NO_PROXY: "127.0.0.1,localhost" }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") {
        // Stands in for the server's policy engine.
        const cmd = String((e.rawInput as { command?: string } | null)?.command ?? "");
        manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: /rm -rf/.test(cmd) ? "deny" : "allow" });
      }
      if (e.type === "run.ended") done();
    },
  });
  const runId = randomUUID();
  const cwd = mkdtempSync(path.join(tmpdir(), "bm-ws-"));
  manager.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model, fundingSourceId, cwd, prompt: "Run the spike scenario.", mcpToken: "bm_sess_test" });
  return { events, ended, runId, cwd, manager };
}

const sessionStarted = (events: RunnerEvent[]) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.type === "run.started")) {
        clearInterval(t);
        resolve();
      }
    }, 20);
  });

describe("SessionManager with Claude Code over ACP (stub model)", () => {
  it("delivers a steering message as a second turn in the same session (R37)", async () => {
    const h = harness(null);
    // Send the message as soon as the session exists; it waits for the current turn.
    await sessionStarted(h.events);
    h.manager.handle({ type: "run.message", runId: h.runId, text: "Message from the owner: also add a README.", interrupt: false });
    await h.ended;
    const delivered = h.events.find((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered");
    expect((delivered as { update: { text: string } }).update.text).toContain("also add a README");
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
    // Two turns reached the model's final step: the original and the steered one.
    expect(stubLog.filter((l) => l.step === "final").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("a stop drops queued messages instead of starting another turn", async () => {
    const h = harness(null);
    await sessionStarted(h.events);
    h.manager.handle({ type: "run.message", runId: h.runId, text: "Message from the owner: keep going", interrupt: false });
    h.manager.handle({ type: "run.cancel", runId: h.runId });
    await h.ended;
    expect(h.events.some((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered")).toBe(false);
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "cancelled" });
  }, 60_000);

  it("runs a turn end to end: permissions via the server, MCP passthrough, cost deltas", async () => {
    const h = harness(null);
    await h.ended;

    const ended = h.events.find((e) => e.type === "run.ended");
    expect(ended).toMatchObject({ stopReason: "end_turn", error: null });
    expect(existsSync(path.join(h.cwd, "spike.txt"))).toBe(true);

    const permissions = h.events.filter((e) => e.type === "run.permission_request");
    expect(permissions.map((p) => p.title)).toContain("rm -rf /srv/precious");
    expect(mcpCalls).toEqual([expect.objectContaining({ tool: "create_ticket", token: "bm_sess_test" })]);

    const started = h.events.find((e) => e.type === "run.started");
    expect(started).toMatchObject({ runId: h.runId });

    const costs = h.events.filter((e) => e.type === "run.cost");
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((c) => c.costMicrosDelta > 0)).toBe(true);

    const message = h.events.find((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "agent_message");
    expect((message as { update: { text: string } }).update.text).toContain("SPIKE_DONE");
    expect(h.manager.activeRuns).toBe(0);
  }, 60_000);

  it("pins an unlisted model at launch (spike S2 finding)", async () => {
    const h = harness("claude-future-model-x");
    await h.ended;
    const models = new Set(stubLog.filter((l) => l.hasTools).map((l) => l.model));
    expect([...models]).toEqual(["claude-future-model-x"]);
    expect(h.events.find((e) => e.type === "run.started")).toMatchObject({ model: "claude-future-model-x" });
  }, 60_000);
});
