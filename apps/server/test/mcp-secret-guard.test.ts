import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guardSecrets, secretRefusal } from "../src/mcp-secret-guard.js";

// Key-shaped values are built at run time so this file holds no secret for the merge-line scan to find.
const rnd = "aB3dE5gH7jK9mN1pQ3sT5vX7zC2fG4hJ6kL8";
const anthropic = ["sk", "ant", "api03"].join("-") + "-" + rnd;
const github = "ghp" + "_" + rnd;
const pem = "-----BEGIN " + "RSA PRIVATE KEY-----";
const assign = "api_key = '" + rnd + "'";

describe("secretRefusal (BOS-2731)", () => {
  it("refuses each tool's text with the rule's kind, and never shows the value", () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["wiki", { action: "write", title: "t", body: `key ${anthropic}` }],
      ["wiki", { action: "append", slug: "s", entry: `key ${anthropic}` }],
      ["create_ticket", { title: "t", body: `see ${anthropic}` }],
      ["create_ticket", { title: "t", acceptanceCriteria: [{ text: `uses ${anthropic}` }] }],
      ["update_ticket", { ticketId: "x", ownerSetup: `export K=${anthropic}` }],
      ["ticket_reply", { ticketId: "x", text: `here: ${anthropic}` }],
      ["set_ticket_state", { ticketId: "x", state: "review", summary: anthropic }],
      ["raise_decision", { question: "q", options: ["a", "b"], steps: [`run with ${anthropic}`] }],
      ["nudge", { agent: "Kit", why: anthropic }],
    ];
    for (const [tool, input] of calls) {
      const r = secretRefusal(tool, input);
      expect(r, `${tool} ${JSON.stringify(Object.keys(input))}`).toContain("anthropic-key");
      expect(r).not.toContain(rnd);
      expect(r).not.toContain("sk-ant");
    }
  });

  it("covers each kind of rule family, not only one", () => {
    expect(secretRefusal("ticket_reply", { text: github })).toContain("github-token");
    expect(secretRefusal("ticket_reply", { text: pem })).toContain("private-key");
    expect(secretRefusal("ticket_reply", { text: assign })).toContain("secret-assignment");
    expect(secretRefusal("ticket_reply", { text: "https://u:" + rnd.slice(0, 12) + "@db.internal/x" })).toContain("url-with-credentials");
  });

  it("lets clean text, placeholders and made-up values through", () => {
    expect(secretRefusal("ticket_reply", { ticketId: "5b3c1c7e-5b1a-4d52-9d41-0f3a5a7b1c11", text: "Fixed. Use $ANTHROPIC_API_KEY from the environment." })).toBeNull();
    expect(secretRefusal("wiki", { action: "write", body: "api_key = 'your-api-key-goes-here-1234567890'" })).toBeNull();
    expect(secretRefusal("wiki", { action: "write", body: "Tokens look like sk-ant-... and are never written here." })).toBeNull();
  });

  it("checks only the wiki's writing actions, and only the guarded tools", () => {
    expect(secretRefusal("wiki", { action: "read", slug: anthropic })).toBeNull();
    expect(secretRefusal("notes", { action: "save", body: anthropic })).toBeNull();
  });

  it("finds a secret in a deeply nested or later field, and one split from clean text", () => {
    expect(secretRefusal("create_ticket", { title: "ok", extra: { a: [{ b: "fine" }, { c: `x ${anthropic} y` }] } })).toContain("anthropic-key");
    expect(secretRefusal("ticket_reply", { text: "line one\n\n" + anthropic + "\nline three" })).toContain("anthropic-key");
  });
});

describe("guardSecrets on a real server", () => {
  it("returns an error result and does not run the tool for a secret; runs it for clean text", async () => {
    const server = guardSecrets(new McpServer({ name: "t", version: "0" }));
    let ran = 0;
    let handler: ((input: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>) | undefined;
    server.registerTool("ticket_reply", { description: "d", inputSchema: { text: z.string() } }, (async () => {
      ran++;
      return { content: [{ type: "text", text: "ok" }] };
    }) as never);
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: typeof handler }> })._registeredTools;
    handler = tools["ticket_reply"]!.handler;
    const bad = await handler!({ text: anthropic }, {});
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("anthropic-key");
    expect(ran).toBe(0);
    const good = await handler!({ text: "all fine" }, {});
    expect(good.isError).toBeUndefined();
    expect(ran).toBe(1);
  });
});
