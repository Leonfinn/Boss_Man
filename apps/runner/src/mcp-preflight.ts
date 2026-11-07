// Before a turn starts, check that Boss Man's MCP endpoint answers.
// The server can stall for several seconds; Claude Code gives its own MCP handshake only about
// 5 s, then starts the turn without Boss Man's tools (BOS-428). Waiting here, with retries, lets
// the stall pass first.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type PreflightResult = { ok: boolean; attempts: number; waitedMs: number; lastError: string | null };

export async function mcpPreflight(
  url: string,
  token: string,
  opts: { budgetMs?: number; attemptTimeoutMs?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PreflightResult> {
  const budget = opts.budgetMs ?? 20_000;
  const attemptTimeout = opts.attemptTimeoutMs ?? 5_000;
  const delay = opts.delayMs ?? 1_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  let attempts = 0;
  let lastError: string | null = null;
  for (;;) {
    attempts++;
    const left = budget - (Date.now() - started);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bossman-runner-preflight", version: "1" } } }),
        signal: AbortSignal.timeout(Math.max(500, Math.min(attemptTimeout, left))),
      });
      await res.body?.cancel().catch(() => undefined);
      // 401/403 is a real answer (bad token): retrying won't help, and the server is up.
      if (res.ok || res.status === 401 || res.status === 403) return { ok: true, attempts, waitedMs: Date.now() - started, lastError: null };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
    }
    if (Date.now() - started + delay >= budget) return { ok: false, attempts, waitedMs: Date.now() - started, lastError };
    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Asks the Boss Man MCP server for its tool list, the same way an agent would (BOS-552). OpenCode
 * silently drops an MCP server it can't reach at session/new, so a run with mcpRequired must check
 * first: a server that answers with tools is healthy, anything else stops the run instead of letting
 * it work blind. Returns the tool names on success, or a short reason on failure.
 */
export async function checkBossManTools(url: string, token: string): Promise<{ ok: boolean; tools?: string[]; reason?: string }> {
  const client = new Client({ name: "bossman-preflight", version: "0.0.1" }, { capabilities: {} });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((t) => t.name);
    if (!tools.length) return { ok: false, reason: "it answered but listed no tools" };
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
  } finally {
    await client.close().catch(() => {});
  }
}
