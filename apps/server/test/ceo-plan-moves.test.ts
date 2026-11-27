// BOS-1509 (T13): the CEO's plan is shown to the assignee, a move off the plan tells the mover and the CEO once,
// the plan's deadline card also fires in Backlog, Blocked and Review, finished work can't be parked in Blocked to
// wait for another ticket's merge, and the CEO hears when an urgent ticket goes backwards.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, reviewRequests, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { buildBrief } from "../src/services/brief.js";
import { addTicketDependency } from "../src/services/ticket-links.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const HOUR = 3_600_000;
const REASON = "ticket moved off plan";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close().catch(() => undefined))), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Plan Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const ticket = async (fields: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id, ...fields })).json() as { id: string };
  const put = async (id: string, patch: Partial<typeof tickets.$inferInsert>) => {
    await db.update(tickets).set(patch).where(eq(tickets.id, id));
    await db.delete(wakes).where(eq(wakes.ticketId, id));
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const move = async (c: Client, ticketId: string, state: string, extra: Record<string, unknown> = {}) => textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId, state, summary: "Moving it.", ...extra } }));
  const ceoWakes = async (ticketId: string) => db.select().from(wakes).where(and(eq(wakes.agentId, ceo.id), eq(wakes.ticketId, ticketId), eq(wakes.reason, REASON)));
  const plan = (ticketId: string, fields: Partial<typeof tickets.$inferInsert> = {}) => put(ticketId, { ceoPlan: "Engineer splits it in two", ceoPlanDeadline: new Date(Date.now() + 6 * HOUR), ...fields });
  return { ...built, db, req, company, ceo, worker, project, ticket, put, row, mcp, move, ceoWakes, plan };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
type Ctx = Awaited<ReturnType<typeof setup>>;

/** A ticket that waits on another ticket's merge. */
async function waitingOnTicket(c: Ctx, state: "review" | "in_progress") {
  const t = await c.ticket();
  const other = await c.ticket();
  await c.put(t.id, { systemState: state });
  await addTicketDependency(c.db, { companyId: c.company.id, blockedTicketId: t.id, blockerTicketId: other.id, actor: { type: "system" }, until: "merged" });
  return t;
}

describe("the plan is shown (BOS-1509)", () => {
  it("tickets read and the assignee's brief carry the plan with its deadline", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.plan(t.id, { systemState: "in_progress" });
    const read = textOf(await (await c.mcp(c.worker.id)).callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }));
    expect(read).toMatch(/CEO plan \(due \d{4}-\d\d-\d\d \d\d:\d\d UTC\): Engineer splits it in two/);
    const brief = await buildBrief(c.db, { companyId: c.company.id, agentId: c.worker.id, role: "worker", since: null, now: new Date() });
    expect(brief).toMatch(/CEO plan \(due [^)]+\): Engineer splits it in two/);
  });
});

describe("a move off the plan (BOS-1509)", () => {
  it("still works, quotes the plan to the mover, and wakes the CEO once with the plan, old -> new and the summary", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.plan(t.id, { systemState: "in_progress" });
    const worker = await c.mcp(c.worker.id);
    const reply = await c.move(worker, t.id, "blocked", { blocked_until: new Date(Date.now() + 2 * HOUR).toISOString(), blocked_reason: "waiting for data", summary: "Parked for the data." });
    expect(reply).toContain("is now blocked");
    expect(reply).toContain("Engineer splits it in two");
    expect(reply).toMatch(/The CEO was alerted: raised at \d\d:\d\d UTC/);
    expect((await c.row(t.id)).systemState).toBe("blocked");
    const [w, ...rest] = await c.ceoWakes(t.id);
    expect(rest).toHaveLength(0);
    expect(w!.note).toContain("in_progress -> blocked");
    expect(w!.note).toContain("Engineer splits it in two");
    expect(w!.note).toContain("Parked for the data.");
    // Repeating the same move changes only the note: no second wake.
    await c.move(worker, t.id, "blocked", { blocked_until: new Date(Date.now() + 2 * HOUR).toISOString(), blocked_reason: "waiting for data", summary: "Still parked." });
    expect(await c.ceoWakes(t.id)).toHaveLength(1);
  });

  it("covers In progress -> Ready and Backlog, but not an expired plan or a plain forward move", async () => {
    const c = await setup();
    const worker = await c.mcp(c.worker.id);
    const a = await c.ticket();
    await c.plan(a.id, { systemState: "in_progress" });
    expect(await c.move(worker, a.id, "ready")).toMatch(/The CEO was alerted: raised at \d\d:\d\d UTC/);
    const b = await c.ticket();
    await c.plan(b.id, { systemState: "in_progress", ceoPlanDeadline: new Date(Date.now() - HOUR) });
    expect(await c.move(worker, b.id, "ready")).not.toContain("CEO plan");
    expect(await c.ceoWakes(b.id)).toHaveLength(0);
    const d = await c.ticket();
    await c.plan(d.id, { systemState: "ready" });
    await c.move(worker, d.id, "in_progress");
    expect(await c.ceoWakes(d.id)).toHaveLength(0);
  });

  it("the CEO's own move is allowed and wakes nobody", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.plan(t.id, { systemState: "in_progress" });
    const reply = await c.move(await c.mcp(c.ceo.id), t.id, "ready");
    expect(reply).toContain("You are the CEO");
    expect(await c.ceoWakes(t.id)).toHaveLength(0);
  });
});

