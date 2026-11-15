// BOS-1479: a ticket that only waits on a queued or running check is freed from the COMPANY WIP limit (not the agent's),
// the CEO brief says how many Ready tickets the company limit refuses, and an update's resume wake skips such a ticket.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, runs, settings, tickets, wakes } from "../src/db/schema.js";
import { agentWipCount, agentWipHold, countInProgress } from "../src/services/agent-wip.js";
import { buildBrief } from "../src/services/brief.js";
import { sweepService } from "../src/services/sweeps.js";

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
  const ticket = async (state: typeof tickets.$inferInsert["systemState"], patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ systemState: state, ...patch }).where(eq(tickets.id, t.id));
    await db.delete(wakes).where(eq(wakes.ticketId, t.id));
    return t;
  };
  const check = (ticketId: string, state: string, kind = "pre_review") =>
    db.insert(checkJobs).values({ companyId: company.id, projectId: project.id, ticketId, kind, scope: "quick", commit: "abc", tree: randomUUID(), state });
  const limits = (v: { agent: number | null; company: number | null }) => db.insert(settings).values({ key: "wip_limits", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  return { ...built, db, close, cookie, company, project, worker, ticket, check, limits };
}

describe("tickets waiting on a queued check and the company limit (BOS-1479)", () => {
  it("a queued or running quick check frees the ticket from the company count only; a finished one or a merge job does not", async () => {
    ctx = await setup();
    const c = ctx;
    const queued = await c.ticket("in_progress");
    const running = await c.ticket("in_progress");
    const passed = await c.ticket("in_progress");
    const merging = await c.ticket("in_progress");
    await c.ticket("in_progress");
    await c.check(queued.id, "queued");
    await c.check(running.id, "running");
    await c.check(passed.id, "passed");
    await c.check(merging.id, "queued", "merge");
    const inCompany = eq(tickets.companyId, c.company.id);
    expect(await countInProgress(c.db, inCompany, undefined, "company")).toBe(3); // passed, merging, plain
    expect(await countInProgress(c.db, inCompany)).toBe(5); // the agent rule is unchanged
    expect(await agentWipCount(c.db, c.worker.id)).toBe(5);
  });

  it("a new start is held by the agent's own limit even when its other tickets wait on checks, and by the company limit only when real work fills it", async () => {
    ctx = await setup();
    const c = ctx;
    await c.limits({ agent: null, company: 2 });
    const a = await c.ticket("in_progress");
    const b = await c.ticket("in_progress");
    await c.check(a.id, "queued");
    await c.check(b.id, "queued");
    const next = await c.ticket("ready");
    const [row] = await c.db.select().from(tickets).where(eq(tickets.id, next.id));
    expect((await agentWipHold(c.db, row!)).hold).toBeNull(); // both in-progress tickets only wait for checks
    await c.db.delete(checkJobs).where(eq(checkJobs.ticketId, b.id));
    await c.ticket("in_progress");
    expect((await agentWipHold(c.db, row!)).hold?.scope).toBe("company"); // a (waiting) is free, b and the new one count: 2
    // The agent's own limit still counts the waiting ticket.
    await c.limits({ agent: 2, company: 10 });
    expect((await agentWipHold(c.db, row!)).hold?.scope).toBe("agent");
  });

  it("the CEO brief says how many Ready tickets the company limit refuses", async () => {
    ctx = await setup();
    const c = ctx;
    await c.limits({ agent: null, company: 1 });
    await c.ticket("in_progress");
    await c.ticket("ready", { wipHeldAt: new Date() });
    await c.ticket("ready", { wipHeldAt: new Date() });
    const text = await buildBrief(c.db, { companyId: c.company.id, agentId: null, role: "ceo", since: null, now: new Date() });
    expect(text).toContain("At company limit: 2 Ready tickets refused");
    await c.limits({ agent: null, company: 5 });
    expect(await buildBrief(c.db, { companyId: c.company.id, agentId: null, role: "ceo", since: null, now: new Date() })).not.toContain("At company limit");
  });

  it("an agent whose only Ready ticket the company limit holds is idle for the CEO, and the list names the limit", async () => {
    ctx = await setup();
    const c = ctx;
    const asked: string[] = [];
    const sweeps = sweepService(c.db, { wake: async (w) => void asked.push(w.note ?? ""), isConnected: () => true, endRun: async () => ({}), endUnconfirmedCancels: async () => ({}), alert: async () => null, freeSlots: async () => 2 });
    await c.limits({ agent: 2, company: 1 });
    // The company's CEO exists already; "Engineer" (c.worker) has no ticket, so it is idle too. Two more agents are Busy and Idler.
    const hire = async (name: string) => (await c.app.inject({ method: "POST", url: `/api/companies/${c.company.id}/agents`, headers: { cookie: c.cookie }, payload: { name } })).json() as { id: string };
    const busy = await hire("Busy");
    const idler = await hire("Idler");
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Real work", systemState: "in_progress", assigneeAgentId: busy!.id });
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Held work", systemState: "ready", assigneeAgentId: idler!.id, wipHeldAt: new Date(Date.now() - 3_600_000) });
    await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "Unassigned work", systemState: "ready" });
    await sweeps.run();
    const note = asked.find((n) => n.includes("Idle agents")) ?? "";
    expect(note).toContain("- Idler");
    expect(note).toContain("held by the company limit");
    expect(note).not.toContain("held behind");
  });

  it("an update's resume wake skips a ticket whose check is still queued, and wakes one with none", async () => {
    ctx = await setup();
    const c = ctx;
    const woken: string[] = [];
    const sweeps = sweepService(c.db, { wake: async (w) => void woken.push(w.ticketId!), isConnected: () => true, endRun: async () => ({}), endUnconfirmedCancels: async () => ({}), alert: async () => null });
    const waiting = await c.ticket("in_progress");
    const plain = await c.ticket("in_progress");
    await c.check(waiting.id, "queued");
    const since = new Date(Date.now() - 60_000);
    for (const t of [waiting, plain]) await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.worker.id, ticketId: t.id, startedAt: since, endedAt: new Date(), outcome: "completed" });
    await sweeps.resumeAfterUpdate(since);
    expect(woken).toEqual([plain.id]);
  });
});
