import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
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
  const diff = { current: EMPTY };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: diff.current }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
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

async function agent() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId: ctx.dev.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const toReview = async (id: string) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "review", summary: "Built it." } }));

describe("a ticket that changed nothing", () => {
  it("a code ticket with an empty branch cannot reach review", async () => {
    const t = await ctx.ticket(ctx.withRepo.id);
    expect(await toReview(t.id)).toBe(NOTHING_CHANGED);
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
    const out = textOf(await c.callTool({ name: "create_ticket", arguments: { project: "Customer app", title: "Research limits", noCode: true } }));
    const id = /([0-9a-f-]{36})/.exec(out)![1]!;
    expect((await row(id)).noCode).toBe(true);
    const plain = await ctx.ticket(ctx.withRepo.id);
    expect(plain.noCode).toBe(false);
    await ctx.req("PATCH", `/api/tickets/${plain.id}`, { noCode: true });
    expect((await row(plain.id)).noCode).toBe(true);
  });

  it("the project brief ticket is created as no code", async () => {
    const r = await ctx.req("POST", `/api/projects/${ctx.withRepo.id}/brief`);
    expect(r.statusCode).toBe(201);
    expect((await row((r.json() as { id: string }).id)).noCode).toBe(true);
  });
});
