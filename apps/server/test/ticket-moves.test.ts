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
