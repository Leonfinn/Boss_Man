// Image canary (R52). Before a rebuilt runner image replaces the running one, it has to show
// that a real session of each agent kind still works end to end through its ACP adapter: the
// adapter starts, the agent reaches the model endpoint, a tool call goes through Boss Man's
// permission flow and runs, and the final answer comes back. The model is a scripted stand-in
// served from this process, so the check needs no credentials and no network
// (run it with `docker run --network none`).
//
// Where the host can fence agents (BOS-321) every session runs inside the fence, the way agents
// will run, and its tool command also tries to write outside its folder, which must be refused.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEvent } from "@boss-man/shared";
import type { FenceLevel } from "./fence.js";
import { SessionManager } from "./session-manager.js";

export const CANARY_TEXT = "CANARY_OK";
const MARKER = "canary.txt";

export type CanaryKind = "claude" | "codex" | "opencode";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/**
 * A stand-in for the Anthropic Messages API (Claude Code, OpenCode) and the OpenAI Responses API
 * (Codex). With a shell tool on offer it asks for one command, then answers with CANARY_OK;
 * anything else (titles, summaries) gets a short reply. `command` is the shell command it asks for.
 */
export async function startCanaryModel(command = `echo ok > ${MARKER}`): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
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
      if (req.method === "POST" && route === "/v1/responses") {
        requests++;
        return responsesReply(res, JSON.parse(raw || "{}"), command);
      }
      if (req.method !== "POST" || route !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "canary" } }));
      }
      requests++;
      const body = JSON.parse(raw || "{}") as { model?: string; stream?: boolean; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> };
      const answered = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === "tool_result"));
      // Claude Code calls its shell tool Bash, OpenCode bash.
      const shell = body.tools?.find((t) => t.name === "Bash" || t.name === "bash")?.name;
      const blocks: Block[] = shell && !answered ? [{ type: "tool_use", id: newId("toolu"), name: shell, input: { command, description: "Write the canary marker" } }] : [{ type: "text", text: shell ? CANARY_TEXT : "Canary" }];
      const stopReason = blocks[0]!.type === "tool_use" ? "tool_use" : "end_turn";
      const model = body.model ?? "canary";
      const id = newId("msg");
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

/**
 * One streamed Responses-API turn: Codex's exec_command (or older shell) call, or the answer.
 * The call asks to run outside Codex's own sandbox, which can't start in a container (BOS-315):
 * that is what a real model does after the sandbox fails, and it brings the approval to Boss Man.
 */
