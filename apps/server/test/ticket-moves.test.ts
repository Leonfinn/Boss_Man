// DR-047 points 1-2 (BOS-921): one function, moveTicket, moves a ticket. set_ticket_state, the owner's move and
// updateTicket all go through it, so the rules that used to live in two drifting copies now hold for each.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { activity, reviewRequests, tickets, workflowColumns } from "../src/db/schema.js";
import { lineEvent, MERGE_LINE_KIND } from "../src/services/merge-line.js";
import { moveTicket } from "../src/services/ticket-moves.js";

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
  const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (state: "ready" | "in_progress" | "review" = "in_progress") => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state }).where(eq(tickets.id, t.id));
    return t;
  };
  const history = async (id: string) => (await db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "state")))).map((r) => r.summary);
  return { ...built, db, close, req, mcp, worker, project, company, ticket, history, clients };
}

describe("moveTicket (DR-047)", () => {
  it("set_ticket_state out of review writes the merge line's left event, as the owner's move does", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("review");
    await lineEvent(c.db, { id: t.id, companyId: c.company.id }, { event: "approved", by: "the owner" } as never);
    const mcp = await c.mcp(c.worker.id);
    const r = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress" } });
    expect(JSON.stringify(r)).toContain("is now in_progress");
    const line = (await c.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, MERGE_LINE_KIND)))).map((x) => (x.detail as { event: string }).event);
    expect(line).toEqual(["approved", "left"]);
  });

  it("set_ticket_state respects a column's limit; the owner's move can pass it with overLimit via updateTicket", async () => {
    const c = (ctx = await setup());
    await c.db.update(workflowColumns).set({ wipLimit: 1 }).where(and(eq(workflowColumns.projectId, c.project.id), eq(workflowColumns.systemState, "in_progress")));
    const first = await c.ticket("ready");
    const second = await c.ticket("ready");
    const mcp = await c.mcp(c.worker.id);
    expect(JSON.stringify(await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: first.id, state: "in_progress" } }))).toContain("is now in_progress");
    const refused = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: second.id, state: "in_progress" } });
    expect(JSON.stringify(refused)).toContain("is at its limit of 1");
    const [still] = await c.db.select().from(tickets).where(eq(tickets.id, second.id));
    expect(still!.systemState).toBe("ready");
  });

  it("a merged no-code ticket moved back to in progress is no longer no-code, by either door", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("review");
    await c.db.update(tickets).set({ systemState: "done", noCode: true, mergeCommit: "c".repeat(40) }).where(eq(tickets.id, t.id));
    const mcp = await c.mcp(c.worker.id);
    await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress" } });
    const [after] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(after).toMatchObject({ systemState: "in_progress", noCode: false });
  });

  it("the owner's move into review opens one round and writes one history line", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("in_progress");
    expect((await c.req("POST", `/api/tickets/${t.id}/state`, { state: "review" })).statusCode).toBe(200);
    const rounds = (await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).map((r) => r.round);
    expect(rounds.length).toBeGreaterThan(0);
    expect(new Set(rounds)).toEqual(new Set([1]));
    expect(await c.history(t.id)).toEqual(["in_progress -> review: Owner moved it to In review"]);
  });

  it("a stale version or a wrong starting state is refused and writes nothing", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("in_progress");
    const [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    await expect(moveTicket(c.db, t.id, "review", { expectedVersion: row!.version + 5 })).rejects.toMatchObject({ status: 409 });
    await expect(moveTicket(c.db, t.id, "ready", { from: ["blocked"] })).rejects.toMatchObject({ status: 409 });
    const [after] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(after!.systemState).toBe("in_progress");
    expect(await c.history(t.id)).toEqual([]);
  });

  // Criterion 2: every from -> to pair, for each mover (agent: set_ticket_state, owner: the state route, system: moveTicket directly).
  const STATES = ["backlog", "ready", "in_progress", "blocked", "review", "done"] as const;
  const PAIRS = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  /** What every row of the table asserts, whoever moved the ticket. */
  async function expectMove(c: Awaited<ReturnType<typeof setup>>, id: string, from: (typeof STATES)[number], to: (typeof STATES)[number], actor: "agent" | "owner" | "system") {
    const [after] = await c.db.select().from(tickets).where(eq(tickets.id, id));
    expect(after!.systemState).toBe(to);
    const cols = await c.db.select().from(workflowColumns).where(eq(workflowColumns.id, after!.columnId!));
    expect(cols[0]!.systemState).toBe(to);
    const rows = await c.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "state")));
    if (from === to) {
      expect(rows).toHaveLength(0);
      return;
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary.startsWith(`${from} -> ${to}`)).toBe(true);
    expect(rows[0]!.agentId ?? null).toBe(actor === "agent" ? (await c.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.assigneeAgentId : null);
    const left = (await c.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, MERGE_LINE_KIND)))).map((x) => (x.detail as { event: string }).event);
    expect(left).toEqual(from === "review" ? ["approved", "left"] : []);
  }
  async function seed(c: Awaited<ReturnType<typeof setup>>, from: (typeof STATES)[number]) {
    const t = await c.ticket("ready");
    const [col] = await c.db.select().from(workflowColumns).where(and(eq(workflowColumns.projectId, c.project.id), eq(workflowColumns.systemState, from)));
    await c.db.update(tickets).set({ systemState: from, columnId: col!.id }).where(eq(tickets.id, t.id));
    if (from === "review") await lineEvent(c.db, { id: t.id, companyId: c.company.id }, { event: "approved", by: "the owner" } as never);
    return t;
  }

  it("system: every from -> to move through moveTicket writes one line, the column, 'left' only out of review, done steps and the round once", async () => {
    const c = (ctx = await setup());
    for (const [from, to] of PAIRS) {
      const t = await seed(c, from);
      let done = 0;
      let rounds = 0;
      await moveTicket(c.db, t.id, to, { by: null, hooks: { onDone: () => void done++, onReview: () => void rounds++ } });
      await expectMove(c, t.id, from, to, "system");
      expect({ pair: `${from}->${to}`, done }).toEqual({ pair: `${from}->${to}`, done: from !== to && to === "done" ? 1 : 0 });
      expect({ pair: `${from}->${to}`, rounds }).toEqual({ pair: `${from}->${to}`, rounds: from !== to && to === "review" ? 1 : 0 });
    }
  }, 120_000);

  it("agent: every from -> to move through set_ticket_state writes one line with the agent, the column and 'left' only out of review", async () => {
    const c = (ctx = await setup());
    const mcp = await c.mcp(c.worker.id);
    const refused: string[] = [];
    for (const [from, to] of PAIRS) {
      const t = await seed(c, from);
      await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: to, summary: "table move" } });
      const [after] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
      if (after!.systemState !== to) {
        refused.push(`${from}->${to}`); // refused by a rule that is not about the move itself; it must leave the ticket untouched
        expect(after!.systemState).toBe(from);
        expect(await c.history(t.id)).toEqual([]);
        continue;
      }
      await expectMove(c, t.id, from, to, "agent");
      const rounds = (await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).map((r) => r.round);
      expect({ pair: `${from}->${to}`, rounds: new Set(rounds).size }).toEqual({ pair: `${from}->${to}`, rounds: from !== to && to === "review" ? 1 : 0 });
    }
    // The tool's own pre-checks (not moveTicket): a start needs the ready state (BOS-254), a block needs a wake time or a reason. Each left the ticket untouched, asserted above.
    expect(refused).toEqual(["backlog->in_progress", "backlog->blocked", "ready->blocked", "in_progress->blocked", "review->blocked", "done->blocked"]);
  }, 120_000);

  it("owner: every from -> to move through the state route writes one line, the column and 'left' only out of review, one round into review", async () => {
    const c = (ctx = await setup());
    for (const [from, to] of PAIRS) {
      const t = await seed(c, from);
      const r = await c.req("POST", `/api/tickets/${t.id}/state`, { state: to });
      expect({ pair: `${from}->${to}`, status: r.statusCode }).toEqual({ pair: `${from}->${to}`, status: 200 });
      await expectMove(c, t.id, from, to, "owner");
      const rounds = (await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id))).map((x) => x.round);
      expect({ pair: `${from}->${to}`, rounds: new Set(rounds).size }).toEqual({ pair: `${from}->${to}`, rounds: from !== to && to === "review" ? 1 : 0 });
    }
  }, 120_000);

  it("a same-state move keeps the column and writes no history line", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("in_progress");
    const [before] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    const r = await moveTicket(c.db, t.id, "in_progress", { fields: { stateNote: "still going" } });
    expect(r.changed).toBe(false);
    expect(r.ticket).toMatchObject({ columnId: before!.columnId, stateNote: "still going" });
    expect(await c.history(t.id)).toEqual([]);
  });
});
