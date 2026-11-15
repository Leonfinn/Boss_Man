// DR-061 Q3 (BOS-1534): one "is this agent busy / what can it carry on with" answer. agentBusy is the single busy rule
// (a live run that isn't a chat, or a queued/deferred wake); oldestMovableInProgress never names a ticket nobody can
// work on; the Agents page count, the Board's and the Dashboard's "working" count and the Board column limit all
// skip tickets that can't move or chat runs, like the agent's own limit does.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { agentBusy, busyAgentIds, oldestMovableInProgress } from "../src/services/agent-wip.js";

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
  const req = (method: "POST" | "GET", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = async (state: typeof tickets.$inferInsert["systemState"]) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const run = (purpose: string | null) => db.insert(runs).values({ companyId: company.id, agentId: worker.id, purpose } as typeof runs.$inferInsert);
  return { ...built, db, close, req, company, worker, ticket, run };
}

describe("agentBusy: the one busy rule", () => {
  it("a live work run makes the agent busy; a live chat run does not", async () => {
    const c = (ctx = await setup());
    expect(await agentBusy(c.db, c.worker.id)).toBe(false);
    await c.run("chat");
    expect(await agentBusy(c.db, c.worker.id)).toBe(false);
    expect([...(await busyAgentIds(c.db))]).not.toContain(c.worker.id);
    await c.run(null);
    expect(await agentBusy(c.db, c.worker.id)).toBe(true);
    expect([...(await busyAgentIds(c.db))]).toContain(c.worker.id);
  });

  it("a queued wake makes the agent busy, in both the one-agent and the many-agents form", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("ready");
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: c.worker.id, ticketId: t.id, reason: "assigned", status: "queued" } as typeof wakes.$inferInsert);
    expect(await agentBusy(c.db, c.worker.id)).toBe(true);
    expect([...(await busyAgentIds(c.db))]).toContain(c.worker.id);
  });
});

describe("oldestMovableInProgress", () => {
  it("skips an in-progress ticket that waits on an unfinished ticket, and names the next one", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("in_progress");
    const stuck = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: stuck.id, blockerTicketId: blocker.id });
    // `stuck` is newer than `blocker`; make it the oldest so only the rule (not the order) can skip it.
    await c.db.update(tickets).set({ createdAt: new Date(Date.now() - 86_400_000) }).where(eq(tickets.id, stuck.id));
    expect(await oldestMovableInProgress(c.db, c.worker.id)).toBe(blocker.id);
  });

  it("names nobody when every in-progress ticket is stuck", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("backlog");
    const stuck = await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: stuck.id, blockerTicketId: blocker.id });
    expect(await oldestMovableInProgress(c.db, c.worker.id)).toBeNull();
  });
});

describe("owner-visible counts use the same rules", () => {
  it("the Agents list counts only in-progress tickets that can move", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("backlog");
    const stuck = await c.ticket("in_progress");
    await c.ticket("in_progress");
    await c.db.insert(ticketDependencies).values({ blockedTicketId: stuck.id, blockerTicketId: blocker.id });
    const list = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as { id: string; wipCount: number }[];
    expect(list.find((a) => a.id === c.worker.id)?.wipCount).toBe(1);
  });

  it("the Dashboard and the Agents list agree: a chat run is not 'working'", async () => {
    const c = (ctx = await setup());
    await c.run("chat");
    const list = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as { id: string; working?: unknown }[];
    expect(list.find((a) => a.id === c.worker.id)?.working).toBeFalsy();
    const dash = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json() as { stats: { running: number } };
    expect(dash.stats.running).toBe(0);
  });
});
