import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const EMPTY: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "a".repeat(40), commits: [], files: [], diff: "", truncated: false };

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { ...EMPTY, head: "b".repeat(40), files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff" } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "Nothing taken." } }));
    return true;
  });
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Second Claude account", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x", ...patch }).returning())[0]!;
  return { ...built, db, close, base, req, co, dev, project, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function agentFor(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("a ticket carries the owner's setup steps (DR-011)", () => {
  it("create_ticket advertises ownerSetup and stores it", async () => {
    const c = await agentFor(ctx.dev.id);
    const tool = (await c.listTools()).tools.find((x) => x.name === "create_ticket")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("ownerSetup");
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "Second account", ownerSetup: "Settings → Funding → Add account" } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    expect((await row(id)).ownerSetup).toBe("Settings → Funding → Add account");
  });

  it("the ticket's own author sets it with set_ticket_state, and the move-to-review reply reminds them when it's missing", async () => {
    const c = await agentFor(ctx.dev.id);
    const t = await ctx.ticket();
    const moved = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it." } }));
    expect(moved).toMatch(/has to do anything once this is live/);
    expect((await row(t.id)).ownerSetup).toBeNull();
    // Another move can carry the steps; the field is theirs to write.
    await ctx.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, t.id));
    textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it.", ownerSetup: "Settings → Funding → Add account\nSign in to the second plan" } }));
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add account\nSign in to the second plan");
  });

  it("the ticket read shows the steps to a reviewer, and the diff looks at them", async () => {
    const t = await ctx.ticket({ ownerSetup: "Settings → Funding → Add account" });
    const c = await agentFor(ctx.dev.id);
    const read = textOf(await c.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }));
    expect(read).toContain("After it goes live, the owner will need to");
    expect(read).toContain("Settings → Funding → Add account");
  });

  it("the owner's web form saves and clears the steps", async () => {
    const t = await ctx.ticket();
    expect((await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "Settings → Funding → Add account" })).statusCode).toBe(200);
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add account");
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { ownerSetup: "" });
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("a worker can't set it on a ticket that isn't theirs", async () => {
    const other = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Someone else" })).json() as { id: string };
    const t = await ctx.ticket();
    const c = await agentFor(other.id);
    const out = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "x", ownerSetup: "Settings → Funding" } }));
    expect(out).toMatch(/isn't yours/);
    expect((await row(t.id)).ownerSetup).toBeNull();
  });

  it("a manager sets it with update_ticket", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket();
    const c = await agentFor(ctx.dev.id);
    textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, ownerSetup: "Settings → Funding → Add account", reason: "Steps for the owner." } }));
    expect((await row(t.id)).ownerSetup).toBe("Settings → Funding → Add account");
  });
});