function responsesReply(res: http.ServerResponse, body: { model?: string; tools?: Array<{ name?: string }>; input?: Array<{ type?: string }> }, command: string) {
  const answered = (body.input ?? []).some((i) => i.type === "function_call_output");
  const shell = body.tools?.find((t) => t.name === "exec_command" || t.name === "shell")?.name;
  const id = newId("resp");
  const item =
    shell && !answered
      ? { type: "function_call", id: newId("fc"), call_id: newId("call"), name: shell, arguments: JSON.stringify(shell === "shell" ? { command: ["bash", "-lc", command], sandbox_permissions: "require_escalated", justification: "Write the canary marker" } : { cmd: command, sandbox_permissions: "require_escalated", justification: "Write the canary marker" }) }
      : { type: "message", id: newId("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: shell ? CANARY_TEXT : "Canary", annotations: [] }] };
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let seq = 0;
  const sse = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: seq++, ...data })}\n\n`);
  const response = { id, object: "response", model: body.model ?? "canary", status: "in_progress", output: [] as unknown[] };
  sse("response.created", { response });
  sse("response.output_item.added", { output_index: 0, item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
  if (item.type === "message") sse("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: (item.content as Array<{ text: string }>)[0]!.text });
  sse("response.output_item.done", { output_index: 0, item });
  sse("response.completed", { response: { ...response, status: "completed", output: [item], usage } });
  res.end();
}

export type CanaryResult = { ok: boolean; checks: Record<string, boolean>; detail: string; ms: number };

/**
 * Runs one session of an agent kind against the stand-in model and reports what worked.
 * fence: the host's fence level; unless "unavailable", the session runs fenced and must stay so.
 */
export async function runCanary(opts: { agentKind?: CanaryKind; fence?: FenceLevel; timeoutMs?: number; baseEnv?: NodeJS.ProcessEnv } = {}): Promise<CanaryResult> {
  const started = Date.now();
  const kind = opts.agentKind ?? "claude";
  const fenced = !!opts.fence && opts.fence !== "unavailable";
  const home = mkdtempSync(path.join(tmpdir(), "bm-canary-"));
  const cwd = path.join(home, "work");
  // Outside the session's folders: a fenced session's attempt to write here must fail.
  const escape = path.join(home, "escaped.txt");
  const model = await startCanaryModel(fenced ? `echo ok > ${MARKER}; echo escaped > ${escape} 2>/dev/null; true` : undefined);
  const events: RunnerEvent[] = [];
  const base = opts.baseEnv ?? process.env;
  const local = "127.0.0.1,localhost";
  // Each kind reaches the stand-in its own way: Claude Code and OpenCode as Anthropic, Codex through a Responses provider.
  const kindEnv: Record<CanaryKind, NodeJS.ProcessEnv> = {
    claude: { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CLAUDE_CODE_EXECUTABLE: base.CLAUDE_CODE_EXECUTABLE },
    codex: {
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_CONFIG: JSON.stringify({ model_provider: "canary", model_providers: { canary: { name: "canary", base_url: `${model.url}/v1`, wire_api: "responses", env_key: "OPENAI_API_KEY" } } }),
    },
    opencode: {},
  };
  const secrets: Record<CanaryKind, Record<string, string>> = {
    claude: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "sk-ant-canary-not-a-real-key" },
    // The runner signs Codex in with an API key only when OPENAI_API_KEY (or CODEX_API_KEY) is set.
    codex: { OPENAI_API_KEY: "sk-canary-not-a-real-key" },
    opencode: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "sk-ant-canary-not-a-real-key" }, models: { canary: { name: "Canary", tool_call: true } } } } }),
    },
  };
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  let finish!: () => void;
  const ended = new Promise<void>((r) => (finish = r));
  const manager: SessionManager = new SessionManager({
    // Nothing listens here: the session has to carry on without Boss Man's tools.
    mcpUrl: `${model.url}/mcp`,
    baseEnv: { PATH: base.PATH, HOME: home, NO_PROXY: local, NPM_CONFIG_PREFIX: base.NPM_CONFIG_PREFIX, ...kindEnv[kind] },
    resolveEnv: async () => ({ ...secrets[kind], NO_PROXY: local }),
    ...(fenced ? { fence: { level: opts.fence!, agentsRoot: path.join(home, "agents") } } : {}),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "allow" });
      if (e.type === "run.ended") finish();
    },
  });
  const runId = randomUUID();
  mkdirSync(cwd, { recursive: true });
  const modelId = kind === "codex" ? "canary" : kind === "opencode" ? "anthropic/canary" : null;
  manager.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: kind, model: modelId, fundingSourceId: randomUUID(), cwd, prompt: "Canary check.", mcpToken: "bm_canary", ...(fenced ? { fence: true } : {}) });
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
  const checks: Record<string, boolean> = {
    sessionStarted: events.some((e) => e.type === "run.started"),
    modelReached: model.requests() > 0,
    permissionAsked: events.some((e) => e.type === "run.permission_request"),
    toolRan: existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === "ok",
    answered: text.includes(CANARY_TEXT),
    endedCleanly: !!end && !end.error && end.stopReason === "end_turn",
    ...(fenced
      ? {
          fenced: events.some((e) => e.type === "run.started" && e.fenced === true),
          // Only meaningful once the tool ran: the same command wrote the marker first.
          fenceHeld: existsSync(markerPath) && !existsSync(escape),
        }
      : {}),
  };
  // The agent may still be flushing its transcript: wait for the run's processes to go.
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
