// BOS-1067 probe (must not merge): what a fenced check job gives the real agent, in one failing line.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";

// Keep what the spawned agent says on stdout/stderr, so the "Internal error" can be explained.
const seen = vi.hoisted(() => ({ out: "", err: "" }));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a);
      c.stdout?.on("data", (d) => (seen.out += String(d)));
      c.stderr?.on("data", (d) => (seen.err += String(d)));
      return c;
    }) as typeof real.spawn,
  };
});
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";
import { startStubAnthropic, type StubLogEntry } from "./stub-model.js";
import { startMcpServer, type McpCall } from "./mcp-server.js";

const canWrite = (dir: string) => {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "p"), "x");
    return "w";
  } catch (e) {
    return String((e as NodeJS.ErrnoException).code);
  }
};

async function run(extra: Record<string, string>) {
  const log: StubLogEntry[] = [];
  const calls: McpCall[] = [];
  const stub = await startStubAnthropic(log);
  const mcp = await startMcpServer(calls);
  const events: RunnerEvent[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "bm-probe-home-"));
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager: SessionManager = new SessionManager({
    mcpUrl: mcp.url,
    baseEnv: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_PROXY: "127.0.0.1,localhost", ...extra },
    resolveEnv: async () => ({ ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key", NO_PROXY: "127.0.0.1,localhost" }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "allow" });
      if (e.type === "run.ended") done();
    },
  });
  manager.handle({ type: "run.start", runId: randomUUID(), agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: mkdtempSync(path.join(tmpdir(), "bm-ws-")), prompt: "Run the spike scenario.", mcpToken: "bm_sess_test" });
  const timeout = new Promise<void>((r) => setTimeout(r, 70_000));
  await Promise.race([ended, timeout]);
  const end = events.find((e) => e.type === "run.ended") as { stopReason?: string; error?: string | null } | undefined;
  const out = `end=${end ? `${end.stopReason}/${String(end.error ?? "").replace(/\s+/g, " ").slice(0, 300)}` : "none"} types=${[...new Set(events.map((e) => e.type))].join(",")} stub=${log.length}`;
  await stub.close();
  await mcp.close();
  return out;
}

it("probe", async () => {
  const env = process.env;
  const facts = `TMPDIR=${env.TMPDIR} CLAUDE=${Object.keys(env).filter((k) => k.startsWith("CLAUDE")).join(",")} os.tmpdir=${tmpdir()} /tmp=${canWrite("/tmp/bm-probe-x")} /tmp/claude-1000=${canWrite("/tmp/claude-1000")} uid=${process.getuid?.()}`;
  const a = await run({});
  const flat = (s: string) => s.replace(/\s+/g, " ");
  expect(`A: ${a} || STDERR(last)=${flat(seen.err).slice(-700)} || STDOUT(first)=${flat(seen.out).slice(0, 500)} || STDOUT(last)=${flat(seen.out).slice(-500)}`).toBe("probe");
  void facts;
}, 200_000);
