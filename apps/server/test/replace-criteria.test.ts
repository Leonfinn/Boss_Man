import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readVerdicts } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

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
  const boss = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Boss" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  return { ...built, db, close, base, co, dev, boss, project };
}

beforeEach(async () => {
  ctx = await setup();
  await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.boss.id));
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

describe("update_ticket replaces the tracked acceptance criteria (BOS-609)", () => {
  it("replaces them on a ticket in review, drops the old verdicts, says reviews are not re-requested and logs it", async () => {
    const t = (
      await ctx.db
        .insert(tickets)
        .values({ companyId: ctx.co.company.id, projectId: ctx.project.id, title: "Split ticket", systemState: "review", assigneeAgentId: ctx.dev.id, noCode: true, acceptanceCriteria: ["Name the cause of the stall", "Add the tests"], stateNote: "1 fail; 2 pass" })
        .returning()
    )[0]!;
    const boss = await agentFor(ctx.boss.id);
    const out = textOf(await boss.callTool({ name: "update_ticket", arguments: { ticketId: t.id, acceptanceCriteria: ["Add the tests", { text: "Check the dashboard once live", after: "merge" }], reason: "Cause moved to another ticket." } }));
    expect(out).toMatch(/replaced/);
    expect(out).toMatch(/in review: reviews were NOT re-requested/);
    const after = await row(t.id);
    expect(after.acceptanceCriteria).toEqual(["Add the tests", { text: "Check the dashboard once live", after: "merge" }]);
    // No verdict survives for the new list, so the old [fail] can't turn an approval into changes.
    expect(readVerdicts(after.acceptanceCriteria, after.stateNote).map((v) => v.verdict)).toEqual([null, null]);
    expect(after.systemState).toBe("review");
    const log = await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(log.some((a) => /acceptance criteria replaced/.test(a.summary) && /Cause moved/.test(a.summary))).toBe(true);

    // The assignee must now report the new list only.
    const dev = await agentFor(ctx.dev.id);
    await ctx.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, t.id));
    const refused = textOf(await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built it." } }));
    expect(refused).toMatch(/Not reported: "Add the tests"/);
    expect(refused).not.toContain("Name the cause");
    const ok = textOf(await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "1 pass; 2 pass" } }));
    expect(ok).not.toMatch(/Not reported/);
  });

  it("a worker can't, and an empty list clears them", async () => {
    const t = (await ctx.db.insert(tickets).values({ companyId: ctx.co.company.id, projectId: ctx.project.id, title: "T", systemState: "in_progress", assigneeAgentId: ctx.dev.id, acceptanceCriteria: ["One thing"] }).returning())[0]!;
    const dev = await agentFor(ctx.dev.id);
    expect(textOf(await dev.callTool({ name: "update_ticket", arguments: { ticketId: t.id, acceptanceCriteria: [], reason: "x" } }))).toMatch(/Only your company's CEO or a manager/);
    const boss = await agentFor(ctx.boss.id);
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: t.id, acceptanceCriteria: [], reason: "none needed" } });
    expect((await row(t.id)).acceptanceCriteria).toEqual([]);
  });
});
