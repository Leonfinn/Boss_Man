// BOS-1473: create_ticket and update_ticket warn (never refuse) when a criterion or the ticket text names
// staging and the company has no non-production deploy target; the risk-tier help drops its staging promise
// in the same case. Each test fails without the warning and passes with it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { deployTargets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Staging Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" });
  const ceo = async () => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId: co.ceo.id, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const target = (isProduction: boolean) => db.insert(deployTargets).values({ companyId: co.company.id, name: isProduction ? "prod" : "stage", kind: "ssh", endpoint: "deploy@example.invalid", isProduction });
  return { db, req, co, ceo, target, done: () => Promise.all(clients.map((c) => c.close())) };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const STAGING_CRITERION = "Behaviour checked on staging";

describe("staging warning", () => {
  beforeAll(async () => {
    server = await boot();
  });
  afterAll(async () => {
    await server.built.app.close();
    await server.close();
  });
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.done();
  });

  const create = async (criteria: string[], title = "Rate limiting") => {
    const c = await ctx.ceo();
    return textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title, body: "Add a limit.", acceptanceCriteria: criteria } }));
  };

  it("create_ticket warns about a staging criterion when no deploy target exists, and still creates the ticket", async () => {
    const t = await create([STAGING_CRITERION]);
    expect(t).toMatch(/Created/);
    expect(t).toContain("names staging");
    expect(t).toContain("warning only");
  });

  it("a production-only target does not make staging reachable", async () => {
    await ctx.target(true);
    expect(await create([STAGING_CRITERION])).toContain("names staging");
  });

  it("a non-production target silences the warning", async () => {
    await ctx.target(false);
    expect(await create([STAGING_CRITERION])).not.toContain("names staging");
  });

  it("git's staging area wording never warns", async () => {
    expect(await create(["Nothing is left in the staging area"])).not.toContain("names staging");
  });

  it("update_ticket warns when new criteria or a new body name staging, and not when they don't", async () => {
    const made = await create(["Plain criterion"]);
    const id = /Created (?:ticket |#\/tickets\/)([0-9a-f-]{36})/.exec(made)![1]!;
    const c = await ctx.ceo();
    const update = async (args: Record<string, unknown>) => textOf(await c.callTool({ name: "update_ticket", arguments: { ticketId: id, reason: "test", ...args } }));
    const byCriteria = await update({ acceptanceCriteria: [STAGING_CRITERION] });
    expect(byCriteria).toContain("names staging");
    const byBody = await update({ body: "Then verify it on staging." });
    expect(byBody).toContain("names staging");
    const clean = await update({ body: "Verify with the merge check." });
    expect(clean).not.toContain("names staging");
    await ctx.target(false);
    const reachable = await update({ acceptanceCriteria: [STAGING_CRITERION] });
    expect(reachable).not.toContain("names staging");
  });

  it("/api/risk-tiers omits the staging promise with no target and includes it with a non-production one", async () => {
    const summaries = async () => ((await ctx.req("GET", `/api/risk-tiers?companyId=${ctx.co.company.id}`)).json() as Array<{ summary: string }>).map((t) => t.summary).join(" ");
    expect(await summaries()).not.toContain("staging");
    await ctx.target(false);
    expect(await summaries()).toContain("staging");
  });
});
