import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, features, projects, runners, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
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
  return { ...built, db, close, base, co, dev, commands, ticket, req };
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
    // The activity row names the CEO as the assigner, so the Workflow page can show the CEO -> Dev handoff.
    const [log] = await ctx.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "assigned")));
    expect(log!.agentId).toBe(ctx.co.ceo.id);
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

  it("a QA task that waitsOn its build waits blocked and wakes its assignee when the build is done", async () => {
    const build = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    const c = await agent(ctx.co.ceo.id);
    expect((await c.callTool({ name: "create_ticket", arguments: { title: "x", waitsOn: randomUUID() } })).isError).toBe(true);
    const res = await c.callTool({ name: "create_ticket", arguments: { title: "QA the limiter", assignee: "Dev", waitsOn: build.id } });
    expect(res.isError).toBeFalsy();
    const [qa] = await ctx.db.select().from(tickets).where(eq(tickets.title, "QA the limiter"));
    expect(qa).toMatchObject({ systemState: "blocked", assigneeAgentId: ctx.dev.id });
    expect(await assignedWakes(ctx.dev.id)).toHaveLength(0);
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, build.id));
    await ctx.scheduler.onTicketDone(build.id);
    expect((await row(qa!.id)).systemState).toBe("ready");
    expect(await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.dev.id), eq(wakes.reason, "unblocked")))).toHaveLength(1);
    await c.close();
  });

  it("a feature's plan ticket tells the CEO to keep it and make build and QA tasks", async () => {
    const [f] = await ctx.db.insert(features).values({ companyId: ctx.co.company.id, title: "Empty columns" }).returning();
    const plan = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id, title: "Plan: Empty columns", featureId: f!.id });
    await ctx.scheduler.wake({ agentId: ctx.co.ceo.id, reason: "assigned", ticketId: plan.id });
    await ctx.scheduler.tick();
    expect(ctx.commands.at(-1)!.prompt).toContain("a QA task that waitsOn the build");
  });

  it("the CEO's ticket prompt has the delegate rule and team; a worker's does not", async () => {
    // The PA is read-only, so it is never offered as someone to delegate to.
    const pa = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Assistant", template: "assistant" })).json() as { id: string };
    await ctx.db.update(agents).set({ paused: false }).where(eq(agents.id, pa.id));
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    const t2 = await ctx.ticket({ assigneeAgentId: ctx.dev.id, title: "Other" });
    await ctx.scheduler.wake({ agentId: ctx.co.ceo.id, reason: "assigned", ticketId: t.id });
    await ctx.scheduler.wake({ agentId: ctx.dev.id, reason: "assigned", ticketId: t2.id });
    await ctx.scheduler.tick();
    const ceoPrompt = ctx.commands.find((x) => x.agentId === ctx.co.ceo.id)!.prompt;
    const devPrompt = ctx.commands.find((x) => x.agentId === ctx.dev.id)!.prompt;
    expect(ceoPrompt).toContain("assign_ticket");
    expect(ceoPrompt).toMatch(/Your team: Dev \(Engineer\)\./);
    expect(ceoPrompt).not.toContain("Assistant (");
    expect(ceoPrompt).toContain("never as loose files");
    expect(ceoPrompt).toContain("New functionality is a feature");
    expect(devPrompt).not.toContain("assign_ticket");
    expect(devPrompt).not.toContain("New functionality is a feature");
    expect(devPrompt).not.toContain("Your team:");
    expect(devPrompt).toContain("never as loose files");
  });
});

