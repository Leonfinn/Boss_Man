import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { waitsOnAdvice } from "../src/mcp-common.js";

// BOS-989: update_ticket waitsOn add/remove with until merged | done, the merge wake, and the write-time advice.
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
  const other = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Other" })).json() as { id: string };
  const boss = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Boss" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  return { ...built, db, close, base, co, dev, other, boss, project, req };
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
const mk = async (title: string, over: Partial<typeof tickets.$inferInsert> = {}) =>
  (await ctx.db.insert(tickets).values({ companyId: ctx.co.company.id, projectId: ctx.project.id, title, assigneeAgentId: ctx.dev.id, noCode: true, ...over }).returning())[0]!;
const deps = (blocked: string) => ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, blocked));

describe("update_ticket waitsOn", () => {
  it("adds a link that waits until merged by default, and the same call with until done changes it, not duplicates it", async () => {
    const blocker = await mk("Build", { systemState: "in_progress" });
    const waiting = await mk("QA", { systemState: "backlog" });
    const boss = await agentFor(ctx.boss.id);
    // Any prefix finds the number, so a reference works whatever the company's prefix is.
    const ref = `BOS-${blocker.number}`;
    const out = textOf(await boss.callTool({ name: "update_ticket", arguments: { ticketId: waiting.id, waitsOn: { add: [ref] }, reason: "QA needs the build on main." } }));
    expect(out).toMatch(/waits on .* until merged/);
    expect((await deps(waiting.id)).map((d) => [d.blockerTicketId, d.until])).toEqual([[blocker.id, "merged"]]);
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: waiting.id, waitsOn: { add: [blocker.id], until: "done" }, reason: "Needs it live." } });
    expect((await deps(waiting.id)).map((d) => d.until)).toEqual(["done"]);
    const gone = textOf(await boss.callTool({ name: "update_ticket", arguments: { ticketId: waiting.id, waitsOn: { remove: [blocker.id] }, reason: "No longer needed." } }));
    expect(gone).toMatch(/no longer waits/);
    expect(await deps(waiting.id)).toEqual([]);
  });

  it("the ticket's own assignee can order their own ticket; another worker can't, and the assignee can't change anything else", async () => {
    const blocker = await mk("Build", { systemState: "in_progress", assigneeAgentId: ctx.other.id });
    const mine = await mk("QA", { systemState: "in_progress" });
    const dev = await agentFor(ctx.dev.id);
    const ok = textOf(await dev.callTool({ name: "update_ticket", arguments: { ticketId: mine.id, waitsOn: { add: [blocker.id] }, reason: "Order found." } }));
    expect(ok).toMatch(/until merged/);
    expect(await deps(mine.id)).toHaveLength(1);
    const notMine = textOf(await (await agentFor(ctx.other.id)).callTool({ name: "update_ticket", arguments: { ticketId: mine.id, waitsOn: { remove: [blocker.id] }, reason: "Nope." } }));
    expect(notMine).toMatch(/own assignee|CEO or a manager/);
    expect(await deps(mine.id)).toHaveLength(1);
    const more = textOf(await dev.callTool({ name: "update_ticket", arguments: { ticketId: mine.id, title: "Renamed", waitsOn: { remove: [blocker.id] }, reason: "Sneaky." } }));
    expect(more).toMatch(/CEO or a manager/);
    expect((await row(mine.id)).title).toBe("QA");
  });

  it("refuses a cycle and a ticket outside the company", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const boss = await agentFor(ctx.boss.id);
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: a.id, waitsOn: { add: [b.id] }, reason: "A after B." } });
    const cycle = textOf(await boss.callTool({ name: "update_ticket", arguments: { ticketId: b.id, waitsOn: { add: [a.id] }, reason: "B after A." } }));
    expect(cycle).toMatch(/wait on each other/);
    const missing = textOf(await boss.callTool({ name: "update_ticket", arguments: { ticketId: b.id, waitsOn: { add: [randomUUID()] }, reason: "Ghost." } }));
    expect(missing).toMatch(/no ticket/);
  });
});

