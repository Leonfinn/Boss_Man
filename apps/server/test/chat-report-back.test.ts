// R52 (BOS-1911): a ticket asked for in owner chat is reported back in chat when it closes or hands out follow-ups.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

type Start = Extract<RunnerCommand, { type: "run.start" }>;

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
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  const link = () => built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let disconnect = link();
  /** A runner swap: the link drops, and a fresh one connects later. */
  const swapOut = () => disconnect();
  const swapIn = () => {
    disconnect = link();
  };
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  // The runner events are ingested on the server's own queue and nothing signals when one is applied, so each caller reads the database after this short pause (the same shape as chat.test.ts).
  // test-lines-ok: no event marks the end of ingest; the 50 ms is far above the in-memory database's write time, so a slower machine only lengthens the wait
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const mcp = async (runId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  const chat = async () => (await req("GET", `/api/companies/${company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
  /** A chat run starts for the owner's message; it makes a ticket, optionally replies, and ends. Returns the ticket row. */
  const askInChat = async (message: string) => {
    await req("POST", `/api/companies/${company.id}/chat`, { text: message });
    sent.length = 0;
    await built.scheduler.tick();
    const start = sent.find((x): x is Start => x.type === "run.start")!;
    const client = await mcp(start.runId);
    await client.callTool({ name: "create_ticket", arguments: { title: "Write the recommendation", size: 2 } });
    await client.close();
    await emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message", text: "I'll bring you the recommendation." } });
    await settle();
    await emit({ type: "run.ended", runId: start.runId, stopReason: "end_turn", error: null });
    await settle();
    return (await db.select().from(tickets).where(eq(tickets.companyId, company.id)))[0]!;
  };
  /** Closes the ticket the way a ticket run's done move does, then lets the scheduler start the chat run it queued. */
  const closeTicket = async (ticketId: string) => {
    await db.update(tickets).set({ systemState: "done", outcome: "completed", stateChangedAt: new Date() }).where(eq(tickets.id, ticketId));
    await built.scheduler.onTicketDone(ticketId);
    sent.length = 0;
    await built.scheduler.tick();
    return sent.find((x): x is Start => x.type === "run.start");
  };
  return { ...built, db, req, company, project, ceo, sent, emit, settle, mcp, chat, askInChat, closeTicket, swapOut, swapIn };
}

describe("R52: a ticket asked for in chat is reported back in chat", () => {
  it("marks a ticket a chat run creates; closing it wakes a chat run whose prompt carries it; no reply means Boss Man's own line", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const t = await c.askInChat("Please get Florence to write the recommendation.");
    expect(t.reportInChatAgentId).toBe(c.ceo.id);
    expect(t.reportInChatAt).not.toBeNull();
    expect(t.chatReportDueAt).toBeNull();

    const run = await c.closeTicket(t.id);
    expect(run, "closing a ticket asked for in chat queues a chat run").toBeDefined();
    expect(run!.prompt).toContain("## Report back to the owner now");
    expect(run!.prompt).toContain("APP-1");
    // The run ends without a reply: Boss Man says it in the chat itself.
    await c.emit({ type: "run.ended", runId: run!.runId, stopReason: "end_turn", error: null });
    await c.settle();
    const lines = (await c.chat()).filter((m) => m.role === "system" && m.text.startsWith("Boss Man: APP-1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain('"Write the recommendation" is done');
    const [after] = await c.db.select({ due: tickets.chatReportDueAt }).from(tickets).where(eq(tickets.id, t.id));
    expect(after!.due).toBeNull();
  });

  it("a reply that names the ticket keeps the promise: no Boss Man line", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const t = await c.askInChat("Please get Florence to write the recommendation.");
    const run = await c.closeTicket(t.id);
    await c.emit({ type: "run.update", runId: run!.runId, update: { kind: "agent_message", text: "APP-1 is done: here is the recommendation." } });
    await c.settle();
    await c.emit({ type: "run.ended", runId: run!.runId, stopReason: "end_turn", error: null });
    await c.settle();
    expect((await c.chat()).filter((m) => m.role === "system" && m.text.startsWith("Boss Man:"))).toHaveLength(0);
  });

  it("a ticket that did not come from chat finds no line and starts no chat run", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const t = await c.askInChat("Hello.");
    // Same ticket, mark cleared by the CEO: closing it reports nothing.
    await c.db.update(tickets).set({ reportInChatAgentId: null, reportInChatAt: null }).where(eq(tickets.id, t.id));
    const run = await c.closeTicket(t.id);
    expect(run).toBeUndefined();
    expect((await c.chat()).filter((m) => m.text.startsWith("Boss Man: APP-1"))).toHaveLength(0);
  });

  it("a ticket made by a run that is not a chat run is left unmarked: closing it reports nothing", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    // The owner opens a ticket for the CEO in the board, and the CEO's ticket run (not a chat run) opens a second one.
    const seed = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Plan the work", assigneeAgentId: c.ceo.id })).json();
    c.sent.length = 0;
    await c.scheduler.wake({ agentId: c.ceo.id, ticketId: seed.id, reason: "check due", note: "Woken: check due." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Start => x.type === "run.start" && x.agentId === c.ceo.id)!;
    expect(start, "the ticket run starts").toBeDefined();
    const client = await c.mcp(start.runId);
    await client.callTool({ name: "create_ticket", arguments: { title: "A follow-up from the board", size: 2 } });
    await client.close();
    const rows = await c.db.select().from(tickets).where(eq(tickets.title, "A follow-up from the board"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportInChatAt).toBeNull();
    expect(rows[0]!.reportInChatAgentId).toBeNull();
    const run = await c.closeTicket(rows[0]!.id);
    expect(run, "no chat run starts for it").toBeUndefined();
    expect((await c.chat()).filter((m) => m.role === "system" && m.text.startsWith("Boss Man:"))).toHaveLength(0);
  });

  it("a wake queued while the runner is swapped out still fires after the new runner connects", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const t = await c.askInChat("Please get Florence to write the recommendation.");
    c.swapOut();
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed", stateChangedAt: new Date() }).where(eq(tickets.id, t.id));
    await c.scheduler.onTicketDone(t.id);
    const [due] = await c.db.select({ due: tickets.chatReportDueAt }).from(tickets).where(eq(tickets.id, t.id));
    expect(due!.due, "the report is owed, stored on the ticket row").not.toBeNull();
    c.sent.length = 0;
    await c.scheduler.tick();
    expect(c.sent.find((x) => x.type === "run.start"), "nothing starts while no runner is connected").toBeUndefined();
    c.swapIn();
    await c.scheduler.tick();
    const run = c.sent.find((x): x is Start => x.type === "run.start");
    expect(run, "the chat run starts once the runner is back").toBeDefined();
    expect(run!.prompt).toContain("## Report back to the owner now");
    await c.emit({ type: "run.ended", runId: run!.runId, stopReason: "end_turn", error: null });
    await c.settle();
    expect((await c.chat()).filter((m) => m.role === "system" && m.text.startsWith("Boss Man: APP-1"))).toHaveLength(1);
  });

  it("the CEO sets and clears the mark with update_ticket reportInChat", async () => {
    const c = await setup();
    await c.db.delete(wakes);
    const t = await c.askInChat("Hello.");
    await c.db.update(tickets).set({ reportInChatAgentId: null, reportInChatAt: null }).where(eq(tickets.id, t.id));
    // A second chat run, still open, makes the calls (the first one's token ended with it).
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Again." });
    c.sent.length = 0;
    await c.scheduler.tick();
    const open = c.sent.find((x): x is Start => x.type === "run.start")!;
    const client = await c.mcp(open.runId);
    const on = await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, reportInChat: true, reason: "Owner asked for it in chat" } });
    expect(JSON.stringify(on)).toContain("Marked");
    const [row] = await c.db.select({ at: tickets.reportInChatAt, agent: tickets.reportInChatAgentId }).from(tickets).where(eq(tickets.id, t.id));
    expect(row!.agent).toBe(c.ceo.id);
    expect(row!.at).not.toBeNull();
    const off = await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, reportInChat: false, reason: "Not from chat after all" } });
    await client.close();
    expect(JSON.stringify(off)).toContain("Cleared");
    const [cleared] = await c.db.select({ at: tickets.reportInChatAt }).from(tickets).where(eq(tickets.id, t.id));
    expect(cleared!.at).toBeNull();
  });
});
