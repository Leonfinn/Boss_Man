import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { registerBoard } from "../src/mcp-board.js";

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
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const mcp = async (agentId = worker.id) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: "00000000-0000-4000-8000-000000000001" });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  return { ...built, db, close, req, company, ceo, worker, project, mcp };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const split = (t: string) => {
  const i = t.indexOf("\n\n");
  return i < 0 ? { rows: JSON.parse(t) as Array<{ title: string }>, note: "" } : { rows: JSON.parse(t.slice(0, i)) as Array<{ title: string }>, note: t.slice(i + 2) };
};

describe("tickets find paging and assignee (BOS-2262)", () => {
  it("pages by 40 with a total and a continue hint, and filters by assignee name", async () => {
    const c = (ctx = await setup());
    for (let i = 0; i < 43; i++) await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: `Paged ${i}` });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Mine", assigneeAgentId: c.worker.id });
    const client = await c.mcp();
    const call = async (args: Record<string, unknown>) => textOf(await client.callTool({ name: "tickets", arguments: { action: "find", ...args } }));

    const first = split(await call({ q: "Paged" }));
    expect(first.rows).toHaveLength(40);
    expect(first.note).toContain("Showing 1 to 40 of 43");
    expect(first.note).toContain("tickets find offset=40");
    const second = split(await call({ q: "Paged", offset: 40 }));
    expect(second.rows).toHaveLength(3);
    expect(second.note).toContain("Showing 41 to 43 of 43");
    expect(second.note).not.toContain("continue with");
    expect(new Set([...first.rows, ...second.rows].map((r) => r.title)).size).toBe(43);

    // A short first page is the plain list, as before.
    const short = split(await call({ q: "Mine" }));
    expect(short.rows).toHaveLength(1);
    expect(short.note).toBe("Showing 1 to 1 of 1 matching tickets (newest activity first).");
    expect(split(await call({ assignee: "engineer" })).rows.map((r) => r.title)).toEqual(["Mine"]);
    expect(await call({ assignee: "Nobody" })).toContain('No agent called "Nobody"');
    await client.close();
  });

  it("the board says when it shows only the oldest 300 open tickets", async () => {
    const c = (ctx = await setup());
    await c.db.insert(tickets).values(Array.from({ length: 302 }, (_, i) => ({ companyId: c.company.id, projectId: c.project.id, number: 1000 + i, title: `Bulk ${i}` })));
    // The board tool is only on the chat and Scrum Master servers, so call its handler directly.
    let handler: (() => Promise<unknown>) | undefined;
    registerBoard({ registerTool: ((_n: string, _c: unknown, cb: () => Promise<unknown>) => void (handler = cb)) as never }, c.db, { companyId: c.company.id, agentId: null, runId: "r" });
    const board = JSON.parse(textOf(await handler!()));
    expect(board.openTickets).toHaveLength(300);
    expect(board.openTicketsNote).toBe("showing the oldest 300 of 302 open tickets; use tickets find state=… for the rest");
  });
});
