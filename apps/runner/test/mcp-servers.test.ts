// The company's extra MCP servers reach session/new with their header filled from the run's granted secrets.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");
const server = (name: string, transport: "http" | "sse", secretEnv: string | null) => ({ name, url: `http://lan/${name}`, transport, headerName: "Authorization", headerValue: "Bearer {secret}", secretEnv });

async function run(caps: object, secrets: Record<string, string>, mcpServers: ReturnType<typeof server>[]) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-mcp-")), "dump.json");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    resolveEnv: async () => ({ DUMP: dump, MCP_CAPS: JSON.stringify(caps), ...secrets }),
    emit: (e) => (events.push(e), e.type === "run.ended" && done()),
  });
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-mcp-ws-")), prompt: "hi", mcpToken: "t", mcpServers } as never);
  await ended;
  manager.shutdown();
  const sent = JSON.parse(readFileSync(dump, "utf8")).mcpServers as Array<{ type: string; name: string; headers: unknown[] }>;
  return { events, sent };
}

describe("extra MCP servers", () => {
  it("adds granted servers after bossman with the header filled from secrets", async () => {
    const { sent } = await run({ http: true, sse: true }, { SCRAPLING_MCP_TOKEN: "tok-1" }, [server("scrapling", "http", "SCRAPLING_MCP_TOKEN"), server("crawl4ai", "sse", null)]);
    expect(sent.map((s) => [s.type, s.name])).toEqual([["http", "bossman"], ["http", "scrapling"], ["sse", "crawl4ai"]]);
    expect(sent[1]).toMatchObject({ url: "http://lan/scrapling", headers: [{ name: "Authorization", value: "Bearer tok-1" }] });
    expect(sent[2]!.headers).toEqual([]);
  });

  it("skips a server whose secret this run doesn't have", async () => {
    const { sent } = await run({ http: true }, {}, [server("scrapling", "http", "SCRAPLING_MCP_TOKEN")]);
    expect(sent.map((s) => s.name)).toEqual(["bossman"]);
  });

  it("skips a server whose transport the agent can't use, and logs it without the token", async () => {
    const { sent, events } = await run({ http: true }, { CRAWL_TOKEN: "tok-2" }, [server("crawl4ai", "sse", "CRAWL_TOKEN")]);
    expect(sent.map((s) => s.name)).toEqual(["bossman"]);
    const log = events.find((e) => e.type === "runner.log") as { message: string };
    expect(log.message).toContain("crawl4ai");
    expect(log.message).toContain("sse");
    expect(JSON.stringify(events)).not.toContain("tok-2");
  });
});
