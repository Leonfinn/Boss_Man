import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, projects, runners, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev", template: "engineer" })).json() as { id: string };
  const [p] = await db.insert(projects).values({ companyId: co.company.id, name: "Customer app" }).returning();
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  void runnerRow;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: p!.id, title: "Add rate limiting", systemState: "ready", ...patch }).returning())[0]!;
  return { ...built, db, close, base, co, dev, commands, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
async function agent(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const assignedWakes = (agentId: string) => ctx.db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.reason, "assigned")));

describe("CEO delegation", () => {
  it("assign_ticket hands the ticket to a worker, wakes them and leaves the note", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    const c = await agent(ctx.co.ceo.id);
    const stale = await c.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "dev", note: "Needs code.", expected_version: 99 } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/changed since you last saw it/);
    const none = await c.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "Nobody", note: "x" } });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/Valid names: .*Dev/);
    expect((await row(t.id)).assigneeAgentId).toBe(ctx.co.ceo.id);

    const ok = await c.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "dev", note: "Needs code; start with the limiter.", expected_version: t.version } });
    expect(ok.isError).toBeFalsy();
    expect(await row(t.id)).toMatchObject({ assigneeAgentId: ctx.dev.id, stateNote: "Needs code; start with the limiter." });
    expect(await assignedWakes(ctx.dev.id)).toHaveLength(1);
    await c.close();
  });

  it("refuses a paused agent, and a worker can't assign", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.dev.id));
    const ceo = await agent(ctx.co.ceo.id);
    const paused = await ceo.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "Dev", note: "x" } });
    expect(paused.isError).toBe(true);
    expect(textOf(paused)).toMatch(/paused/);
    await ceo.close();

    await ctx.db.update(agents).set({ paused: false }).where(eq(agents.id, ctx.dev.id));
    const dev = await agent(ctx.dev.id);
    const res = await dev.callTool({ name: "assign_ticket", arguments: { ticketId: t.id, agent: "Dev", note: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Only your company's CEO or a manager/);
    const made = await dev.callTool({ name: "create_ticket", arguments: { title: "Sub task", assignee: "Dev" } });
    expect(made.isError).toBe(true);
    await dev.close();
  });

  it("create_ticket with an assignee assigns and wakes", async () => {
    const c = await agent(ctx.co.ceo.id);
    const res = await c.callTool({ name: "create_ticket", arguments: { title: "Build the limiter", assignee: "Dev" } });
    expect(res.isError).toBeFalsy();
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.title, "Build the limiter"));
    expect(t!.assigneeAgentId).toBe(ctx.dev.id);
    expect(await assignedWakes(ctx.dev.id)).toHaveLength(1);
    await c.close();
  });

  it("the CEO's ticket prompt has the delegate rule and team; a worker's does not", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    const t2 = await ctx.ticket({ assigneeAgentId: ctx.dev.id, title: "Other" });
    await ctx.scheduler.wake({ agentId: ctx.co.ceo.id, reason: "assigned", ticketId: t.id });
    await ctx.scheduler.wake({ agentId: ctx.dev.id, reason: "assigned", ticketId: t2.id });
    await ctx.scheduler.tick();
    const ceoPrompt = ctx.commands.find((x) => x.agentId === ctx.co.ceo.id)!.prompt;
    const devPrompt = ctx.commands.find((x) => x.agentId === ctx.dev.id)!.prompt;
    expect(ceoPrompt).toContain("assign_ticket");
    expect(ceoPrompt).toMatch(/Your team: Dev \(Engineer\)/);
    expect(ceoPrompt).toContain("never as loose files");
    expect(devPrompt).not.toContain("assign_ticket");
    expect(devPrompt).not.toContain("Your team:");
    expect(devPrompt).toContain("never as loose files");
  });
});
