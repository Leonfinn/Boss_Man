import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, decisions, notifications, projects, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import type { Ladder } from "../src/services/alert-ladder.js";

// BOS-111: a request whose only deletes are of temp files goes to the CEO first, not the owner.
// BOS-120: so does one whose deletes are plain relative paths in the agent's own checkout.

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];
const CLEANUP = "rm -rf /tmp/rv86 /tmp/rv86-install.log && git worktree add /tmp/rv86 origin/main && cd /tmp/rv86 && pnpm install > /tmp/rv86-install.log 2>&1";

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  let seq = 0;
  /** An agent's run asks to run a shell command; returns the decision it made, if any. */
  // With a ticket, the runner reports it started the run in that ticket's worktree, unless workspace says otherwise.
  const ask = async (command: string, agentId = dev.id, opts: { ticketId?: string; rawInput?: Record<string, unknown>; workspace?: false | { ticketId: string }; tool?: { title: string; kind: string; rawInput: unknown } } = {}) => {
    const runId = randomUUID();
    const requestId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.started", runId, agentId, acpSessionId: "s", model: null } });
    if (opts.ticketId) await db.update(runs).set({ ticketId: opts.ticketId }).where(eq(runs.id, runId));
    const ws = opts.workspace === false ? null : (opts.workspace ?? (opts.ticketId ? { ticketId: opts.ticketId } : null));
    if (ws) await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.workspace", runId, ticketId: ws.ticketId, branch: `bossman/${ws.ticketId}`, baseCommit: "abc123", created: false, restoredPatch: false } });
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.permission_request", runId, requestId, ...(opts.tool ?? { title: "Create branch worktree and install deps", kind: "execute", rawInput: { command, ...opts.rawInput } }), optionKinds: ["allow_once", "reject_once"] } });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d, runId, requestId };
  };
  const [repo] = await db.insert(projects).values({ companyId, name: "App", repoUrl: "https://example.com/app.git" }).returning();
  const [plain] = await db.insert(projects).values({ companyId, name: "Notes" }).returning();
  const [ticket] = await db.insert(tickets).values({ companyId, projectId: repo!.id, title: "Probe extra spellings", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  const [noRepo] = await db.insert(tickets).values({ companyId, projectId: plain!.id, title: "Write notes", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  await db.delete(wakes);
  return { ...built, db, close, base, req, companyId, dev, ceo: ceo!, sent, ask, ticket: ticket!, noRepo: noRepo!, advance: (m: number) => (clock = new Date(clock.getTime() + m * 60_000)) };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function client(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => !!(r as { isError?: boolean }).isError;
const reload = async (id: string) => (await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const ownerNotified = async (id: string) => {
  await ctx.notes.syncDecisions();
  return ctx.db.select().from(notifications).where(eq(notifications.decisionId, id));
};

describe("temp-file cleanup goes to the CEO first (BOS-111)", () => {
  it("waits with the CEO, off the owner's queue, recommended Allow, and the CEO is woken", async () => {
    const { d } = await ctx.ask(CLEANUP);
    expect(d).toMatchObject({ tier: "ceo", status: "open", recommendedOption: "Allow once" });
    const c = d!.context as { tempCleanup?: boolean; ladder: Ladder; explain: { summary: string } };
    expect(c.tempCleanup).toBe(true);
    expect(c.ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    expect(c.explain.summary).not.toMatch(/doesn't recognise: worktree/);
    expect((await ctx.decisions.queue()).map((q) => q.id)).not.toContain(d!.id);
    expect((await ctx.decisions.withTeam()).map((q) => q.id)).toContain(d!.id);
    expect(await ownerNotified(d!.id)).toEqual([]);
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(w).toMatchObject({ reason: "ceo reply", priority: 4 });
    expect(w!.note).toContain(CLEANUP);
    expect(w!.note).toMatch(/git worktree add writes into the project.s repository/);
    // A worktree writes the repository's .git, so the card never promises the repository is untouched.
    expect((c.explain as { scratch?: unknown }).scratch).toBeUndefined();
    expect(ctx.sent).toEqual([]);
  });

  it("the CEO settles it with a reason, the agent gets the verdict, and the owner can see who and why", async () => {
    const { d, runId, requestId } = await ctx.ask(CLEANUP);
    const ceo = await client(ctx.ceo.id);
    const listed = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(listed).toContain(`${d!.id}: TEMP-FILE CLEANUP: `);
    const bare = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Allow once" } });
    expect(isError(bare)).toBe(true);
    expect(textOf(bare)).toMatch(/note saying why/);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Allow once", note: "It only removes its own scratch checkout in /tmp." } });
    expect(textOf(ok)).toBe("Answered: Allow once.");
    expect(ctx.sent).toEqual([{ type: "permission.decide", runId, requestId, verdict: "allow" }]);
    const after = await reload(d!.id);
    expect((after.context as { settled: { name: string; note: string } }).settled).toMatchObject({ agentId: ctx.ceo.id, note: "It only removes its own scratch checkout in /tmp." });
    const log = await ctx.db.select().from(activity).where(eq(activity.kind, "decision_answered"));
    expect(log.at(-1)!.summary).toMatch(/settled ".*": Allow once\. Reason: It only removes/);
    expect(log.at(-1)!.summary).not.toMatch(/^Owner answered/);
    const settled = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; settled?: { answer: string; note: string; command: string; tempCleanup: boolean } }>;
    expect(settled.find((s) => s.id === d!.id)?.settled).toEqual({ by: expect.any(String), answer: "Allow once", note: "It only removes its own scratch checkout in /tmp.", command: CLEANUP, tempCleanup: true });
  });

  it("moves to the owner after 5 minutes, or when the CEO escalates it", async () => {
    const { d } = await ctx.ask(CLEANUP);
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.ceo.id, startedAt: ctx.advance(0) });
    ctx.advance(4);
    await ctx.alerts.sweep();
    expect((await reload(d!.id)).tier).toBe("ceo");
    ctx.advance(2);
    await ctx.alerts.sweep();
    const moved = await reload(d!.id);
    expect(moved).toMatchObject({ tier: "owner", status: "open" });
    expect((await ctx.decisions.queue()).map((q) => q.id)).toContain(d!.id);
    expect((await ownerNotified(d!.id)).length).toBe(1);

    const { d: d2 } = await ctx.ask("rm -rf /tmp/other-agents-cache && mkdir /tmp/other-agents-cache");
    const ceo = await client(ctx.ceo.id);
    // A permission card now needs the CEO's advice before it reaches the owner (BOS-233): what it's for and
    // what a Deny stops.
    const noAdvice = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d2!.id, triedFirst: "The folder isn't this agent's own scratch checkout, so I can't vouch for deleting it." } });
    expect(isError(noAdvice)).toBe(true);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d2!.id, triedFirst: "The folder isn't this agent's own scratch checkout, so I can't vouch for deleting it.", adviceNeeded: "It is needed to clear the old cache before the next build.", adviceDeny: "The cache stays, so the next build may fail or run out of space." } });
    expect(isError(r)).toBe(false);
    expect(await reload(d2!.id)).toMatchObject({ tier: "owner", status: "open" });
    expect((await reload(d2!.id)).context).toMatchObject({ triedFirst: "The folder isn't this agent's own scratch checkout, so I can't vouch for deleting it." });
  });

  it("goes to the owner as before when it's the CEO's own request, the CEO is paused, or it deletes outside /tmp", async () => {
    expect((await ctx.ask(CLEANUP, ctx.ceo.id)).d).toMatchObject({ tier: "owner" });
    expect((await ctx.ask("rm -rf /tmp/../home")).d).toMatchObject({ tier: "owner", recommendedOption: "Deny" });
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    const { d } = await ctx.ask(CLEANUP);
    expect(d).toMatchObject({ tier: "owner", recommendedOption: "Allow once" });
    expect((d!.context as { ladder?: unknown }).ladder).toBeUndefined();
  });
});

