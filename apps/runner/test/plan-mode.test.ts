// Plan-first tickets (R40) against the real Claude ACP adapter and the Claude Code it ships:
// the session starts in plan mode, the agent's request to leave it reaches Boss Man as a
// permission request carrying the plan, and approval lets it carry on.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const PLAN = "1. Read the limiter config.\n2. Add a test for the window boundary.";
let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A model that asks to leave plan mode with PLAN, then finishes. It records what it was offered. */
async function planningModel(seen: { tools: string[][]; systemPlanMode: boolean }) {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/messages/count_tokens")) return res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
      const body = JSON.parse(raw || "{}");
      const tools: string[] = (body.tools ?? []).map((t: { name: string }) => t.name);
      const main = tools.includes("ExitPlanMode") || tools.includes("Bash");
      if (main) {
        seen.tools.push(tools);
        if (JSON.stringify(body.messages ?? []).toLowerCase().includes("plan mode")) seen.systemPlanMode = true;
        if (JSON.stringify(body.system ?? "").toLowerCase().includes("plan mode")) seen.systemPlanMode = true;
      }
      const answered = (body.messages ?? []).some((m: { content: unknown }) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === "tool_result"));
      const id = `msg_${randomUUID().slice(0, 8)}`;
      const block = main && !answered ? { type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name: "ExitPlanMode", input: { plan: PLAN } } : { type: "text", text: main ? "BUILDING" : "Plan" };
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!body.stream) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      sse("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (block.type === "text") {
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
      } else {
        sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      sse("content_block_stop", { index: 0 });
      sse("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      sse("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

describe("plan-first runs (R40)", () => {
  it("start in plan mode, send the plan for approval, and carry on once it's approved", async () => {
    const seen = { tools: [] as string[][], systemPlanMode: false };
    const url = await planningModel(seen);
    const home = mkdtempSync(path.join(tmpdir(), "bm-plan-"));
    const events: RunnerEvent[] = [];
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager: SessionManager = new SessionManager({
      mcpUrl: `${url}/mcp`,
      baseEnv: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_PROXY: "127.0.0.1,localhost" },
      resolveEnv: async () => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "sk-ant-test-not-real", NO_PROXY: "127.0.0.1,localhost" }),
      emit: (e) => {
        events.push(e);
        if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "allow" });
        if (e.type === "run.ended") done();
      },
    });
    const runId = randomUUID();
    manager.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-plan-ws-")), prompt: "Plan the change.", mcpToken: "t", mode: "plan" });
    await ended;
    manager.shutdown();

    const ask = events.find((e): e is Extract<RunnerEvent, { type: "run.permission_request" }> => e.type === "run.permission_request");
    expect(ask).toBeDefined();
    expect(ask).toMatchObject({ kind: "switch_mode", detail: PLAN });
    // "Allow" picks the option that keeps Boss Man approving each tool call, never auto or bypass.
    expect(ask!.optionKinds).toContain("allow_once");
    expect(seen.systemPlanMode).toBe(true);
    const end = events.find((e): e is Extract<RunnerEvent, { type: "run.ended" }> => e.type === "run.ended");
    expect(end).toMatchObject({ stopReason: "end_turn", error: null });
    const said = events.filter((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "agent_message").map((e) => (e as { update: { text: string } }).update.text);
    expect(said.join("")).toContain("BUILDING");
  }, 120_000);
});