describe("CEO rates risk", () => {
  const rate = (c: Client, ticketId: string, risk: string) => c.callTool({ name: "set_ticket_risk", arguments: { ticketId, risk, reason: "Touches billing." } });

  it("rates an unrated backlog task, sets plan-first and records why; raises but never lowers", async () => {
    const t = await ctx.ticket({ systemState: "backlog" });
    const c = await agent(ctx.co.ceo.id);
    expect((await rate(c, t.id, "medium")).isError).toBeFalsy();
    expect(await row(t.id)).toMatchObject({ risk: "medium", planFirst: false });
    expect((await rate(c, t.id, "high")).isError).toBeFalsy();
    expect(await row(t.id)).toMatchObject({ risk: "high", planFirst: true });
    const log = await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(log.map((a) => a.summary)).toContain("CEO rated it high: Touches billing.");
    const lower = await rate(c, t.id, "low");
    expect(lower.isError).toBe(true);
    expect(textOf(lower)).toMatch(/only the owner can lower/);
    expect((await row(t.id)).risk).toBe("high");
    await c.close();
  });

  it("leaves a running task's plan-first alone", async () => {
    const t = await ctx.ticket({ systemState: "in_progress" });
    const c = await agent(ctx.co.ceo.id);
    await rate(c, t.id, "critical");
    expect(await row(t.id)).toMatchObject({ risk: "critical", planFirst: false });
    await c.close();
  });

  it("refuses a worker and a ticket from another company", async () => {
    const t = await ctx.ticket();
    const dev = await agent(ctx.dev.id);
    const res = await rate(dev, t.id, "high");
    expect(res.isError).toBe(true);
    expect((await row(t.id)).risk).toBeNull();
    await dev.close();

    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string }; ceo: { id: string } };
    const [op] = await ctx.db.insert(projects).values({ companyId: other.company.id, name: "Theirs" }).returning();
    const [ot] = await ctx.db.insert(tickets).values({ companyId: other.company.id, projectId: op!.id, title: "Theirs", systemState: "ready" }).returning();
    const c = await agent(ctx.co.ceo.id);
    const cross = await rate(c, ot!.id, "high");
    expect(cross.isError).toBe(true);
    expect(textOf(cross)).toMatch(/No ticket with that ID/);
    expect((await row(ot!.id)).risk).toBeNull();
    await c.close();
  });

  it.each([[null, true], ["low", false]] as const)("the CEO's wake prompt for a task rated %s asks for a rating: %s", async (risk, asks) => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id, risk });
    await ctx.scheduler.wake({ agentId: ctx.co.ceo.id, reason: "assigned", ticketId: t.id });
    await ctx.scheduler.tick();
    expect(ctx.commands.at(-1)!.prompt.includes("This ticket has no risk rating yet")).toBe(asks);
  });
});

describe("CEO reorganises tickets", () => {
  const update = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "update_ticket", arguments: { reason: "Backlog review.", ...args } });

  it("moves a ticket with its sub-tasks to another project, keeping state, and records why", async () => {
    const from = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/projects`, { name: "Imported" })).json() as { id: string };
    const to = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/projects`, { name: "Main" })).json() as { id: string };
    const parent = (await ctx.req("POST", `/api/projects/${from.id}/tickets`, { title: "Parent", state: "ready" })).json() as { id: string };
    const kid = (await ctx.req("POST", `/api/projects/${from.id}/tickets`, { title: "Kid" })).json() as { id: string };
    const c = await agent(ctx.co.ceo.id);
    expect((await update(c, { ticketId: kid.id, parentTicketId: parent.id })).isError).toBeFalsy();
    const res = await update(c, { ticketId: parent.id, project: "main" });
    expect(res.isError).toBeFalsy();
    // The parent waits on its open sub-task, and keeps that state in the new project.
    expect(await row(parent.id)).toMatchObject({ projectId: to.id, systemState: "blocked" });
    expect(await row(kid.id)).toMatchObject({ projectId: to.id, parentTicketId: parent.id });
    // Each landed in the new board's column for its state.
    const cols = (await ctx.req("GET", `/api/projects/${to.id}/board`)).json() as { columns: Array<{ id: string }> };
    expect(cols.columns.map((x) => x.id)).toEqual(expect.arrayContaining([(await row(parent.id)).columnId, (await row(kid.id)).columnId]));
    const log = (await ctx.db.select().from(activity).where(eq(activity.ticketId, parent.id))).map((a) => a.summary);
    expect(log).toContain("Moved from Imported to Main, with 1 sub-task");
    expect(log).toContain("CEO reorganised it: Backlog review.");
    // A sub-task alone can't leave its parent's project.
    const back = await update(c, { ticketId: kid.id, project: "Imported" });
    expect(textOf(back)).toMatch(/It is a sub-task/);
    await c.close();
  });

  it("refuses work in progress, a worker, and an empty change; keeps a cancelled outcome", async () => {
    const to = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/projects`, { name: "Main" })).json() as { id: string };
    await ctx.req("POST", `/api/companies/${ctx.co.company.id}/projects`, { name: "Other" });
    const busy = await ctx.ticket({ systemState: "in_progress" });
    const c = await agent(ctx.co.ceo.id);
    expect(textOf(await update(c, { ticketId: busy.id, project: "Main" }))).toMatch(/in progress. Move tickets before work starts/);
    expect(textOf(await update(c, { ticketId: busy.id }))).toMatch(/Nothing to change/);
    const dup = (await ctx.req("POST", `/api/projects/${to.id}/tickets`, { title: "Dup" })).json() as { id: string };
    await ctx.req("POST", `/api/tickets/${dup.id}/state`, { state: "done" });
    await ctx.db.update(tickets).set({ outcome: "cancelled" }).where(eq(tickets.id, dup.id));
    expect((await update(c, { ticketId: dup.id, project: "Other" })).isError).toBeFalsy();
    expect(await row(dup.id)).toMatchObject({ systemState: "done", outcome: "cancelled" });
    const dev = await agent(ctx.dev.id);
    expect(textOf(await update(dev, { ticketId: busy.id, title: "New" }))).toMatch(/Only your company's CEO or a manager/);
    await c.close();
    await dev.close();
  });

  it("puts a ticket under a feature and a parent, and takes it out again", async () => {
    const p = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/projects`, { name: "Main" })).json() as { id: string };
    const [f] = await ctx.db.insert(features).values({ companyId: ctx.co.company.id, title: "Rate limits" }).returning();
    const parent = (await ctx.req("POST", `/api/projects/${p.id}/tickets`, { title: "Parent", featureId: f!.id, state: "ready" })).json() as { id: string };
    const t = (await ctx.req("POST", `/api/projects/${p.id}/tickets`, { title: "Loose" })).json() as { id: string };
    const c = await agent(ctx.co.ceo.id);
    expect((await update(c, { ticketId: t.id, parentTicketId: parent.id, title: "Limiter" })).isError).toBeFalsy();
    expect(await row(t.id)).toMatchObject({ parentTicketId: parent.id, featureId: f!.id, title: "Limiter" });
    expect((await row(parent.id)).systemState).toBe("blocked");
    expect(textOf(await update(c, { ticketId: parent.id, parentTicketId: t.id }))).toMatch(/sub-task/);
    expect((await update(c, { ticketId: t.id, parentTicketId: null, featureId: null })).isError).toBeFalsy();
    expect(await row(t.id)).toMatchObject({ parentTicketId: null, featureId: null });
    expect(await ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerTicketId, t.id))).toHaveLength(0);
    await c.close();
  });
});

