import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, policyRules, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.clients.forEach((c) => c.close());
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
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, mcp, clients };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const propose = { name: "Allow GitHub reads", explanation: "Lets agents read from GitHub without asking you.", outcome: "allow", match: { titlePattern: "^mcp__github__(get|list)_" } };

describe("rule requests", () => {
  it("wakes the CEO with the owner's words", async () => {
    const c = (ctx = await setup());
    const r = await c.req("POST", `/api/companies/${c.company.id}/rule-requests`, { text: "Let agents read GitHub freely" });
    expect(r.statusCode).toBe(202);
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id));
    expect(w).toMatchObject({ reason: "rule request", ticketId: null });
    expect(w!.note).toContain("Let agents read GitHub freely");
    expect(w!.note).toContain("propose_rule");
    expect((await c.req("POST", `/api/companies/${c.company.id}/rule-requests`, { text: "  " })).statusCode).toBe(400);
  });

  it("queues the CEO's proposal for the owner, and adds the rule (safe-only when it allows) on approval", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    expect(textOf(await ceo.callTool({ name: "propose_rule", arguments: propose }))).toMatch(/waiting for the owner's answer/);
    const [d] = await c.db.select().from(decisions);
    expect(d).toMatchObject({ kind: "question", tier: "owner", options: ["Add this rule", "Don't add"], recommendedOption: "Add this rule", raisedByAgentId: c.ceo.id });
    expect(d!.question).toContain("Lets agents read from GitHub");
    expect(await c.db.select().from(policyRules)).toEqual([]);

    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Add this rule" })).statusCode).toBe(200);
    const [rule] = await c.db.select().from(policyRules);
    expect(rule).toMatchObject({ companyId: c.company.id, name: "Allow GitHub reads", outcome: "allow", condition: { titlePattern: "^mcp__github__(get|list)_", safeOnly: true } });
  });

  it("adds nothing when declined or answered in the owner's words, and wakes the CEO with those words", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    await ceo.callTool({ name: "propose_rule", arguments: { ...propose, outcome: "owner" } });
    const [d] = await c.db.select().from(decisions);
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Add this rule", custom: true });
    expect(await c.db.select().from(policyRules)).toEqual([]);
    expect((await c.db.select().from(wakes).where(eq(wakes.reason, "decision answered")))[0]!.note).toContain("Add this rule");
  });

  it("refuses a bad regex, a rule with no condition, and anyone but the CEO", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    expect(await ceo.callTool({ name: "propose_rule", arguments: { ...propose, match: { commandPattern: "(" } } })).toMatchObject({ isError: true });
    expect(await ceo.callTool({ name: "propose_rule", arguments: { ...propose, match: {} } })).toMatchObject({ isError: true });
    const other = await c.mcp(c.worker.id);
    expect(textOf(await other.callTool({ name: "propose_rule", arguments: propose }))).toContain("Only your company's CEO");
    expect(await c.db.select().from(decisions)).toEqual([]);
  });
});
