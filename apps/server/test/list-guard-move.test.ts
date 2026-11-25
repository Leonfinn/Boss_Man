// BOS-2522: set_ticket_state review refuses a branch that would fail a list guard, naming the edits, before the quick
// check is queued; listGuardWrong lets a wrong refusal through and is kept in the state note; a runner that can't answer
// never stops the move.
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
import { WAKE_CLASSES_FILE, WAKE_CLASSES_TEST } from "../src/services/list-guard-gate.js";
import { diffOnce } from "../src/services/list-guard-move.js";

const SCHED = "apps/server/src/services/scheduler.ts";
const BASE: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Plan due" }], files: [], diff: "", truncated: false };
const NEW_REASON: WorkspaceDiff = { ...BASE, files: [{ path: SCHED, added: 1, removed: 0 }], diff: [`diff --git a/${SCHED} b/${SCHED}`, '+  await wake({ agentId, reason: "plan due" });'].join("\n") };
const FILES: Record<string, string> = { [WAKE_CLASSES_FILE]: 'const WAKE_TABLE = {\n  decision: "waiting",\n};\n', [WAKE_CLASSES_TEST]: 'const NOT_WAKE_REASONS = new Set(["meaning none"]);\n' };

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/example/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  const runner = { diff: NEW_REASON, diffFails: false, files: { ...FILES } as Record<string, string> };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff")
      queueMicrotask(() => built.runners.resolveReply(runner.diffFails ? { requestId: c.requestId, ok: false, error: "no workspace or branch" } : { requestId: c.requestId, ok: true, data: runner.diff }));
    if (c.type === "workspace.file") {
      const text = runner.files[c.path];
      queueMicrotask(() => built.runners.resolveReply(text === undefined ? { requestId: c.requestId, ok: false, error: "no such file" } : { requestId: c.requestId, ok: true, data: { text, truncated: false, from: "branch" } }));
    }
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  });
  const ticket = async () => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Plan due wake", systemState: "in_progress", assigneeAgentId: dev.id, branch: "bossman/x" }).returning())[0]!;
  return { ...built, db, close, base, co, dev, runner, ticket };
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
const toReview = async (id: string, extra: Record<string, unknown> = {}) => textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "review", summary: "Built it.", ...extra } }));
const stateOf = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("BOS-2522: the list guards at the move to review", () => {
  it("refuses a new wake reason with no class, naming the line to add", async () => {
    const t = await ctx.ticket();
    const out = await toReview(t.id);
    for (const s of ["list guard wake-classes", '"plan due": "<class>",', WAKE_CLASSES_FILE, "NOT_WAKE_REASONS", "scripts/check-guards.sh wake-classes", "listGuardWrong"]) expect(out).toContain(s);
    expect((await stateOf(t.id)).systemState).toBe("in_progress");
  });

  it("asks the runner for the diff once for the screen-change check (BOS-2511) and this one", async () => {
    let asks = 0;
    const reads = diffOnce({ diff: async () => (asks++, NEW_REASON), readFile: async () => ({ text: "", truncated: false }) });
    await Promise.all([reads.diff("t"), reads.diff("t")]);
    expect(asks).toBe(1);
  });

  it("moves once the reason is classified", async () => {
    const t = await ctx.ticket();
    ctx.runner.files[WAKE_CLASSES_FILE] = 'const WAKE_TABLE = {\n  decision: "waiting",\n  "plan due": "scheduled",\n};\n';
    await toReview(t.id);
    expect((await stateOf(t.id)).systemState).toBe("review");
  });

  it("moves with listGuardWrong, keeping the reason in the state note; refuses a short one or one with another state", async () => {
    const t = await ctx.ticket();
    expect(await toReview(t.id, { listGuardWrong: "n/a" })).toMatch(/at least 10/);
    const other = textOf(await (await agent()).callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", listGuardWrong: "the reason is a log label, not a wake" } }));
    expect(other).toContain("listGuardWrong goes with state review");
    await toReview(t.id, { listGuardWrong: "the reason is a log label, not a wake" });
    const row = await stateOf(t.id);
    expect(row.systemState).toBe("review");
    expect(row.stateNote).toContain("List-guard check overruled (author's reason): the reason is a log label, not a wake");
  });

  it("lets the move through when a list file or the diff can't be read", async () => {
    delete ctx.runner.files[WAKE_CLASSES_TEST];
    const a = await ctx.ticket();
    await toReview(a.id);
    expect((await stateOf(a.id)).systemState).toBe("review");

    ctx.runner.diffFails = true;
    const b = await ctx.ticket();
    await toReview(b.id);
    expect((await stateOf(b.id)).systemState).toBe("review");
  });
});
