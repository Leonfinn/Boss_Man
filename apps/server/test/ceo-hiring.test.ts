import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, notifications, projects, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer", template: "engineer" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, mcp };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("the CEO builds the team (R62)", () => {
  it("proposes a hire that waits for the owner, and is hired on approval with its history", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    const r = await client.callTool({ name: "propose_hire", arguments: { name: "Sam", template: "scrum-master", reason: "Someone should keep an eye on the checkout tickets." } });
    expect(textOf(r)).toMatch(/waiting for the owner's approval \(decision /);
    expect(await c.db.select().from(agents).where(eq(agents.name, "Sam"))).toEqual([]);
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d).toMatchObject({ tier: "owner", options: ["Hire", "Don't hire"], recommendedOption: "Hire", raisedByAgentId: c.ceo.id });
    expect(d!.question).toContain("The CEO wants to hire Sam as Scrum Master.");
    expect(d!.question).toContain("Why: Someone should keep an eye");

    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" })).statusCode).toBeLessThan(300);
    const [sam] = await c.db.select().from(agents).where(eq(agents.name, "Sam"));
    expect(sam).toMatchObject({ title: "Scrum Master", template: "scrum-master" });
    const history = (await c.req("GET", `/api/agents/${sam!.id}/history`)).json() as Array<{ c: { field: string; byAgentId: string } }>;
    expect(history[0]!.c).toMatchObject({ field: "hired", byAgentId: c.ceo.id });

    // Only the CEO hires; a bad template is refused with the list.
    const other = await c.mcp(c.worker.id);
    expect(await other.callTool({ name: "propose_hire", arguments: { name: "X", reason: "why not" } })).toMatchObject({ isError: true });
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: { name: "X", template: "pilot", reason: "r" } }))).toContain("Templates: engineer");
    await client.close();
    await other.close();
  });

  it("hires straight away when the owner says nothing needs approval", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", `/api/companies/${c.company.id}/agent-approvals`)).json()).toEqual({ approvals: "hires" });
    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "nothing" });
    const client = await c.mcp(c.ceo.id);
    expect(textOf(await client.callTool({ name: "propose_hire", arguments: { name: "Quinn", template: "qa", reason: "Releases need testing." } }))).toMatch(/^Quinn is hired/);
    await client.close();
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("The CEO hired Quinn (QA)");
  });

  it("changes instructions with a notification and undo, or waits when the owner approves edits too", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    // The CEO reads the current text before revising it; other agents can't.
    const read = textOf(await client.callTool({ name: "agent_instructions", arguments: { agent: "engineer" } }));
    expect(read).toMatch(/^# Engineer: Engineer \(hired from the engineer template\)/);
    expect(read).toContain("You build and fix software");
    const worker = await c.mcp(c.worker.id);
    expect(textOf(await worker.callTool({ name: "agent_instructions", arguments: { agent: "CEO" } }))).toBe("Only your company's CEO can read other agents' instructions.");
    await worker.close();
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "engineer", instructions: "Work only on the API.", reason: "The site is frozen." } }))).toContain("updated from their next run");
    const [eng] = await c.db.select().from(agents).where(eq(agents.id, c.worker.id));
    expect(eng!.instructions).toBe("Work only on the API.");
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("The CEO changed Engineer's instructions");
    const change = ((await c.req("GET", `/api/agents/${c.worker.id}/history`)).json() as Array<{ c: { id: string; field: string; byAgentId: string } }>).find((h) => h.c.field === "instructions")!;
    expect(change.c.byAgentId).toBe(c.ceo.id);
    expect((await c.req("POST", `/api/agent-changes/${change.c.id}/undo`)).json().instructions).toContain("You build and fix software");

    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: "Pair with QA.", reason: "Fewer bugs." } }))).toContain("waiting for the owner's approval");
    // A long change: the card's question holds the start, the queue carries all of it for the owner to read.
    const long = `Pair with QA.\n${"x".repeat(5000)}`;
    await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: long, reason: "Longer." } });
    const queued = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string; question: string; context: { instructions?: string } }>;
    const longOne = queued.find((q) => q.context.instructions === long)!;
    expect(longOne.question.length).toBeLessThan(long.length);
    await c.db.delete(decisions).where(eq(decisions.id, longOne.id));
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Apply the change" });
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]!.instructions).toBe("Pair with QA.");
    expect(await client.callTool({ name: "update_instructions", arguments: { agent: "Nobody", instructions: "x", reason: "y" } })).toMatchObject({ isError: true });
    await client.close();
  });
});

