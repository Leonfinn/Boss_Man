// BOS-922 (DR-047 points 4 to 6): every quiet state change goes through moveTicket, so each leaves a history line with
// its cause and moves the column; a WIP limit counts only tickets whose column matches their state; and migration 0138
// resets columns that were left behind. One test per path the ticket names.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { activity, projects, tickets, workflowColumns } from "../src/db/schema.js";

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0138_reset_stale_ticket_columns.sql");

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
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const columnState = async (id: string) => {
    const t = await row(id);
    return (await db.select().from(workflowColumns).where(eq(workflowColumns.id, t.columnId!)))[0]!.systemState;
  };
  const history = async (id: string) => (await db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "state")))).map((r) => r.summary);
  const col = async (state: typeof workflowColumns.$inferSelect["systemState"]) => (await db.select().from(workflowColumns).where(and(eq(workflowColumns.projectId, project.id), eq(workflowColumns.systemState, state))))[0]!;
  return { ...built, db, close, req, company, ceo, project, worker, mcp, clients, commands, ticket, row, columnState, history, col };
}

describe("the system's own moves leave a history line with a cause and move the column (BOS-922)", () => {
  it("start on the wake: ready -> in_progress, in the in-progress column", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("ready");
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: t.id, reason: "assigned", note: "Please start." });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    expect(await c.history(t.id)).toEqual(["ready -> in_progress: Boss Man: started on the wake"]);
    expect(await c.columnState(t.id)).toBe("in_progress");
  });

  it("its last blocker finished: a backlog ticket with an assignee goes to ready (the second release path)", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("done");
    const t = await c.ticket("backlog");
    await c.work.addDependency(t.id, { ticketId: blocker.id });
    await c.scheduler.releaseIfUnblocked(t.id);
    expect(await c.history(t.id)).toContain("backlog -> ready: Boss Man: its last blocker finished");
    expect(await c.columnState(t.id)).toBe("ready");
  });

  it("its last blocker finished: a blocked ticket goes to ready, in the ready column", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("done");
    const t = await c.ticket("blocked");
    await c.work.addDependency(t.id, { ticketId: blocker.id });
    await c.scheduler.releaseIfUnblocked(t.id);
    expect(await c.history(t.id)).toContain("blocked -> ready: Boss Man: its last blocker finished");
    expect(await c.columnState(t.id)).toBe("ready");
  });

  it("an answered owner card releases the ticket: releaseIfFree writes the cause", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("in_progress");
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "Which provider?", options: ["A", "B"], recommended: "A", blocksTicketId: t.id, triedFirst: "Compared both" });
    expect(await c.history(t.id)).toEqual([`in_progress -> blocked: Waiting on the owner's card ${card.id}`]);
    expect(await c.columnState(t.id)).toBe("blocked");
    await c.decisions.answer(card.id, "A");
    await c.decisions.release(t.id);
    expect(await c.history(t.id)).toContain("blocked -> ready: Boss Man: its last blocker finished");
    expect(await c.columnState(t.id)).toBe("ready");
  });

  it("create_ticket waiting on an unfinished ticket is blocked through moveTicket, with a history line and the blocked column", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("in_progress");
    const mcp = await c.mcp(c.ceo.id);
    const r = await mcp.callTool({ name: "create_ticket", arguments: { project: "Customer app", title: "Follow-up", size: 3, waitsOn: blocker.id } });
    expect(JSON.stringify(r)).not.toContain('"isError":true');
    const [made] = await c.db.select().from(tickets).where(eq(tickets.title, "Follow-up"));
    expect(made!.systemState).toBe("blocked");
    expect(await c.columnState(made!.id)).toBe("blocked");
    expect(await c.history(made!.id)).toEqual(["backlog -> blocked: Boss Man: created waiting on another ticket"]);
  });
});

describe("a limit counts only tickets whose column matches their state (BOS-922)", () => {
  it("moveTicket: a stale ticket in the in-progress column does not fill its limit of 1", async () => {
    const c = (ctx = await setup());
    const inProgress = await c.col("in_progress");
    await c.db.update(workflowColumns).set({ wipLimit: 1 }).where(eq(workflowColumns.id, inProgress.id));
    await c.ticket("backlog", { columnId: inProgress.id }); // left behind by a quiet write
    const t = await c.ticket("ready");
    const mcp = await c.mcp(c.worker.id);
    expect(JSON.stringify(await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress" } }))).toContain("is now in_progress");
    // A real in-progress ticket still fills it.
    const next = await c.ticket("ready");
    expect(JSON.stringify(await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: next.id, state: "in_progress" } }))).toContain("is at its limit of 1");
  });

  it("work.createTicket (placement): the same stale ticket does not count; a real one does", async () => {
    const c = (ctx = await setup());
    const inProgress = await c.col("in_progress");
    await c.db.update(workflowColumns).set({ wipLimit: 1 }).where(eq(workflowColumns.id, inProgress.id));
    await c.ticket("backlog", { columnId: inProgress.id });
    await expect(c.work.createTicket(c.project.id, { title: "First", state: "in_progress" })).resolves.toBeTruthy();
    await expect(c.work.createTicket(c.project.id, { title: "Second", state: "in_progress" })).rejects.toThrow(/at its limit of 1/);
  });
});

describe("migration 0138 resets stale columns (BOS-922)", () => {
  /** Every statement of the committed migration file, run as it is. */
  const runMigration = (db: Awaited<ReturnType<typeof setup>>["db"]) => db.execute(sql.raw(readFileSync(migrationPath, "utf8")));

  it("moves a mismatched ticket to the first column for its state and leaves a matching one alone", async () => {
    const c = (ctx = await setup());
    const ready = await c.col("ready");
    const backlog = await c.col("backlog");
    const stale = await c.ticket("ready", { columnId: backlog.id });
    const fine = await c.ticket("ready", { columnId: ready.id });
    await runMigration(c.db);
    expect((await c.row(stale.id)).columnId).toBe(ready.id);
    expect((await c.row(fine.id)).columnId).toBe(ready.id);
  });

  it("picks the lowest position when a state has two columns", async () => {
    const c = (ctx = await setup());
    const ready = await c.col("ready");
    const backlog = await c.col("backlog");
    await c.db.insert(workflowColumns).values({ projectId: c.project.id, name: "Ready 2", systemState: "ready", position: ready.position + 100 });
    const stale = await c.ticket("ready", { columnId: backlog.id });
    await runMigration(c.db);
    expect((await c.row(stale.id)).columnId).toBe(ready.id);
  });

  it("keeps the column of a ticket whose project has no column for its state", async () => {
    const c = (ctx = await setup());
    const [bare] = await c.db.insert(projects).values({ companyId: c.company.id, name: "Bare" }).returning();
    const [only] = await c.db.insert(workflowColumns).values({ projectId: bare!.id, name: "Only", systemState: "backlog", position: 0 }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: c.company.id, projectId: bare!.id, title: "Odd", systemState: "review", columnId: only!.id }).returning();
    await runMigration(c.db);
    expect((await c.row(t!.id)).columnId).toBe(only!.id);
  });
});