describe("unrecognised tools go to the CEO first (BOS-295)", () => {
  const tool = (title: string) => ({ tool: { title, kind: "other", rawInput: {} } });

  it("waits with the CEO, with a warning on a lookalike name, and the CEO is woken", async () => {
    const plain = (await ctx.ask("", ctx.dev.id, tool("mcp__frobnicator__run"))).d;
    expect(plain).toMatchObject({ tier: "ceo", status: "open" });
    expect(plain!.question).not.toMatch(/Warning/);
    expect((await ctx.decisions.queue()).map((q) => q.id)).not.toContain(plain!.id);
    const look = (await ctx.ask("", ctx.dev.id, tool("mcp__bossrnan__wiki"))).d;
    expect(look).toMatchObject({ tier: "ceo" });
    expect(look!.question).toMatch(/doesn't recognise.*Warning: this name looks like one of Boss Man's own tools/);
    const wake = (await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id))).find((w) => w.note?.includes("bossrnan"));
    expect(wake!.note).toMatch(/doesn't recognise this tool/);
  });

  it("goes to the owner when the CEO itself asks, or the CEO is paused", async () => {
    expect((await ctx.ask("", ctx.ceo.id, tool("mcp__frobnicator__run"))).d).toMatchObject({ tier: "owner" });
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    expect((await ctx.ask("", ctx.dev.id, tool("mcp__frobnicator__run"))).d).toMatchObject({ tier: "owner" });
  });
});

