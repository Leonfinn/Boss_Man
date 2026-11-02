import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, reviewRequests, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { NOTHING_CHANGED } from "../src/services/review.js";
import { approveAndWait } from "./helpers.js";

const EMPTY: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "a".repeat(40), commits: [], files: [], diff: "", truncated: false };
const REAL: WorkspaceDiff = { ...EMPTY, head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add limiter" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts" };

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
  const withRepo = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${withRepo.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const noRepo = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Notes" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const diff = { current: EMPTY, failing: false };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff")
      queueMicrotask(() => built.runners.resolveReply(diff.failing ? { requestId: c.requestId, ok: false, error: "no workspace or branch" } : { requestId: c.requestId, ok: true, data: diff.current }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  const ticket = async (projectId: string, patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId, title: "Add rate limiting", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x", ...patch }).returning())[0]!;
  return { ...built, db, close, base, req, co, dev, withRepo, noRepo, diff, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function agentAs(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const agent = () => agentAs(ctx.dev.id);
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const toReview = async (id: string) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "review", summary: "Built it." } }));

describe("a ticket whose change shipped on another ticket", () => {
  const toDone = async (id: string) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "done", summary: "Shipped on HOL-375; live since 23 Oct." } }));

  it("the CEO or a manager can close it; a worker is told to ask them", async () => {
    const t = await ctx.ticket(ctx.withRepo.id);
    expect(await toDone(t.id)).toMatch(/ask your CEO or manager to close it/);
    expect((await row(t.id)).systemState).toBe("in_progress");
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    await toDone(t.id);
    expect(await row(t.id)).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  it("not when the ticket has changes of its own, or the runner can't say", async () => {
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    ctx.diff.current = REAL;
    const t = await ctx.ticket(ctx.withRepo.id);
    expect(await toDone(t.id)).toMatch(/move the ticket to "review" instead/);
    ctx.diff.failing = true;
    expect(await toDone(t.id)).toMatch(/move the ticket to "review" instead/);
    expect((await row(t.id)).systemState).toBe("in_progress");
  });
});

