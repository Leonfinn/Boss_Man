// Agent runs inside the fence (BOS-321): what the agent can reach, its own home, and that a run
// not asked to be fenced starts exactly as before.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { claudeProjectSlug, levelFor, probeLandlock, runnerFence, type FenceLevel } from "../src/fence.js";
import { SessionManager } from "../src/session-manager.js";
import { Workspaces } from "../src/workspace.js";
import { startStubAnthropic, type StubLogEntry } from "./stub-model.js";

const level = levelFor(probeLandlock().abi).level;
const live = level !== "unavailable";
const FAKE_REACH = path.join(import.meta.dirname, "fake-reach.mjs");

type Reach = { wroteInside: boolean; wroteTmp: boolean; wroteOutside: boolean; readSecret: boolean; readSharedClaude: boolean; wroteQueue: boolean; wroteStore: boolean; wroteProof: boolean; env: Record<string, string | null> };

/** One run of the reach-probing adapter; `fence` is what the run asks for, `runnerLevel` what the runner can do. */
async function reachRun(opts: { fence?: boolean; runnerLevel?: FenceLevel }) {
  const root = mkdtempSync(path.join(tmpdir(), "bm-fence-run-"));
  const sharedHome = path.join(root, "node");
  const sharedClaude = path.join(sharedHome, ".claude");
  mkdirSync(sharedClaude, { recursive: true });
  writeFileSync(path.join(sharedClaude, "other-agent-transcript.jsonl"), "secret conversation");
  const outside = path.join(root, "other-ticket.txt");
  writeFileSync(outside, "original");
  const secret = path.join(root, "runner_token");
  writeFileSync(secret, "token");
  const cwd = path.join(root, "workspaces", "tickets", "t1");
  mkdirSync(cwd, { recursive: true });
  const agentsRoot = path.join(root, "runner-data", "agents");
  const coordDir = path.join(root, "workspaces", ".bossman-coord");

  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:1/mcp",
    baseEnv: { PATH: process.env.PATH, HOME: sharedHome, CLAUDE_CONFIG_DIR: sharedClaude },
    resolveEnv: async () => ({ REACH_OUTSIDE: outside, REACH_SECRET: secret, REACH_SHARED_CLAUDE: path.join(sharedClaude, "other-agent-transcript.jsonl") }),
    adapterBins: { claude: FAKE_REACH },
    coordDir,
    ...(opts.runnerLevel ? { fence: runnerFence(opts.runnerLevel, path.join(root, "runner-data"), path.join(root, "workspaces")) } : {}),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.ended") done();
    },
  });
  const agentId = randomUUID();
  const runId = randomUUID();
  manager.handle({ type: "run.start", runId, agentId, agentKind: "claude", model: null, fundingSourceId: null, cwd, prompt: "probe", mcpToken: "t", ...(opts.fence === undefined ? {} : { fence: opts.fence }) });
  await ended;
  const reach = JSON.parse(readFileSync(path.join(cwd, "reach.json"), "utf8")) as Reach;
  return { reach, events, outside, sharedHome, home: path.join(agentsRoot, agentId), runId, coordDir };
}