describe("deletes in the agent's own working copy go to the CEO first (BOS-120)", () => {
  const PROBE = "rm -f test/zz-probe.test.ts && rm -rf dist 2>/dev/null; git status";

  it("waits with the CEO, and every card says which checkout and which files", async () => {
    const { d } = await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id });
    // A probe file isn't build output, so Boss Man can't vouch for it: the CEO decides from the card.
    expect(d).toMatchObject({ tier: "ceo", status: "open", recommendedOption: "Deny" });
    const c = d!.context as { tempCleanup?: boolean; workingCopy: { ticketId: string; branch: string; files: string[] }; ladder: Ladder };
    expect(c.tempCleanup).toBeUndefined();
    expect(c.workingCopy).toMatchObject({ ticketId: ctx.ticket.id, branch: `bossman/${ctx.ticket.id}`, files: ["test/zz-probe.test.ts", "dist"] });
    expect(c.ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    expect(d!.question).toContain(`working copy for `);
    expect(d!.question).toContain(`(branch bossman/${ctx.ticket.id}), and Boss Man can't see where it has moved to since: test/zz-probe.test.ts, dist.`);
    // BOS-159: the card says where the run STARTED, never that the paths are inside the checkout now.
    expect(d!.question).not.toContain(`(branch bossman/${ctx.ticket.id}): test/zz-probe.test.ts, dist.`);
    expect((await ctx.decisions.queue()).map((q) => q.id)).not.toContain(d!.id);
    expect(await ownerNotified(d!.id)).toEqual([]);
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(w).toMatchObject({ reason: "ceo reply", priority: 4, ticketId: ctx.ticket.id });
    expect(w!.note).toContain("symlink");
    // BOS-159: the shell keeps its folder between commands, so the note can't vouch for where it sits.
    expect(w!.note).toContain("can't vouch for where it sits now");
    expect(w!.note).not.toContain("It has no cd.");
    expect(w!.note).not.toContain("pnpm or npm install");

    const ceo = await client(ctx.ceo.id);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }))).toContain(`${d!.id}: WORKING-COPY CLEANUP: `);
    await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Allow once", note: "Its own probe file and build output, for its ticket." } });
    const settled = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; settled?: { workingCopy?: boolean; tempCleanup: boolean } }>;
    expect(settled.find((x) => x.id === d!.id)?.settled).toMatchObject({ workingCopy: true, tempCleanup: false });
  });

  it("moves to the owner after 5 minutes, still naming the checkout", async () => {
    const { d } = await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id });
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.ceo.id, startedAt: ctx.advance(0) });
    ctx.advance(6);
    await ctx.alerts.sweep();
    const moved = await reload(d!.id);
    expect(moved).toMatchObject({ tier: "owner", status: "open", recommendedOption: "Deny" });
    expect(moved.question).toContain("test/zz-probe.test.ts");
    expect((await ctx.decisions.queue()).map((q) => q.id)).toContain(d!.id);
  });

  it("recommends Allow only for build output, never for source (adversarial review)", async () => {
    expect((await ctx.ask("rm -rf dist node_modules", ctx.dev.id, { ticketId: ctx.ticket.id })).d).toMatchObject({ tier: "ceo", recommendedOption: "Allow once" });
    // BOS-150: a trailing slash or a deeper path follows a symlinked dist, so it is never recommended Allow
    for (const [c, tier] of [["rm -rf dist/", "owner"], ["rm -rf apps/web/dist/", "owner"], ["rm -rf dist apps/web/dist", "ceo"]] as [string, string][]) {
      expect((await ctx.ask(c, ctx.dev.id, { ticketId: ctx.ticket.id })).d, c).toMatchObject({ tier, recommendedOption: "Deny" });
    }
    for (const c of ["rm -rf src", "rm -rf package.json", "rm -rf .github/workflows", "rm -f .env", "rm -rf dist src"]) {
      expect((await ctx.ask(c, ctx.dev.id, { ticketId: ctx.ticket.id })).d, c).toMatchObject({ tier: "ceo", recommendedOption: "Deny" });
    }
  });

  it("says when the file list is cut short", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `out/file-${i}.txt`);
    const { d } = await ctx.ask(`rm -f ${many.join(" ")}`, ctx.dev.id, { ticketId: ctx.ticket.id });
    expect(d).toMatchObject({ tier: "ceo" });
    expect(d!.question).toMatch(/out\/file-\d+\.txt, …and \d+ more\.$/);
    expect((d!.context as { workingCopy: { files: string[] } }).workingCopy.files).toHaveLength(300);
  });

  it("goes to the owner as before when Boss Man can't tell the run has a checkout", async () => {
    // No ticket, a ticket in a project with no repo, no worktree reported for the run (a review copy)
    // or one for another ticket, or tool input with any key Claude Code's Bash tool doesn't send.
    for (const d of [
      (await ctx.ask(PROBE)).d,
      (await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.noRepo.id })).d,
      (await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id, workspace: false })).d,
      (await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id, workspace: { ticketId: ctx.noRepo.id } })).d,
      ...(await Promise.all([{ cwd: "/home/node" }, { workdir: "/home/node" }, { cwdPath: "/etc" }, { folder: "/etc" }, { path: "/etc" }, { working_dir: "/etc" }, { tool_input: { workdir: "/etc" } }].map(async (rawInput) => (await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id, rawInput })).d))),
    ]) {
      expect(d).toMatchObject({ tier: "owner", recommendedOption: "Deny" });
      expect((d!.context as { workingCopy?: unknown; ladder?: unknown }).workingCopy).toBeUndefined();
      expect((d!.context as { ladder?: unknown }).ladder).toBeUndefined();
    }
    // Build output alone keeps BOS-111's Allow recommendation, but still reaches the owner without a checkout.
    expect((await ctx.ask("rm -rf dist")).d).toMatchObject({ tier: "owner", recommendedOption: "Allow once" });
    // The CEO's own request, and a paused CEO.
    expect((await ctx.ask(PROBE, ctx.ceo.id, { ticketId: ctx.ticket.id })).d).toMatchObject({ tier: "owner" });
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    const { d: paused } = await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id });
    expect(paused).toMatchObject({ tier: "owner" });
    // It still says it's a working-copy delete, on the card and in its record.
    expect(paused!.question).toContain("test/zz-probe.test.ts");
    expect((paused!.context as { workingCopy?: { files: string[] }; ladder?: unknown })).toMatchObject({ workingCopy: { files: ["test/zz-probe.test.ts", "dist"] } });
    expect((paused!.context as { ladder?: unknown }).ladder).toBeUndefined();
  });

  it("still goes to the CEO with Claude Code's other Bash keys", async () => {
    const rawInput = { description: "Remove probe", timeout: 60000, run_in_background: false, dangerouslyDisableSandbox: false };
    expect((await ctx.ask(PROBE, ctx.dev.id, { ticketId: ctx.ticket.id, rawInput })).d).toMatchObject({ tier: "ceo" });
  });

  it("keeps path tricks with the owner even on a run with a checkout", async () => {
    for (const c of ["rm -rf ../other", "rm -rf .git", "cd src && rm -rf x", "rm -rf /home/node/x", "rm -rf $HOME/x", "rm -rf dist; cp -r src /tmp/x",
      // Security Reviewer, round 2: writes through a link at /tmp/lnk beside a working-copy delete. Only a /tmp delete clears a /tmp write.
      "rm -rf dist && git worktree add -b x /tmp/lnk", "mkdir -p /tmp/lnk/sub; rm -rf dist", "echo x >/tmp/lnk; rm -rf dist", "rm -rf dist && mkdir -p /tmp/lnk", "rm -rf dist && echo x >/tmp/lnk"]) {
      expect((await ctx.ask(c, ctx.dev.id, { ticketId: ctx.ticket.id })).d, c).toMatchObject({ tier: "owner" });
    }
  });
});

