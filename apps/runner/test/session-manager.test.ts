// Drives the real claude-agent-acp adapter (and its bundled Claude Code) against the
// scripted stub model, so no credentials are used. Same scenario as spike S2.
// Under the merge check these tests run in a bare environment (PATH, a job HOME and TMPDIR, CI=1); see BOS-1114.
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";
import { RepoLockTimeout, Workspaces } from "../src/workspace.js";
import { LONG_STEP_MARKER, WRAP_UP_MARKER, startStubAnthropic, type StubLogEntry } from "./stub-model.js";
import { startMcpServer, type McpCall } from "./mcp-server.js";

let stub: Awaited<ReturnType<typeof startStubAnthropic>>;
let mcp: Awaited<ReturnType<typeof startMcpServer>>;
const stubLog: StubLogEntry[] = [];
const mcpCalls: McpCall[] = [];

beforeEach(async () => {
  stubLog.length = 0;
  mcpCalls.length = 0;
  stub = await startStubAnthropic(stubLog);
  mcp = await startMcpServer(mcpCalls);
});
afterEach(async () => {
  await stub.close();
  await mcp.close();
});

function harness(model: string | null, opts: { prompt?: string; expectError?: boolean; skills?: Array<{ name: string; files: Array<{ path: string; content: string }> }>; skillsRoot?: string; home?: string; cwd?: string; resumeSessionId?: string; freshPrompt?: string; boardToolsOnly?: boolean; workspaces?: Workspaces; lockRetryMs?: number; workspace?: { projectId: string; ticketId: string; repoUrl: string; baseRef: string } } = {}) {
  const events: RunnerEvent[] = [];
  const home = opts.home ?? mkdtempSync(path.join(tmpdir(), "bm-runner-home-"));
  const fundingSourceId = randomUUID();
  let done!: (error: string | null) => void;
  // Settles when the run ends. A run that ends with an error rejects with that error, unless the test expects one
  // (expectError): under load the agent can fail to start, and the test should then read "the run ended with: <reason>"
  // instead of a bare "undefined" or "expected false to be true" further down (BOS-965).
  const ended = new Promise<void>((resolve, reject) => {
    done = (error) => {
      if (!error || opts.expectError) return resolve();
      // No stack frames: they push the reason out of a short log tail, and the reason is what matters.
      const failure = new Error(`The run ended with an error: ${error}`);
      failure.stack = `Error: ${failure.message}`;
      reject(failure);
    };
  });
  ended.catch(() => {});
  const manager: SessionManager = new SessionManager({
    workspaces: opts.workspaces,
    lockRetryMs: opts.lockRetryMs,
    lockRetryDelayMs: 5,
    skillsRoot: opts.skillsRoot,
    mcpUrl: mcp.url,
    baseEnv: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), NO_PROXY: "127.0.0.1,localhost" },
    // Stands in for the company's granted secrets.
    resolveEnv: async () => ({ ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key", NO_PROXY: "127.0.0.1,localhost" }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.permission_request") {
        // Stands in for the server's policy engine.
        const cmd = String((e.rawInput as { command?: string } | null)?.command ?? "");
        manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: /rm -rf/.test(cmd) ? "deny" : "allow" });
      }
      if (e.type === "run.ended") done(e.error ?? null);
    },
  });
  const runId = randomUUID();
  const cwd = opts.cwd ?? mkdtempSync(path.join(tmpdir(), "bm-ws-"));
  manager.handle({
    type: "run.start",
    runId,
    agentId: randomUUID(),
    agentKind: "claude",
    model,
    fundingSourceId,
    cwd,
    prompt: opts.prompt ?? "Run the spike scenario.",
    mcpToken: "bm_sess_test",
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    ...(opts.freshPrompt ? { freshPrompt: opts.freshPrompt } : {}),
    ...(opts.boardToolsOnly ? { boardToolsOnly: true } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
  });
  return { events, ended, runId, cwd, home, manager };
}