describe.skipIf(!live)("a fenced run", () => {
  it("can't write outside its folders or read other agents' files and the runner's secrets", async () => {
    const r = await reachRun({ fence: true, runnerLevel: level });
    expect(r.reach).toMatchObject({ wroteInside: true, wroteTmp: true, wroteOutside: false, readSecret: false, readSharedClaude: false });
    expect(readFileSync(r.outside, "utf8")).toBe("original");
    expect(r.events.find((e) => e.type === "run.started")).toMatchObject({ fenced: true });
    expect(r.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
  });

  it("gets its own home, harness folders and a temp folder that goes when the run ends", async () => {
    const r = await reachRun({ fence: true, runnerLevel: level });
    expect(r.reach.env).toMatchObject({
      HOME: r.home,
      TMPDIR: path.join(r.home, "tmp", r.runId),
      CLAUDE_CONFIG_DIR: path.join(r.home, ".claude"),
      CODEX_HOME: path.join(r.home, ".codex"),
      XDG_CACHE_HOME: path.join(r.home, ".cache"),
      CHECK_ALL_LOCK: path.join(r.coordDir, "queue", "check-all"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "gc.auto",
    });
    expect(r.reach.env.npm_config_store_dir).toMatch(/\.pnpm-store$/);
    expect(existsSync(path.join(r.home, "tmp", r.runId))).toBe(false);
  });

  it("can join check-all's queue but can't forge its stored results or pair proof (BOS-321 review)", async () => {
    const r = await reachRun({ fence: true, runnerLevel: level });
    expect(r.reach.env).toMatchObject({
      BOSSMAN_CHECK_STORE: path.join(r.coordDir, "gate", "check-results"),
      CHECK_ALL_PAIR_PROOF: path.join(r.coordDir, "gate", "check-pair-passed"),
    });
    expect(r.reach).toMatchObject({ wroteQueue: true, wroteStore: false, wroteProof: false });
    expect(existsSync(path.join(r.coordDir, "gate", "check-pair-passed"))).toBe(false);
    expect(existsSync(path.join(r.coordDir, "gate", "check-results", "forged.json"))).toBe(false);
  });
});

describe("a run that isn't asked to be fenced", () => {
  it("starts exactly as before, on a runner that could fence it", async () => {
    const r = await reachRun({ runnerLevel: live ? level : "full" });
    // Today's reach: the agent can change another ticket's file and read other agents' transcripts.
    expect(r.reach).toMatchObject({ wroteInside: true, wroteOutside: true, readSharedClaude: true });
    expect(r.reach.env).toMatchObject({ HOME: r.sharedHome, TMPDIR: null, CLAUDE_CONFIG_DIR: path.join(r.sharedHome, ".claude"), CODEX_HOME: null, npm_config_store_dir: null, GIT_CONFIG_COUNT: null });
    // The check queue's folder is the one change every session gets, so fenced and unfenced checks take turns.
    expect(r.reach.env.CHECK_ALL_LOCK).toBe(path.join(r.coordDir, "queue", "check-all"));
    expect(r.events.find((e) => e.type === "run.started")).not.toHaveProperty("fenced");
  });

  it("runs unfenced and says so when the runner can't fence", async () => {
    const r = await reachRun({ fence: true, runnerLevel: "unavailable" });
    expect(r.reach.wroteOutside).toBe(true);
    expect(r.events.find((e) => e.type === "run.started")).toMatchObject({ fenced: false });
    expect(r.events).toContainEqual(expect.objectContaining({ type: "runner.log", level: "warn", message: expect.stringContaining("can't fence agents") }));
  });
});

describe.skipIf(!live)("the shared memory link", () => {
  it("is only made inside the agent's real home, whatever the agent did to its folders", async () => {
    const remote = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: remote, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(remote, "README.md"), "app\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-link-"));
    const workspaces = new Workspaces(path.join(root, "workspaces"));
    const agentsRoot = path.join(root, "agents");
    const agentId = randomUUID();
    // In an earlier run the agent swapped its projects folder for a link to a folder of the runner's.
    const elsewhere = path.join(root, "runner-data");
    mkdirSync(elsewhere);
    mkdirSync(path.join(agentsRoot, agentId, ".claude"), { recursive: true });
    symlinkSync(elsewhere, path.join(agentsRoot, agentId, ".claude", "projects"));
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager = new SessionManager({
      workspaces,
      mcpUrl: "http://127.0.0.1:1/mcp",
      baseEnv: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "shared-claude") },
      resolveEnv: async () => ({}),
      adapterBins: { claude: FAKE_REACH },
      fence: { level, agentsRoot },
      emit: (e) => e.type === "run.ended" && done(),
    });
    manager.handle({ type: "run.start", runId: randomUUID(), agentId, agentKind: "claude", model: null, fundingSourceId: null, cwd: root, prompt: "probe", mcpToken: "t", workspace: { projectId: randomUUID(), ticketId: randomUUID(), repoUrl: remote, baseRef: "main" }, fence: true });
    await ended;
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses to start when the agent turned its temp folder into a link", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-link-"));
    const agentsRoot = path.join(root, "agents");
    const agentId = randomUUID();
    const elsewhere = path.join(root, "runner-data");
    mkdirSync(elsewhere);
    mkdirSync(path.join(agentsRoot, agentId), { recursive: true });
    symlinkSync(elsewhere, path.join(agentsRoot, agentId, "tmp"));
    const events: RunnerEvent[] = [];
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager = new SessionManager({
      mcpUrl: "http://127.0.0.1:1/mcp",
      baseEnv: { PATH: process.env.PATH, HOME: root },
      resolveEnv: async () => ({}),
      adapterBins: { claude: FAKE_REACH },
      fence: { level, agentsRoot },
      emit: (e) => (events.push(e), e.type === "run.ended" && done()),
    });
    manager.handle({ type: "run.start", runId: randomUUID(), agentId, agentKind: "claude", model: null, fundingSourceId: null, cwd: path.join(root, "work"), prompt: "probe", mcpToken: "t", fence: true });
    await ended;
    expect((events.find((e) => e.type === "run.ended") as { error: string }).error).toMatch(/^Couldn't set up the agent's fence: tmp\//);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe.skipIf(!live)("Claude Code inside the fence (stub model)", () => {
  let stub: Awaited<ReturnType<typeof startStubAnthropic>>;
  const stubLog: StubLogEntry[] = [];
  beforeEach(async () => {
    stubLog.length = 0;
    stub = await startStubAnthropic(stubLog);
  });
  afterEach(async () => {
    await stub.close();
  });

  it("works a ticket in its git worktree and keeps the project's shared memory", async () => {
    const remote = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
    const g = (args: string[], cwd = remote) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" }).trim();
    g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(remote, "README.md"), "app\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    const root = mkdtempSync(path.join(tmpdir(), "bm-fence-claude-"));
    const workspaces = new Workspaces(path.join(root, "workspaces"));
    const sharedClaude = path.join(root, "shared-claude");
    const agentsRoot = path.join(root, "agents");
    const projectId = randomUUID();
    const ticketId = randomUUID();
    const agentId = randomUUID();
    const events: RunnerEvent[] = [];
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager: SessionManager = new SessionManager({
      workspaces,
      mcpUrl: "http://127.0.0.1:1/mcp",
      baseEnv: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: sharedClaude, NO_PROXY: "127.0.0.1,localhost" },
      resolveEnv: async () => ({ ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key", NO_PROXY: "127.0.0.1,localhost" }),
      fence: { level, agentsRoot },
      emit: (e) => {
        events.push(e);
        if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: /rm -rf/.test(String((e.rawInput as { command?: string } | null)?.command)) ? "deny" : "allow" });
        if (e.type === "run.ended") done();
      },
    });
    manager.handle({
      type: "run.start",
      runId: randomUUID(),
      agentId,
      agentKind: "claude",
      model: null,
      fundingSourceId: null,
      cwd: path.join(root, "unused"),
      prompt: "Run the spike scenario.",
      mcpToken: "t",
      workspace: { projectId, ticketId, repoUrl: remote, baseRef: "main" },
      fence: true,
    });
    await ended;

    expect(events.find((e) => e.type === "run.started")).toMatchObject({ fenced: true });
    expect(events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
    // The stub's first step writes spike.txt in the worktree; the runner's checkpoint still works on it.
    expect(existsSync(path.join(workspaces.ticketDir(ticketId), "spike.txt"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.update", update: { kind: "checkpoint", turn: 1, files: 1 } }));
    // Claude Code's state went to the agent's own folder, not the shared one.
    expect(existsSync(path.join(agentsRoot, agentId, ".claude", "projects"))).toBe(true);
    expect(existsSync(path.join(sharedClaude, "projects", claudeProjectSlug(workspaces.ticketDir(ticketId))))).toBe(false);
    // The project's auto-memory is still the shared folder.
    const slug = claudeProjectSlug(workspaces.repoDir(projectId));
    expect(readlinkSync(path.join(agentsRoot, agentId, ".claude", "projects", slug, "memory"))).toBe(path.join(sharedClaude, "projects", slug, "memory"));
    expect(stubLog.some((l) => l.step === "final")).toBe(true);
  }, 120_000);
});
