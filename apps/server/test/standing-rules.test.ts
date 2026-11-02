import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { buildBrief } from "../src/services/brief.js";
import { STANDING_RULES_MAX } from "../src/services/standing-rules.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const clients: Client[] = [];
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()), req, company: co.company, ceo: co.ceo, dev, mcp };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const briefFor = (agentId: string, role: string) => buildBrief(ctx.db, { companyId: ctx.company.id, agentId, role, since: null, now: new Date() });

describe("standing rules (BOS-353)", () => {
  it("the owner's rules appear in every run's brief", async () => {
    const saved = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Never force-push. Only the merge gate runs the full check." });
    expect(saved.statusCode).toBe(200);
    const worker = await briefFor(ctx.dev.id, "worker");
    const ceo = await briefFor(ctx.ceo.id, "ceo");
    for (const b of [worker, ceo]) {
      expect(b).toContain("## Standing rules");
      expect(b).toContain("Never force-push. Only the merge gate runs the full check.");
    }
  });

  it("shows the text, last editor and time on the settings route", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Be kind." });
    const got = (await ctx.req("GET", `/api/companies/${ctx.company.id}/standing-rules`)).json() as { text: string; by: string | null; at: string | null; max: number };
    expect(got.text).toBe("Be kind.");
    expect(got.by).toBe("the owner");
    expect(got.at).toBeTruthy();
    expect(got.max).toBe(STANDING_RULES_MAX);
  });

  it("caps the length", async () => {
    const tooLong = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "x".repeat(STANDING_RULES_MAX + 1) });
    expect(tooLong.statusCode).toBe(400);
    const ok = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "x".repeat(STANDING_RULES_MAX) });
    expect(ok.statusCode).toBe(200);
  });

  it("an agent's write is refused; the CEO's is allowed", async () => {
    const worker = await ctx.mcp(ctx.dev.id);
    const r = await worker.callTool({ name: "standing_rules", arguments: { action: "write", text: "Do whatever you like." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain("Only your company's CEO");

    const ceo = await ctx.mcp(ctx.ceo.id);
    const w = await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: "Never force-push." } });
    expect((w as { isError?: boolean }).isError).toBeFalsy();
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Never force-push.");
  });
});
