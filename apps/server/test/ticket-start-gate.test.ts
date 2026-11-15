// A run can't start a ticket it shouldn't (BOS-254): not one that still waits on unfinished work,
// and not a Backlog ticket nobody handed it. The owner, the CEO and managers may override.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { startRefusal } from "../src/services/work.js";

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
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
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
  const ticket = async (title: string, assigneeAgentId?: string) =>
    (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...(assigneeAgentId ? { assigneeAgentId } : {}) })).json() as { id: string; version: number };
  return { ...built, db, close, req, company, ceo, project, worker, mcp, clients, ticket };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("a run can't start a ticket it shouldn't (BOS-254)", () => {
  it("refuses a ticket that still waits on an unfinished one, and moves it once that is done", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("Ship the base layout", c.worker.id);
    const waiting = await c.ticket("Build on the base", c.worker.id);
    await c.work.updateTicket(waiting.id, { state: "ready", byAgentId: c.ceo.id });
    await c.work.addDependency(waiting.id, { ticketId: blocker.id });
    const mcp = await c.mcp(c.worker.id);
    const move = () => mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: waiting.id, state: "in_progress" } });

    const refused = await move();
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/waits on .*Ship the base layout/i);
    const [still] = await c.db.select().from(tickets).where(eq(tickets.id, waiting.id));
    expect(still!.systemState).not.toBe("in_progress");

    await c.work.updateTicket(blocker.id, { state: "done", outcome: "completed" });
    const allowed = await move();
    expect(isError(allowed)).toBe(false);
  });

  it("lets the CEO override the blocker, as the ticket says", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("Ship the base layout", c.worker.id);
    const waiting = await c.ticket("Build on the base", c.worker.id);
    await c.work.addDependency(waiting.id, { ticketId: blocker.id });
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "set_ticket_state", arguments: { ticketId: waiting.id, state: "in_progress" } });
    expect(isError(r)).toBe(false);
  });

  it("refuses starting a Backlog ticket nobody handed over, and allows one that was handed over", async () => {
    const c = (ctx = await setup());
    const parked = await c.ticket("A future idea", c.worker.id);
    const mcp = await c.mcp(c.worker.id);
    const refused = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: parked.id, state: "in_progress" } });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/still in the Backlog/i);

    // A teammate's hand-over changes the ticket after it was created, so it is no longer "nobody handed it".
    await c.work.updateTicket(parked.id, { stateNote: "The CEO handed this to you: start it now.", byAgentId: c.ceo.id });
    const allowed = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: parked.id, state: "in_progress" } });
    expect(isError(allowed)).toBe(false);
  });

  it("still lets the owner move a waiting ticket by hand", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("Ship the base layout");
    const waiting = await c.ticket("Build on the base", c.worker.id);
    await c.work.addDependency(waiting.id, { ticketId: blocker.id });
    const r = await c.req("POST", `/api/tickets/${waiting.id}/state`, { state: "in_progress" });
    expect(r.statusCode).toBeLessThan(400);
  });

  it("startRefusal reads a waiting ticket, a handed-over backlog ticket and overrides", () => {
    const created = new Date("2026-10-01T00:00:00Z");
    const same = { createdAt: created, lastActivityAt: created };
    expect(startRefusal({ systemState: "ready", ...same }, [{ kind: "ticket", title: "Merge train" }], { agentId: "a", role: "worker" })).toMatch(/waits on "Merge train"/i);
    expect(startRefusal({ systemState: "ready", ...same }, [], { agentId: "a", role: "worker" })).toBeNull();
    expect(startRefusal({ systemState: "ready", ...same }, [{ kind: "decision", title: null }], { agentId: "a", role: "worker" })).toBeNull();
    expect(startRefusal({ systemState: "backlog", ...same }, [], { agentId: "a", role: "worker" })).toMatch(/Backlog/i);
    // A hand-over moves lastActivityAt past createdAt.
    expect(startRefusal({ systemState: "backlog", createdAt: created, lastActivityAt: new Date("2026-10-02T00:00:00Z") }, [], { agentId: "a", role: "worker" })).toBeNull();
    // The owner (no agent), the CEO and managers may start anything.
    expect(startRefusal({ systemState: "backlog", ...same }, [], { agentId: null })).toBeNull();
    expect(startRefusal({ systemState: "ready", ...same }, [{ kind: "ticket", title: null }], { agentId: "c", role: "ceo" })).toBeNull();
    expect(startRefusal({ systemState: "ready", ...same }, [{ kind: "ticket", title: null }], { agentId: "m", role: "manager" })).toBeNull();
  });
});