describe("a ticket that changed nothing", () => {
  it("a code ticket with an empty branch cannot reach review", async () => {
    const t = await ctx.ticket(ctx.withRepo.id);
    expect(await toReview(t.id)).toBe(NOTHING_CHANGED);
    expect((await row(t.id)).systemState).toBe("in_progress");
  });

  it("a code ticket that never got a branch cannot reach review, even if the runner has no workspace for it", async () => {
    ctx.diff.failing = true;
    const t = await ctx.ticket(ctx.withRepo.id, { branch: null });
    expect(await toReview(t.id)).toBe(NOTHING_CHANGED);
    expect((await row(t.id)).systemState).toBe("in_progress");
  });

  it("an approved code ticket with no branch is sent back when the runner has no workspace for it", async () => {
    ctx.diff.failing = true;
    const t = await ctx.ticket(ctx.withRepo.id, { systemState: "review", branch: null });
    const verdict = (await approveAndWait(ctx.req, t.id)).json() as { verdict: string; outcome: string; message: string };
    expect(verdict).toMatchObject({ verdict: "approved", outcome: "empty" });
    expect(verdict.message).toContain("nothing in the repository changed");
    expect((await row(t.id)).systemState).toBe("in_progress");
  });

  it("a ticket marked no code reaches review and, approved with an empty diff, goes to done", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true });
    expect(await toReview(t.id)).toContain("is now review");
    expect((await approveAndWait(ctx.req, t.id)).json()).toMatchObject({ verdict: "approved", outcome: "done" });
    expect(await row(t.id)).toMatchObject({ systemState: "done", mergeCommit: null });
  });

  it("an approved code ticket whose branch is empty is sent back, not closed", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { systemState: "review" });
    expect((await approveAndWait(ctx.req, t.id)).json()).toMatchObject({ verdict: "approved", outcome: "empty" });
    expect((await row(t.id)).systemState).toBe("in_progress");
  });

  it("a project without a repo is unaffected", async () => {
    const t = await ctx.ticket(ctx.noRepo.id);
    expect(await toReview(t.id)).toContain("is now review");
  });

  it("a ticket with real changes is unaffected", async () => {
    ctx.diff.current = REAL;
    const t = await ctx.ticket(ctx.withRepo.id);
    expect(await toReview(t.id)).toContain("is now review");
    expect((await approveAndWait(ctx.req, t.id)).json()).toMatchObject({ verdict: "approved", outcome: "merged" });
  });

  it("create_ticket and the ticket patch set the flag", async () => {
    const c = await agent();
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Research limits", noCode: true } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    expect((await row(id)).noCode).toBe(true);
    const plain = await ctx.ticket(ctx.withRepo.id);
    expect(plain.noCode).toBe(false);
    await ctx.req("PATCH", `/api/tickets/${plain.id}`, { noCode: true });
    expect((await row(plain.id)).noCode).toBe(true);
  });

  it("create_ticket advertises noCode, and a ticket created with it reaches review with an empty diff", async () => {
    const c = await agent();
    const tool = (await c.listTools()).tools.find((x) => x.name === "create_ticket")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("noCode");
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Research limits", noCode: true } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    await ctx.db.update(tickets).set({ systemState: "in_progress", assigneeAgentId: ctx.dev.id, branch: "bossman/x" }).where(eq(tickets.id, id));
    expect(await toReview(id)).toContain("is now review");
  });

  it("the CEO or a manager sets and clears noCode with update_ticket, and it is logged; a worker can't", async () => {
    const t = await ctx.ticket(ctx.withRepo.id);
    const call = async (noCode: boolean) => textOf(await (await agent()).callTool({ name: "update_ticket", arguments: { ticketId: t.id, noCode, reason: "Research only." } }));
    expect(await call(true)).toMatch(/Only your company's CEO or a manager/);
    expect((await row(t.id)).noCode).toBe(false);
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    expect(await call(true)).toContain("updated");
    expect((await row(t.id)).noCode).toBe(true);
    expect(await toReview(t.id)).toContain("is now review");
    await call(false);
    expect((await row(t.id)).noCode).toBe(false);
    const log = (await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary);
    expect(log).toContain("Dev reorganised it (marked no code): Research only.");
    expect(log).toContain("Dev reorganised it (no longer marked no code): Research only.");
  });

  it("the refusal says who can mark the ticket no code", () => {
    expect(NOTHING_CHANGED).toMatch(/CEO or a manager/);
  });

  it("the project brief ticket is created as no code", async () => {
    const r = await ctx.req("POST", `/api/projects/${ctx.withRepo.id}/brief`);
    expect(r.statusCode).toBe(201);
    expect((await row((r.json() as { id: string }).id)).noCode).toBe(true);
  });

  it("a feature plan ticket created with noCode reaches review in a repo project", async () => {
    const f = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/features`, { title: "Rate limits" })).json() as { id: string };
    const r = await ctx.req("POST", `/api/features/${f.id}/tickets`, { projectId: ctx.withRepo.id, title: "Plan: Rate limits", noCode: true });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    expect((await row(id)).noCode).toBe(true);
    await ctx.db.update(tickets).set({ systemState: "in_progress", assigneeAgentId: ctx.dev.id, branch: "bossman/x" }).where(eq(tickets.id, id));
    expect(await toReview(id)).not.toBe(NOTHING_CHANGED);
    expect((await row(id)).systemState).toBe("review");
  });
});

describe("a no-code ticket in review", () => {
  const toDone = async (id: string) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "done", summary: "QA check passed." } }));

  it("the CEO or a manager can close it as done", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true, systemState: "review" });
    ctx.diff.current = REAL; // no code wins even when the branch has a real diff
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    await toDone(t.id);
    expect(await row(t.id)).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  // BOS-304: no-code work has nothing to merge, so its own assignee closes it instead of the CEO doing it by hand.
  it("its assignee closes it as done, without needing a manager", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true, systemState: "review" });
    ctx.diff.current = REAL; // no code wins even when the branch has a real diff
    expect(await toDone(t.id)).toContain("is now done");
    expect(await row(t.id)).toMatchObject({ systemState: "done", outcome: "completed", stateNote: "QA check passed." });
  });

  // Rex (BOS-304 review): the old code let a manager close any no-code ticket; the assignee rule
  // must not take that away, even when the branch holds a real diff the manager may not merge.
  it("a manager who is not the assignee can still close it, even with a real diff on the branch", async () => {
    const [boss] = await ctx.db
      .insert(agents)
      .values({ companyId: ctx.co.company.id, name: "Boss", role: "manager", agentKind: "claude" })
      .returning();
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true, systemState: "review" });
    ctx.diff.current = REAL;
    const out = textOf(await (await agentAs(boss!.id)).callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Closed by the manager." } }));
    expect(out).toContain("is now done");
    expect(await row(t.id)).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  it("someone else still can't close it, and a code ticket still has to go through review", async () => {
    const theirs = await ctx.ticket(ctx.withRepo.id, { noCode: true, systemState: "review" });
    await ctx.db.update(tickets).set({ assigneeAgentId: null, createdByAgentId: null }).where(eq(tickets.id, theirs.id));
    expect(await toDone(theirs.id)).toMatch(/isn't yours/);
    expect((await row(theirs.id)).systemState).toBe("review");
    // A ticket with code is not closed by its assignee: it goes to review and merge as before.
    const code = await ctx.ticket(ctx.withRepo.id);
    ctx.diff.current = REAL;
    expect(await toDone(code.id)).toMatch(/move the ticket to "review" instead/);
    expect((await row(code.id)).systemState).toBe("in_progress");
  });

  it("gets a review requested when it moves to review", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true });
    expect(await toReview(t.id)).toContain("is now review");
    const rows = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
    expect(rows.find((r) => r.status === "pending")?.reviewerAgentId).not.toBeNull();
    expect((await approveAndWait(ctx.req, t.id)).json()).toMatchObject({ verdict: "approved", outcome: "done" });
    expect(await row(t.id)).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  it("does not show a ticket that is already approved and landing, or has a pull request", async () => {
    const landing = await ctx.ticket(ctx.withRepo.id, { systemState: "review" });
    await ctx.db.insert(reviewRequests).values({ ticketId: landing.id, kind: "code", round: 1, status: "approved" });
    const pr = await ctx.ticket(ctx.withRepo.id, { systemState: "review", pullRequestUrl: "https://github.com/Leonfinn/customer-app/pull/1" });
    const board = (await ctx.req("GET", `/api/projects/${ctx.withRepo.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; waitingOnOwner?: boolean }> }> };
    const cards = board.columns.flatMap((c) => c.tickets);
    expect(cards.find((c) => c.id === landing.id)?.waitingOnOwner).toBeFalsy();
    expect(cards.find((c) => c.id === pr.id)?.waitingOnOwner).toBeFalsy();
  });

  it("shows in the owner's Your review lane when it has no open review", async () => {
    const t = await ctx.ticket(ctx.withRepo.id, { noCode: true, systemState: "review" });
    const board = (await ctx.req("GET", `/api/projects/${ctx.withRepo.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; waitingOnOwner?: boolean }> }> };
    const card = board.columns.flatMap((c) => c.tickets).find((c) => c.id === t.id);
    expect(card?.waitingOnOwner).toBe(true);
  });
});
