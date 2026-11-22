// Pure helpers from session-manager.ts that had no direct test: the thinking-level
// config choice, Claude Code's MCP config file, the permission kinds a harness offers
// that the runner doesn't know, and the stderr tail shown in an exit message.
import { describe, expect, it } from "vitest";
import type { McpServer } from "@agentclientprotocol/sdk";
import { claudeMcpConfig, setAsideUnknownPermissionKinds, stderrTail, thinkingOption } from "../src/session-manager.js";

type PermissionMessage = {
  method?: string;
  params?: { options?: unknown; _meta?: Record<string, unknown>; [key: string]: unknown };
};

async function through(messages: PermissionMessage[]): Promise<PermissionMessage[]> {
  const out: PermissionMessage[] = [];
  const input = new ReadableStream<PermissionMessage>({
    start(controller) {
      for (const m of messages) controller.enqueue(m);
      controller.close();
    },
  });
  const output = new WritableStream<PermissionMessage>({
    write(m) {
      out.push(m);
    },
  });
  const { readable, writable } = setAsideUnknownPermissionKinds({ readable: input, writable: output });
  await readable.pipeTo(writable);
  return out;
}

const permission = (options: unknown, extra: Record<string, unknown> = {}): PermissionMessage => ({
  method: "session/request_permission",
  params: { options, ...extra },
});

const allowOnce = { optionId: "yes", name: "Yes", kind: "allow_once" };
const allowAlways = { optionId: "always", name: "Always", kind: "allow_always" };

describe("setAsideUnknownPermissionKinds", () => {
  it("passes a request with only known kinds through untouched", async () => {
    const request = permission([allowOnce, allowAlways]);
    const out = await through([request]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(request);
  });

  it("drops an unknown kind, keeps the known ones and records every offered kind in _meta", async () => {
    const request = permission([allowOnce, { optionId: "renamed", name: "Yes", kind: "permit_once" }, allowAlways], { sessionId: "s1" });
    const out = await through([request]);
    expect(out[0]!.params?.options).toEqual([allowOnce, allowAlways]);
    expect(out[0]!.params?._meta).toEqual({ "bossman/offeredKinds": ["allow_once", "permit_once", "allow_always"] });
    expect(out[0]!.params?.sessionId).toBe("s1");
  });

  it("keeps other _meta keys when it adds the offered kinds", async () => {
    const request = permission([{ optionId: "x", name: "X", kind: "refuse_later" }], { _meta: { traceId: "abc" } });
    const out = await through([request]);
    expect(out[0]!.params?._meta).toEqual({ traceId: "abc", "bossman/offeredKinds": ["refuse_later"] });
    expect(out[0]!.params?.options).toEqual([]);
  });

  it("leaves a non-permission method alone even when its params carry options", async () => {
    const update: PermissionMessage = { method: "session/update", params: { options: [{ kind: "allow_once" }] } };
    const out = await through([update]);
    expect(out[0]).toBe(update);
  });

  it("leaves a permission request alone when its options are not an array", async () => {
    const request = permission("not-a-list");
    const out = await through([request]);
    expect(out[0]).toBe(request);
  });

  it("passes every message in order", async () => {
    const first = permission([{ optionId: "a", name: "A", kind: "allow_once" }]);
    const second = permission([{ optionId: "b", name: "B", kind: "reject_once" }]);
    const out = await through([first, second]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(first);
    expect(out[1]).toBe(second);
  });
});

describe("thinkingOption", () => {
  const levels = [
    { id: "model", category: "model", options: [{ value: "high" }] },
    {
      id: "thought",
      category: "thought_level",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High", description: "Thinks harder" },
      ],
    },
  ];

  it("returns the config id and value for a level the option offers", () => {
    expect(thinkingOption(levels, "high")).toEqual({ configId: "thought", value: "high" });
    expect(thinkingOption(levels, "low")).toEqual({ configId: "thought", value: "low" });
  });

  it("returns null for a level the option does not offer", () => {
    expect(thinkingOption(levels, "medium")).toBeNull();
    expect(thinkingOption(levels, "")).toBeNull();
  });

  it("returns null when there is no thought_level option", () => {
    expect(thinkingOption([levels[0]], "high")).toBeNull();
    expect(thinkingOption(null, "high")).toBeNull();
    expect(thinkingOption(undefined, "high")).toBeNull();
  });

  it("returns null when the thought_level option has no id", () => {
    expect(thinkingOption([{ category: "thought_level", options: [{ value: "high" }] }], "high")).toBeNull();
  });

  it("finds a level inside a grouped option", () => {
    const grouped = [
      {
        id: "thought",
        category: "thought_level",
        options: [
          { name: "Standard", options: [{ value: "low" }, { value: "medium" }] },
          { name: "Deep", options: [{ value: "high" }] },
        ],
      },
    ];
    expect(thinkingOption(grouped, "medium")).toEqual({ configId: "thought", value: "medium" });
    expect(thinkingOption(grouped, "high")).toEqual({ configId: "thought", value: "high" });
  });
});

describe("claudeMcpConfig", () => {
  it("writes http and sse servers with their headers and leaves stdio and acp servers out", () => {
    const servers: McpServer[] = [
      {
        type: "http",
        name: "bossman",
        url: "https://example.com/mcp",
        headers: [
          { name: "Authorization", value: "Bearer example" },
          { name: "X-Trace", value: "1" },
        ],
      },
      { type: "sse", name: "events", url: "https://example.com/sse", headers: [] },
      { name: "local", command: "node", args: ["server.js"], env: [] },
      { type: "acp", name: "component", serverId: "abc" },
    ];

    expect(JSON.parse(claudeMcpConfig(servers))).toEqual({
      mcpServers: {
        bossman: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer example", "X-Trace": "1" },
        },
        events: { type: "sse", url: "https://example.com/sse", headers: {} },
      },
    });
  });

  it("writes an empty server map when there are no servers", () => {
    expect(JSON.parse(claudeMcpConfig([]))).toEqual({ mcpServers: {} });
  });
});

describe("stderrTail", () => {
  it("is empty when there is no stderr", () => {
    expect(stderrTail("")).toBe("");
    expect(stderrTail("\n  \n\t\n")).toBe("");
  });

  it("drops blank lines and Bun's version banner", () => {
    expect(stderrTail("Error: EACCES\n\n  Bun v1.2.3 (Linux x64)  \n")).toBe("Error: EACCES");
  });

  it("trims each line and joins the rest with one space", () => {
    expect(stderrTail("  first line  \n second\tline \n\n")).toBe("first line second\tline");
  });

  it("keeps the last 600 characters", () => {
    const long = `start-${"x".repeat(700)}-end`;
    const tail = stderrTail(long);
    expect(tail).toHaveLength(600);
    expect(tail.endsWith("-end")).toBe(true);
    expect(tail.startsWith("start-")).toBe(false);
  });
});
