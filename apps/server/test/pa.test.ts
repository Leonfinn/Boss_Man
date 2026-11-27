import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agentChanges, agents, ownerChatMessages, paAnswers, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { JUDGEMENT } from "../src/services/pa.js";
import { expectEveryWriterGuarded } from "./secret-guard-walk.js";

let ctx: { close: () => Promise<void> } | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx?.close();
  ctx = undefined;
  delete process.env.PA_AUDIT_RATE;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const refused = async (p: Promise<unknown>) => {
  try {
    return (await p as { isError?: boolean }).isError === true;
  } catch {
    return true;
  }
};

async function setup(auditRate = 0) {
  process.env.PA_AUDIT_RATE = String(auditRate);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const pa = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Pat", template: "assistant", model: "haiku-test" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await req("PATCH", `/api/agents/${pa.id}`, { paused: false });
  await db.delete(wakes);
  const chatUrl = `/api/companies/${company.id}/chat`;
  const mcp = async (runId: string, agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, risk?: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    if (risk) await db.update(tickets).set({ risk: risk as "high" }).where(eq(tickets.id, t.id));
    return t.id;
  };
  /** The owner asks the PA; its run starts. Returns an MCP client for that run. */
  const ask = async (text: string, to?: string) => {
    sent.length = 0;
    expect((await req("POST", chatUrl, { text, ...(to ? { agentId: to } : {}) })).statusCode).toBe(201);
    await built.scheduler.tick();
    const start = sent.find((x): x is Start => x.type === "run.start" && x.agentId === pa.id)!;
    return { start, client: await mcp(start.runId, pa.id) };
  };
  const thread = async (agentId: string) => (await req("GET", `${chatUrl}?agentId=${agentId}`)).json().items as Array<{ role: string; text: string }>;
  const outcomes = async () => (await db.select().from(paAnswers)).map((a) => a.outcome);
  return { ...built, db, req, company, ceo, worker, pa, project, sent, emit, settle, mcp, ticket, ask, thread, outcomes, chatUrl };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** The PA reads a ticket, as it would before answering. */
const read = (client: Client, id: string) => client.callTool({ name: "tickets", arguments: { action: "read", ticketId: id } });
const reply = (client: Client, text: string, cites: Array<{ kind: string; id: string }>, confidence = "high") => client.callTool({ name: "pa_reply", arguments: { text, cites, confidence } });
const ceoThread = async (c: Ctx) => c.thread(c.ceo.id);

describe("the CEO's PA (R87)", () => {
  it("has read tools and the two PA tools, and no way to write", async () => {
    const c = await setup();
    const { client } = await c.ask("What's open?");
    const paTools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(paTools).toEqual(["board", "decisions", "list_my_work", "open_attachment", "pa_escalate", "pa_reply", "tickets", "whats_new", "wiki"]);
    expectEveryWriterGuarded(paTools);
    for (const name of ["create_ticket", "set_ticket_state", "raise_decision", "notify_owner", "deploy", "nudge", "propose_hire", "update_instructions", "link_tickets", "pa_verdict"]) {
      expect(await refused(client.callTool({ name, arguments: {} })), name).toBe(true);
    }
    expect(await refused(client.callTool({ name: "wiki", arguments: { action: "write", title: "x", body: "y" } }))).toBe(true);
    expect(await refused(client.callTool({ name: "decisions", arguments: { action: "answer", id: randomUUID(), answer: "Yes" } }))).toBe(true);
    expect(await refused(client.callTool({ name: "wiki", arguments: { action: "list" } }))).toBe(false);
  });

  it("posts a reply that cites what it read, with a label", async () => {
    const c = await setup();
    const id = await c.ticket("Add checkout");
    const { start, client } = await c.ask("What is the state of the checkout ticket?");
    expect(start).toMatchObject({ agentId: c.pa.id, boardToolsOnly: true, model: "haiku-test" });
    expect(start.prompt).toContain("pa_reply is the only way you answer");
    await read(client, id);
    expect(textOf(await reply(client, "Add checkout is in backlog.", [{ kind: "ticket", id }]))).toBe("Posted to the owner.");
    const last = (await c.thread(c.pa.id)).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.text).toMatch(new RegExp(`^Add checkout is in backlog\\.\\n\\n— Answered by your PA \\(haiku-test\\) from \\[Add checkout\\]\\(#/tickets/${id}\\) as of \\d\\d:\\d\\d UTC · \\[Ask the CEO\\]$`));
    expect(await c.outcomes()).toEqual(["posted"]);
    // The PA's own closing text never reaches the owner, and nothing woke the CEO.
    await c.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "Unchecked closing text." } });
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    expect((await c.thread(c.pa.id)).map((m) => m.text)).not.toContain("Unchecked closing text.");
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).toEqual([]);
  });

  it.each([
    ["an id it never fetched", "What is the state of the checkout ticket?", async (c: Ctx) => [{ kind: "ticket", id: await c.ticket("Never read") }], "high", "it cited ids no tool showed it"],
    ["a made-up id", "What is the state of the checkout ticket?", async () => [{ kind: "ticket", id: randomUUID() }], "high", "it cited ids no tool showed it"],
    ["no cites", "What is the state of the checkout ticket?", async () => [], "high", "no cites"],
    ["low confidence", "What is the state of the checkout ticket?", async (c: Ctx) => [{ kind: "ticket", id: await c.ticket("Read") }], "low", "low confidence"],
    ["a judgement question", "Should we ship the checkout this week?", async (c: Ctx) => [{ kind: "ticket", id: await c.ticket("Read") }], "high", "a judgement question"],
    ["a high-risk ticket", "What is the state of the checkout ticket?", async (c: Ctx) => [{ kind: "ticket", id: await c.ticket("Risky", "high") }], "high", "it cited a high-risk ticket"],
  ])("escalates instead of posting on %s", async (_name, question, makeCites, confidence, why) => {
    const c = await setup();
    const cites = await makeCites(c);
    const { client } = await c.ask(question);
    // The PA reads every ticket it cites, except in the cases that test it didn't.
    if (!_name.includes("never") && !_name.includes("made-up")) for (const x of cites) await read(client, x.id);
    const r = await reply(client, "It's in backlog.", cites, confidence);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(why);
    expect(await c.outcomes()).toEqual([`escalated:${why}`]);
    expect((await c.thread(c.pa.id)).map((m) => [m.role, m.text])).toEqual([["owner", question], ["assistant", "Passing this to the CEO."]]);
    expect(await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.ceo.id), eq(wakes.reason, "owner_chat")))).toHaveLength(1);
  });

  it("escalates a question the owner asked again within ten minutes", async () => {
    const c = await setup();
    const id = await c.ticket("Add checkout");
    const first = await c.ask("What is the state of the checkout ticket?");
    await read(first.client, id);
    await reply(first.client, "In backlog.", [{ kind: "ticket", id }]);
    await c.emit({ type: "run.ended", runId: first.start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const again = await c.ask("what is the state of the CHECKOUT ticket??");
    await read(again.client, id);
    expect(textOf(await reply(again.client, "In backlog.", [{ kind: "ticket", id }]))).toContain("the owner asked again");
    expect(await c.outcomes()).toEqual(["posted", "escalated:the owner asked again"]);
  });

  it("does not count the same question asked in the CEO's own thread as a re-ask", async () => {
    const c = await setup();
    expect((await c.req("POST", c.chatUrl, { text: "What is blocked?", agentId: c.ceo.id })).statusCode).toBe(201);
    const id = await c.ticket("Add checkout");
    const { client } = await c.ask("what is blocked");
    await read(client, id);
    expect(textOf(await reply(client, "Nothing.", [{ kind: "ticket", id }]))).toBe("Posted to the owner.");
    expect(await c.outcomes()).toEqual(["posted"]);
  });

  it("posts an empty cite list as a board search when the run searched tickets", async () => {
    const c = await setup();
    const { client } = await c.ask("What is blocked?");
    await client.callTool({ name: "tickets", arguments: { action: "find", q: "blocked" } });
    expect(textOf(await reply(client, "Nothing is blocked.", []))).toBe("Posted to the owner.");
    expect((await c.thread(c.pa.id)).at(-1)!.text).toMatch(/from a board search as of \d\d:\d\d UTC/);
  });

  it("escalates an empty cite list when the run only read the wiki", async () => {
    const c = await setup();
    const { client } = await c.ask("What is blocked?");
    await client.callTool({ name: "wiki", arguments: { action: "list" } });
    // Reading one ticket isn't a search either.
    await client.callTool({ name: "tickets", arguments: { action: "read", ticketId: "00000000-0000-4000-8000-000000000000" } });
    expect(textOf(await reply(client, "Nothing is blocked.", []))).toContain("no cites");
    expect(await c.outcomes()).toEqual(["escalated:no cites"]);
  });

  it("keeps its judgement patterns in one list", () => {
    for (const q of ["why", "should we", "recommend one", "what next", "plan it", "prioritise", "approve it", "budget", "cost", "money", "spend", "hire", "fire him", "deploy", "risk", "merge it"]) expect(JUDGEMENT.some((p) => p.test(q)), q).toBe(true);
    expect(JUDGEMENT.some((p) => p.test("what is the state of the first ticket"))).toBe(false);
  });

  it("pa_escalate holds the owner and briefs the CEO, whose answer returns to the PA chat", async () => {
    const c = await setup();
    const id = await c.ticket("Add checkout");
    const { client } = await c.ask("Is checkout late?");
    await read(client, id);
    expect(textOf(await client.callTool({ name: "pa_escalate", arguments: { summary: "Checkout is in backlog; I can't tell if it's late." } }))).toContain("Passed to the CEO");
    expect((await c.thread(c.pa.id)).at(-1)).toMatchObject({ role: "assistant", text: "Passing this to the CEO." });
    const brief = (await ceoThread(c)).at(-1)!.text;
    expect(brief).toContain("The owner asked: Is checkout late?");
    expect(brief).toContain("What the PA found: Checkout is in backlog; I can't tell if it's late.");
    expect(brief).toContain("Why it escalated: the PA asked the CEO");
    expect(await c.outcomes()).toEqual(["escalated:the PA asked the CEO"]);

    c.sent.length = 0;
    await c.scheduler.tick();
    const ceoRun = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.ceo.id)!;
    expect(ceoRun.prompt).toContain("The owner asked: Is checkout late?");
    await c.emit({ type: "run.update", runId: ceoRun.runId, update: { kind: "agent_message", text: "It's on track." } });
    await c.settle();
    // The PA relay posts the CEO's words unchanged; the CEO's own chat reply also gets its what-changed line (BOS-758).
    expect((await c.thread(c.pa.id)).at(-1)).toMatchObject({ role: "assistant", text: "From the CEO:\n\nIt's on track." });
    expect((await ceoThread(c)).at(-1)).toMatchObject({ role: "assistant", text: "It's on track.\n\nNo changes made in this reply." });
  });

  it("briefs a follow-up with the earlier unanswered message, and one CEO reply closes both (BOS-1392)", async () => {
    const c = await setup();
    const first = await c.ask("Can you look at issue 147?");
    await first.client.callTool({ name: "pa_escalate", arguments: { summary: "Needs the issue text." } });
    await c.emit({ type: "run.ended", runId: first.start.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const second = await c.ask("Here it is: the checkout page shows a blank total.");
    await second.client.callTool({ name: "pa_escalate", arguments: { summary: "No explicit question." } });
    const brief = (await ceoThread(c)).at(-1)!.text;
    expect(brief).toMatch(/^Follow-up to the owner's message at \d\d:\d\d that you haven't answered yet; read them together/m);
    expect(brief).toMatch(/- \d\d:\d\d: Can you look at issue 147\?\n- \d\d:\d\d \(latest\): Here it is: the checkout page shows a blank total\./);

    expect(await c.db.select().from(paAnswers)).toHaveLength(2);
  });

  it("does not mark a follow-up once the CEO has answered the earlier message (BOS-1392)", async () => {
    const c = await setup();
    const first = await c.ask("Can you look at issue 147?");
    await first.client.callTool({ name: "pa_escalate", arguments: { summary: "Needs the issue text." } });
    await c.emit({ type: "run.ended", runId: first.start.runId, stopReason: "end_turn", error: null });
    c.sent.length = 0;
    await c.scheduler.tick();
    const ceoRun = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.ceo.id)!;
    await c.emit({ type: "run.update", runId: ceoRun.runId, update: { kind: "agent_message", text: "Send me the text." } });
    await c.settle();
    const second = await c.ask("Anything else open?");
    await second.client.callTool({ name: "pa_escalate", arguments: { summary: "Judgement." } });
    const brief = (await ceoThread(c)).at(-1)!.text;
    expect(brief).not.toContain("Follow-up to");
    expect(brief).toContain("The owner asked: Anything else open?");
  });

  it("gives every owner message one run claimed an outcome (BOS-1392)", async () => {
    const c = await setup();
    await c.req("POST", c.chatUrl, { text: "What is open?", agentId: c.pa.id });
    await c.req("POST", c.chatUrl, { text: "And what is late?", agentId: c.pa.id });
    c.sent.length = 0;
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.pa.id)!;
    const client = await c.mcp(start.runId, c.pa.id);
    await client.callTool({ name: "pa_escalate", arguments: { summary: "Both at once." } });
    const rows = await c.db.select().from(paAnswers);
    expect(rows.map((r) => r.question).sort()).toEqual(["And what is late?", "What is open?"]);
    expect(rows.every((r) => r.outcome === "escalated:the PA asked the CEO")).toBe(true);
    expect(new Set(rows.map((r) => r.ceoMessageId)).size).toBe(1);
    const brief = (await ceoThread(c)).at(-1)!.text;
    expect(brief).toContain("What is open?");
    expect(brief).toContain("(latest): And what is late?");

    // One CEO reply closes both messages' escalations.
    c.sent.length = 0;
    await c.scheduler.tick();
    const ceoRun = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.ceo.id)!;
    await c.emit({ type: "run.update", runId: ceoRun.runId, update: { kind: "agent_message", text: "Two open, none late." } });
    await c.settle();
    expect((await c.db.select().from(paAnswers)).every((r) => r.ceoRepliedAt)).toBe(true);
  });

  it("keeps a brief of ten long messages under the cap, with the latest in (BOS-1392)", async () => {
    const c = await setup();
    for (let i = 0; i < 9; i++) await c.req("POST", c.chatUrl, { text: `message ${i} ${"x".repeat(1500)}`, agentId: c.pa.id });
    await c.req("POST", c.chatUrl, { text: `latest ${"y".repeat(1500)}`, agentId: c.pa.id });
    c.sent.length = 0;
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.pa.id)!;
    await (await c.mcp(start.runId, c.pa.id)).callTool({ name: "pa_escalate", arguments: { summary: "Many." } });
    const brief = (await ceoThread(c)).at(-1)!.text;
    expect(brief).toContain("(latest): latest ");
    expect(brief.match(/^- /gm)!.length).toBeLessThanOrEqual(5);
    expect(brief.length).toBeLessThan(4000 + 800);
    // Every message still has its outcome, even those too old for the brief.
    expect(await c.db.select().from(paAnswers)).toHaveLength(10);
  });

  it("fails open: a failed PA run goes to the CEO", async () => {
    const c = await setup();
    const { start } = await c.ask("What is open?");
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: null, error: "rate limited" });
    await c.settle();
    expect(await c.outcomes()).toEqual(["escalated:the PA's run failed: rate limited"]);
    expect((await c.thread(c.pa.id)).at(-1)).toMatchObject({ text: "Passing this to the CEO." });
    expect((await ceoThread(c)).at(-1)!.text).toContain("The owner asked: What is open?");
  });

  it("fails open: with the PA paused or retired, chat goes straight to the CEO", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/agents/${c.pa.id}`, { paused: true });
    await c.req("POST", c.chatUrl, { text: "How is it going?" });
    await c.req("POST", c.chatUrl, { text: "And you?", agentId: c.pa.id });
    expect((await ceoThread(c)).map((m) => m.text)).toEqual(["How is it going?", "And you?"]);
    expect(await c.thread(c.pa.id)).toEqual([]);
    expect((await c.req("GET", c.chatUrl)).json().agentId).toBe(c.ceo.id);
  });

  it("sends chat to the PA by default, and to the CEO from the Ask the CEO button", async () => {
    const c = await setup();
    await c.req("POST", c.chatUrl, { text: "How is it going?" });
    await c.req("POST", c.chatUrl, { text: "Straight to you.", agentId: c.ceo.id });
    expect((await c.thread(c.pa.id)).map((m) => m.text)).toEqual(["How is it going?"]);
    expect((await ceoThread(c)).map((m) => m.text)).toEqual(["Straight to you."]);
    expect((await c.req("GET", `${c.chatUrl}/threads`)).json().map((t: { name: string }) => t.name).slice(0, 2)).toEqual(["Pat", c.ceo.name]);
  });

  it("puts a sample of posted answers in the CEO's brief, and only the CEO marks them", async () => {
    const c = await setup(1);
    const id = await c.ticket("Add checkout");
    const { start, client } = await c.ask("What is the state of the checkout ticket?");
    await read(client, id);
    await reply(client, "In backlog.", [{ kind: "ticket", id }]);
    await c.emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    const [row] = await c.db.select().from(paAnswers);
    expect(row).toMatchObject({ sampled: true, outcome: "posted" });

    await c.scheduler.wake({ agentId: c.ceo.id, reason: "decision" });
    c.sent.length = 0;
    await c.scheduler.tick();
    const brief = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.ceo.id)!.prompt;
    expect(brief).toContain("## PA answers to check");
    expect(brief).toContain(`${row!.id}: asked "What is the state of the checkout ticket?"; the PA said "In backlog." citing ticket ${id}`);

    const run = async (agentId: string) => {
      const runId = randomUUID();
      await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId, startedAt: new Date() });
      return c.mcp(runId, agentId);
    };
    const args = { answerId: row!.id, verdict: "wrong", note: "It was in review." };
    expect(await refused((await run(c.worker.id)).callTool({ name: "pa_verdict", arguments: args }))).toBe(true);
    expect((await c.db.select().from(paAnswers))[0]!.verdict).toBeNull();
    expect(textOf(await (await run(c.ceo.id)).callTool({ name: "pa_verdict", arguments: args }))).toBe("Marked wrong.");
    expect((await c.db.select().from(paAnswers))[0]).toMatchObject({ verdict: "wrong", verdictNote: "It was in review." });

    const list = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as Array<{ id: string; pa: unknown }>;
    expect(list.find((a) => a.id === c.pa.id)!.pa).toEqual({ posted: 1, escalated: 0, wrong: 1 });
    expect(list.find((a) => a.id === c.ceo.id)!.pa).toBeNull();
    expect((await c.db.select().from(agents).where(eq(agents.id, c.pa.id)))[0]).toMatchObject({ duty: "assistant", title: "Assistant" });
  });

  it("always sandboxes the PA, even when it isn't woken by chat", async () => {
    const c = await setup();
    c.sent.length = 0;
    await c.req("POST", `/api/agents/${c.pa.id}/wake`, { note: "Look around." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.pa.id)!;
    expect(start.boardToolsOnly).toBe(true);
    expect((await c.db.select().from(runs).where(eq(runs.id, start.runId)))[0]!.purpose).toBeNull();
  });

  it("cuts a long cited ticket title in the label", async () => {
    const c = await setup();
    const id = await c.ticket("A very long ticket title that goes on and on well past forty characters");
    const { client } = await c.ask("What is the state of that ticket?");
    await read(client, id);
    await reply(client, "In backlog.", [{ kind: "ticket", id }]);
    expect((await c.thread(c.pa.id)).at(-1)!.text).toContain("[A very long ticket title that goes on an](#/tickets/");
  });

  it("lets a retired assistant be replaced, and refuses rehiring it beside an active one", async () => {
    const c = await setup();
    const base = `/api/companies/${c.company.id}/agents`;
    expect((await c.req("POST", base, { name: "Second", template: "assistant" })).statusCode).toBe(409);
    await c.req("POST", `/api/agents/${c.pa.id}/retire`);
    const second = await c.req("POST", base, { name: "Second", template: "assistant" });
    expect(second.statusCode).toBe(201);
    const change = (await c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, c.pa.id), eq(agentChanges.field, "retired"))))[0]!;
    const undo = await c.req("POST", `/api/agent-changes/${change.id}/undo`);
    expect(undo.statusCode).toBe(409);
    expect(undo.json().message ?? undo.body).toContain("already has an active Assistant");
  });

  it("allows one assistant per company", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Second", template: "assistant" })).statusCode).toBe(409);
    expect(await c.db.select().from(ownerChatMessages)).toEqual([]);
  });
});
