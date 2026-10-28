import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { deploys, features, ticketDependencies, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const other = (await req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const p = await built.work.createProject(co.company.id, "App");
  const op = await built.work.createProject(other.company.id, "Theirs");
  const feature = async (companyId = co.company.id, title = "Dark mode") => (await req("POST", `/api/companies/${companyId}/features`, { title })).json() as { id: string };
  const status = async (id: string) => (await db.select().from(features).where(eq(features.id, id)))[0]!.status;
  return { ...built, db, close, base, co, other, p, op, req, feature, status };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
async function agent(agentId: string, companyId = ctx.co.company.id) {
  const token = await issueRunToken(ctx.db, { companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const move = (id: string, state: string) => ctx.req("PATCH", `/api/tickets/${id}`, { state });

describe("feature status follows its tasks", () => {
  it("starts, releases when all tasks are done, reopens, and never touches declined", async () => {
    const f = await ctx.feature();
    const a = await ctx.work.createTicket(ctx.p.id, { title: "A", featureId: f.id });
    const b = await ctx.work.createTicket(ctx.p.id, { title: "B", featureId: f.id });
    expect(await ctx.status(f.id)).toBe("idea");
    await move(a.id, "in_progress");
    expect(await ctx.status(f.id)).toBe("in_progress");
    await move(a.id, "done");
    expect(await ctx.status(f.id)).toBe("in_progress");
    await move(b.id, "done");
    expect(await ctx.status(f.id)).toBe("released");
    await move(b.id, "in_progress");
    expect(await ctx.status(f.id)).toBe("in_progress");
    expect((await ctx.db.select().from(features).where(eq(features.id, f.id)))[0]!.releasedAt).toBeNull();

    const d = await ctx.feature(ctx.co.company.id, "Declined one");
    await ctx.req("PATCH", `/api/features/${d.id}`, { status: "declined" });
    const t = await ctx.work.createTicket(ctx.p.id, { title: "C", featureId: d.id });
    await move(t.id, "in_progress");
    await move(t.id, "done");
    expect(await ctx.status(d.id)).toBe("declined");
  });

  it("starting via the scheduler and set_ticket_state moves the feature too", async () => {
    const f = await ctx.feature();
    const t = await ctx.work.createTicket(ctx.p.id, { title: "A", featureId: f.id, assigneeAgentId: ctx.co.ceo.id, state: "ready" });
    const c = await agent(ctx.co.ceo.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress" } });
    expect(await ctx.status(f.id)).toBe("in_progress");
    await c.close();
  });

  it("waits for a successful production deploy when the company has a production target", async () => {
    const f = await ctx.feature();
    const t = await ctx.work.createTicket(ctx.p.id, { title: "A", featureId: f.id });
    await ctx.req("POST", `/api/companies/${ctx.co.company.id}/deploy-targets`, { name: "Prod", kind: "ssh", endpoint: "deploy@nas.lan", isProduction: true });
    await move(t.id, "done");
    expect(await ctx.status(f.id)).toBe("in_progress");
    const [target] = await ctx.deploys.listTargets(ctx.co.company.id);
    const [d] = await ctx.db.insert(deploys).values({ companyId: ctx.co.company.id, targetId: target!.id, ticketId: t.id, ref: "v1", status: "running" }).returning();
    await ctx.deploys.report({ companyId: ctx.co.company.id }, { deployId: d!.id, outcome: "succeeded" });
    expect(await ctx.status(f.id)).toBe("released");
  });
});

describe("sub-tasks", () => {
  it("adds a dependency, blocks the parent and inherits the feature", async () => {
    const f = await ctx.feature();
    const parent = await ctx.work.createTicket(ctx.p.id, { title: "Parent", featureId: f.id, state: "in_progress" });
    const child = await ctx.work.createTicket(ctx.p.id, { title: "Infra help", parentTicketId: parent.id });
    expect(child).toMatchObject({ parentTicketId: parent.id, featureId: f.id });
    expect((await ctx.db.select().from(ticketDependencies))[0]).toMatchObject({ blockedTicketId: parent.id, blockerTicketId: child.id });
    expect((await row(parent.id)).systemState).toBe("blocked");
    await move(child.id, "done");
    await ctx.scheduler.onTicketDone(child.id);
    expect((await row(parent.id)).systemState).toBe("ready");
  });

  it("refuses depth 2 and a parent from another company", async () => {
    const parent = await ctx.work.createTicket(ctx.p.id, { title: "Parent" });
    const child = await ctx.work.createTicket(ctx.p.id, { title: "Child", parentTicketId: parent.id });
    await expect(ctx.work.createTicket(ctx.p.id, { title: "Grandchild", parentTicketId: child.id })).rejects.toThrow(/can't have sub-tasks/);
    const theirs = await ctx.work.createTicket(ctx.op.id, { title: "Theirs" });
    await expect(ctx.work.createTicket(ctx.p.id, { title: "X", parentTicketId: theirs.id })).rejects.toThrow(/isn't in this company/);
  });
});

describe("create_ticket with feature and parent", () => {
  it("resolves a feature by exact title or id, and makes sub-tasks", async () => {
    const f = await ctx.feature();
    const c = await agent(ctx.co.ceo.id);
    const byTitle = await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "Build it", feature: "dark MODE" } });
    expect(byTitle.isError).toBeFalsy();
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.title, "Build it"));
    expect(t!.featureId).toBe(f.id);
    expect((await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "By id", feature: f.id } })).isError).toBeFalsy();
    expect((await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "Nope", feature: "No such" } })).isError).toBe(true);

    const sub = await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "Need infra", parent: t!.id } });
    expect(sub.isError).toBeFalsy();
    const [s] = await ctx.db.select().from(tickets).where(eq(tickets.title, "Need infra"));
    expect(s).toMatchObject({ parentTicketId: t!.id, featureId: f.id });
    expect(await ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerTicketId, s!.id))).toHaveLength(1);
    const deep = await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "Deeper", parent: s!.id } });
    expect(deep.isError).toBe(true);
    expect(textOf(deep)).toMatch(/can't have sub-tasks/);
    await c.close();
  });

  it("refuses another company's feature and parent", async () => {
    const theirs = await ctx.feature(ctx.other.company.id, "Theirs");
    const theirTask = await ctx.work.createTicket(ctx.op.id, { title: "Theirs" });
    const c = await agent(ctx.co.ceo.id);
    expect((await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "x", feature: theirs.id } })).isError).toBe(true);
    expect((await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "x", featureId: theirs.id } })).isError).toBe(true);
    expect((await c.callTool({ name: "create_ticket", arguments: { size: 3, title: "x", parent: theirTask.id } })).isError).toBe(true);
    await c.close();
  });
});
