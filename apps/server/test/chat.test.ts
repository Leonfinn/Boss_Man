import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ceoChapters, runners, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json();
  const obj = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Launch" })).json();
  const ms = (await req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta", targetDate: "2026-11-01" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const mcp = async (runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, req, company, ceo, worker, project, ms, sent, emit, settle, mcp };
}

describe("owner chat", () => {
  it("says why a message is held, such as the agent being paused", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/agents/${c.ceo.id}`, { paused: true });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Are you there?" });
    await c.scheduler.tick();
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("waiting: agent paused");
  });

  it("answers with a board-only run beside the CEO's own work, and the reply lands in the chat", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    // The CEO is busy with its own work.
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision" });
    await c.scheduler.tick();
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Add rate limiting to the login API before the beta." })).statusCode).toBe(201);
    // A second message before the run starts joins the same run.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "And make it wait on the auth refactor." });
    expect((await c.db.select().from(wakes).where(eq(wakes.reason, "owner_chat"))).length).toBe(1);
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("queued");

    c.sent.length = 0;
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    expect(start).toMatchObject({ agentId: c.ceo.id, boardToolsOnly: true, cwd: `/ws/chat/${c.company.id}/${c.ceo.id}` });
    expect(start.resumeSessionId).toBeUndefined();
    expect(start.prompt).toContain("Owner: Add rate limiting to the login API before the beta.\nOwner: And make it wait on the auth refactor.");
    // A substantial answer is filed in the wiki, so it outlives the chat.
    expect(start.prompt).toContain("also save it as a wiki page (Product/Analysis");
    expect((await c.db.select().from(runs).where(eq(runs.id, start.runId)))[0]).toMatchObject({ purpose: "chat", chapterId: null });
    // Only the CEO's own run made a chapter.
    expect((await c.db.select().from(ceoChapters)).length).toBe(1);
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("answering");

    // Anything but Boss Man's tools is refused, without asking anyone.
    c.sent.length = 0;
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p1", title: "Bash", kind: "execute", rawInput: { command: "ls" }, optionKinds: ["allow_once", "reject_once"] });
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p2", title: "mcp__bossman__create_ticket", kind: "other", rawInput: {}, optionKinds: ["allow_once", "reject_once"] });
    expect(c.sent).toEqual([
      expect.objectContaining({ type: "permission.decide", requestId: "p1", verdict: "deny" }),
      expect.objectContaining({ type: "permission.decide", requestId: "p2", verdict: "allow" }),
    ]);

    // Its MCP server has the board tools, plus looking up tickets, the wiki and skills (R77).
    const client = await c.mcp(start.runId);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["agent_instructions", "board", "create_feature", "create_ticket", "features", "link_tickets", "log_feedback", "nudge", "propose_hire", "propose_rule", "propose_team", "set_milestone", "skills", "tickets", "update_instructions", "whats_new", "wiki"]);
    // It asks a colleague itself, rather than asking the owner to pass a message on.
    expect(textOf(await client.callTool({ name: "nudge", arguments: { agent: "Engineer", why: "Please set the organising ticket to in_progress." } }))).toMatch(/^Nudged/);
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "nudge"))).toEqual([expect.objectContaining({ agentId: c.worker.id })]);
    expect(textOf(await client.callTool({ name: "log_feedback", arguments: { text: "Acme wants SSO.", from: "Acme" } }))).toMatch(/^Filed in the feedback inbox: #\/feedback\//);
    expect((await c.feedback.notes(c.company.id))[0]).toMatchObject({ source: "chat", customer: "Acme", text: "Acme wants SSO." });
    const board = JSON.parse(textOf(await client.callTool({ name: "board", arguments: {} })));
    expect(board.objectives[0].milestones[0]).toMatchObject({ id: c.ms.id, title: "Beta" });
    expect(textOf(await client.callTool({ name: "create_feature", arguments: { title: "SSO", description: "For Acme.", milestoneId: c.ms.id } }))).toMatch(/^Created feature [0-9a-f-]{36} "SSO"/);
    expect((await c.feedback.scored(c.company.id)).features[0]).toMatchObject({ title: "SSO", description: "For Acme.", milestoneId: c.ms.id });
    expect(textOf(await client.callTool({ name: "create_feature", arguments: { title: "sso" } }))).toMatch(/already exists/);
    const auth = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Refactor auth", risk: "medium" } }));
    const authId = /#\/tickets\/([0-9a-f-]{36})/.exec(auth)![1]!;
    const made = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Rate-limit login", risk: "high", milestoneId: c.ms.id, assignee: "engineer", waitsOn: [authId] } }));
    expect(made).toMatch(/^Created #\/tickets\/[0-9a-f-]{36} "Rate-limit login" in App \(plan first\)\.$/);
    const rateId = /#\/tickets\/([0-9a-f-]{36})/.exec(made)![1]!;
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, rateId));
    expect(t).toMatchObject({ milestoneId: c.ms.id, assigneeAgentId: c.worker.id, risk: "high", planFirst: true, createdByAgentId: null });
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, rateId))).toEqual([expect.objectContaining({ blockerTicketId: authId })]);
    expect((await client.callTool({ name: "create_ticket", arguments: { title: "x", assignee: "Nobody" } })).isError).toBe(true);
    expect((await client.callTool({ name: "link_tickets", arguments: { ticketId: authId, waitsOnTicketId: rateId } })).isError).toBe(true);
    await client.close();

    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: `Done: #/tickets/${rateId} "Rate-limit login", waiting on #/tickets/${authId}.` } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const chat = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json();
    expect(chat.state).toBe("idle");
    expect(chat.items.map((m: { role: string }) => m.role)).toEqual(["owner", "owner", "assistant"]);
    expect(chat.items[2].text).toContain(`#/tickets/${rateId}`);
  });

  it("sends the owner's draft to the CEO with how to question them, before anything is created", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const r = await c.req("POST", `/api/companies/${c.company.id}/chat/grill`, { kind: "task", title: "Add SSO", description: "Acme needs it", projectId: c.project.id });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ agentId: c.ceo.id });
    const [m] = (await c.req("GET", `/api/companies/${c.company.id}/chat?agentId=${c.ceo.id}`)).json().items;
    expect(m.role).toBe("owner");
    expect(m.text).toContain("I want to add a task");
    expect(m.text).toContain("Title: Add SSO\nProject: App\nDescription: Acme needs it");
    expect(m.text).toContain("Ask one question at a time");
    expect(m.text).toContain("recommended answer");
    expect(m.text).toContain("usually 3 to 7 questions");
    expect(m.text).toContain("create_ticket");
    expect(m.text).toContain("acceptanceCriteria");
    expect((await c.db.select().from(wakes).where(eq(wakes.reason, "owner_chat"))).length).toBe(1);
    expect((await c.db.select().from(tickets)).length).toBe(0);

    const f = await c.req("POST", `/api/companies/${c.company.id}/chat/grill`, { kind: "feature", title: "Export" });
    expect(f.statusCode).toBe(201);
    const last = (await c.req("GET", `/api/companies/${c.company.id}/chat?agentId=${c.ceo.id}`)).json().items.at(-1);
    expect(last.text).toContain("I want to add a feature");
    expect(last.text).toContain("Description: (none yet)");
    expect(last.text).toContain("create_feature");
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat/grill`, { kind: "task", title: "x", projectId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat/grill`, { kind: "bug", title: "x" })).statusCode).toBe(400);
  });

  it("says when a run finishes without a reply, or keeps working after its last one", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Tidy up the team's instructions." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    // A progress message, then more work, then the run ends without another reply.
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "Four of nine done so far." } });
    await c.settle();
    const client = await c.mcp(start.runId);
    await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: "Work only on the API.", reason: "Tidy." } });
    await client.callTool({ name: "create_ticket", arguments: { title: "Check the API docs" } });
    await client.close();
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const items = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
    expect(items.map((m) => m.role)).toEqual(["owner", "assistant", "system"]);
    // Tickets made in the chat are the owner's requests, so they aren't in the agent's activity; decisions are.
    expect(items[2]!.text).toBe("CEO finished after its last message. Since that message: 1 decision sent to Decisions.");

    // No reply at all, and nothing done: still said, so the owner isn't left waiting.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Anything else?" });
    c.sent.length = 0;
    await c.scheduler.tick();
    const second = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.ended", runId: second.runId, stopReason: "end_turn", error: null });
    await c.settle();
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1)).toMatchObject({ role: "system", text: "CEO finished without a reply." });
  });

  it("says when a run fails, and asks again after a runner restart", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Plan the beta." });
    await c.scheduler.tick();
    const first = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.ended", runId: first.runId, stopReason: null, error: "rate limited" });
    await c.settle();
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1)).toMatchObject({ role: "system", text: "The reply couldn't be finished: rate limited" });

    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Try again." });
    c.sent.length = 0;
    await c.scheduler.tick();
    const second = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.ended", runId: second.runId, stopReason: null, error: null, interrupted: true });
    await c.settle();
    await c.settle();
    // An interrupted run isn't finished, so no note.
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1)).toMatchObject({ role: "owner", text: "Try again." });
    // Asked again as a chat run: board tools only, not resumed as CEO work.
    const again = c.sent.filter((x): x is Start => x.type === "run.start").at(-1)!;
    expect(again.runId).not.toBe(second.runId);
    expect(again).toMatchObject({ boardToolsOnly: true, cwd: `/ws/chat/${c.company.id}/${c.ceo.id}` });
    expect(again.resumeSessionId).toBeUndefined();
  });

  it("lets the owner message any agent directly, each in its own conversation, one run per agent", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const base = `/api/companies/${c.company.id}/chat`;
    await c.req("POST", base, { text: "How is the beta going?" });
    expect((await c.req("POST", base, { text: "What are you working on?", agentId: c.worker.id })).statusCode).toBe(201);
    // CEO first, then the rest, each with their last message.
    const threads = (await c.req("GET", `${base}/threads`)).json();
    expect(threads.map((t: { name: string; state: string; last: { text: string } | null }) => [t.name, t.state, t.last?.text])).toEqual([
      [threads[0].name, "queued", "How is the beta going?"],
      ["Engineer", "queued", "What are you working on?"],
      ["Wiki Maintainer", "idle", undefined],
    ]);
    expect(threads[0].role).toBe("ceo");
    expect((await c.req("GET", `${base}?agentId=${c.worker.id}`)).json().items.map((m: { text: string }) => m.text)).toEqual(["What are you working on?"]);
    expect((await c.req("GET", base)).json().items.map((m: { text: string }) => m.text)).toEqual(["How is the beta going?"]);

    // Both answer at once: one chat run each, in their own folders.
    await c.scheduler.tick();
    const starts = c.sent.filter((x): x is Start => x.type === "run.start");
    expect(starts.map((x) => x.agentId).sort()).toEqual([c.ceo.id, c.worker.id].sort());
    const workerStart = starts.find((x) => x.agentId === c.worker.id)!;
    expect(workerStart).toMatchObject({ boardToolsOnly: true, cwd: `/ws/chat/${c.company.id}/${c.worker.id}` });
    expect(workerStart.prompt).toContain("You are Engineer, the worker of App Co. The owner is messaging you directly");
    expect(workerStart.prompt).toContain("Owner: What are you working on?");
    expect(workerStart.prompt).not.toContain("How is the beta going?");

    await c.emit({ type: "run.update", runId: workerStart.runId, update: { kind: "agent_message", text: "The login page." } });
    await c.settle();
    expect((await c.req("GET", `${base}?agentId=${c.worker.id}`)).json()).toMatchObject({ state: "answering", items: [{ role: "owner" }, { role: "assistant", text: "The login page.", agentId: c.worker.id }] });
    expect((await c.req("POST", base, { text: "hi", agentId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("needs a CEO and a message", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "  " })).statusCode).toBe(400);
  });
});
