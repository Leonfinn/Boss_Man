// BOS-1029: an agent finishes before it starts more. A new start (backlog or ready -> in progress) of an agent at its
// limit waits in Ready, assigned, with a note; returning to started work is never held; an urgent ticket may start one
// over; a freed slot starts the held ticket by itself; and the tools say "queued in Ready".
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { activity, runs, settings, tickets, wakes } from "../src/db/schema.js";
import { moveTicket } from "../src/services/ticket-moves.js";
import { agentWipCount, WIP_REFUSED_REASON } from "../src/services/agent-wip.js";
import { IDLE_SLOT_REASON } from "../src/services/scheduler.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await Promise.all((ctx?.clients ?? []).map((c) => c.close().catch(() => undefined)));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH" | "PUT" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    // Creating an assigned ticket queued a wake for it; the test sends its own wakes.
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const history = async (id: string) => (await db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "state")))).map((r) => r.summary);
  const setLimits = (v: { agent: number | null; company?: number | null }) => db.insert(settings).values({ key: "wip_limits", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  const reply = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;
  return { ...built, db, close, req, company, ceo, project, worker, mcp, clients, commands, ticket, row, history, setLimits, reply };
}

/** The agent holds `n` tickets in progress. */
async function holding(c: Awaited<ReturnType<typeof setup>>, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await c.ticket("in_progress")).id);
  return ids;
}

const HELD = /^Waiting: Engineer is at the limit of 2 in-progress tickets; starts when one finishes\.$/;

describe("start on the wake is held at the limit (default 2)", () => {
  it("an agent with 2 in progress: the woken ready ticket stays in Ready with the Waiting note and does not start", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    const after = await c.row(t.id);
    expect(after.systemState).toBe("ready");
    expect(after.assigneeAgentId).toBe(c.worker.id);
    expect(after.stateNote).toMatch(HELD);
    expect(await agentWipCount(c.db, c.worker.id)).toBe(2);
  });

  it("a backlog ticket held at the limit goes to Ready, assigned", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("backlog");
    const r = await moveTicket(c.db, t.id, "in_progress", { note: "x", overLimit: true, internal: true });
    expect(r.held).toMatch(HELD);
    expect(r.ticket.systemState).toBe("ready");
    expect(await c.history(t.id)).toEqual([expect.stringMatching(/^backlog -> ready/)]);
  });

  it("under the limit it starts, and review, blocked and done do not count", async () => {
    const c = (ctx = await setup());
    await c.ticket("in_progress");
    await c.ticket("review");
    await c.ticket("blocked");
    await c.ticket("done");
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("'No limit' never holds", async () => {
    const c = (ctx = await setup());
    await c.setLimits({ agent: null });
    await holding(c, 5);
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("the whole-company limit holds when it is on", async () => {
    const c = (ctx = await setup());
    await c.setLimits({ agent: null, company: 1 });
    await c.ticket("in_progress");
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.held).toMatch(/the company is at the limit of 1/);
    expect(r.ticket.systemState).toBe("ready");
  });
});

describe("never block finishing; urgent may go over", () => {
  it("returning from review to in progress is never held, even at the limit", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("review");
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("a blocker clearing on a ticket already started: ready again, started before, restarts past the limit", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("in_progress");
    await moveTicket(c.db, t.id, "in_progress", { internal: true }); // already there: records nothing
    await c.db.insert(activity).values({ companyId: c.company.id, ticketId: t.id, kind: "state", summary: "ready -> in_progress: Boss Man: started on the wake" });
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, t.id));
    await holding(c, 2);
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.held).toBeNull();
    expect(r.ticket.systemState).toBe("in_progress");
  });

  it("an urgent ticket starts one over the limit and the history says so", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("ready", { urgent: true });
    const r = await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(r.urgentOver).toBe(true);
    expect(r.ticket.systemState).toBe("in_progress");
    expect(await c.history(t.id)).toEqual([expect.stringContaining("urgent: started over the WIP limit")]);
  });

  it("an agent already over the limit is not bounced: its tickets stay in progress, and nothing new starts", async () => {
    const c = (ctx = await setup());
    const ids = await holding(c, 4);
    const t = await c.ticket("ready");
    await moveTicket(c.db, t.id, "in_progress", { internal: true, overLimit: true });
    expect(await agentWipCount(c.db, c.worker.id)).toBe(4);
    for (const id of ids) expect((await c.row(id)).systemState).toBe("in_progress");
  });

  it("the owner's override (overLimit, not internal) starts it anyway", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("ready");
    const r = await moveTicket(c.db, t.id, "in_progress", { overLimit: true });
    expect(r.ticket.systemState).toBe("in_progress");
  });
});