describe("the CEO assigns tickets, including to a planned hire", () => {
  const make = async (c: Awaited<ReturnType<typeof setup>>, title: string, assigneeAgentId?: string) => {
    const [pr] = await c.db.select().from(projects).where(eq(projects.companyId, c.company.id));
    const p = pr ?? (await c.db.insert(projects).values({ companyId: c.company.id, name: "App" }).returning())[0]!;
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: p.id, title, systemState: "ready", assigneeAgentId: assigneeAgentId ?? null });
  };
  const ticketOf = async (c: Awaited<ReturnType<typeof setup>>, title: string) => {
    const [t] = await c.db.select().from(tickets).where(eq(tickets.title, title));
    return t!;
  };

  it("sets and clears a ticket's assignee with a reason in the activity log, for managers only", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    await make(c, "Fix login");
    const t = await ticketOf(c, "Fix login");
    expect(t.assigneeAgentId).toBeNull();

    const set = await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Engineer", reason: "Engineer owns the login code" } });
    expect(set).not.toHaveProperty("isError", true);
    expect((await ticketOf(c, "Fix login")).assigneeAgentId).toBe(c.worker.id);
    let log = (await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary);
    expect(log).toContain("Assigned to Engineer");
    expect(log.some((s) => s.includes("Engineer owns the login code"))).toBe(true);

    expect(await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Nobody Here", reason: "r" } })).toMatchObject({ isError: true });

    await client.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: null, reason: "Reassigning later" } });
    expect((await ticketOf(c, "Fix login")).assigneeAgentId).toBeNull();
    log = (await c.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary);
    expect(log).toContain("Assigned to nobody");

    const other = await c.mcp(c.worker.id);
    expect(await other.callTool({ name: "update_ticket", arguments: { ticketId: t.id, assignee: "Engineer", reason: "r" } })).toMatchObject({ isError: true });
    await other.close();
    await client.close();
  });

  it("assigns tickets planned for a hire when the owner approves it, and leaves taken ones alone", async () => {
    const c = (ctx = await setup());
    const client = await c.mcp(c.ceo.id);
    await make(c, "Design the filter bar");
    await make(c, "Already taken", c.worker.id);
    const planned = await ticketOf(c, "Design the filter bar");
    const taken = await ticketOf(c, "Already taken");

    expect(await client.callTool({ name: "propose_hire", arguments: { name: "Dee", template: "scrum-master", reason: "r", forTickets: [randomUUID()] } })).toMatchObject({ isError: true });
    const r = await client.callTool({ name: "propose_hire", arguments: { name: "Dee", template: "scrum-master", reason: "Needs a designer", forTickets: [planned.id, taken.id] } });
    expect(textOf(r)).toMatch(/waiting for the owner's approval/);
    expect((await ticketOf(c, "Design the filter bar")).assigneeAgentId).toBeNull();

    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Hire" })).statusCode).toBeLessThan(300);
    const [dee] = await c.db.select().from(agents).where(eq(agents.name, "Dee"));
    expect((await ticketOf(c, "Design the filter bar")).assigneeAgentId).toBe(dee!.id);
    expect((await ticketOf(c, "Already taken")).assigneeAgentId).toBe(c.worker.id);
    await client.close();
  });
});
