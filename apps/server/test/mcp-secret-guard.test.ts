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

  it("accepts what the merge gate accepts: placeholders in every guarded tool", () => {
    const placeholders = ["sk-ant-api03-EXAMPLE…", "export K=${TOKEN}", "path {{host.env.file}}", "api_key = 'REPLACE-ME-your-key-0000000000000'", "AKIAIOSFODNN7EXAMPLE"];
    for (const p of placeholders) {
      for (const [tool, input] of [
        ["wiki", { action: "write", body: p }],
        ["wiki", { action: "append", entry: p }],
        ["create_ticket", { body: p }],
        ["update_ticket", { ownerSetup: p }],
        ["ticket_reply", { text: p }],
        ["set_ticket_state", { summary: p }],
        ["raise_decision", { steps: [p] }],
        ["nudge", { why: p }],
      ] as Array<[string, Record<string, unknown>]>) expect(secretRefusal(tool, input), `${tool}: ${p}`).toBeNull();
    }
  });

  it("does not apply the owner's private-details list: a host name or address is accepted", () => {
    expect(secretRefusal("ticket_reply", { text: "Reach it at nas.home.example on 192.168.1.50" })).toBeNull();
  });

  it("uses the very same rule list as the merge-line scan script", async () => {
    // @ts-expect-error the script is plain JavaScript with no declaration file
    const script = (await import("../../../scripts/scan-added-lines.mjs")) as { SECRET_RULES: Array<[string, RegExp, unknown?]> };
    const shared = (await import("@boss-man/shared")) as unknown as { findSecretKind: (t: string) => string | null };
    const rules = (await import("../../../packages/shared/src/secret-rules.mjs")) as unknown as { SECRET_RULES: Array<[string, RegExp, unknown?]> };
    expect(script.SECRET_RULES).toBe(rules.SECRET_RULES);
    expect(script.SECRET_RULES.length).toBeGreaterThan(20);
    expect(shared.findSecretKind(anthropic)).toBe(script.SECRET_RULES.find(([k]) => k === "anthropic-key")![0]);
  });

  it("stays fast on a 200 KB run of the word token (the secret-assignment rule once took quadratic time)", () => {
    const time = (text: string) => {
      const t0 = performance.now();
      secretRefusal("wiki", { action: "write", body: text });
      return performance.now() - t0;
    };
    const baseline = time("a".repeat(200_000)) + 20; // same length, no keyword: the cost of scanning alone, plus a floor for timer noise
    const hostile = time("token".repeat(40_000));
    // Catches a return to quadratic time (about 8 s here before the cap); a linear scan stays within a small multiple of the baseline.
    expect(hostile).toBeLessThan(baseline * 25);
  });

  it("stays fast on 200 KB of scheme-like text (the url-with-credentials rule once took quadratic time)", () => {
    const time = (text: string) => {
      const t0 = performance.now();
      secretRefusal("wiki", { action: "write", body: text });
      return performance.now() - t0;
    };
    const baseline = time("b".repeat(200_000)) + 20;
    // Each shape took 14 to 23 s before the cap on the scheme part; a linear scan stays near the baseline.
    for (const text of ["a.".repeat(100_000), "a-".repeat(100_000), "sk-".repeat(66_000)]) {
      expect(time(text)).toBeLessThan(baseline * 25);
    }
  });

  it("still refuses a database URL with a password", () => {
    const url = ["postgres", "://app:", "x7Kq2mZp9Lw", "@db.example.com/main"].join("");
    expect(secretRefusal("wiki", { action: "write", body: `use ${url}` })).toMatch(/url-with-credentials/);
  });

  it("skips only reads: the wiki's list, read and history, and the read-only tools", () => {
    expect(secretRefusal("wiki", { action: "read", slug: anthropic })).toBeNull();
    expect(secretRefusal("tickets", { action: "find", q: anthropic })).toBeNull();
    expect(secretRefusal("notes", { action: "list", q: anthropic })).toBeNull();
  });

  it("checks every other writing tool and action, so one added later is covered (BOS-2760)", () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["github_reply", { text: anthropic }],
      ["request_engagement", { message: anthropic }],
      ["review", { action: "submit", summary: anthropic }],
      ["notify_owner", { message: anthropic }],
      ["handoff", { summary: anthropic }],
      ["pa_reply", { text: anthropic, cites: [], confidence: "high" }],
      ["submit_plan", { plan: anthropic }],
      ["skills", { action: "review_verdict", note: anthropic }],
      ["propose_rule", { rule: anthropic }],
      ["update_instructions", { agent: "Kit", text: anthropic }],
      ["notes", { action: "save", body: anthropic }],
      ["request_note", { text: anthropic }],
      ["wiki", { action: "attach", ticketId: "x", title: anthropic, url: "https://example.com" }],
      ["wiki", { action: "restore", slug: anthropic }],
      ["some_tool_added_next_year", { anything: anthropic }],
      ["wiki", { action: "an_action_added_next_year", body: anthropic }],
    ];
    for (const [tool, input] of calls) expect(secretRefusal(tool, input), `${tool} ${String(input.action ?? "")}`).toContain("anthropic-key");
    // a wiki call with no action at all is checked too, not skipped
    expect(secretRefusal("wiki", { body: anthropic })).toContain("anthropic-key");
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