describe("the plan's deadline card in any open state (BOS-1509)", () => {
  it("fires once for a Blocked ticket and a Backlog ticket whose plan has passed", async () => {
    const c = await setup();
    const blocked = await c.ticket();
    const backlog = await c.ticket();
    const fresh = await c.ticket();
    await c.plan(blocked.id, { systemState: "blocked", ceoPlanDeadline: new Date(Date.now() - 2 * HOUR) });
    await c.plan(backlog.id, { systemState: "backlog", ceoPlanDeadline: new Date(Date.now() - 2 * HOUR) });
    await c.plan(fresh.id, { systemState: "blocked" });
    await c.sweeps.run();
    await c.sweeps.run();
    const cards = await c.db.select().from(decisions);
    expect(cards.map((d) => d.question).filter((q) => q.includes("had a deadline of"))).toHaveLength(2);
    expect((await c.row(blocked.id)).ceoPlanAlertedAt).not.toBeNull();
    expect((await c.row(fresh.id)).ceoPlanAlertedAt).toBeNull();
  });
});

describe("finished work doesn't wait in Blocked (BOS-1509)", () => {
  it("refuses Review -> Blocked when the only wait is another ticket's merge, and says it waits in review", async () => {
    const c = await setup();
    const t = await waitingOnTicket(c, "review");
    const reply = await c.move(await c.mcp(c.worker.id), t.id, "blocked");
    expect(reply).toContain("Passed, held");
    expect(reply).toContain("Leave it in review");
    expect((await c.row(t.id)).systemState).toBe("review");
  });

  it("still allows Review -> Blocked for a date or an open card", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "review" });
    expect(await c.move(await c.mcp(c.worker.id), t.id, "blocked", { blocked_until: new Date(Date.now() + 2 * HOUR).toISOString(), blocked_reason: "scheduled deploy" })).toContain("is now blocked");
  });

  it("warns, but allows, In progress -> Blocked on a waits-on once the ticket has had a review round", async () => {
    const c = await setup();
    const worker = await c.mcp(c.worker.id);
    const t = await waitingOnTicket(c, "in_progress");
    await c.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", round: 1, status: "approved" });
    const reply = await c.move(worker, t.id, "blocked");
    expect(reply).toContain("is now blocked");
    expect(reply).toContain("move it back to review");
    const fresh = await waitingOnTicket(c, "in_progress");
    expect(await c.move(worker, fresh.id, "blocked")).not.toContain("move it back to review");
  });
});

describe("an urgent ticket going backwards (BOS-1509)", () => {
  it("tells the CEO once, with no plan on the ticket", async () => {
    const c = await setup();
    const t = await c.ticket();
    await c.put(t.id, { systemState: "review", urgent: true });
    const worker = await c.mcp(c.worker.id);
    await c.move(worker, t.id, "in_progress", { summary: "Reviewer asked for changes." });
    const [w, ...rest] = await c.ceoWakes(t.id);
    expect(rest).toHaveLength(0);
    expect(w!.note).toContain("review -> in_progress");
    expect(w!.note).toContain("urgent");
    const plain = await c.ticket();
    await c.put(plain.id, { systemState: "review" });
    await c.move(worker, plain.id, "in_progress");
    expect(await c.ceoWakes(plain.id)).toHaveLength(0);
  });
});