describe("a wait until merged ends at the merge", () => {
  it("frees and wakes the waiting ticket's assignee when the blocker's merge lands, not before; until done waits for done", async () => {
    const blocker = await mk("Build", { systemState: "review", assigneeAgentId: ctx.other.id });
    const early = await mk("Merged wait", { systemState: "backlog" });
    const late = await mk("Done wait", { systemState: "backlog" });
    const boss = await agentFor(ctx.boss.id);
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: early.id, waitsOn: { add: [blocker.id] }, reason: "Order." } });
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: late.id, waitsOn: { add: [blocker.id], until: "done" }, reason: "Order." } });
    expect(await ctx.scheduler.releaseIfUnblocked(early.id)).toBe(false);
    await ctx.db.delete(wakes);
    // The merge lands: the blocker has a merge commit but is not done yet (an after-merge check is left).
    await ctx.db.update(tickets).set({ mergeCommit: "abc1234" }).where(eq(tickets.id, blocker.id));
    await ctx.scheduler.onTicketMerged(blocker.id);
    expect((await row(early.id)).systemState).toBe("ready");
    expect((await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.dev.id)))).length).toBeGreaterThan(0);
    // Waiting until done stays put until the blocker is done.
    expect((await row(late.id)).systemState).toBe("backlog");
    expect(await ctx.scheduler.releaseIfUnblocked(late.id)).toBe(false);
    await ctx.work.updateTicket(blocker.id, { state: "done", outcome: "completed", overLimit: true });
    expect((await row(late.id)).systemState).toBe("ready");
  });

  it("the board and the ticket links say which point the wait ends at", async () => {
    const blocker = await mk("Build", { systemState: "in_progress" });
    const waiting = await mk("QA", { systemState: "backlog" });
    const boss = await agentFor(ctx.boss.id);
    await boss.callTool({ name: "update_ticket", arguments: { ticketId: waiting.id, waitsOn: { add: [blocker.id] }, reason: "Order." } });
    const links = (await ctx.req("GET", `/api/tickets/${waiting.id}/links`)).json() as { waitsOn: Array<{ until: string; open: boolean }> };
    expect(links.waitsOn.map((w) => [w.until, w.open])).toEqual([["merged", true]]);
    await ctx.db.update(tickets).set({ mergeCommit: "abc1234" }).where(eq(tickets.id, blocker.id));
    const after = (await ctx.req("GET", `/api/tickets/${waiting.id}/links`)).json() as { waitsOn: Array<{ until: string; open: boolean }> };
    expect(after.waitsOn.map((w) => w.open)).toEqual([false]);
    const rel = (await ctx.req("GET", `/api/tickets/${waiting.id}/related`)).json() as { waitsOn: Array<{ until: string }> };
    expect(rel.waitsOn.map((w) => w.until)).toEqual(["merged"]);
  });
});

describe("write-time advice (never a refusal)", () => {
  it("adds one tip when a summary names a ticket next to wait, after or blocked", () => {
    expect(waitsOnAdvice("Stopped: waits on BOS-947 to merge")).toMatch(/update_ticket waitsOn/);
    expect(waitsOnAdvice("Do this after BOS-12")).toMatch(/update_ticket waitsOn/);
    expect(waitsOnAdvice(`Blocked by ${randomUUID()}`)).toMatch(/update_ticket waitsOn/);
    expect(waitsOnAdvice("Built the thing, 3 pass")).toBe("");
    expect(waitsOnAdvice("See BOS-12 for background")).toBe("");
    expect(waitsOnAdvice(undefined)).toBe("");
  });

  it("set_ticket_state still succeeds and the reply carries the tip", async () => {
    const t = await mk("Work", { systemState: "in_progress" });
    const dev = await agentFor(ctx.dev.id);
    const out = textOf(await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", outcome: "completed", summary: "Done after BOS-947 landed." } }));
    expect(out).toMatch(/is now done/);
    expect(out).toMatch(/update_ticket waitsOn to make this a real link/);
  });
});
