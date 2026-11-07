// BOS-553: a Claude run's Boss Man token goes to Claude Code in a 0600 file, never in the command line the adapter passes on.
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude-acp.mjs");
const TOKEN = "bm_run_secret-token-for-test-0001";
const EXTRA = "extra-server-secret-0002";

async function run(over: Record<string, unknown> = {}) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-mcpf-")), "dump.json");
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { claude: fake },
    resolveEnv: async () => ({ DUMP: dump, EXTRA_TOKEN: EXTRA }),
    emit: (e) => e.type === "run.ended" && done(),
  });
  const extra = { name: "scrapling", url: "http://lan/s", transport: "http", headerName: "Authorization", headerValue: "Bearer {secret}", secretEnv: "EXTRA_TOKEN" };
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "claude", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-mcpf-ws-")), prompt: "hi", mcpToken: TOKEN, mcpServers: [extra], ...over } as never);
  await ended;
  manager.shutdown();
  return JSON.parse(readFileSync(dump, "utf8")) as { params: { mcpServers: unknown[]; _meta?: { claudeCode: { options: Record<string, unknown> } } }; file: string; config: string; fileMode: number; dirMode: number; hits: number };
}

describe("Claude MCP config file", () => {
  it("sends no server in session/new, only the path of a private file holding the token", async () => {
    const d = await run();
    expect(d.params.mcpServers).toEqual([]);
    expect(JSON.stringify(d.params)).not.toContain(TOKEN);
    expect(JSON.stringify(d.params)).not.toContain(EXTRA);
    expect(d.fileMode).toBe(0o600);
    expect(d.dirMode).toBe(0o700);
    const cfg = JSON.parse(d.config) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(cfg.mcpServers.bossman).toMatchObject({ type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(cfg.mcpServers.scrapling!.headers.Authorization).toBe(`Bearer ${EXTRA}`);
  });

  it("removes the file when the run ends", async () => {
    const d = await run();
    expect(existsSync(d.file)).toBe(false);
    expect(existsSync(path.dirname(d.file))).toBe(false);
  });

  it("keeps the token out of every process's command line and environment on the machine", async () => {
    const d = await run();
    expect(d.hits).toBe(0);
  });

  it("keeps the board-tools-only setting beside the file", async () => {
    const d = await run({ boardToolsOnly: true });
    expect(d.params._meta?.claudeCode.options).toMatchObject({ tools: [], extraArgs: { "mcp-config": d.file } });
  });

  it("deletes the file as soon as the session is open, not at run end (production runs share /tmp and one user)", async () => {
    const d = (await run()) as { fileDuringRun?: boolean };
    expect(d.fileDuringRun).toBe(false);
  });

  it("sweeps token folders a crashed runner left in tmp at startup", () => {
    const stale = mkdtempSync(path.join(tmpdir(), "bossman-mcp-"));
    const fresh = mkdtempSync(path.join(tmpdir(), "bossman-mcp-"));
    writeFileSync(path.join(stale, "mcp.json"), "{}");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(stale, hourAgo, hourAgo);
    new SessionManager({ mcpUrl: "x", emit: () => {}, resolveEnv: async () => ({}) }).recoverInterrupted();
    expect(existsSync(stale)).toBe(false);
    // A young folder may belong to a live run of another process sharing this tmp: it must survive (it broke the canary in parallel tests).
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("gives two runs different files", async () => {
    const [a, b] = await Promise.all([run({ runId: "r1" }), run({ runId: "r2" })]);
    expect(a.file).not.toBe(b.file);
  });
});
