// BOS-2115: create_ticket refuses once when open or recently done tickets in the project have a
// similar title; notDuplicateOf returns that ticket, notDuplicateReason is kept on the new one.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { similarTitles } from "../src/services/duplicate-titles.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Dup Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Record<string, unknown>) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "x", ...patch }).returning())[0]!;
  const token = await issueRunToken(db, { companyId: co.company.id, agentId: co.ceo.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  const create = async (args: Record<string, unknown>) => {
    const r = (await c.callTool({ name: "create_ticket", arguments: { size: 2, risk: "low", ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
    return { error: !!r.isError, text: r.content[0]?.text ?? "" };
  };
  return { db, co, ticket, create, done: async () => { await Promise.all(clients.map((x) => x.close())); } };
}

beforeAll(async () => { server = await boot(); }, 120_000);
afterAll(async () => { await server.built.app.close(); await server.close(); });
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.done(); });

const count = async () => (await ctx.db.select().from(tickets).where(eq(tickets.companyId, ctx.co.company.id))).length;

describe("similar titles", () => {
  it("matches shared key words and ignores common ones", () => {
    expect(similarTitles("Board fix: stuck cards stay in Review", "Board: stuck cards stay in review after merge")).toBe(true);
    expect(similarTitles("Add a ticket", "Fix a ticket")).toBe(false);
    expect(similarTitles("Phone push notifications for owner cards", "Website feed for release notes")).toBe(false);
  });
});

describe("create_ticket duplicate check", () => {
  it("refuses once with the similar open and recently done tickets, then creates with a reason kept on the ticket", async () => {
    const open = await ctx.ticket({ title: "Board shows stuck cards in review column", systemState: "in_progress" });
    const recent = await ctx.ticket({ title: "Stuck cards in review column on board fixed", systemState: "done", outcome: "completed" });
    await ctx.ticket({ title: "Stuck cards in review column on board, old", systemState: "done", outcome: "completed", stateChangedAt: new Date(Date.now() - 20 * 24 * 3_600_000) });
    const first = await ctx.create({ title: "Board stuck cards in review column again", body: "Details" });
    expect(first.error).toBe(true);
    expect(first.text).toContain(open.title);
    expect(first.text).toContain(recent.title);
    expect(first.text).not.toContain("old\"");
    expect(await count()).toBe(3);
    const second = await ctx.create({ title: "Board stuck cards in review column again", body: "Details", notDuplicateReason: "This one is about the phone layout" });
    expect(second.error).toBe(false);
    const made = (await ctx.db.select().from(tickets).where(eq(tickets.companyId, ctx.co.company.id))).find((t) => t.title === "Board stuck cards in review column again")!;
    expect(made.body).toContain("This one is about the phone layout");
  });

  it("notDuplicateOf creates nothing and returns that ticket", async () => {
    const t = await ctx.ticket({ title: "Board shows stuck cards in review column", systemState: "in_progress" });
    const before = await count();
    const r = await ctx.create({ title: "Board stuck cards in review column again", notDuplicateOf: `T-${t.number}` });
    expect(r.text).toContain("No new ticket was created");
    expect(r.text).toContain(t.id);
    expect(await count()).toBe(before);
  });

  it("does not refuse an unrelated title, a cancelled ticket or a sub-task", async () => {
    await ctx.ticket({ title: "Board shows stuck cards in review column", systemState: "done", outcome: "cancelled" });
    expect((await ctx.create({ title: "Board stuck cards in review column again" })).error).toBe(false);
    const parent = await ctx.ticket({ title: "Phone notifications overhaul", systemState: "in_progress" });
    await ctx.ticket({ title: "Phone notifications sound choices", systemState: "in_progress" });
    expect((await ctx.create({ title: "Phone notifications sound choices extra", parent: parent.id })).error).toBe(false);
    expect((await ctx.create({ title: "Website release feed" })).error).toBe(false);
  });
});
