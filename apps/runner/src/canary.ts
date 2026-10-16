// Image canary (R52). Before a rebuilt runner image replaces the running one, it has to show
// that a real Claude Code session still works end to end through the ACP adapter: the adapter
// starts, Claude Code reaches the model endpoint, a tool call goes through Boss Man's
// permission flow and runs, and the final answer comes back. The model is a scripted stand-in
// served from this process, so the check needs no credentials and no network
// (run it with `docker run --network none`).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "./session-manager.js";

export const CANARY_TEXT = "CANARY_OK";
const MARKER = "canary.txt";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * A stand-in for the Anthropic Messages API. With the Bash tool on offer it asks for one
 * command, then answers with CANARY_OK; anything else (titles, summaries) gets a short reply.
 */
export async function startCanaryModel(): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0];
      if (req.method === "POST" && route === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 100 }));
      }
      if (req.method !== "POST" || route !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "canary" } }));
      }
      requests++;
      const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> };
      const answered = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === "tool_result"));
      const mainLoop = body.tools?.some((t) => t.name === "Bash");
      const blocks: Block[] =
        mainLoop && !answered
          ? [{ type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`, name: "Bash", input: { command: `echo ok > ${MARKER}`, description: "Write the canary marker" } }]
          : [{ type: "text", text: mainLoop ? CANARY_TEXT : "Canary" }];
      const stopReason = blocks[0]!.type === "tool_use" ? "tool_use" : "end_turn";
      const model = body.model ?? "canary";
      const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id, type: "message", role: "assistant", model, content: blocks, stop_reason: stopReason, stop_sequence: null, usage }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const sse = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      sse("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
      blocks.forEach((b, index) => {
        if (b.type === "text") {
          sse("content_block_start", { index, content_block: { type: "text", text: "" } });
          sse("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
        } else {
          sse("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        }
        sse("content_block_stop", { index });
      });
      sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
      sse("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests: () => requests, close: () => new Promise((r) => server.close(() => r())) };
}

export type CanaryResult = { ok: boolean; checks: Record<string, boolean>; detail: string; ms: number };

/** Runs one Claude session against the stand-in model and reports what worked. */
export async function runCanary(opts: { timeoutMs?: number; baseEnv?: NodeJS.ProcessEnv } = {}): Promise<CanaryResult> {
  const started = Date.now();
  const model = await startCanaryModel();
  const home = mkdtempSync(path.join(tmpdir(), "bm-canary-"));
  const cwd = path.join(home, "work");
  const events: RunnerEvent[] = [];
  const base = opts.baseEnv ?? process.env;
  let finish!: () => void;
  const ended = new Promise<void>((r) => (finish = r));
  const manager: SessionManager = new SessionManager({
    // Nothing listens here: the session has to carry on without Boss Man's tools.
    mcpUrl: `${model.url}/mcp`,
    baseEnv: { PATH: base.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_CODE_EXECUTABLE: base.CLAUDE_CODE_EXECUTABLE, NO_PROXY: "127.0.0.1,localhost" },
    resolveEnv: async () => ({ ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "sk-ant-canary-not-a-real-key", NO_PROXY: "127.0.0.1,localhost" }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "allow" });
      if (e.type === "run.ended") finish();
    },
  });
  const runId = randomUUID();
  mkdirSync(cwd, { recursive: true });
  manager.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd, prompt: "Canary check.", mcpToken: "bm_canary" });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timedOut = await Promise.race([ended.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs).unref())]);
  if (timedOut) manager.shutdown();

  const text = events
    .map((e) => (e.type === "run.update" ? (e.update as { kind?: string; text?: string }) : null))
    .filter((u) => u?.kind === "agent_message")
    .map((u) => u!.text ?? "")
    .join("");
  const end = events.find((e): e is Extract<RunnerEvent, { type: "run.ended" }> => e.type === "run.ended");
  const markerPath = path.join(cwd, MARKER);
  const checks = {
    sessionStarted: events.some((e) => e.type === "run.started"),
    modelReached: model.requests() > 0,
    permissionAsked: events.some((e) => e.type === "run.permission_request"),
    toolRan: existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === "ok",
    answered: text.includes(CANARY_TEXT),
    endedCleanly: !!end && !end.error && end.stopReason === "end_turn",
  };
  // Claude Code may still be flushing its transcript: wait for the run's processes to go.
  manager.shutdown();
  for (let i = 0; i < 50 && manager.processGroups().length; i++) await new Promise((r) => setTimeout(r, 100));
  await model.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp directory doesn't change the verdict.
  }
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const detail = timedOut ? `timed out after ${timeoutMs} ms; failed: ${failed.join(", ")}` : failed.length ? `failed: ${failed.join(", ")}${end?.error ? ` (${end.error})` : ""}` : "all checks passed";
  return { ok: !timedOut && failed.length === 0, checks, detail, ms: Date.now() - started };
}
