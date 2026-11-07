import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (id: string, title: string) => (await db.insert(tickets).values({ id, companyId: co.company.id, projectId: project.id, title, systemState: "in_progress" }).returning())[0]!;
  return { ...built, db, close, base, co, dev, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function client() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId: ctx.dev.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("tickets: 8-character id prefix (BOS-435)", () => {
  it("read and find accept a unique prefix; an ambiguous one lists the matches; an unknown one is refused", async () => {
    await ctx.ticket("2b45038c-1111-4111-8111-111111111111", "Alpha ticket");
    await ctx.ticket("aaaaaaaa-1111-4111-8111-111111111111", "Beta ticket");
    await ctx.ticket("aaaaaaaa-2222-4222-8222-222222222222", "Gamma ticket");
    const c = await client();
    const call = async (arguments_: Record<string, string>) => textOf(await c.callTool({ name: "tickets", arguments: arguments_ }));

    expect(await call({ action: "read", ticketId: "2b45038c" })).toContain("# Alpha ticket");
    expect(await call({ action: "read", ticketId: "2B45038C" })).toContain("# Alpha ticket");
    expect(JSON.parse(await call({ action: "find", q: "2b45038c" })).map((r: { title: string }) => r.title)).toEqual(["Alpha ticket"]);

    const ambiguous = await call({ action: "read", ticketId: "aaaaaaaa" });
    expect(ambiguous).toContain("2 tickets start with aaaaaaaa");
    expect(ambiguous).toContain("Beta ticket");
    expect(ambiguous).toContain("Gamma ticket");

    expect(await call({ action: "read", ticketId: "deadbeef" })).toBe("No ticket deadbeef in your company.");
    await c.close();
  });
});
