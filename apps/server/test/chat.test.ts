import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BUILT_IN_RULES, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, ceoChapters, checkJobs, checkWorkers, decisions, runners, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { READ_ONLY_TOOLS, TRACED_TOOLS } from "../src/mcp-trace.js";

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
  const mcp = async (runId: string, agentId: string = ceo.id) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
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

  it("DR-069 D1: the CEO's chat prompt carries the Owner's setup section with each worker and the owner's last word on it; a worker's chat does not", async () => {
    const c = await setup();
    await c.db.insert(checkWorkers).values({ name: "Truenas", tokenHash: randomUUID(), companyIds: [c.company.id], enabled: false });
    await c.db.insert(decisions).values({
      companyId: c.company.id,
      kind: "question",
      question: "Please turn the check worker Truenas off for now so the merge line stops using it",
      options: ["Done"],
      recommendedOption: "Done",
      raisedByAgentId: c.ceo.id,
      status: "answered",
      answer: "Done: worker is off",
      answeredAt: new Date(Date.now() - 86_400_000),
      context: { type: "question", steps: ["Switch Truenas off."], ownerMustDo: true },
    });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Let Truenas take merges?" });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Status?", agentId: c.worker.id });
    await c.scheduler.tick();
    const starts = c.sent.filter((x): x is Start => x.type === "run.start");
    const ceoStart = starts.find((x) => x.agentId === c.ceo.id)!;
    expect(ceoStart.prompt).toContain("## Owner's setup");
    expect(ceoStart.prompt).toMatch(/- Worker Truenas: .*switched off.*owner's last word: card .*Done: worker is off/);
    const workerStart = starts.find((x) => x.agentId === c.worker.id);
    if (workerStart) expect(workerStart.prompt).not.toContain("## Owner's setup");
  });

  it("DR-069 D2: the chat prompt names what the record and the owner say about each thing the owner's message names, newest first; a message naming nothing adds no section", async () => {
    const c = await setup();
    await c.db.insert(checkWorkers).values({ name: "Truenas", tokenHash: randomUUID(), companyIds: [c.company.id], enabled: false });
    const card = (question: string, answer: string, daysAgo: number) =>
      c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question, options: ["Done"], recommendedOption: "Done", raisedByAgentId: c.ceo.id, status: "answered", answer, answeredAt: new Date(Date.now() - daysAgo * 86_400_000), context: { type: "question", steps: ["Do it."], ownerMustDo: true } }).returning({ id: decisions.id });
    await card("Please turn the check worker Truenas off for now", "Done: worker is off", 5);
    await card("Should Truenas take merge checks again?", "Done: Truenas stays off", 1);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Let Truenas take merges?" });
    await c.scheduler.tick();
    const section = c.sent.filter((x): x is Start => x.type === "run.start").find((x) => x.agentId === c.ceo.id)!.prompt;
    expect(section).toContain("## What the record and the owner already say about the things named here");
    const line = section.slice(section.indexOf("## What the record and the owner already say")).split("\n").find((l) => l.startsWith("- Worker Truenas:"))!;
    expect(line).toMatch(/record: .*switched off/);
    // newest answer first, at most 2 per thing, and a line is at most 300 characters
    expect(line, line).toContain("worker is off");
    expect(line.indexOf("Truenas stays off")).toBeGreaterThan(-1);
    expect(line.indexOf("Truenas stays off")).toBeLessThan(line.indexOf("worker is off"));
    expect(line.length).toBeLessThanOrEqual(300);
    // a message that names nothing known gets no section
    const { namedThingsSection } = await import("../src/services/named-things.js");
    expect(await namedThingsSection(c.db, c.company.id, ["How is the board looking today?"])).toEqual([]);
  });

  it("DR-069 D2: each kind is recognised from the record; unknown things and other companies' names say nothing; the section holds at most 8 lines", async () => {
    const c = await setup();
    const { namedThingsSection, namedThingLines, NAMED_MAX_LINES } = await import("../src/services/named-things.js");
    const [d] = await c.db
      .insert(decisions)
      // fixed id: the detector only reads an 8-hex token with both a letter and a digit as a card short id, so a random uuid failed ~2.4% of runs
      .values({ id: "3f9a1c27-5b4e-4d8a-9c3e-7a1b2c3d4e5f", companyId: c.company.id, kind: "question", question: "Keep the Penpot add-on?", options: ["Yes"], recommendedOption: "Yes", raisedByAgentId: c.ceo.id, status: "answered", answer: "Yes keep Penpot", answeredAt: new Date(Date.now() - 86_400_000), context: { type: "question" } })
      .returning({ id: decisions.id });
    const short = d!.id.slice(0, 8);
    const addons = async () => ({ tailscale: { state: "unknown", since: null, source: "x" }, ntfy: { state: "unknown", since: null, source: "x" }, penpot: { state: "running", since: "2026-11-10T09:00:00Z", source: "x" } }) as never;
    // a card by its 8-hex short id, an add-on by name (with the owner's newest answer naming it), a git token by phrase
    const lines = await namedThingsSection(c.db, c.company.id, [`What happened on card ${short}? And is Penpot ok? The git token too.`], { addons, gitTokenProbe: async () => "yes" });
    const text = lines.join("\n");
    expect(text).toMatch(new RegExp(`- Card ${short}: record: answered .*Yes keep Penpot`));
    expect(text).toMatch(/- Add-on Penpot: record: running since 2026-11-10 · owner .*card .*Yes keep Penpot/);
    expect(text).toContain("- Git token: record: can read GitHub Actions runs");
    // by design an all-digit or all-letter 8-hex token is not a card (it would match plain numbers and words)
    const [n] = await c.db.insert(decisions).values({ id: "12345678-5b4e-4d8a-9c3e-7a1b2c3d4e5f", companyId: c.company.id, kind: "question", question: "Digits only?", options: ["Yes"], recommendedOption: "Yes", raisedByAgentId: c.ceo.id, status: "answered", answer: "Yes", answeredAt: new Date(Date.now() - 86_400_000), context: { type: "question" } }).returning({ id: decisions.id });
    expect(await namedThingsSection(c.db, c.company.id, [`What happened on card ${n!.id.slice(0, 8)}?`])).toEqual([]);
    // a worker that isn't this company's, and a ticket number that doesn't exist, say nothing
    expect(await namedThingsSection(c.db, c.company.id, ["What about APP-99999 and Mystery-box?"])).toEqual([]);
    // the cap
    const names = Array.from({ length: 11 }, (_, i) => `Box${i}`);
    for (const name of names) await c.db.insert(checkWorkers).values({ name, tokenHash: randomUUID(), companyIds: [c.company.id] });
    const capped = (await namedThingsSection(c.db, c.company.id, [names.join(" and ")])).filter((l) => l.startsWith("- "));
    expect(capped).toHaveLength(NAMED_MAX_LINES);
    expect(NAMED_MAX_LINES).toBe(8);
    expect(await namedThingLines(c.db, c.company.id, [{ kind: "Worker", name: "Unknown", needles: ["Unknown"], record: null }])).toEqual([]);
  });

  it("BOS-2087: a CEO reply naming a worker the owner answered a card about gets no 'You said' footer; old saved footers are hidden", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.db.insert(checkWorkers).values({ name: "Truenas", tokenHash: randomUUID(), companyIds: [c.company.id], enabled: false });
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Keep Truenas off?", options: ["Done"], recommendedOption: "Done", raisedByAgentId: c.ceo.id, status: "answered", answer: "Done: Truenas stays off", answeredAt: new Date(Date.now() - 86_400_000), context: { type: "question" } });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What should we do about merges?" });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "I'd move merges to Truenas." } });
    await c.settle();
    const { ownerChatMessages } = await import("../src/db/schema.js");
    await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: 'Old reply.\n\nYou said "Done: Truenas stays off" on card abcd1234, 2026-11-19, about Truenas, which your messages here didn\'t name.\nYou said "x" in chat, 2026-11-18, about Foo, which your messages here didn\'t name.' });
    const items = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
    const replies = items.filter((m) => m.role === "assistant").map((m) => m.text);
    expect(replies.some((t) => t.startsWith("I'd move merges to Truenas."))).toBe(true);
    expect(replies).toContain("Old reply.");
    expect(items.some((m) => m.text.includes("You said"))).toBe(false);
  });

  it("BOS-1870: a Settings path through Limits shows the saved and in-force values; other paths and a failing source say nothing", async () => {
    const c = await setup();
    const { namedThingsSection } = await import("../src/services/named-things.js");
    const held = { saved: 6, inForce: 3, because: "a server update is waiting for a quiet machine", since: "2026-11-19T10:00:00.000Z", until: "2026-11-19T13:00:00.000Z" };
    const free = { saved: 2, inForce: 2, because: null, since: null, until: null };
    const text = "Why is Settings → Server and runner → Limits and checks lower than I set?";
    const out = (await namedThingsSection(c.db, c.company.id, [text], { limits: async () => ({ allCompanies: held, background: free }) })).join("\n");
    expect(out).toContain("record: agents at once, all companies: saved 6, in force 3 (a server update is waiting for a quiet machine, until 2026-11-19 at the latest); background: 2 (saved and in force)");
    // a path that is not about limits, and a source that fails, add no record
    expect(await namedThingsSection(c.db, c.company.id, ["See Settings → Add-ons."], { limits: async () => ({ allCompanies: held, background: free }) })).toEqual([]);
    expect(await namedThingsSection(c.db, c.company.id, [text], { limits: async () => { throw new Error("down"); } })).toEqual([]);
  });

  it("stays open while an update waits and an agent is still working (BOS-349)", async () => {
    const c = await setup();
    // The CEO is busy with its own work, then a runner update starts to drain.
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision" });
    await c.scheduler.tick();
    expect(await c.db.select().from(runs).where(eq(runs.companyId, c.company.id))).toHaveLength(1);
    await c.maintenance.start({ minutes: 30 });
    // The owner's chat is let through: it starts and answers as normal, even mid-drain.
    c.sent.length = 0;
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What's still running?" })).statusCode).toBe(201);
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start");
    expect(start).toMatchObject({ agentId: c.ceo.id, boardToolsOnly: true });
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("answering");
  });

  it("still holds the chat when nothing is working and an update is waiting (BOS-349)", async () => {
    await (async () => {
      const c = await setup();
      await c.maintenance.start({ minutes: 30 });
      // No agent is working, so the swap can land any moment: the chat waits, exactly as before.
      expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Are you there?" })).statusCode).toBe(201);
      await c.scheduler.tick();
      expect(c.sent.some((x) => x.type === "run.start")).toBe(false);
      expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("waiting: update pending");
    })();
  });

  it("stays open while an update waits only on a running check, not only on agents (BOS-1877)", async () => {
    const c = await setup();
    const [t] = await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "T", number: 1 }).returning();
    await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
    await c.maintenance.start({ minutes: 30 });
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What's the update waiting on?" })).statusCode).toBe(201);
    await c.scheduler.tick();
    expect(c.sent.find((x): x is Start => x.type === "run.start")).toMatchObject({ agentId: c.ceo.id, boardToolsOnly: true });
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("answering");
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
    // Work it can't do here is offered as a ticket, not left at "I can't".
    expect(start.prompt).toContain("don't stop at saying you can't. Offer to create the ticket that does it");
    // The chat's tool description names the tools it now shares with its runs (BOS-224).
    expect(start.prompt).toContain("server_status");
    expect(start.prompt).toContain("decisions (");
    // The built-in safety rules, in a company that set no standing rules (BOS-754).
    expect(start.prompt).toContain(BUILT_IN_RULES.join("\n"));
    expect((await c.db.select().from(runs).where(eq(runs.id, start.runId)))[0]).toMatchObject({ purpose: "chat", chapterId: null });
    // Only the CEO's own run made a chapter.
    expect((await c.db.select().from(ceoChapters)).length).toBe(1);
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().state).toBe("answering");

    // Anything but Boss Man's tools is refused, without asking anyone.
    c.sent.length = 0;
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p1", title: "Bash", kind: "execute", rawInput: { command: "ls" }, optionKinds: ["allow_once", "reject_once"] });
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p2", title: "mcp__bossman__create_ticket", kind: "other", rawInput: {}, optionKinds: ["allow_once", "reject_once"] });
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p3", title: "Edit", kind: "edit", rawInput: { file_path: "src/x.ts" }, optionKinds: ["allow_once", "reject_once"] });
    // A shell request titled like a Boss Man tool is still a command (BOS-292 security review).
    await c.emit({ type: "run.permission_request", runId: start.runId, requestId: "p4", title: "bossman_x; rm -rf /srv/precious", kind: "execute", rawInput: { command: "bossman_x; rm -rf /srv/precious" }, optionKinds: ["allow_once", "reject_once"] });
    expect(c.sent).toEqual([
      expect.objectContaining({ type: "permission.decide", requestId: "p1", verdict: "deny" }),
      expect.objectContaining({ type: "permission.decide", requestId: "p2", verdict: "allow" }),
      expect.objectContaining({ type: "permission.decide", requestId: "p3", verdict: "deny" }),
      expect.objectContaining({ type: "permission.decide", requestId: "p4", verdict: "deny" }),
    ]);

    // Its MCP server has the board tools, plus looking up tickets, the wiki and skills (R77).
    const client = await c.mcp(start.runId);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["agent_instructions", "assign_ticket", "attach_image", "board", "clear_check", "create_feature", "create_ticket", "decisions", "deploy", "devices", "engagement", "features", "feedback", "handoff", "link_tickets", "list_my_work", "log_feedback", "model_options", "notes", "notify_owner", "nudge", "open_attachment", "owner_answers", "pa_verdict", "propose_hire", "propose_model_change", "propose_rule", "propose_team", "raise_decision", "rename_agent", "report_key_result", "request_check", "request_engagement", "request_note", "review", "roadmap", "runs", "schedule_check", "server_status", "set_agent_picture", "set_milestone", "set_ticket_risk", "set_ticket_state", "sizing_guide", "skills", "standing_rules", "submit_plan", "ticket_reply", "tickets", "update_instructions", "update_ticket", "whats_new", "wiki", "withdraw_decision"]);
    // The CEO can build the roadmap from chat too.
    expect(textOf(await client.callTool({ name: "roadmap", arguments: { action: "add_objective", title: "Grow search traffic", reason: "Owner asked in chat." } }))).toMatch(/^Added the objective "Grow search traffic"/);
    // It asks a colleague itself, rather than asking the owner to pass a message on.
    expect(textOf(await client.callTool({ name: "nudge", arguments: { agent: "Engineer", why: "Please set the organising ticket to in_progress." } }))).toMatch(/^Nudged/);
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, "nudge"))).toEqual([expect.objectContaining({ agentId: c.worker.id })]);
    expect(textOf(await client.callTool({ name: "log_feedback", arguments: { text: "Acme wants SSO.", from: "Acme" } }))).toMatch(/^Filed in the feedback inbox: #\/feedback\//);
    expect((await c.feedback.notes(c.company.id))[0]).toMatchObject({ source: "chat", customer: "Acme", text: "Acme wants SSO." });
    const board = JSON.parse(textOf(await client.callTool({ name: "board", arguments: {} })));
    expect(board.objectives[0].milestones[0]).toMatchObject({ id: c.ms.id, title: "Beta" });
    // It can also see the server from chat now (BOS-224), read-only, and settle decisions.
    const serverView = JSON.parse(textOf(await client.callTool({ name: "server_status", arguments: {} })));
    expect(serverView.server).toMatchObject({ role: "single" });
    expect(serverView).toHaveProperty("deploy");
    expect(serverView).toHaveProperty("migration");
    expect(Array.isArray(serverView.wakes.waiting)).toBe(true);
    expect(Array.isArray(serverView.runs.recent)).toBe(true);
    expect(serverView.errors).toMatchObject({ count: expect.any(Number), recent: expect.any(Array) });
    expect(textOf(await client.callTool({ name: "decisions", arguments: { action: "list" } }))).toMatch(/No decisions|^\[/);
    expect(textOf(await client.callTool({ name: "create_feature", arguments: { title: "SSO", description: "For Acme.", milestoneId: c.ms.id } }))).toMatch(/^Created feature [0-9a-f-]{36} "SSO"/);
    expect((await c.feedback.scored(c.company.id)).features[0]).toMatchObject({ title: "SSO", description: "For Acme.", milestoneId: c.ms.id });
    expect(textOf(await client.callTool({ name: "create_feature", arguments: { title: "sso" } }))).toMatch(/already exists/);
    const auth = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Refactor auth", body: "Move the auth routes behind the shared session helper.", risk: "medium" } }));
    const authId = /#\/tickets\/([0-9a-f-]{36})/.exec(auth)![1]!;
    const made = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Rate-limit login", body: "Cap login attempts per account before the beta.", risk: "high", milestoneId: c.ms.id, assignee: "engineer", waitsOn: [authId] } }));
    expect(made).toMatch(/^Created #\/tickets\/[0-9a-f-]{36} "Rate-limit login" in App \(plan first\)\.$/);
    const rateId = /#\/tickets\/([0-9a-f-]{36})/.exec(made)![1]!;
    const [t] = await c.db.select().from(tickets).where(eq(tickets.id, rateId));
    expect(t).toMatchObject({ milestoneId: c.ms.id, assigneeAgentId: c.worker.id, risk: "high", planFirst: true, createdByAgentId: null });
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, rateId))).toEqual([expect.objectContaining({ blockerTicketId: authId })]);
    expect((await client.callTool({ name: "create_ticket", arguments: { title: "x", assignee: "Nobody" } })).isError).toBe(true);
    expect((await client.callTool({ name: "link_tickets", arguments: { ticketId: authId, waitsOnTicketId: rateId } })).isError).toBe(true);
    // The CEO closes and reorganises tickets from chat; a worker asked in chat is told to offer a ticket instead.
    expect(textOf(await client.callTool({ name: "update_ticket", arguments: { ticketId: rateId, title: "Rate-limit the login API", reason: "Owner asked in chat." } }))).toMatch(/updated/);
    expect(textOf(await client.callTool({ name: "set_ticket_state", arguments: { ticketId: authId, state: "done", summary: "Shipped with the login work." } }))).toBe(`Ticket ${authId} is now done.`);
    const asWorker = await c.mcp(start.runId, c.worker.id);
    expect(textOf(await asWorker.callTool({ name: "set_ticket_state", arguments: { ticketId: rateId, state: "done", summary: "x" } }))).toMatch(/only your CEO or a manager can move tickets, except that you can start your own ticket.*Offer the owner to create a ticket/);
    await asWorker.close();
    await client.close();

    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: `Done: #/tickets/${rateId} "Rate-limit login", waiting on #/tickets/${authId}.` } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const chat = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json();
    expect(chat.state).toBe("idle");
    expect(chat.items.map((m: { role: string }) => m.role)).toEqual(["owner", "owner", "assistant"]);
    // Both tickets were created or read by this run, so the link check says nothing; the changes are listed in code (BOS-758).
    expect(chat.items[2].text).toContain(`#/tickets/${rateId}`);
    expect(chat.items[2].text).toContain("Done in this reply:");
    expect(chat.items[2].text).toContain("nudged Engineer");
    // A busy run lists the first 5 changes and counts the rest; the two created tickets are traced and counted (BOS-806).
    expect(chat.items[2].text).toContain("(and 4 more)");
    expect(chat.items[2].text).not.toContain("Ticket link check");
    // A run that made changes doesn't also need a run-end note.
    expect(chat.items.map((m: { role: string }) => m.role)).not.toContain("system");
  });

  it("keeps server_status and decisions to the calling company", async () => {
    const c = await setup();
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json();
    const [ceo2] = await c.db.select().from(agents).where(eq(agents.companyId, other.company.id));
    if (!ceo2) throw new Error("no second CEO");
    const run2 = randomUUID();
    const wake2 = randomUUID();
    const decision2 = randomUUID();
    await c.db.insert(runs).values({ id: run2, companyId: other.company.id, agentId: ceo2.id, purpose: "chat", origin: "owner_chat" });
    await c.db.insert(wakes).values({ id: wake2, companyId: other.company.id, agentId: ceo2.id, reason: "owner_chat" });
    await c.db.insert(decisions).values({ id: decision2, companyId: other.company.id, kind: "question", question: "Other Co secret question", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: ceo2.id, tier: "ceo" });
    // A server error carrying another company's text must not reach this company's agents.
    const leak = Object.assign(
      new Error('Failed query: select * from tickets where id = $1 params: ["B Co private plan: acquire Acme"]'),
      { query: "select * from tickets", params: ["B Co private plan: acquire Acme"] },
    );
    // This company's own error keeps only the message it was logged with, never the query or params.
    c.app.log.error({ err: leak, companyId: c.company.id }, "run-ended handling failed");
    // Another company's error is tagged to it, so this company never reads even its safe message.
    const otherLeak = Object.assign(
      new Error('Failed query: select * from tickets where id = $1 params: ["Other Co private plan"]'),
      { query: "select * from tickets", params: ["Other Co private plan"] },
    );
    c.app.log.error({ err: otherLeak, companyId: other.company.id }, "runner event failed");
    // An error with no company attached is counted for everyone, shown to no one.
    c.app.log.error(leak);
    const port = (c.app.server.address() as { port: number }).port;
    const connect = async (companyId: string, agentId: string) => {
      const token = await issueRunToken(c.db, { companyId, agentId, runId: randomUUID() });
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
      return client;
    };
    // This company's CEO sees its own server facts but not the other company's work.
    const mine = await connect(c.company.id, c.ceo.id);
    const view = JSON.parse(textOf(await mine.callTool({ name: "server_status", arguments: {} })));
    const seen = JSON.stringify(view);
    expect(seen).not.toContain(run2);
    expect(seen).not.toContain(wake2);
    expect(seen).not.toContain("B Co private plan");
    expect(seen).not.toContain("acquire Acme");
    expect(seen).not.toContain("Other Co private plan");
    expect(seen).not.toContain("select * from tickets");
    expect(seen).not.toContain("runner event failed");
    expect(view.errors.recent.map((e: { message: string }) => e.message)).toContain("run-ended handling failed");
    expect(view.errors.untagged).toBeGreaterThan(0);
    expect(textOf(await mine.callTool({ name: "decisions", arguments: { action: "list" } }))).not.toContain("Other Co secret question");
    await mine.close();
    // The other company's CEO does see them.
    const theirs = await connect(other.company.id, ceo2.id);
    const theirView = JSON.parse(textOf(await theirs.callTool({ name: "server_status", arguments: {} })));
    expect(JSON.stringify(theirView.runs.recent)).toContain(run2);
    expect(JSON.stringify(theirView.wakes.waiting)).toContain(wake2);
    // Each company reads only its own error lines, and only their safe messages.
    expect(theirView.errors.recent.map((e: { message: string }) => e.message)).toContain("runner event failed");
    expect(theirView.errors.recent.map((e: { message: string }) => e.message)).not.toContain("run-ended handling failed");
    expect(JSON.stringify(theirView.errors.recent)).not.toContain("Other Co private plan");
    expect(textOf(await theirs.callTool({ name: "decisions", arguments: { action: "list" } }))).toContain("Other Co secret question");
    await theirs.close();
  });

  it("keeps another agent's chat to the board tools, so it can't outgrow its restricted runs (BOS-58)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("PATCH", `/api/companies/${c.company.id}/watchdog`, { scrumMasterAgentId: c.worker.id });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "What is stuck?", agentId: c.worker.id });
    c.sent.length = 0;
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.worker.id)!;
    expect(start).toBeTruthy();
    // Its chat doesn't claim the CEO's run tools.
    expect(start.prompt).not.toContain("same tools here as in your ticket runs");
    const client = await c.mcp(start.runId, c.worker.id);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "agent_instructions",
      "board",
      "create_feature",
      "create_ticket",
      "features",
      "link_tickets",
      "list_my_work",
      "log_feedback",
      "model_options",
      "notes",
      "nudge",
      "open_attachment",
      "owner_answers",
      "propose_hire",
      "propose_model_change",
      "propose_rule",
      "propose_team",
      "rename_agent",
      "request_note",
      "roadmap",
      "set_agent_picture",
      "set_milestone",
      "set_ticket_state",
      "skills",
      "tickets",
      "update_instructions",
      "update_ticket",
      "whats_new",
      "wiki",
    ]);
    await client.close();
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
    expect(last.text).not.toContain("Don't break it into tasks");
    expect(last.text).toContain("plan it as a main ticket with sub-tasks where the work naturally divides");
    expect(last.text).toContain("Keep it as one ticket when it is small or doesn't divide");
    expect(last.text).toContain("Don't split just for the sake of it");
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
    // The run-end line lists what this run did after its last reply, from its own record (BOS-758).
    expect(items[2]!.text).toBe("CEO finished after its last message. Since that message: 1 decision sent to Decisions; changed Engineer's instructions; created a ticket APP-1.");

    // No reply at all, and nothing done: still said, so the owner isn't left waiting.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Anything else?" });
    c.sent.length = 0;
    await c.scheduler.tick();
    const second = c.sent.find((x): x is Start => x.type === "run.start")!;
    await c.emit({ type: "run.ended", runId: second.runId, stopReason: "end_turn", error: null });
    await c.settle();
    expect((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1)).toMatchObject({ role: "system", text: 'CEO finished without a reply (it ended its turn without writing one; stop reason "end_turn"), so it was asked again.' });
  });

  it("asks a run that ended without a reply again once, then tells the owner why and flags it (BOS-1734)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const chat = () => c.req("GET", `/api/companies/${c.company.id}/chat`).then((r) => r.json().items as Array<{ role: string; text: string; runId: string | null }>);
    const starts = () => c.sent.filter((x): x is Start => x.type === "run.start");
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Stop the background workers for the update." });
    await c.scheduler.tick();
    const first = starts().at(-1)!;
    await c.emit({ type: "run.ended", runId: first.runId, stopReason: "max_turn_requests", error: null });
    await c.settle();
    await c.scheduler.tick();
    // Asked again straight away, as a chat run, and the owner's message moves to the new run.
    const second = starts().at(-1)!;
    expect(second.runId).not.toBe(first.runId);
    expect(second).toMatchObject({ boardToolsOnly: true, cwd: `/ws/chat/${c.company.id}/${c.ceo.id}` });
    expect((await chat()).find((m) => m.role === "owner")!.runId).toBe(second.runId);
    expect((await chat()).at(-1)).toMatchObject({ role: "system", text: 'CEO finished without a reply (it hit its step limit; stop reason "max_turn_requests"), so it was asked again.' });
    expect((await c.db.select().from(runs).where(eq(runs.id, first.runId)))[0]!.outcome).toBe("max_turn_requests");

    // Silent again: no third run; the owner reads why, that the message is kept, and gets a flag.
    await c.emit({ type: "run.ended", runId: second.runId, stopReason: "end_turn", error: null });
    await c.settle();
    await c.scheduler.tick();
    expect(starts().at(-1)!.runId).toBe(second.runId);
    expect((await chat()).at(-1)).toMatchObject({ role: "system", text: 'CEO finished without a reply again (it ended its turn without writing one; stop reason "end_turn"). Your message is kept: CEO\'s next chat run answers it, and sending another message starts one.' });
    const feed = (await c.req("GET", "/api/notifications")).json().items as Array<{ level: string; title: string; link: string }>;
    expect(feed.filter((n) => n.title === "CEO didn't answer your chat message")).toMatchObject([{ level: "flag", link: `#/chat/${c.company.id}/${c.ceo.id}` }]);
    // The kept message goes to the next run the owner starts.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Hello?" });
    await c.scheduler.tick();
    const third = starts().at(-1)!;
    expect((await chat()).filter((m) => m.role === "owner").map((m) => m.runId)).toEqual([third.runId, third.runId]);

    // A run that replied is not asked again.
    await c.emit({ type: "run.update", runId: third.runId, update: { kind: "agent_message", text: "Workers stopped." } });
    await c.settle();
    await c.emit({ type: "run.ended", runId: third.runId, stopReason: "end_turn", error: null });
    await c.settle();
    await c.scheduler.tick();
    expect(starts().at(-1)!.runId).toBe(third.runId);
    expect((await chat()).at(-1)).toMatchObject({ role: "assistant" });

    // A run someone stopped by hand isn't restarted behind their back; it still says why.
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "And the reviewers?" });
    await c.scheduler.tick();
    const fourth = starts().at(-1)!;
    await c.db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, fourth.runId));
    await c.emit({ type: "run.ended", runId: fourth.runId, stopReason: "cancelled", error: null });
    await c.settle();
    await c.scheduler.tick();
    expect(starts().at(-1)!.runId).toBe(fourth.runId);
    expect((await chat()).at(-1)!.text).toBe('CEO finished without a reply (it was cancelled; stop reason "cancelled"). Your message is kept: CEO\'s next chat run answers it, and sending another message starts one.');
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

  it("gives an ordinary agent's chat the ticket tools for its own tickets, and the add-on guard (BOS-1300)", async () => {
    const c = await setup();
    const mine =(await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "About page", assigneeAgentId: c.worker.id })).json();
    const theirs = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Other work", assigneeAgentId: c.ceo.id })).json();
    await c.db.update(tickets).set({ systemState: "blocked" }).where(eq(tickets.id, mine.id));
    await c.db.update(tickets).set({ systemState: "blocked" }).where(eq(tickets.id, theirs.id));
    // A skill that needs Penpot, while the runner reports it as not working.
    await c.db.update(runners).set({ addons: [{ id: "agent-browser", version: "1", ok: false }] });
    const [{ id: skillId }] = (await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "written", name: "Browse", description: "Look at pages.", body: "Use the browser." })).json();
    expect((await c.req("PUT", `/api/companies/${c.company.id}/skills/${skillId}/addons`, { requires: ["agent-browser"] })).statusCode).toBe(200);
    await c.req("PUT", `/api/companies/${c.company.id}/skills/${skillId}/agents`, { agentIds: [c.worker.id] });
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "The words are in Penpot.", agentId: c.worker.id });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.worker.id)!;
    expect(start.boardToolsOnly).toBeUndefined();
    // The guard: the run says plainly at its start that the add-on skill is missing, and the server records it.
    expect(start.prompt).toContain('NOT loaded in this run: "browse" (needs the agent-browser add-on)');
    expect(c.errors.recent(10, c.company.id).map((e) => e.message).join("\n")).toContain("started without");

    const client = await c.mcp(start.runId, c.worker.id);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["ticket_reply", "schedule_check", "clear_check", "attach_image", "tickets", "set_ticket_state"]) expect(names).toContain(n);
    // Not the other run tools: no deploys, decisions or agent admin.
    for (const n of ["deploy", "decisions", "raise_decision", "server_status", "runs"]) expect(names).not.toContain(n);
    // It restarts its own Blocked ticket, but not another agent's, and not into review or done.
    expect(textOf(await client.callTool({ name: "set_ticket_state", arguments: { ticketId: mine.id, state: "in_progress" } }))).toContain("in_progress");
    expect((await client.callTool({ name: "set_ticket_state", arguments: { ticketId: theirs.id, state: "in_progress" } })).isError).toBe(true);
    expect((await client.callTool({ name: "set_ticket_state", arguments: { ticketId: mine.id, state: "done", summary: "x" } })).isError).toBe(true);
    await client.close();
  });

  it("every ticket run gets the agent's add-on skills and tool servers, whatever woke it, and says when one is left out (BOS-1300)", async () => {
    const c = await setup();
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "About page", assigneeAgentId: c.worker.id })).json();
    await c.db.update(runners).set({ addons: [{ id: "agent-browser", version: "1", ok: true }] });
    const [{ id: skillId }] = (await c.req("POST", `/api/companies/${c.company.id}/skills`, { from: "written", name: "Browse", description: "Look at pages.", body: "Use the browser." })).json();
    await c.req("PUT", `/api/companies/${c.company.id}/skills/${skillId}/addons`, { requires: ["agent-browser"] });
    await c.req("PUT", `/api/companies/${c.company.id}/skills/${skillId}/agents`, { agentIds: [c.worker.id] });
    await c.req("POST", `/api/companies/${c.company.id}/mcp-servers`, { name: "tools", url: "https://tools.example/mcp", transport: "http" });
    const wakeOnce = async (reason: string) => {
      await c.db.delete(wakes);
      c.sent.length = 0;
      await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason, note: `Woken: ${reason}.` });
      await c.scheduler.tick();
      return c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.worker.id)!;
    };
    // Scheduled check, nudge and the owner's restart each carry the skill and the tool servers, and none is board-only.
    for (const reason of ["check due", "nudge", "woken by owner"]) {
      const start = await wakeOnce(reason);
      expect(start, reason).toBeDefined();
      expect(start.boardToolsOnly, reason).toBeUndefined();
      expect(start.skills?.map((s) => s.name), reason).toContain("browse");
      expect(start.mcpServers?.map((s) => s.name), reason).toContain("tools");
      expect(start.prompt, reason).not.toContain("NOT loaded");
      await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
      await c.settle();
    }
    // The runner stops reporting the add-on: the ticket run says so at its start and the server records it.
    await c.db.update(runners).set({ addons: [{ id: "agent-browser", version: "1", ok: false }] });
    const left = await wakeOnce("check due");
    expect(left.skills?.map((s) => s.name) ?? []).not.toContain("browse");
    expect(left.prompt).toContain('NOT loaded in this run: "browse" (needs the agent-browser add-on)');
    expect(c.errors.recent(10, c.company.id).map((e) => e.message).join("\n")).toContain("started without");
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
    // BOS-1300: an ordinary agent's chat has its working tools (no board-tools-only switch); the CEO's chat keeps it.
    expect(workerStart).toMatchObject({ cwd: `/ws/chat/${c.company.id}/${c.worker.id}` });
    expect(workerStart.boardToolsOnly).toBeUndefined();
    expect(starts.find((x) => x.agentId === c.ceo.id)!.boardToolsOnly).toBe(true);
    expect(workerStart.prompt).toContain("You are Engineer, the worker of App Co. The owner is messaging you directly");
    expect(workerStart.prompt).toContain("Owner: What are you working on?");
    expect(workerStart.prompt).not.toContain("How is the beta going?");

    await c.emit({ type: "run.update", runId: workerStart.runId, update: { kind: "agent_message", text: "The login page." } });
    await c.settle();
    expect((await c.req("GET", `${base}?agentId=${c.worker.id}`)).json()).toMatchObject({ state: "answering", items: [{ role: "owner" }, { role: "assistant", text: "The login page.\n\nNo changes made in this reply.", agentId: c.worker.id }] });
    expect((await c.req("POST", base, { text: "hi", agentId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("checks a reply's claims against what the run actually changed (BOS-758)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Remember that I like short summaries." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    // A reply that claims a note it never saved: Boss Man says so in code, without touching the words.
    const words = "Saved a note: keep replies short. I created BOS-12 for the rest.";
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: words } });
    await c.settle();
    let saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text).toBe(`${words}\n\nNo changes made in this reply.`);

    // A later reply in the same run, after a real note and a real ticket, lists each.
    const client = await c.mcp(start.runId);
    await client.callTool({ name: "notes", arguments: { action: "save", title: "Short replies", text: "Keep them short.", why: "Remember that I like short summaries." } });
    const made = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Tidy the inbox", project: "App" } }));
    const madeId = /#\/tickets\/([0-9a-f-]{36})/.exec(made)![1]!;
    await client.close();
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: `Noted. Ticket: #/tickets/${madeId}.` } });
    await c.settle();
    saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text).toContain("Done in this reply: saved note \"Short replies\"; created a ticket APP-1.");
    expect(saved.text).not.toContain("Ticket link check");

    // A third reply lists only what came since the last one: nothing, so "No changes made".
    // A ticket that wasn't created or read by this run is named, and the reply is otherwise as written.
    const linked = "That's #/tickets/00000000-0000-4000-8000-0000000000aa, I think. Ticket #/tickets/0000abcd-0000-4000-8000-0000000000aa too.";
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: linked } });
    await c.settle();
    saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text.startsWith(linked)).toBe(true);
    expect(saved.text).toContain("No changes made in this reply.");
    expect(saved.text).not.toContain("Done in this reply:");
    expect(saved.text).toContain("Ticket link check: these ticket links are to a ticket this run didn't create or read: #/tickets/00000000-0000-4000-8000-0000000000aa, #/tickets/0000abcd-0000-4000-8000-0000000000aa.");
    expect(saved.text).toContain("The text was saved as written.");
  });

  it("lists only a run's own changes when two runs of the same agent overlap (BOS-758)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    // A ticket run of the CEO's own, still live while the chat run starts.
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Rebalance the sprint", assigneeAgentId: c.ceo.id })).json() as { id: string };
    await c.scheduler.tick();
    const ticketStart = c.sent.find((x): x is Start => x.type === "run.start")!;
    expect(ticketStart.agentId).toBe(c.ceo.id);

    // The chat run is beside it; Boss Man lets it through while the CEO works (BOS-349).
    c.sent.length = 0;
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Tidy the team's instructions." });
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    await c.scheduler.tick();
    const chatStart = c.sent.find((x): x is Start => x.type === "run.start")!;
    expect(chatStart).toMatchObject({ agentId: c.ceo.id, boardToolsOnly: true });

    // Each run changes something different.
    const ticketClient = await c.mcp(ticketStart.runId);
    await ticketClient.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: "Work only on the API.", reason: "Ticket run." } });
    await ticketClient.close();
    const chatClient = await c.mcp(chatStart.runId);
    await chatClient.callTool({ name: "notes", arguments: { action: "save", title: "Short replies", text: "Keep them short.", why: "Tidy the team's instructions." } });
    await chatClient.close();

    // The chat reply lists only the chat's note, not the ticket run's change.
    await c.emit({ type: "run.update", runId: chatStart.runId, update: { kind: "agent_message", text: "All tidy." } });
    await c.settle();
    const items = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
    expect(items.at(-1)!.text).toBe("All tidy.\n\nDone in this reply: saved note \"Short replies\".");
    // The ticket run's end adds nothing to the chat, and its change never appears in the chat's lines.
    const before = items.length;
    await c.emit({ type: "run.ended", runId: ticketStart.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const after = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
    expect(after).toHaveLength(before);
    expect(after.some((m) => m.text.includes("changed Engineer's instructions"))).toBe(false);
    expect(t).toBeDefined();
  });

  it("names a notify_owner note in the what-changed line, not \"No changes made\" (BOS-806)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Tell me when you're done." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    const client = await c.mcp(start.runId);
    // BOS-806's repro: a real note, which the old changeTrace left out of the line.
    expect(textOf(await client.callTool({ name: "notify_owner", arguments: { level: "note", title: "Probe note" } }))).toBe("Sent as a note.");
    await client.close();
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "I told the owner." } });
    await c.settle();
    const saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text).toBe("I told the owner.\n\nDone in this reply: sent the owner a note.");
    expect(saved.text).not.toContain("No changes made in this reply.");
  });

  it("counts neither a read nor a failed call as a change, and names an updated or moved ticket by its ref (BOS-806, QA BOS-821)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Look around." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    const client = await c.mcp(start.runId);
    const saidAs = async (words: string) => {
      await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: words } });
      await c.settle();
      return ((await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string }).text;
    };
    // Read actions of tools that also write, plain reads, and a call that fails: none is a change.
    await client.callTool({ name: "notes", arguments: { action: "list" } });
    await client.callTool({ name: "decisions", arguments: { action: "list" } });
    await client.callTool({ name: "board", arguments: {} });
    expect((await client.callTool({ name: "set_ticket_state", arguments: { ticketId: randomUUID(), state: "done", summary: "x" } })).isError).toBe(true);
    expect(await saidAs("Had a look.")).toBe("Had a look.\n\nNo changes made in this reply.");
    // A real change to a ticket the run made names the ticket by its ref, not just "a ticket".
    const made = textOf(await client.callTool({ name: "create_ticket", arguments: { title: "Tidy the inbox", project: "App" } }));
    const id = /#\/tickets\/([0-9a-f-]{36})/.exec(made)![1]!;
    await client.callTool({ name: "update_ticket", arguments: { ticketId: id, title: "Tidy the owner inbox", reason: "Clearer." } });
    await client.callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "done", summary: "Not needed." } });
    await client.callTool({ name: "notify_owner", arguments: { level: "flag", title: "FYI" } });
    await client.close();
    const text = await saidAs(`Done: #/tickets/${id}.`);
    expect(text).toContain("Done in this reply: created a ticket APP-1; updated a ticket APP-1; moved a ticket APP-1; sent the owner a flag.");
    expect(text).not.toContain("No changes made");
  });

  it("has every chat tool either listed as a change in the what-changed line or named as read-only (BOS-806)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Hello." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    const client = await c.mcp(start.runId);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    // A new tool cannot be added silently: it is either listed as a change (in TRACED_TOOLS, with a case
    // in changeTrace) or named as read-only. The two sets must not overlap, so a read can't be counted as a change.
    const readOnly = names.filter((n) => READ_ONLY_TOOLS.has(n));
    const changing = names.filter((n) => TRACED_TOOLS.has(n));
    const missed = names.filter((n) => !READ_ONLY_TOOLS.has(n) && !TRACED_TOOLS.has(n));
    expect(missed).toEqual([]);
    expect(names.filter((n) => READ_ONLY_TOOLS.has(n) && TRACED_TOOLS.has(n))).toEqual([]);
    // Every tool is one or the other, and the sets hold no name the chat no longer has.
    expect([...readOnly, ...changing].sort()).toEqual(names);
    expect([...READ_ONLY_TOOLS].filter((n) => !names.includes(n))).toEqual([]);
    expect([...TRACED_TOOLS].filter((n) => !names.includes(n))).toEqual([]);
  });

  it("counts reading a diff as a read, not a change (BOS-820)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Have a look at the ticket I just sent you." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Tidy the inbox" })).json() as { id: string };
    const client = await c.mcp(start.runId);
    expect(textOf(await client.callTool({ name: "review", arguments: { action: "diff", ticketId: t.id } }))).not.toBe("");
    await client.close();
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "I read it." } });
    await c.settle();
    const saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text).toBe("I read it.\n\nNo changes made in this reply.");
    expect(saved.text).not.toContain("read a ticket's diff");
  });

  it("still succeeds and is named when the ticket-number lookup fails (BOS-820)", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Remember that I like short summaries." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start")!;
    // The lookup reads the company's ticket prefix; give it a form it can't use, so it throws
    // where a real one might (a busy or failing database) while the tool itself still worked.
    await c.req("PATCH", `/api/companies/${c.company.id}`, { ticketPrefix: "NOT A PREFIX" });
    const client = await c.mcp(start.runId);
    const r = await client.callTool({ name: "create_ticket", arguments: { title: "Tidy the inbox", project: "App" } });
    await client.close();
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(r)).not.toMatch(/isError|lookup/i);
    const made = (await c.db.select().from(tickets).where(eq(tickets.companyId, c.company.id))).filter((t) => t.title === "Tidy the inbox");
    expect(made).toHaveLength(1);
    // The change was made, so the reply says so (the number is missing, the change is not).
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "Made it." } });
    await c.settle();
    const saved = (await c.req("GET", `/api/companies/${c.company.id}/chat`)).json().items.at(-1) as { text: string };
    expect(saved.text).toContain("Done in this reply: created a ticket");
    expect(saved.text).not.toContain("No changes made in this reply.");
  });

  it("needs a CEO and a message", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "  " })).statusCode).toBe(400);
  });
});
