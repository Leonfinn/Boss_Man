// BOS-555: one fenced agent run can't reach another's temp folder or MCP config file (which holds its run token while
// the session opens), and no token is on any command line. Two live fenced runs on one SessionManager: a holder that
// keeps its session/new open, and a prober started while it waits. Only file access and command lines are tried.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { levelFor, probeLandlock, runnerFence, shortTmpName } from "../src/fence.js";
import { SessionManager } from "../src/session-manager.js";

const level = levelFor(probeLandlock().abi).level;
const live = level !== "unavailable";
const FAKE_PEER = path.join(import.meta.dirname, "fake-peer.mjs");

type Probe = { listedPeerTmp: boolean; readPeerSecret: boolean; readPeerMcp: boolean; wrotePeerTmp: boolean; readPeerHome: boolean; peerMcpExisted: boolean; cmdlineHits: number; tmp: string | null };

async function waitFor(check: () => boolean, what: string, ms = 20_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every file under dir whose text holds needle (links are not followed). */
function filesHolding(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && readFileSync(p, "utf8").includes(needle)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

async function crossRun(sameAgent: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "bm-isolation-"));
  const dataDir = path.join(root, "runner-data");
  const agentA = randomUUID();
  const agentB = sameAgent ? agentA : randomUUID();
  const runA = randomUUID();
  const runB = randomUUID();
  const cwdA = path.join(root, "work-a");
  const cwdB = path.join(root, "work-b");
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  const token = `bm_run_isolation-${randomUUID()}`;
  const secret = `stand-in-secret-${randomUUID()}`;
  const fence = runnerFence(level, dataDir, path.join(root, "workspaces"));
  const runTmpA = path.join(fence.runTmpRoot, shortTmpName(runA));
  const mcpA = path.join(runTmpA, "mcp", "mcp.json");
  const homeA = path.join(fence.agentsRoot, agentA);
  // B aims at wherever A's files really are (what A's adapter saw), not where this test expects them.
  type Holder = { tmp: string; mcpConfig: string; mcpConfigExists: boolean };
  const readHolder = () => JSON.parse(readFileSync(path.join(cwdA, "holder.json"), "utf8")) as Holder;

  const events: RunnerEvent[] = [];
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH, HOME: root },
    adapterBins: { claude: FAKE_PEER },
    fence,
    resolveEnv: async (runId): Promise<Record<string, string>> => {
      if (runId === runA) return { PEER_ROLE: "holder", PEER_SECRET: secret };
      const h = readHolder();
      return { PEER_ROLE: "prober", PEER_TMP: h.tmp, PEER_MCP: h.mcpConfig, PEER_MCP_EXISTS: existsSync(h.mcpConfig) ? "1" : "0", PEER_HOME: homeA, PEER_TOKEN: token, PEER_SECRET: secret };
    },
    emit: (e) => events.push(e),
  });
  const ended = (runId: string) => events.find((e) => e.type === "run.ended" && e.runId === runId) as { error: string | null } | undefined;
  const start = (runId: string, agentId: string, cwd: string, mcpToken: string) =>
    manager.handle({ type: "run.start", runId, agentId, agentKind: "claude", model: null, fundingSourceId: null, cwd, prompt: "probe", mcpToken, fence: true });

  try {
    start(runA, agentA, cwdA, token);
    await waitFor(() => existsSync(path.join(cwdA, "holder.json")) || !!ended(runA), "the holder's session/new");
    if (ended(runA)) throw new Error(`the holder ended early: ${ended(runA)!.error}`);
    const holder = readHolder();
    // While A's session opens, its token is in one file, in A's own temp folder: not /tmp, /dev/shm or A's home.
    const atStart = { holder, homeHits: filesHolding(homeA, token), homeSecretHits: filesHolding(homeA, secret) };

    start(runB, agentB, cwdB, `bm_run_other-${randomUUID()}`);
    await waitFor(() => !!ended(runB), "the prober");
    expect(ended(runB)).toMatchObject({ error: null });
    const probe = JSON.parse(readFileSync(path.join(cwdB, "probe.json"), "utf8")) as Probe;
    const planted = existsSync(path.join(holder.tmp, "planted.txt"));

    writeFileSync(path.join(cwdA, "release"), "");
    await waitFor(() => !!ended(runA), "the holder to end");
    expect(ended(runA)).toMatchObject({ error: null });
    return { ...atStart, probe, planted, runTmpA, mcpA, homeA, events, tmpAGone: !existsSync(holder.tmp) };
  } finally {
    manager.shutdown();
  }
}

