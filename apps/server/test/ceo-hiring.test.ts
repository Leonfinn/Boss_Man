import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, notifications } from "../src/db/schema.js";
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
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "engineer", instructions: "Work only on the API.", reason: "The site is frozen." } }))).toContain("updated from their next run");
    const [eng] = await c.db.select().from(agents).where(eq(agents.id, c.worker.id));
    expect(eng!.instructions).toBe("Work only on the API.");
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("The CEO changed Engineer's instructions");
    const change = ((await c.req("GET", `/api/agents/${c.worker.id}/history`)).json() as Array<{ c: { id: string; field: string; byAgentId: string } }>).find((h) => h.c.field === "instructions")!;
    expect(change.c.byAgentId).toBe(c.ceo.id);
    expect((await c.req("POST", `/api/agent-changes/${change.c.id}/undo`)).json().instructions).toContain("You build and fix software");

    await c.req("PUT", `/api/companies/${c.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    expect(textOf(await client.callTool({ name: "update_instructions", arguments: { agent: "Engineer", instructions: "Pair with QA.", reason: "Fewer bugs." } }))).toContain("waiting for the owner's approval");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Apply the change" });
    expect((await c.db.select().from(agents).where(eq(agents.id, c.worker.id)))[0]!.instructions).toBe("Pair with QA.");
    expect(await client.callTool({ name: "update_instructions", arguments: { agent: "Nobody", instructions: "x", reason: "y" } })).toMatchObject({ isError: true });
    await client.close();
  });
});
