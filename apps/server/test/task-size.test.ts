// Task sizing (docs/19-workflow-retros.md part 6): the field, who may set it, and the guide that helps planners pick one.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agentSkills, agents, costEvents, fundingSources, runs, skills, ticketReviews, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const D = 86_400_000;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev", template: "engineer" })).json() as { id: string };
  const p = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: p.id, title: "Add rate limiting", systemState: "ready", ...patch }).returning())[0]!;
  return { ...built, db, close, base, co, dev, req, ticket, project: p };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
async function agent(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

describe("the size field", () => {
  it("takes 1, 2, 3, 5 and 8 or nothing, and the database refuses the rest", async () => {
    for (const size of [1, 2, 3, 5, 8, null]) expect((await ctx.ticket({ size })).size).toBe(size);
    for (const size of [0, 4, 6, 13, -1]) await expect(ctx.ticket({ size })).rejects.toThrow();
  });

  it("is set and cleared by the owner on the ticket, and validated", async () => {
    const t = await ctx.ticket();
    const patch = (size: unknown) => ctx.req("PATCH", `/api/tickets/${t.id}`, { size });
    expect((await patch(5)).statusCode).toBe(200);
    expect((await row(t.id)).size).toBe(5);
    expect((await patch(4)).statusCode).toBe(400);
    expect((await patch("big")).statusCode).toBe(400);
    expect((await row(t.id)).size).toBe(5);
    expect((await patch(null)).statusCode).toBe(200);
    expect((await row(t.id)).size).toBeNull();
    // The owner can also size a ticket as it is made.
    const made = await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Sized from the start", size: 3 });
    expect(made.statusCode).toBe(201);
    expect(made.json().size).toBe(3);
  });

  it("shows on the board's cards", async () => {
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Big one", size: 8 })).json() as { id: string };
    const board = (await ctx.req("GET", `/api/projects/${ctx.project.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; size: number | null }> }> };
    expect(board.columns.flatMap((c) => c.tickets).find((x) => x.id === t.id)!.size).toBe(8);
  });
});

describe("create_ticket and update_ticket", () => {
  it("create_ticket needs a size from an agent, and says what the scale is and where to look", async () => {
    const dev = await agent(ctx.dev.id);
    const missing = await dev.callTool({ name: "create_ticket", arguments: { title: "No size" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("1, 2, 3, 5 or 8");
    expect(textOf(missing)).toContain("sizing_guide");
    const odd = await dev.callTool({ name: "create_ticket", arguments: { title: "Odd size", size: 4 } });
    expect(odd.isError).toBe(true);
    expect(textOf(odd)).toContain("4 is not a size");
    expect(await ctx.db.select().from(tickets)).toHaveLength(0);

    const ok = await dev.callTool({ name: "create_ticket", arguments: { title: "Sized", size: 5 } });
    expect(ok.isError).toBeFalsy();
    const [made] = await ctx.db.select().from(tickets);
    expect(made).toMatchObject({ title: "Sized", size: 5 });
    const tool = (await dev.listTools()).tools.find((t) => t.name === "create_ticket")!;
    expect(tool.description).toContain("sizing_guide");
    await dev.close();
  });

  it("update_ticket lets the CEO change or clear a size, and refuses a worker", async () => {
    const t = await ctx.ticket({ size: 2 });
    const ceo = await agent(ctx.co.ceo.id);
    const set = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, size: 5, reason: "Bigger than it looked." } });
    expect(set.isError).toBeFalsy();
    expect((await row(t.id)).size).toBe(5);
    expect((await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, size: 6, reason: "x" } })).isError).toBe(true);
    expect((await row(t.id)).size).toBe(5);
    expect((await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, size: null, reason: "Not sure." } })).isError).toBeFalsy();
    expect((await row(t.id)).size).toBeNull();
    await ceo.close();

    const dev = await agent(ctx.dev.id);
    const refused = await dev.callTool({ name: "update_ticket", arguments: { ticketId: t.id, size: 1, reason: "Easy." } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Only your company's CEO or a manager/);
    expect((await row(t.id)).size).toBeNull();
    await dev.close();
  });
});

describe("sizing_guide", () => {
  /** A finished ticket of a size that took `cycle`, finished `doneAgo` ago. */
  const finished = async (size: number, title: string, cycle: number, doneAgo: number) => {
    const t = await ctx.ticket({ title, size, assigneeAgentId: ctx.dev.id, systemState: "in_progress", stateChangedAt: new Date(Date.now() - doneAgo - cycle) });
    await ctx.db.update(tickets).set({ systemState: "done", stateChangedAt: new Date(Date.now() - doneAgo) }).where(eq(tickets.id, t.id));
    return t;
  };

  it("gives recent finished tickets of each size with time, cost and send-backs, and typical figures per role", async () => {
    const a = await finished(3, "Add the limiter", 6 * 3_600_000, D);
    await finished(3, "Add the cache", 8 * 3_600_000, 2 * D);
    for (let i = 0; i < 4; i++) await finished(2, `Small ${i}`, 3_600_000, (i + 1) * D);
    await ctx.db.insert(ticketReviews).values({ ticketId: a.id, reviewer: "Ed", verdict: "changes_requested" });
    const [src] = await ctx.db.insert(fundingSources).values({ name: "Pay as you go", kind: "api_payg", provider: "anthropic" }).returning();
    const [run] = await ctx.db.insert(runs).values({ companyId: ctx.co.company.id, agentId: ctx.dev.id, ticketId: a.id, startedAt: new Date() }).returning();
    await ctx.db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: ctx.co.company.id, agentId: ctx.dev.id, costMicros: 2_500_000 });

    const dev = await agent(ctx.dev.id);
    const out = textOf(await dev.callTool({ name: "sizing_guide", arguments: {} }));
    expect(out).toContain("1, 2, 3, 5 or 8");
    expect(out).toContain("## Size 1\n- No finished ticket of this size yet.");
    // Never more than three examples of a size, newest first.
    const twos = out.slice(out.indexOf("## Size 2"), out.indexOf("## Size 3"));
    expect(twos.match(/"Small \d"/g)).toEqual(['"Small 0"', '"Small 1"', '"Small 2"']);
    const threes = out.slice(out.indexOf("## Size 3"), out.indexOf("## Size 5"));
    expect(threes).toContain('"Add the limiter" (engineer): 6.0 h, $2.50, 1 send-back');
    expect(threes).toContain('"Add the cache" (engineer): 8.0 h, $0.00, 0 send-backs');
    expect(threes).toContain("Typical per role: engineer 7.0 h middle time, $1.25 average, 2 finished.");
    await dev.close();
  });

  it("includes an active sizing playbook a retro made, and nothing else with that name", async () => {
    const md = (name: string, body: string) => ({ path: "SKILL.md", content: Buffer.from(`---\nname: ${name}\ndescription: "d"\n---\n\n${body}\n`).toString("base64") });
    const make = async (name: string, source: "retro" | "written", body: string, holder?: string) => {
      const [s] = await ctx.db.insert(skills).values({ companyId: ctx.co.company.id, name, description: "d", source, files: [md(name, body)], sizeBytes: 10 }).returning();
      if (holder) await ctx.db.insert(agentSkills).values({ agentId: holder, skillId: s!.id });
    };
    await make("sizing-by-surface", "retro", "A change that touches one file is a 2.", ctx.co.ceo.id);
    await make("sizing-reverted", "retro", "REVERTED PLAYBOOK TEXT");
    await make("sizing-by-hand", "written", "WRITTEN BY THE OWNER");
    await make("other-playbook", "retro", "NOT ABOUT SIZES", ctx.co.ceo.id);
    const dev = await agent(ctx.dev.id);
    const out = textOf(await dev.callTool({ name: "sizing_guide", arguments: {} }));
    expect(out).toContain('## Sizing playbook "sizing-by-surface"');
    expect(out).toContain("starts with \"sizing\"");
    expect(out).toContain("A change that touches one file is a 2.");
    for (const left of ["REVERTED PLAYBOOK TEXT", "WRITTEN BY THE OWNER", "NOT ABOUT SIZES"]) expect(out).not.toContain(left);
    await dev.close();
  });

  it("stays short however much there is", async () => {
    for (const size of [1, 2, 3, 5, 8]) for (let i = 0; i < 6; i++) await finished(size, `${"T".repeat(190)} ${size}-${i}`, 3_600_000, (i + 1) * D);
    const [s] = await ctx.db.insert(skills).values({ companyId: ctx.co.company.id, name: "sizing-long", description: "d", source: "retro", files: [{ path: "SKILL.md", content: Buffer.from("x".repeat(20_000)).toString("base64") }], sizeBytes: 20_000 }).returning();
    await ctx.db.insert(agentSkills).values({ agentId: ctx.co.ceo.id, skillId: s!.id });
    const dev = await agent(ctx.dev.id);
    const out = textOf(await dev.callTool({ name: "sizing_guide", arguments: {} }));
    expect(out.length).toBeLessThanOrEqual(6200);
    await dev.close();
  });

  it("is not offered to the Scrum Master, who can't create tickets either", async () => {
    await ctx.db.update(agents).set({ duty: "scrum_master" }).where(eq(agents.id, ctx.dev.id));
    const sm = await agent(ctx.dev.id);
    const names = (await sm.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("create_ticket");
    expect(names).not.toContain("sizing_guide");
    await sm.close();
  });
});
