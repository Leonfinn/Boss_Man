import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { deploys } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
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
  const mk = async (name: string) => {
    const { company } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    const agent = (await req("POST", `/api/companies/${company.id}/agents`, { name: `${name} engineer` })).json() as { id: string };
    const target = (await req("POST", `/api/companies/${company.id}/deploy-targets`, { name: "Staging", kind: "docker", endpoint: "tcp://socket-proxy:2375" })).json() as { id: string };
    return { company, agent, target };
  };
  const mcp = async (x: { company: { id: string }; agent: { id: string } }) => {
    const token = await issueRunToken(db, { companyId: x.company.id, agentId: x.agent.id, runId: "00000000-0000-4000-8000-000000000001" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, mk, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("deploy tool: history", () => {
  it("lists a target's deploys newest first, failed ones too, honours the limit, and never shows another company's", async () => {
    const c = (ctx = await setup());
    const a = await c.mk("Alpha");
    const b = await c.mk("Beta");
    const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 10, n));
    await c.db.insert(deploys).values([
      { companyId: a.company.id, targetId: a.target.id, agentId: a.agent.id, ref: "v1", status: "succeeded", commit: "a".repeat(40), createdAt: at(1) },
      { companyId: a.company.id, targetId: a.target.id, agentId: a.agent.id, ref: "v2", status: "failed", createdAt: at(2) },
      { companyId: a.company.id, targetId: a.target.id, agentId: null, ref: "v3", status: "rejected", createdAt: at(3) },
      { companyId: b.company.id, targetId: b.target.id, ref: "secret-ref", status: "succeeded", createdAt: at(4) },
    ]);
    const client = await c.mcp(a);
    const all = textOf(await client.callTool({ name: "deploy", arguments: { action: "history", target: "staging" } })).split("\n");
    expect(all).toHaveLength(3);
    expect(all[0]).toContain("| v3 |");
    expect(all[0]).toContain("by the owner");
    expect(all[0]).toContain("rejected");
    expect(all[1]).toContain("v2");
    expect(all[1]).toContain("failed");
    expect(all[2]).toContain("v1 (aaaaaaa)");
    expect(all[2]).toContain("2026-11-20 10:01 UTC");
    const one = textOf(await client.callTool({ name: "deploy", arguments: { action: "history", target: a.target.id, limit: 1 } }));
    expect(one.split("\n")).toHaveLength(1);
    // Another company's target is not found, and its deploys never appear.
    const other = await client.callTool({ name: "deploy", arguments: { action: "history", target: b.target.id } });
    expect(textOf(other)).toContain("No deploy target");
    expect(all.join("\n")).not.toContain("secret-ref");
    expect(textOf(await client.callTool({ name: "deploy", arguments: { action: "history" } }))).toContain("Give the target");
    await client.close();
  });
});
