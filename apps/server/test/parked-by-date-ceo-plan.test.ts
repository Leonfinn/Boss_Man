// BOS-2402: the "parked by date again and again" alert (the third date-only park in a row wakes the CEO) stays
// quiet while the ticket has a CEO plan whose deadline plus grace is still ahead, and fires as before without
// a plan or once the deadline plus grace has passed.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const HOUR = 3_600_000;
const REASON = "parked by date again and again";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close().catch(() => undefined))), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Park Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();

  /** A ticket in progress, with an optional CEO plan due `planInMs` from now (negative: already past). */
  const ticket = async (planInMs?: number) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Living plan", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: "in_progress", ...(planInMs === undefined ? {} : { ceoPlan: "Refresh daily", ceoPlanDeadline: new Date(Date.now() + planInMs) }) }).where(eq(tickets.id, t.id));
    return t;
  };
  const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId: randomUUID() });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  /** Park it by date three times in a row, with no link between. */
  const parkThrice = async (ticketId: string) => {
    for (let i = 1; i <= 3; i++) {
      const r = (await client.callTool({ name: "set_ticket_state", arguments: { ticketId, state: "blocked", summary: `Parked ${i}.`, blocked_until: new Date(Date.now() + 2 * HOUR).toISOString(), blocked_reason: "next refresh" } })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(r.isError, r.content[0]?.text).toBeFalsy();
    }
  };
  const alerts = async (ticketId: string) => db.select().from(wakes).where(and(eq(wakes.agentId, ceo.id), eq(wakes.ticketId, ticketId), eq(wakes.reason, REASON)));
  return { ticket, parkThrice, alerts };
}

describe("parked by date again and again, and the CEO plan (BOS-2402)", () => {
  it("wakes the CEO on the third park when the ticket has no plan", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.parkThrice(t.id);
    expect(await c.alerts(t.id)).toHaveLength(1);
  });

  it("stays quiet while a plan's deadline is still ahead", async () => {
    const c = await setup();
    const t = await c.ticket(6 * HOUR);
    await c.parkThrice(t.id);
    expect(await c.alerts(t.id)).toHaveLength(0);
  });

  it("stays quiet inside the grace after the deadline", async () => {
    const c = await setup();
    const t = await c.ticket(-60_000);
    await c.parkThrice(t.id);
    expect(await c.alerts(t.id)).toHaveLength(0);
  });

  it("fires again once the deadline plus grace has passed", async () => {
    const c = await setup();
    const t = await c.ticket(-HOUR);
    await c.parkThrice(t.id);
    expect(await c.alerts(t.id)).toHaveLength(1);
  });
});
