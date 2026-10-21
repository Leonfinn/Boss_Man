import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  return { ...built, close, req, company, worker, project, sent };
}

const good = { name: "scrapling", url: "http://192.168.68.67:30301/mcp", transport: "http", secretEnv: "SCRAPLING_MCP_TOKEN" };

describe("tool servers (MCP)", () => {
  it("refuses bad input", async () => {
    const c = (ctx = await setup());
    const url = `/api/companies/${c.company.id}/mcp-servers`;
    for (const bad of [
      { ...good, name: "Scrapling" },
      { ...good, name: "1st" },
      { ...good, name: "bossman" },
      { ...good, url: "ftp://host/mcp" },
      { ...good, url: "not a url" },
      { ...good, secretEnv: "lower_case" },
      { ...good, headerName: "Bad Header" },
      { ...good, headerValue: "Bearer literal-token" },
      { ...good, transport: "ws" },
    ]) expect((await c.req("POST", url, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await c.req("GET", url)).json()).toEqual([]);
  });

  it("creates, lists, refuses a duplicate name and deletes", async () => {
    const c = (ctx = await setup());
    const url = `/api/companies/${c.company.id}/mcp-servers`;
    const made = await c.req("POST", url, good);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ ...good, headerName: "Authorization", headerValue: "Bearer {secret}" });
    expect((await c.req("POST", url, good)).statusCode).toBe(409);
    expect((await c.req("POST", url, { name: "crawl4ai", url: "http://192.168.68.67:11235/mcp/sse", transport: "sse" })).json().secretEnv).toBeNull();
    expect((await c.req("GET", url)).json().map((m: { name: string }) => m.name)).toEqual(["crawl4ai", "scrapling"]);
    expect((await c.req("DELETE", `/api/mcp-servers/${made.json().id}`)).statusCode).toBe(204);
    expect((await c.req("DELETE", `/api/mcp-servers/${made.json().id}`)).statusCode).toBe(404);
    expect((await c.req("GET", url)).json()).toHaveLength(1);
  });

  it("sends the servers to the runner without secret values, and names them in the prompt", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/companies/${c.company.id}/mcp-servers`, good);
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Look it up", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const start = c.sent.find((s): s is Extract<RunnerCommand, { type: "run.start" }> => s.type === "run.start")!;
    expect(start.mcpServers).toEqual([{ name: "scrapling", url: good.url, transport: "http", headerName: "Authorization", headerValue: "Bearer {secret}", secretEnv: "SCRAPLING_MCP_TOKEN" }]);
    expect(start.prompt).toContain("Extra tools may be available from these servers: scrapling.");
  });
});
