import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, projects, ticketDependencies, tickets, workflowColumns } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const [p] = await db.insert(projects).values({ companyId: co.company.id, name: "Customer app" }).returning();
  const [t] = await db.insert(tickets).values({ companyId: co.company.id, projectId: p!.id, title: "Add rate limiting", systemState: "in_progress" }).returning();
  return { ...built, db, close, base, co, ticketId: t!.id };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const row = async () => (await ctx.db.select().from(tickets).where(eq(tickets.id, ctx.ticketId)))[0]!;
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

async function agent() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

describe("ticket versions (R81)", () => {
  it("bumps on a meaningful change and not on bookkeeping", async () => {
    expect((await row()).version).toBe(1);
    await ctx.db.update(tickets).set({ lastActivityAt: new Date(), watchedAt: new Date(), costCapMicros: 5_000_000 }).where(eq(tickets.id, ctx.ticketId));
    expect((await row()).version).toBe(1);
    await ctx.db.update(tickets).set({ title: "Add rate limiting to the API" }).where(eq(tickets.id, ctx.ticketId));
    expect((await row()).version).toBe(2);
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.co.ceo.id, risk: "high" }).where(eq(tickets.id, ctx.ticketId));
    expect((await row()).version).toBe(3);
  });

  it("refuses a stale expected_version, changes nothing, and says what the ticket is now", async () => {
    const c = await agent();
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.co.ceo.id }).where(eq(tickets.id, ctx.ticketId));
    const res = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ctx.ticketId, state: "review", expected_version: 1, summary: "Ready." } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/changed since you last saw it/);
    expect(textOf(res)).toMatch(/in_progress.*version 2/);
    expect(textOf(res)).toMatch(/assigned to \S/);
    const t = await row();
    expect(t).toMatchObject({ systemState: "in_progress", version: 2 });
    await c.close();
  });

  it("moves the ticket and bumps its version when expected_version matches", async () => {
    const c = await agent();
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ctx.ticketId, state: "review", expected_version: 1, summary: "Ready." } }))).toMatch(/now review/);
    expect(await row()).toMatchObject({ systemState: "review", version: 2 });
    // The version the agent had is now stale.
    expect((await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ctx.ticketId, state: "done", expected_version: 1, summary: "Finished." } })).isError).toBe(true);
    await c.close();
  });

  it("refuses blocked with nothing open holding the ticket, and points to raise_decision", async () => {
    const c = await agent();
    const res = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ctx.ticketId, state: "blocked", summary: "Waiting on the owner to run X." } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/raise_decision with blocksTicketId/);
    expect((await row()).systemState).toBe("in_progress");
    await c.close();
  });

  it("shows an open owner sign-off on the owner lane even when the ticket is not in review", async () => {
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.co.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", dedupeKey: "k1", context: { type: "risk_review", ticketId: ctx.ticketId, reviewer: "Senior Developer" } }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: ctx.ticketId, blockerDecisionId: d!.id });
    const projectId = (await row()).projectId;
    await ctx.db.insert(workflowColumns).values({ projectId, name: "In progress", systemState: "in_progress", position: 0 });
    const board = await ctx.work.board(projectId);
    expect(board.columns.flatMap((c) => c.tickets).find((x) => x.id === ctx.ticketId)?.waitingOnOwner).toBe(true);
  });

  it("still works without expected_version, and agents are shown the version", async () => {
    const c = await agent();
    const [blocker] = await ctx.db.insert(tickets).values({ companyId: ctx.co.company.id, projectId: (await row()).projectId, title: "Other", systemState: "in_progress" }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: ctx.ticketId, blockerTicketId: blocker!.id });
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: ctx.ticketId, state: "blocked", summary: "Waiting on a key." } }))).toMatch(/now blocked/);
    expect((await row()).version).toBe(2);
    expect(textOf(await c.callTool({ name: "tickets", arguments: { action: "read", ticketId: ctx.ticketId } }))).toContain("Version: 2");
    expect(textOf(await c.callTool({ name: "tickets", arguments: { action: "find" } }))).toContain('"version":2');
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.co.ceo.id }).where(eq(tickets.id, ctx.ticketId));
    expect(textOf(await c.callTool({ name: "list_my_work", arguments: {} }))).toContain('"version":3');
    await c.close();
  });
});