const sessionStarted = (events: RunnerEvent[]) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.type === "run.started")) {
        clearInterval(t);
        resolve();
      }
    }, 20);
  });

const waitFor = (ok: () => boolean, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const until = Date.now() + ms;
    const t = setInterval(() => {
      if (ok()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() > until) {
        clearInterval(t);
        reject(new Error("timed out waiting"));
      }
    }, 20);
  });

describe("SessionManager with Claude Code over ACP (stub model)", () => {
  it("delivers a steering message as a second turn in the same session (R37)", async () => {
    const h = harness(null);
    // Send the message as soon as the session exists; it waits for the current turn.
    await sessionStarted(h.events);
    h.manager.handle({ type: "run.message", runId: h.runId, text: "Message from the owner: also add a README.", interrupt: false });
    await h.ended;
    const delivered = h.events.find((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered");
    expect((delivered as { update: { text: string } }).update.text).toContain("also add a README");
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
    // Two turns reached the model's final step: the original and the steered one.
    expect(stubLog.filter((l) => l.step === "final").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("a stop drops queued messages instead of starting another turn", async () => {
    const h = harness(null);
    await sessionStarted(h.events);
    h.manager.handle({ type: "run.message", runId: h.runId, text: "Message from the owner: keep going", interrupt: false });
    h.manager.handle({ type: "run.cancel", runId: h.runId });
    await h.ended;
    expect(h.events.some((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered")).toBe(false);
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "cancelled" });
  }, 60_000);

  it("hands a steered message to a turn stuck in a long command, without cancelling it (BOS-1016)", async () => {
    const h = harness(null, { prompt: `${LONG_STEP_MARKER}: run the long check.` });
    // Wait until the 60 s command is really running.
    const started = Date.now();
    await waitFor(() => h.events.some((e) => e.type === "run.update" && (e.update as { kind?: string; status?: string }).kind === "tool_call_update" && (e.update as { status?: string }).status === "in_progress") || stubLog.some((l) => l.step === "long-step"), 30_000);
    await new Promise((r) => setTimeout(r, 2000));
    const sentAt = Date.now();
    h.manager.handle({ type: "run.message", runId: h.runId, text: `${WRAP_UP_MARKER}: please wrap up.`, interrupt: false, steer: true });
    await h.ended;
    const endedAt = Date.now();
    const delivered = h.events.filter((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered");
    // Delivered once, inside the turn.
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as { update: { steered?: boolean } }).update.steered).toBe(true);
    // The model saw the message and answered it; the run ended normally, well before the command would have.
    expect(stubLog.some((l) => l.step === "wrapped")).toBe(true);
    // Claude Code moved the running command to the background rather than killing it.
    expect(stubLog.find((l) => l.step === "wrapped")?.raw).toMatch(/moved to the background[^"]*it was not interrupted/);
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
    expect(endedAt - sentAt).toBeLessThan(30_000);
    expect(endedAt - started).toBeLessThan(55_000);
  }, 90_000);

  it("runs a turn end to end: permissions via the server, MCP passthrough, cost deltas", async () => {
    const h = harness(null);
    await sessionStarted(h.events);
    const [pgid] = h.manager.processGroups();
    await h.ended;
    // The adapter's whole process group, Claude Code included, is gone once the run ends (S4).
    const alive = () => {
      try {
        process.kill(-pgid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);

    const ended = h.events.find((e) => e.type === "run.ended");
    expect(ended).toMatchObject({ stopReason: "end_turn", error: null });
    // Token use from the turns' PromptResponse.usage (R67); the stub model reports 120 in, 42 out per call.
    const usage = (ended as { usage?: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
    expect(existsSync(path.join(h.cwd, "spike.txt"))).toBe(true);

    const permissions = h.events.filter((e) => e.type === "run.permission_request");
    expect(permissions.map((p) => p.title)).toContain("rm -rf /srv/precious");
    expect(mcpCalls).toEqual([expect.objectContaining({ tool: "create_ticket", token: "bm_sess_test" })]);

    const started = h.events.find((e) => e.type === "run.started");
    expect(started).toMatchObject({ runId: h.runId });

    const costs = h.events.filter((e) => e.type === "run.cost");
    expect(costs.length).toBeGreaterThan(0);
    expect(costs.every((c) => c.costMicrosDelta > 0)).toBe(true);

    const message = h.events.find((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "agent_message");
    expect((message as { update: { text: string } }).update.text).toContain("SPIKE_DONE");
    expect(h.manager.activeRuns).toBe(0);
  }, 60_000);

  it("offers only the Boss Man MCP tools when a run is limited to board tools (owner chat)", async () => {
    stubLog.length = 0;
    const h = harness(null, { boardToolsOnly: true });
    await h.ended;
    const offered = new Set(stubLog.flatMap((l) => l.toolNames ?? []));
    expect([...offered].some((n) => n.startsWith("mcp__bossman__"))).toBe(true);
    for (const builtIn of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"]) expect(offered.has(builtIn)).toBe(false);
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ error: null });
  }, 60_000);

  it("loads the agent's skills from a folder of their own, and removes it after the run (R71)", async () => {
    const skillsRoot = mkdtempSync(path.join(tmpdir(), "bm-skills-"));
    const md = "---\nname: release-notes\ndescription: Writes release notes in the Boss Man house style. Use when asked for a changelog.\n---\n\n# Release notes\n";
    const h = harness(null, { skillsRoot, skills: [{ name: "release-notes", files: [{ path: "SKILL.md", content: Buffer.from(md).toString("base64") }, { path: "templates/entry.md", content: Buffer.from("- {change}").toString("base64") }] }] });
    await sessionStarted(h.events);
    const dir = path.join(skillsRoot, h.runId, ".claude", "skills", "release-notes");
    expect(readFileSync(path.join(dir, "templates", "entry.md"), "utf8")).toBe("- {change}");
    await h.ended;
    // Claude Code told the model about the skill: its description reached the request.
    expect(stubLog.some((l) => l.raw?.includes("Writes release notes in the Boss Man house style"))).toBe(true);
    // Nothing was written into the agent's working folder, and the run's skills are gone.
    expect(existsSync(path.join(h.cwd, ".claude"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, h.runId))).toBe(false);
  }, 60_000);

  it("refuses a skill file that would land outside its folder", async () => {
    const h = harness(null, { expectError: true, skills: [{ name: "evil", files: [{ path: "../../escape.txt", content: "eA==" }] }] });
    await h.ended;
    expect(h.events.find((e) => e.type === "run.ended")).toMatchObject({ error: expect.stringContaining("Couldn't set up the agent's skills") });
  }, 30_000);

  it("pins an unlisted model at launch (spike S2 finding)", async () => {
    const h = harness("claude-future-model-x");
    await h.ended;
    const models = new Set(stubLog.filter((l) => l.hasTools).map((l) => l.model));
    expect([...models]).toEqual(["claude-future-model-x"]);
    expect(h.events.find((e) => e.type === "run.started")).toMatchObject({ model: "claude-future-model-x" });
  }, 60_000);

  it("a recovery run reopens the interrupted session, or starts fresh when it can't (R42)", async () => {
    const first = harness(null);
    await first.ended;
    const sessionId = (first.events.find((e) => e.type === "run.started") as { acpSessionId: string }).acpSessionId;

    // How full the context is, for CEO chapters.
    expect(first.events).toContainEqual(expect.objectContaining({ type: "run.context", used: expect.any(Number), size: expect.any(Number) }));

    const resumed = harness(null, { home: first.home, cwd: first.cwd, resumeSessionId: sessionId, freshPrompt: "FRESH-ONLY" });
    await resumed.ended;
    const marker = resumed.events.findIndex((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "resumed");
    expect(marker).toBeGreaterThanOrEqual(0);
    // The agent replays the old conversation while loading it; that history isn't this run's work.
    expect(resumed.events.slice(0, marker).filter((e) => e.type === "run.update")).toEqual([]);
    expect(first.events.some((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "tool_call")).toBe(true);
    expect(resumed.events.find((e) => e.type === "run.started")).toMatchObject({ acpSessionId: sessionId, resumed: true });

    stubLog.length = 0;
    const lost = harness(null, { home: first.home, cwd: first.cwd, resumeSessionId: "00000000-0000-4000-8000-00000000dead", freshPrompt: "FRESH-ONLY: the chapter's opening" });
    await lost.ended;
    expect(lost.events).toContainEqual(expect.objectContaining({ type: "run.update", update: { kind: "resumed", mode: "fresh" } }));
    expect(lost.events.find((e) => e.type === "run.started")).toMatchObject({ resumed: false });
    // A session that couldn't be reopened gets the fresh prompt instead.
    expect(stubLog.find((l) => l.hasTools)?.firstUserText).toContain("FRESH-ONLY: the chapter's opening");
    expect(lost.events.find((e) => e.type === "run.ended")).toMatchObject({ error: null });
  }, 120_000);
});

describe("runs in a git workspace (R38)", () => {
  it("prepares the ticket's worktree, reports its branch, and the agent works inside it", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "app\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const workspaces = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const ticketId = randomUUID();
    const projectId = randomUUID();
    const h = harness(null, { workspaces, workspace: { projectId, ticketId, repoUrl: repo, baseRef: "main" } });
    await h.ended;
    expect(h.events.find((e) => e.type === "run.workspace")).toMatchObject({ ticketId, branch: `bossman/${ticketId}`, created: true });
    // The stub model's first step writes spike.txt in the agent's cwd: the worktree.
    expect(existsSync(path.join(workspaces.ticketDir(ticketId), "spike.txt"))).toBe(true);
    expect(existsSync(path.join(h.cwd, "spike.txt"))).toBe(false);
    // The turn's changes were checkpointed (R39), leaving the branch alone.
    expect(h.events).toContainEqual(expect.objectContaining({ type: "run.update", update: { kind: "checkpoint", turn: 1, files: 1 } }));
    expect((await workspaces.lastTurnDiff({ projectId, ticketId })).files.map((f) => f.path)).toEqual(["spike.txt"]);
  }, 90_000);

  it("keeps a ticket's own clone on the project's shared Claude memory (BOS-323)", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "app\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const workspaces = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")), { ...process.env, BOSSMAN_TICKET_COPIES: "clone" });
    const ticketId = randomUUID();
    const projectId = randomUUID();
    const h = harness(null, { workspaces, workspace: { projectId, ticketId, repoUrl: repo, baseRef: "main" } });
    await h.ended;
    const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
    const shared = path.join(h.home, ".claude", "projects", slug(workspaces.repoDir(projectId)), "memory");
    const mine = path.join(h.home, ".claude", "projects", slug(workspaces.ticketDir(ticketId)), "memory");
    // Claude Code keys a clone's memory by the clone, and is told that folder; it leads to the shared one.
    expect(stubLog.some((l) => l.raw?.includes(mine))).toBe(true);
    expect(readlinkSync(mine)).toBe(shared);
    expect(existsSync(shared)).toBe(true);
  }, 90_000);

  it("tries again when only the repo lock timed out, and ends the run on any other failure (BOS-331)", async () => {
    let calls = 0;
    const fake = {
      ensure: async () => {
        if (++calls <= 2) throw new RepoLockTimeout("p");
        throw new Error("boom");
      },
    } as unknown as Workspaces;
    const h = harness(null, { expectError: true, workspaces: fake, workspace: { projectId: randomUUID(), ticketId: randomUUID(), repoUrl: "x", baseRef: "main" } });
    await h.ended;
    expect(calls).toBe(3);
    expect((h.events.find((e) => e.type === "run.ended") as { error: string }).error).toBe("Couldn't prepare the git workspace: boom");
  }, 30_000);

  it("gives up on a lock that never frees once the retry limit is up", async () => {
    const fake = { ensure: async () => { throw new RepoLockTimeout("p"); } } as unknown as Workspaces;
    const h = harness(null, { expectError: true, workspaces: fake, lockRetryMs: 50, workspace: { projectId: randomUUID(), ticketId: randomUUID(), repoUrl: "x", baseRef: "main" } });
    await h.ended;
    expect((h.events.find((e) => e.type === "run.ended") as { error: string }).error).toMatch(/Timed out waiting for the lock/);
  }, 30_000);

  it("ends the run with a clear error when the repo can't be cloned", async () => {
    const workspaces = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const h = harness(null, { expectError: true, workspaces, workspace: { projectId: randomUUID(), ticketId: randomUUID(), repoUrl: "/nonexistent/repo", baseRef: "main" } });
    await h.ended;
    expect((h.events.find((e) => e.type === "run.ended") as { error: string }).error).toMatch(/^Couldn't prepare the git workspace/);
  }, 30_000);
});

describe("interrupted runs (R42)", () => {
  it("reports runs the previous process left unfinished, once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-state-"));
    const stateFile = path.join(dir, "active-runs.json");
    writeFileSync(stateFile, JSON.stringify({ runs: ["11111111-1111-4111-8111-111111111111"] }));
    const events: RunnerEvent[] = [];
    const m = new SessionManager({ mcpUrl: "http://127.0.0.1:1/mcp", emit: (e) => events.push(e), resolveEnv: async () => ({}), stateFile });
    expect(m.recoverInterrupted()).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(events).toEqual([{ type: "run.ended", runId: "11111111-1111-4111-8111-111111111111", stopReason: null, error: "The runner restarted while this run was going.", interrupted: true }]);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ runs: [] });
    expect(new SessionManager({ mcpUrl: "x", emit: (e) => events.push(e), resolveEnv: async () => ({}), stateFile }).recoverInterrupted()).toEqual([]);
  });
});

describe("a coding tool that won't start", () => {
  it("ends that one run with a clear reason, once, and the process survives", async () => {
    const events: RunnerEvent[] = [];
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-state-")), "active-runs.json");
    const adapterBins: Record<string, string> = { claude: path.join(tmpdir(), "bm-no-such-claude-acp") };
    const m = new SessionManager({
      mcpUrl: "http://127.0.0.1:1/mcp",
      stateFile,
      adapterBins,
      baseEnv: { PATH: process.env.PATH },
      resolveEnv: async () => ({}),
      emit: (e) => events.push(e),
    });
    const runId = randomUUID();
    m.handle({ type: "run.start", runId, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: mkdtempSync(path.join(tmpdir(), "bm-ws-")), prompt: "hi", mcpToken: "bm_sess_test" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.type === "run.ended")) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    await new Promise((r) => setTimeout(r, 300));
    const ended = events.filter((e) => e.type === "run.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ runId, stopReason: null });
    expect(String((ended[0] as { error: string }).error)).toMatch(/couldn't start claude.*not found/i);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ runs: [] });

    // The runner stayed up: the same manager starts a second run with the fake harness, and it gets as far as a session.
    adapterBins.claude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");
    const second = randomUUID();
    m.handle({ type: "run.start", runId: second, agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: mkdtempSync(path.join(tmpdir(), "bm-ws-")), prompt: "hi", mcpToken: "bm_sess_test" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some((e) => e.type === "run.started" && e.runId === second)) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    expect(events.some((e) => e.type === "run.started" && e.runId === second)).toBe(true);
  }, 30_000);
});
