// BOS-2864: an after-merge criterion no agent can observe from the runner (docker ps, host logs, an owner-only panel)
// is refused when written (create_ticket, update_ticket) and when a reviewer approves a ticket made after the rule.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const BLIND = { text: "docker ps on the host shows the container healthy", after: "merge" as const };
const OK = { text: "docker ps shows it healthy (fact: repo.probe = ok)", after: "merge" as const };

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
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  await db.update(companies).set({ ticketPrefix: "BOS" }).where(eq(companies.id, co.company.id));
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (command) => {
    const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (command as { requestId: string }).requestId, ok: true, data }));
    if (command.type === "workspace.diff") ok({ baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff", truncated: false });
    return true;
  });
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Container change", number: 500, systemState: "review", noCode: true, ...patch }).returning())[0]!;
  return { ...built, db, close, base, co, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function ceo() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("runner-blind after-merge criteria (BOS-2864)", () => {
  it("create_ticket refuses one and names the ways out; a fact clause lets it through", async () => {
    const c = await ceo();
    const bad = await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Container", acceptanceCriteria: [BLIND] } });
    expect(isError(bad)).toBe(true);
    expect(textOf(bad)).toContain(BLIND.text);
    expect(textOf(bad)).toContain("Three ways out");
    const good = await c.callTool({ name: "create_ticket", arguments: { size: 3, project: "Customer app", title: "Container", acceptanceCriteria: [OK] } });
    expect(isError(good)).toBe(false);
  });

  it("update_ticket refuses one too", async () => {
    const c = await ceo();
    const t = await ctx.ticket({ systemState: "in_progress" });
    const bad = await c.callTool({ name: "update_ticket", arguments: { ticketId: t.id, acceptanceCriteria: [BLIND], reason: "Add a check." } });
    expect(isError(bad)).toBe(true);
    expect(textOf(bad)).toContain("Three ways out");
  });

  it("followUps refuse to carry one", async () => {
    const c = await ceo();
    const t = await ctx.ticket({ systemState: "in_progress", acceptanceCriteria: [BLIND] });
    const out = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "1 not reported: handed on.", followUps: [{ title: "Check the container", assignee: "CEO", why: "Needs a look." }] } });
    expect(isError(out)).toBe(true);
    expect(textOf(out)).toContain("Three ways out");
  });

  it("approve is refused on a ticket made after the rule, not on an older one; changes_requested always goes", async () => {
    const c = await ceo();
    const fresh = await ctx.ticket({ acceptanceCriteria: [BLIND], createdAt: new Date("2030-01-01T00:00:00Z") });
    const refused = await c.callTool({ name: "review", arguments: { action: "submit", ticketId: fresh.id, verdict: "approved", summary: "Looks right." } });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain("Three ways out");
    const changes = await c.callTool({ name: "review", arguments: { action: "submit", ticketId: fresh.id, verdict: "changes_requested", summary: "Reword the check." } });
    expect(textOf(changes)).not.toContain("Three ways out");
    const old = await ctx.ticket({ number: 501, acceptanceCriteria: [BLIND], createdAt: new Date("2026-01-01T00:00:00Z") });
    const passed = await c.callTool({ name: "review", arguments: { action: "submit", ticketId: old.id, verdict: "approved", summary: "Looks right." } });
    expect(textOf(passed)).not.toContain("Three ways out");
  });

  it("the reviewer's context carries the one-line reminder", async () => {
    const c = await ceo();
    const t = await ctx.ticket({ branch: "bossman/x", noCode: false });
    const out = textOf(await c.callTool({ name: "review", arguments: { action: "diff", ticketId: t.id } }));
    expect(out).toContain("refuse a criterion the agent has no way to observe from the runner".replace(/^r/, "R"));
  });
});