describe("CEO edits the roadmap", () => {
  const roadmap = (c: Client, args: Record<string, unknown>) => c.callTool({ name: "roadmap", arguments: args });

  it("adds an objective and a milestone, puts a ticket in it, and logs why", async () => {
    const t = await ctx.ticket();
    const c = await agent(ctx.co.ceo.id);
    expect(textOf(await roadmap(c, { action: "add_objective", title: "Launch the calculator" }))).toMatch(/Say why/);
    const added = textOf(await roadmap(c, { action: "add_objective", title: "Launch the calculator", priority: 1, project: "Customer app", reason: "From the backlog review." }));
    const objectiveId = /id ([0-9a-f-]{36})/.exec(added)![1]!;
    const ms = textOf(await roadmap(c, { action: "add_milestone", objectiveId, title: "M1", targetDate: "2026-10-29", horizon: "now", reason: "First deploy." }));
    const milestoneId = /id ([0-9a-f-]{36})/.exec(ms)![1]!;
    expect((await roadmap(c, { action: "set", ticketId: t.id, milestoneId, reason: "Ships in M1." })).isError).toBeFalsy();
    expect((await row(t.id)).milestoneId).toBe(milestoneId);
    const tree = JSON.parse(textOf(await roadmap(c, { action: "list" })));
    expect(tree).toEqual([expect.objectContaining({ id: objectiveId, priority: 1, milestones: [expect.objectContaining({ id: milestoneId, title: "M1", targetDate: "2026-10-29" })] })]);
    const log = (await ctx.db.select().from(activity).where(eq(activity.kind, "roadmap"))).map((a) => a.summary);
    expect(log).toEqual(expect.arrayContaining(['CEO added the objective "Launch the calculator": From the backlog review.', 'CEO added the milestone "M1" (2026-10-29) under "Launch the calculator": First deploy.', "CEO put it in a milestone: Ships in M1."]));
    await c.close();
  });

  it("refuses a worker and another company's objective", async () => {
    const dev = await agent(ctx.dev.id);
    expect(textOf(await roadmap(dev, { action: "list" }))).toMatch(/Only your company's CEO or a manager/);
    await dev.close();
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const theirs = (await ctx.req("POST", `/api/companies/${other.company.id}/objectives`, { title: "Theirs" })).json() as { id: string };
    const c = await agent(ctx.co.ceo.id);
    expect(textOf(await roadmap(c, { action: "add_milestone", objectiveId: theirs.id, title: "Sneaky", reason: "x" }))).toMatch(/No objective with that id/);
    await c.close();
  });
});