describe("a plain /tmp cleanup is allowed with no card (BOS-1453)", () => {
  it("allows it at once: no card, no wake for the CEO, no notice for the owner, and the owner's feed names the agent and the command", async () => {
    const { d, runId, requestId } = await ctx.ask("rm -rf /tmp/rv86 /tmp/rv86-install.log");
    expect(d).toBeUndefined();
    expect(ctx.sent).toEqual([{ type: "permission.decide", runId, requestId, verdict: "allow" }]);
    expect(await ctx.db.select().from(wakes)).toEqual([]);
    expect((await ctx.decisions.queue()).length).toBe(0);
    const feed = await ctx.db.select().from(activity).where(eq(activity.kind, "temp_cleanup_allowed"));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ companyId: ctx.companyId, agentId: ctx.dev.id, detail: { command: "rm -rf /tmp/rv86 /tmp/rv86-install.log" } });
    expect(feed[0]!.summary).toContain("Senior Developer");
    expect(feed[0]!.summary).toContain("rm -rf /tmp/rv86 /tmp/rv86-install.log");
  });

  it("allows the CEO's own plain cleanup too: there is no card to send to the owner", async () => {
    const { d } = await ctx.ask("rm -rf /tmp/rv86", ctx.ceo.id);
    expect(d).toBeUndefined();
    expect(ctx.sent).toHaveLength(1);
  });

  it("goes to the CEO first, as before, when the company turned it off", async () => {
    await ctx.db.update(companies).set({ autoTempCleanup: false }).where(eq(companies.id, ctx.companyId));
    const { d } = await ctx.ask("rm -rf /tmp/rv86");
    expect(d).toMatchObject({ tier: "ceo", status: "open" });
    expect(ctx.sent).toEqual([]);
    expect(await ctx.db.select().from(activity).where(eq(activity.kind, "temp_cleanup_allowed"))).toEqual([]);
  });

  it("is on for a new company, and the owner can switch it off and on from Settings", async () => {
    const get = async () => ((await ctx.req("GET", "/api/companies")).json() as Array<{ id: string; autoTempCleanup: boolean }>).find((c) => c.id === ctx.companyId)!.autoTempCleanup;
    expect(await get()).toBe(true);
    expect((await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { autoTempCleanup: false })).statusCode).toBe(200);
    expect(await get()).toBe(false);
    expect((await ctx.req("PATCH", `/api/companies/${ctx.companyId}`, { autoTempCleanup: true })).statusCode).toBe(200);
    expect(await get()).toBe(true);
  });

  it("still sends every refused shape to the CEO or owner, never allowing it", async () => {
    for (const c of ["rm -rf /tmp/a/b", "rm -rf /tmp/a/", "rm -rf /tmp/*", "rm -rf $TMPDIR/a", "rm -rf /tmp/a /home/x", "rm -rf /tmp/../home", "rm -rf .git", "rm -rf /tmp/a && git worktree add /tmp/a origin/main"]) {
      const { d } = await ctx.ask(c);
      expect(d, c).toBeDefined();
      expect(d!.status, c).toBe("open");
    }
    expect(ctx.sent).toEqual([]);
  });
});
