// A scripted stand-in for the Anthropic Messages API. It lets the spike exercise
// the ACP plumbing (permissions, MCP passthrough, concurrency) without real
// credentials. Nothing here measures model behaviour.
import http from "node:http";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type StubLogEntry = { method: string; path: string; stream?: boolean; step?: string; hasTools?: boolean; model?: string; userAgent?: string };

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const MCP_TOOL = "mcp__bossman__create_ticket";

// The scripted main-loop turn: each step answers the tool_results seen so far.
function scriptedReply(messages: any[]): { step: string; blocks: Block[] } {
  const results = messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((c: any) => c.type === "tool_result").length;
  const tool = (name: string, input: Record<string, unknown>): Block => ({
    type: "tool_use",
    id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    name,
    input,
  });
  switch (results) {
    case 0:
      return {
        step: "bash-allowed",
        blocks: [tool("Bash", { command: "echo spike > spike.txt", description: "Write a marker file" })],
      };
    case 1:
      return {
        step: "mcp-create-ticket",
        blocks: [tool(MCP_TOOL, { title: "Spike S2 ticket", body: "Created through ACP MCP passthrough" })],
      };
    case 2:
      return {
        step: "bash-denied",
        blocks: [tool("Bash", { command: "rm -rf /srv/precious", description: "Delete production data" })],
      };
    default:
      return { step: "final", blocks: [{ type: "text", text: "SPIKE_DONE" }] };
  }
}

function sse(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendStream(res: http.ServerResponse, model: string, blocks: Block[]) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      sse(res, "content_block_start", {
        type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function sendJson(res: http.ServerResponse, model: string, blocks: Block[]) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model,
    content: blocks, stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 42 },
  }));
}

export async function startStubAnthropic(log: StubLogEntry[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        log.push({ method: req.method, path });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 120 }));
      }
      if (req.method === "POST" && path === "/v1/messages") {
        const body = JSON.parse(raw || "{}");
        const hasTools = Array.isArray(body.tools) && body.tools.some((t: any) => t.name === "Bash");
        // Side queries (titles, summaries) carry no Bash tool: answer them plainly.
        const { step, blocks } = hasTools
          ? scriptedReply(body.messages ?? [])
          : { step: "side-query", blocks: [{ type: "text", text: "Spike" } as Block] };
        log.push({ method: req.method, path, stream: !!body.stream, step, hasTools, model: body.model, userAgent: req.headers["user-agent"] });
        return body.stream ? sendStream(res, body.model, blocks) : sendJson(res, body.model, blocks);
      }
      if (req.method === "POST" && path === "/v1/responses") {
        const body = JSON.parse(raw || "{}");
        if (process.env.STUB_DUMP) fs.writeFileSync(process.env.STUB_DUMP, raw);
        const outputs = (body.input ?? []).filter((i: any) => i.type === "custom_tool_call_output" || i.type === "function_call_output");
        const step = outputs.length === 0 ? "codex-exec-script" : "final";
        log.push({ method: req.method, path, stream: !!body.stream, model: body.model, step, toolOutput: outputs.map((o: any) => o.output) } as any);
        return sendResponsesStream(res, step === "final" ? { type: "message", text: "SPIKE_DONE" } : { type: "exec", input: CODEX_SCRIPT });
      }
      log.push({ method: req.method ?? "?", path });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

// Codex "code mode": the model answers with JavaScript for the `exec` tool, which
// calls nested tools. Each step is wrapped so one denial does not stop the rest.
const CODEX_SCRIPT = [
  "const names = ALL_TOOLS.map((t) => t.name).filter((n) => n.includes(\"bossman\"));",
  "text(\"bossman tools: \" + JSON.stringify(names));",
  "try { text(await tools.exec_command({ cmd: \"echo spike > spike.txt\" })); } catch (e) { text(\"exec1 error: \" + e); }",
  "try { text(await tools.mcp__bossman__create_ticket({ title: \"Spike S2 ticket\", body: \"via codex\" })); } catch (e) { text(\"mcp error: \" + e); }",
  "try { text(await tools.exec_command({ cmd: \"rm -rf /srv/precious\" })); } catch (e) { text(\"exec2 error: \" + e); }",
].join("\n");

function sendResponsesStream(res: http.ServerResponse, out: { type: "message"; text: string } | { type: "exec"; input: string }) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `resp_${randomUUID().replace(/-/g, "")}`;
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("response.created", { response: { id, status: "in_progress", output: [] } });
  const item =
    out.type === "message"
      ? { type: "message", id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: out.text, annotations: [] }] }
      : { type: "custom_tool_call", id: `ctc_${randomUUID().slice(0, 8)}`, call_id: `call_${randomUUID().slice(0, 8)}`, name: "exec", input: out.input, status: "completed" };
  ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
  ev("response.output_item.done", { output_index: 0, item });
  ev("response.completed", {
    response: {
      id, status: "completed", output: [item],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 42, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 162 },
    },
  });
  res.end();
}
