// A run with no ticket says what it was doing (BOS-118): every start path records the reason
// on the run, and the dashboard, runs list and brief read it through the shared label.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, nudges, runs, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, wikiBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (commands.push(c), true));
  const starts = () => commands.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const latestRun = async (agentId: string) => {
    const rows = await db.select().from(runs).where(eq(runs.agentId, agentId));
    return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]!;
  };
  return { ...built, db, close, req, base, company, ceo, worker, project, commands, starts, latestRun };
}

/** The card the dashboard shows for one agent. */
async function card(c: NonNullable<typeof ctx>, agentId: string) {
  const data = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json();
  return data.agents.find((a: { id: string }) => a.id === agentId) as { run: null | { id: string; ticketId: string | null; origin: string | null; originFrom: string | null; originNote: string | null; runTicketId: string | null } };
}

/** An agent's MCP client, the way a run gets one. */
async function agent(c: NonNullable<typeof ctx>, agentId: string, runId = randomUUID()) {
  const token = await issueRunToken(c.db, { companyId: c.company.id, agentId, runId });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${c.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

describe("what a run without a ticket was doing (BOS-118)", () => {
  it("records the reason a run started, so its card can say it", async () => {
    const c = (ctx = await setup());
    const queued = await c.scheduler.notify(c.worker.id, { reason: "feedback", note: "Three new notes from the portal." });
    await c.scheduler.tick();
    expect(queued).toMatchObject({ status: "queued" });
    const row = await c.latestRun(c.worker.id);
    expect(row).toMatchObject({ ticketId: null, origin: "feedback" });
    expect((await card(c, c.worker.id)).run).toMatchObject({ id: row.id, origin: "feedback", ticketId: null });
  });

  it("says who nudged a run and why, and links the ticket the nudge named", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add a skill" })).json() as { id: string };
    const ceo = await agent(c, c.ceo.id);
    const out = (await ceo.callTool({ name: "nudge", arguments: { agent: "Engineer", ticketId: t.id, why: "re-check the add-a-skill build" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(out.isError).toBeFalsy();
    await ceo.close();
    await c.scheduler.tick();
    const listed = (await c.req("GET", "/api/runs")).json() as Array<{ agent: string; reason: string; origin: string; originFrom: string | null; originNote: string | null; ticketId: string | null }>;
    const shown = listed.find((r) => r.agent === "Engineer")!;
    expect(shown).toMatchObject({ reason: "nudge", origin: "nudge", originFrom: "CEO", originNote: "re-check the add-a-skill build", ticketId: t.id });
    expect((await card(c, c.worker.id)).run).toMatchObject({ origin: "nudge", originFrom: "CEO", originNote: "re-check the add-a-skill build" });
    // The nudge keeps the wake it delivered, so the label survives a restart.
    expect((await c.db.select().from(nudges))[0]).toMatchObject({ wakeId: expect.any(String), why: "re-check the add-a-skill build" });
  });


  it("links the ticket when a nudge names one but passes no id the run is put on", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add a skill" })).json() as { id: string };
    // An older nudge, from before a nudge's ticket became the run's own: the reason is its note.
    const ceo = await agent(c, c.ceo.id);
    const out = (await ceo.callTool({ name: "nudge", arguments: { agent: "Engineer", why: `The ticket ${t.id} needs a look` } })) as { content: Array<{ text: string }> };
    expect(out.content[0]!.text).toMatch(/^Nudged/);
    await ceo.close();
    await c.scheduler.tick();
    const row = await c.latestRun(c.worker.id);
    expect(row).toMatchObject({ ticketId: null, origin: "nudge", runTicketId: t.id });
    expect((await card(c, c.worker.id)).run).toMatchObject({ origin: "nudge", originFrom: "CEO", runTicketId: t.id });
  });

  it("shows ticketless runs on the board and counts them like the dashboard (BOS-155)", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add a skill" })).json() as { id: string };
    // The Engineer is nudged about the ticket without being on it; the CEO runs with no ticket at all.
    const ceo = await agent(c, c.ceo.id);
    await ceo.callTool({ name: "nudge", arguments: { agent: "Engineer", why: `The ticket ${t.id} needs a look` } });
    await ceo.close();
    await c.scheduler.notify(c.ceo.id, { reason: "feedback", note: "New notes." });
    await c.scheduler.tick();
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { workingAgents: number; withoutTicket: Array<{ agent: string; origin: string }>; columns: Array<{ tickets: Array<{ id: string; working: string[] }> }> };
    const dash = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json() as { stats: { running: number } };
    const card = board.columns.flatMap((x) => x.tickets).find((x) => x.id === t.id)!;
    expect(card.working).toEqual(["Engineer picking this up"]);
    expect(board.withoutTicket.map((r) => r.agent)).toEqual(["CEO"]);
    expect(board.workingAgents).toBe(2);
    expect(board.workingAgents).toBe(dash.stats.running);
  });

  it("lights the ticket a review wake names, and keeps the run out of the ticketless strip", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "First" })).json() as { id: string };
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, reason: "review requested", priority: 3, note: `- ${t.id} "First": ready` });
    await c.scheduler.tick();
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { workingAgents: number; withoutTicket: Array<{ agent: string }>; columns: Array<{ tickets: Array<{ id: string; working: string[] }> }> };
    const card = board.columns.flatMap((x) => x.tickets).find((x) => x.id === t.id)!;
    expect(card.working).toEqual(["Engineer reviewing"]);
    expect(board.withoutTicket).toEqual([]);
    expect(board.workingAgents).toBe(1);
  });

  it("keeps a run reviewing another project's ticket in the strip, so the board never under-reports", async () => {
    const c = (ctx = await setup());
    const other = (await c.req("POST", `/api/companies/${c.company.id}/projects`, { name: "Other site" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${other.id}/tickets`, { title: "Elsewhere" })).json() as { id: string };
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, reason: "review requested", priority: 3, note: `- ${t.id} "Elsewhere": ready` });
    await c.scheduler.tick();
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { workingAgents: number; withoutTicket: Array<{ agent: string }> };
    const dash = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json() as { stats: { running: number } };
    expect(board.withoutTicket.map((r) => r.agent)).toEqual(["Engineer"]);
    expect(board.workingAgents).toBe(1);
    expect(board.workingAgents).toBe(dash.stats.running);
  });

  it("lights every ticket a review run covers, counts the run once, and shows a finished ticket as done", async () => {
    const c = (ctx = await setup());
    const a = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "First" })).json() as { id: string };
    const b = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second" })).json() as { id: string };
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, reason: "review requested", priority: 3, note: `- ${a.id} "First": ready\n- ${b.id} "Second": ready` });
    await c.scheduler.tick();
    // The run does not pick one ticket at wake time; the board shows it on both.
    expect(await c.latestRun(c.worker.id)).toMatchObject({ ticketId: null, origin: "review requested", runTicketId: null });
    // One of the tickets merges while the reviewer is still running.
    await c.req("PATCH", `/api/tickets/${a.id}`, { state: "done" });
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { workingAgents: number; withoutTicket: Array<{ agent: string }>; columns: Array<{ systemState: string; tickets: Array<{ id: string; working: string[] }> }> };
    const cards = board.columns.flatMap((x) => x.tickets);
    expect(cards.find((x) => x.id === a.id)!.working).toEqual(["Engineer reviewing"]);
    expect(cards.find((x) => x.id === b.id)!.working).toEqual(["Engineer reviewing"]);
    expect(board.columns.find((x) => x.systemState === "done")!.tickets.map((x) => x.id)).toContain(a.id);
    expect(board.withoutTicket).toEqual([]);
    expect(board.workingAgents).toBe(1);
  });

  it("lists only the runs with no ticket when reviews and ticketless runs are mixed", async () => {
    const c = (ctx = await setup());
    const a = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "First" })).json() as { id: string };
    const b = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second" })).json() as { id: string };
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, reason: "review requested", priority: 3, note: `- ${a.id} "First": ready\n- ${b.id} "Second": ready` });
    await c.scheduler.notify(c.ceo.id, { reason: "feedback", note: "New notes." });
    await c.scheduler.tick();
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { workingAgents: number; withoutTicket: Array<{ agent: string }>; columns: Array<{ tickets: Array<{ id: string; working: string[] }> }> };
    const cards = board.columns.flatMap((x) => x.tickets);
    expect(cards.find((x) => x.id === a.id)!.working).toEqual(["Engineer reviewing"]);
    expect(cards.find((x) => x.id === b.id)!.working).toEqual(["Engineer reviewing"]);
    expect(board.withoutTicket.map((r) => r.agent)).toEqual(["CEO"]);
    expect(board.workingAgents).toBe(2);
  });

  it("shows the ticket a ticketless run starts working on, and keeps its wake reason as a detail (BOS-254)", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Pick up the loose end", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.work.updateTicket(t.id, { state: "ready", byAgentId: c.ceo.id });
    // Woken for a housekeeping check with no ticket, then it finds real work on its own ticket.
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: null, origin: "checking an old card", startedAt: new Date() });
    const client = await agent(c, c.worker.id, runId);
    const r = (await client.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Nothing of mine was stale; this needed doing." } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeFalsy();
    await client.close();
    const row = await c.latestRun(c.worker.id);
    expect(row).toMatchObject({ id: runId, ticketId: t.id, origin: "checking an old card" });
    // The runs list now headlines the ticket and shows the reason underneath.
    const listed = (await c.req("GET", "/api/runs")).json() as Array<{ id: string; ticketId: string | null; runTicketRef: string | null; origin: string | null }>;
    expect(listed.find((x) => x.id === runId)).toMatchObject({ ticketId: t.id, runTicketRef: expect.stringMatching(/-/), origin: "checking an old card" });
  });

  it("says a scheduled wiki sweep was a sweep", async () => {
    const c = (ctx = await setup());
    const [keeper] = await c.db.select().from(agents).where(eq(agents.duty, "wiki"));
    await c.req("PATCH", `/api/agents/${keeper!.id}`, { paused: false, model: "claude-sonnet-5" });
    await c.scheduler.notify(keeper!.id, { reason: "wiki upkeep", priority: 1 });
    await c.scheduler.tick();
    expect(await c.latestRun(keeper!.id)).toMatchObject({ ticketId: null, origin: "wiki upkeep" });
  });

  it("says a chat run was an owner chat", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "How are things?" });
    await c.scheduler.tick();
    const row = (await c.db.select().from(runs)).find((r) => r.purpose === "chat");
    expect(row).toMatchObject({ purpose: "chat", origin: "owner_chat" });
  });

  it("keeps the fallback for a run with no recorded reason, and records one on every start path now", async () => {
    const c = (ctx = await setup());
    // A run written before the reason was kept, with no wake behind it.
    const oldId = randomUUID();
    await c.db.insert(runs).values({ id: oldId, companyId: c.company.id, agentId: c.worker.id, ticketId: null, startedAt: new Date() });
    expect((await card(c, c.worker.id)).run).toMatchObject({ id: oldId, origin: null, originFrom: null, originNote: null });
    // Every wake carries a reason, and every launch copies it onto the run.
    await c.db.delete(runs);
    await c.scheduler.notify(c.worker.id, { reason: "decision", note: "A decision is waiting for you." });
    await c.scheduler.tick();
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(w!.reason).toBe("decision");
    const [fresh] = await c.db.select().from(runs).where(eq(runs.id, w!.runId!));
    expect(fresh).toMatchObject({ origin: "decision", runTicketId: null });
  });
});
