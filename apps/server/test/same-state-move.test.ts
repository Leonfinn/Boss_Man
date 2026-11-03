// A same-state move only updates the note (DR-010, BOS-438): review -> review must not open a new
// review round or wipe the verdicts; in progress -> review still opens one. Owner route too.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { reviewRequests, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
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
  const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async () => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, t.id));
    return t;
  };
  const rounds = async (id: string) => (await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, id))).map((r) => r.round);
  return { ...built, db, close, req, mcp, worker, ticket, rounds, clients };
}

const move = (c: Client, ticketId: string, summary: string) => c.callTool({ name: "set_ticket_state", arguments: { ticketId, state: "review", summary } });

describe("a same-state move only updates the note (DR-010)", () => {
  it("in progress -> review opens a round; review -> review by an agent keeps it and its verdicts", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket();
    const mcp = await c.mcp(c.worker.id);
    await move(mcp, t.id, "ready");
    const first = await c.rounds(t.id);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first)).toEqual(new Set([1]));
    await c.db.update(reviewRequests).set({ status: "approved" }).where(eq(reviewRequests.ticketId, t.id));

    const again = await move(mcp, t.id, "note refreshed");
    expect(JSON.stringify(again)).toMatch(/only the note changed/);
    expect((await c.rounds(t.id)).sort()).toEqual([...first].sort());
    const rows = await c.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(rows.every((r) => r.status === "approved")).toBe(true);
    const [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.stateNote).toBe("note refreshed");
  });

  it("the owner route has the same guard", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket();
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "review" });
    const first = await c.rounds(t.id);
    expect(first.length).toBeGreaterThan(0);
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "review" });
    expect((await c.rounds(t.id)).sort()).toEqual([...first].sort());
  });
});