describe("a freed slot starts the held ticket by itself", () => {
  it("one in-progress ticket goes to review: the next pass wakes the agent and the held ticket starts", async () => {
    const c = (ctx = await setup());
    const [first] = await holding(c, 2);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    expect((await c.row(t.id)).systemState).toBe("ready");
    // The run the held wake launched has ended; one of the agent's tickets goes to review.
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.agentId, c.worker.id));
    await moveTicket(c.db, first!, "review", { internal: true });
    // The sweep (BOS-1180's one start step) wakes the agent on the held ticket; the next tick launches it.
    const swept = await c.sweeps.run();
    await c.scheduler.tick();
    const after = await c.row(t.id);
    expect(swept.idleSlots).toBeDefined();
    expect(after.systemState).toBe("in_progress");
    expect(after.stateNote).toBeNull();
    expect(after.wipHeldAt).toBeNull();
  });

  // BOS-1180 gap 1: the hold used to live in the state note, so any later note erased it and nothing restarted the ticket.
  it("the hold is a field: the agent rewrites the state note, and the ticket still starts when room frees", async () => {
    const c = (ctx = await setup());
    const [first] = await holding(c, 2);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    const held = await c.row(t.id);
    expect(held.systemState).toBe("ready");
    expect(held.wipHeldAt).not.toBeNull();
    // The agent's own summary replaces the Waiting note (as BOS-1138's did) via set_ticket_state on the same state.
    const client = await c.mcp(c.worker.id);
    await client.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "ready", summary: "Plan approved. It starts by itself when a place frees." } });
    const rewritten = await c.row(t.id);
    expect(rewritten.stateNote).toMatch(/starts by itself/);
    expect(rewritten.wipHeldAt?.getTime()).toBe(held.wipHeldAt!.getTime());
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.agentId, c.worker.id));
    await moveTicket(c.db, first!, "review", { internal: true });
    await c.sweeps.run();
    await c.scheduler.tick();
    expect((await c.row(t.id)).systemState).toBe("in_progress");
  });

  it("a wake the limit refused is marked, so it is not counted against the daily idle-slot allowance", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: IDLE_SLOT_REASON, note: "A run slot is free." });
    await c.scheduler.tick();
    const [w] = await c.db.select().from(wakes).where(eq(wakes.ticketId, t.id));
    expect(w).toMatchObject({ status: "launched", statusReason: WIP_REFUSED_REASON });
  });
});

describe("the tools say it is queued in Ready", () => {
  it("set_ticket_state to in_progress by the agent at its limit: not started, and the reply says so", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = await c.ticket("ready");
    const client = await c.mcp(c.worker.id);
    const out = c.reply(await client.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress" } }));
    expect(out).toContain("did not start");
    expect((await c.row(t.id)).systemState).toBe("ready");
  });

  it("assign_ticket by the CEO to an agent at its limit says it is queued in Ready", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Unassigned" })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, t.id));
    const ceo = await c.mcp(c.ceo.id);
    const out = c.reply(await ceo.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "Engineer", note: "Please take this." } }));
    expect(out).toContain("Queued in Ready");
  });

  it("create_ticket with an assignee at its limit says it is queued in Ready", async () => {
    const c = (ctx = await setup());
    await holding(c, 2);
    const ceo = await c.mcp(c.ceo.id);
    const out = c.reply(await ceo.callTool({ name: "create_ticket", arguments: { title: "New work", body: "Do the thing. ".repeat(20), assignee: "Engineer", noCode: true, size: 2 } }));
    expect(out).toContain("Queued in Ready");
  });
});

describe("the setting API and the Agents count", () => {
  it("PUT /api/wip-limits saves a number or null, and refuses nonsense", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", "/api/wip-limits")).json()).toEqual({ agent: 2, company: null, defaultAgent: 2 });
    expect((await c.req("PUT", "/api/wip-limits", { agent: 3, company: 20 })).json()).toMatchObject({ agent: 3, company: 20 });
    expect((await c.req("PUT", "/api/wip-limits", { agent: null, company: null })).json()).toMatchObject({ agent: null, company: null });
    expect((await c.req("GET", "/api/wip-limits")).json()).toMatchObject({ agent: null });
    expect((await c.req("PUT", "/api/wip-limits", { agent: 0, company: null })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await c.req("PUT", "/api/wip-limits", { agent: 1.5, company: null })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("the agents list carries each agent's count and the limit (\"3 / 2\")", async () => {
    const c = (ctx = await setup());
    await holding(c, 3);
    const list = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as { id: string; wipCount: number; wipLimit: number | null }[];
    expect(list.find((a) => a.id === c.worker.id)).toMatchObject({ wipCount: 3, wipLimit: 2 });
  });
});

describe("the setting", () => {
  it("is read from wip_limits; absent means 2 per agent and no company limit", async () => {
    const c = (ctx = await setup());
    const { readWipLimits } = await import("../src/services/agent-wip.js");
    expect(await readWipLimits(c.db)).toEqual({ agent: 2, company: null });
    await c.setLimits({ agent: null });
    expect(await readWipLimits(c.db)).toEqual({ agent: null, company: null });
  });
});
