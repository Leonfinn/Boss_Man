// A minimal Boss Man MCP server: the one interface every agent uses (R11).
// Each ACP session gets its own bearer token, so a tool call can be traced to
// the company, agent and session that made it.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type McpCall = { tool: string; token: string | undefined; args: unknown };

function buildServer(calls: McpCall[], token: string | undefined) {
  const server = new McpServer({ name: "bossman", version: "0.0.0-spike" });
  server.registerTool(
    "create_ticket",
    {
      description: "Create a ticket in your company's backlog.",
      inputSchema: { title: z.string(), body: z.string().optional() },
    },
    async (args) => {
      calls.push({ tool: "create_ticket", token, args });
      return { content: [{ type: "text", text: `Created ticket BM-${calls.length}` }] };
    },
  );
  server.registerTool(
    "raise_decision",
    {
      description: "Ask the owner or your CEO for a decision. Always include your recommended option.",
      inputSchema: { question: z.string(), options: z.array(z.string()), recommended: z.string() },
    },
    async (args) => {
      calls.push({ tool: "raise_decision", token, args });
      return { content: [{ type: "text", text: "Decision queued" }] };
    },
  );
  return server;
}

export async function startMcpServer(calls: McpCall[]): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      // Stateless mode: a fresh server and transport per request keeps the spike simple.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer(calls, token);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((r) => httpServer.close(() => r())),
  };
}

export const newSessionToken = () => `bm_sess_${randomUUID()}`;
