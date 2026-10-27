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

  it("does not pick one ticket out of a review wake that lists several", async () => {
    const c = (ctx = await setup());
    const a = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "First" })).json() as { id: string };
    const b = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second" })).json() as { id: string };
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, reason: "review requested", priority: 3, note: `- ${a.id} "First": ready\n- ${b.id} "Second": ready` });
    await c.scheduler.tick();
    expect(await c.latestRun(c.worker.id)).toMatchObject({ ticketId: null, origin: "review requested", runTicketId: null });
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