describe.skipIf(!live)("two fenced runs at once (BOS-555)", () => {
  for (const sameAgent of [false, true]) {
    it(`of ${sameAgent ? "the same agent" : "different agents"}: neither reaches the other's temp folder, token file or command-line secrets`, async () => {
      const r = await crossRun(sameAgent);
      expect(r.events.filter((e) => e.type === "run.started")).toEqual([expect.objectContaining({ fenced: true }), expect.objectContaining({ fenced: true })]);
      // A's token file was there while B looked, and B can't list, read or write A's temp folder or that file.
      expect(r.probe.peerMcpExisted).toBe(true);
      expect(r.probe).toMatchObject({ listedPeerTmp: false, readPeerSecret: false, readPeerMcp: false, wrotePeerTmp: false });
      expect(r.planted).toBe(false);
      // The folder is A's own, outside every agent's home, so A's home holds neither the token nor the secret.
      expect(r.holder).toEqual({ tmp: r.runTmpA, mcpConfig: r.mcpA, mcpConfigExists: true });
      expect(r.probe.tmp).not.toBe(r.runTmpA);
      expect(r.homeHits).toEqual([]);
      expect(r.homeSecretHits).toEqual([]);
      // Command lines stay readable without a PID namespace; what matters is that no token or secret is on one.
      expect(r.probe.cmdlineHits).toBe(0);
      // Two runs of one agent share its home and harness state (accepted, DR-040); another agent's home is fenced off.
      expect(r.probe.readPeerHome).toBe(sameAgent);
      expect(r.tmpAGone).toBe(true);
    }, 60_000);
  }
});

describe("the start-up sweep of fenced runs' temp folders (BOS-555)", () => {
  it("removes old leftovers in the run-tmp root and the old per-agent layout, and keeps young ones and what links point at", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-isolation-sweep-"));
    const fence = runnerFence("full", path.join(root, "runner-data"), path.join(root, "workspaces"));
    const old = Date.now() / 1000 - 3600;
    const make = (dir: string, age?: number) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "mcp.json"), "token");
      if (age) utimesSync(dir, age, age);
      return dir;
    };
    const staleRun = make(path.join(fence.runTmpRoot, randomUUID()), old);
    const youngRun = make(path.join(fence.runTmpRoot, randomUUID()));
    const agentHome = path.join(fence.agentsRoot, randomUUID());
    const staleOldLayout = make(path.join(agentHome, "tmp", randomUUID()), old);
    const agentOwn = make(path.join(agentHome, "tmp", "notes"), old);
    // A link an agent planted where a leftover would be: the link goes, its target stays.
    const target = make(path.join(root, "elsewhere"));
    const link = path.join(fence.runTmpRoot, randomUUID());
    symlinkSync(target, link);
    lutimesSync(link, old, old);

    new SessionManager({ mcpUrl: "http://127.0.0.1:9/mcp", resolveEnv: async () => ({}), fence, emit: () => {} }).recoverInterrupted();

    expect(existsSync(staleRun)).toBe(false);
    expect(existsSync(staleOldLayout)).toBe(false);
    expect(existsSync(youngRun)).toBe(true);
    expect(existsSync(agentOwn)).toBe(true);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(path.join(target, "mcp.json"), "utf8")).toBe("token");
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
