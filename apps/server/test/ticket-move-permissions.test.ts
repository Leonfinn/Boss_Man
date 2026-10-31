// BOS-73: a worker moves only its own tickets with set_ticket_state, and only the CEO or a manager cancels.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, settings, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const alice = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Alice" })).json() as { id: string };
  const bob = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Bob" })).json() as { id: string };
  const lead = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Lead" })).json() as { id: string };
  await db.update(agents).set({ role: "manager" }).where(eq(agents.id, lead.id));
  // No repo, so done needs no review or merge and the role check is all that stands in the way.
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Notes" })).json() as { id: string };
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: "Write the FAQ", systemState: "in_progress", ...patch }).returning())[0]!;
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  return { ...built, db, close, base, req, company, ceo, alice, bob, lead, ticket, row };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function as(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return (args: Record<string, unknown>) => c.callTool({ name: "set_ticket_state", arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

describe("set_ticket_state permissions (BOS-73)", () => {
  it("refuses a worker on another agent's ticket: ordinary moves, done and cancelled", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.bob.id });
    const move = await as(ctx.alice.id);
    for (const args of [{ state: "blocked", summary: "Waiting." }, { state: "ready" }, { state: "done", summary: "Finished." }]) {
      const r = await move({ ticketId: t.id, ...args });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("isn't yours");
    }
    const cancel = await move({ ticketId: t.id, state: "done", outcome: "cancelled", summary: "Duplicate." });
    expect(cancel.isError).toBe(true);
    expect(cancel.content[0]!.text).toContain("Only your CEO or a manager can cancel");
    expect(await ctx.row(t.id)).toMatchObject({ systemState: "in_progress", outcome: null, version: t.version });
  });

  it("lets a worker move its own ticket, but not cancel it", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.alice.id });
    const move = await as(ctx.alice.id);
    expect((await move({ ticketId: t.id, state: "done", outcome: "cancelled", summary: "Not needed." })).isError).toBe(true);
    expect((await move({ ticketId: t.id, state: "ready" })).content[0]!.text).toContain("is now ready");
    expect((await move({ ticketId: t.id, state: "done", summary: "Written." })).content[0]!.text).toContain("is now done");
    expect(await ctx.row(t.id)).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  it("lets a worker move a sub-task of its own ticket, and an unassigned ticket it created, but not one someone else created", async () => {
    const parent = await ctx.ticket({ assigneeAgentId: ctx.alice.id });
    const sub = await ctx.ticket({ parentTicketId: parent.id, assigneeAgentId: ctx.bob.id });
    const mine = await ctx.ticket({ createdByAgentId: ctx.alice.id });
    const theirs = await ctx.ticket({ createdByAgentId: ctx.bob.id });
    const move = await as(ctx.alice.id);
    expect((await move({ ticketId: sub.id, state: "ready" })).isError).toBeFalsy();
    expect((await move({ ticketId: mine.id, state: "ready" })).isError).toBeFalsy();
    expect((await move({ ticketId: theirs.id, state: "ready" })).isError).toBe(true);
    // Bob, the sub-task's assignee, can't move Alice's parent.
    expect((await (await as(ctx.bob.id))({ ticketId: parent.id, state: "ready" })).isError).toBe(true);
  });

  it("still lets the CEO and a manager cancel anyone's ticket", async () => {
    const a = await ctx.ticket({ assigneeAgentId: ctx.bob.id });
    const b = await ctx.ticket({ assigneeAgentId: ctx.alice.id });
    expect((await (await as(ctx.ceo.id))({ ticketId: a.id, state: "done", outcome: "cancelled", summary: "Duplicate of the FAQ ticket." })).isError).toBeFalsy();
    expect((await (await as(ctx.lead.id))({ ticketId: b.id, state: "done", outcome: "cancelled", summary: "Dropped by the owner." })).isError).toBeFalsy();
    expect(await ctx.row(a.id)).toMatchObject({ systemState: "done", outcome: "cancelled" });
    expect(await ctx.row(b.id)).toMatchObject({ systemState: "done", outcome: "cancelled" });
  });

  it("tells the agent to end its turn while a runner update waits", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.alice.id });
    const move = await as(ctx.alice.id);
    expect((await move({ ticketId: t.id, state: "ready" })).content[0]!.text).not.toContain("end your turn");
    await ctx.db.insert(settings).values({ key: "maintenance", value: { reason: "runner update" } });
    expect((await move({ ticketId: t.id, state: "done", summary: "Written." })).content[0]!.text).toContain("end your turn now");
  });

  it("leaves the owner's moves alone", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.bob.id });
    expect((await ctx.req("POST", `/api/tickets/${t.id}/state`, { state: "ready" })).statusCode).toBe(200);
    expect(await ctx.row(t.id)).toMatchObject({ systemState: "ready" });
  });
});
