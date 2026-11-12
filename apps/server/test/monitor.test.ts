import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, checkJobs, companies, decisions, runs, tickets, wakes } from "../src/db/schema.js";
import { CARRY_ON_NOTE } from "../src/services/scheduler.js";
import { issueRunToken } from "../src/mcp.js";

const clients: Client[] = [];
let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const other = (await req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const p = await built.work.createProject(co.company.id, "App");
  const [peer] = await db.insert(agents).values({ companyId: co.company.id, name: "Peer", role: "worker", agentKind: "claude" }).returning();
  return { ...built, db, close, base, co, other, p, peer: peer!, req };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
async function agent(agentId: string, companyId = ctx.co.company.id) {
  const token = await issueRunToken(ctx.db, { companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const checkWakes = async (id: string) => ctx.db.select().from(wakes).where(and(eq(wakes.ticketId, id), eq(wakes.reason, "check due")));
const alerts = async () => ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.co.company.id));
const working = async () => {
  const t = await ctx.work.createTicket(ctx.p.id, { title: "Ship it", assigneeAgentId: ctx.co.ceo.id });
  await ctx.work.updateTicket(t.id, { state: "in_progress" });
  return t;
};
const schedule = (c: Client, ticketId: string, extra: Record<string, unknown> = {}) => c.callTool({ name: "schedule_check", arguments: { ticketId, note: "CI on the PR", inMinutes: 30, ...extra } });
/** Makes the monitor due now. */
const due = (id: string) => ctx.db.update(tickets).set({ monitorAt: new Date(Date.now() - 1000) }).where(eq(tickets.id, id));

describe("schedule_check", () => {
  it("lets the assignee schedule and clear, and nobody else", async () => {
    const t = await working();
    const me = await agent(ctx.co.ceo.id);
    const r = await schedule(me, t.id, { maxChecks: 3 });
    expect(textOf(r)).toMatch(/check 1 of 3/);
    expect(await row(t.id)).toMatchObject({ monitorNote: "CI on the PR", monitorMax: 3 });
    expect((await row(t.id)).monitorAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

    const peer = await agent(ctx.peer.id);
    expect(textOf(await schedule(peer, t.id))).toMatch(/Only the agent the ticket is assigned to/);
    expect(textOf(await peer.callTool({ name: "clear_check", arguments: { ticketId: t.id } }))).toMatch(/Only the agent/);
    const foreign = await agent(ctx.other.ceo.id, ctx.other.company.id);
    expect(textOf(await schedule(foreign, t.id))).toMatch(/No ticket with that ID in your company/);
    expect((await row(t.id)).monitorAt).not.toBeNull();

    await me.callTool({ name: "clear_check", arguments: { ticketId: t.id } });
    expect((await row(t.id)).monitorAt).toBeNull();
  });

  it("refuses a past time and a ticket that is not in progress or review", async () => {
    const t = await working();
    const me = await agent(ctx.co.ceo.id);
    const past = await me.callTool({ name: "schedule_check", arguments: { ticketId: t.id, note: "x", at: new Date(Date.now() - 60_000).toISOString() } });
    expect(textOf(past)).toMatch(/in the future/);
    await ctx.work.updateTicket(t.id, { state: "backlog" });
    expect(textOf(await schedule(me, t.id))).toMatch(/in progress, in review or blocked/);
    expect((await row(t.id)).monitorAt).toBeNull();
  });

  it("works on a Blocked ticket and fires there (BOS-1171)", async () => {
    const t = await working();
    await ctx.work.updateTicket(t.id, { state: "blocked" });
    const me = await agent(ctx.co.ceo.id);
    expect(textOf(await schedule(me, t.id))).toMatch(/You will be woken/);
    expect((await row(t.id)).monitorAt).not.toBeNull();
    await due(t.id);
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(1);
  });
});

describe("firing", () => {
  it("does not fire checks from the queue pass; the slower pass wakes one due at T within 30 s (BOS-414)", async () => {
    const t = await working();
    await schedule(await agent(ctx.co.ceo.id), t.id);
    await due(t.id);
    // Five 5 s queue passes run before the 30 s slower pass: none of them fires it.
    for (let i = 0; i < 5; i++) await ctx.scheduler.tick();
    expect(await checkWakes(t.id)).toHaveLength(0);
    // The slower pass at 30 s does, at most one pass interval after it fell due.
    await ctx.scheduler.slow();
    const w = await checkWakes(t.id);
    expect(w).toHaveLength(1);
    expect(w[0]!.note).toMatch(/^Check due \(1 of 5\): CI on the PR\./);
  });

  it("fires once per due time, counts the attempt and wakes with the note", async () => {
    const t = await working();
    await schedule(await agent(ctx.co.ceo.id), t.id);
    await ctx.scheduler.tick();
    expect(await checkWakes(t.id)).toHaveLength(0); // not due yet
    await due(t.id);
    // Scheduled checks ride the slower pass (BOS-414): the queue tick alone leaves a due check alone.
    await ctx.scheduler.tick();
    expect(await checkWakes(t.id)).toHaveLength(0);
    await Promise.all([ctx.scheduler.slow(), ctx.scheduler.slow()]);
    const w = await checkWakes(t.id);
    expect(w).toHaveLength(1);
    expect(w[0]!.agentId).toBe(ctx.co.ceo.id);
    expect(w[0]!.note).toBe("Check due (1 of 5): CI on the PR. Re-check it now. If you still need to wait, call schedule_check again; otherwise carry on or finish.");
    expect(await row(t.id)).toMatchObject({ monitorAt: null, monitorAttempts: 1 });
  });

  it("fires on the next slower pass after the owner's Check now", async () => {
    const t = await working();
    await schedule(await agent(ctx.co.ceo.id), t.id);
    expect((await ctx.req("PUT", `/api/tickets/${t.id}/monitor`, { note: "CI on the PR" })).statusCode).toBe(200);
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(1);
  });

  it("lets the owner set and clear one", async () => {
    const t = await working();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const set = await ctx.req("PUT", `/api/tickets/${t.id}/monitor`, { at, note: "Deploy" });
    expect(set.json()).toMatchObject({ monitorNote: "Deploy", monitorAt: at });
    expect((await ctx.req("PUT", `/api/tickets/${t.id}/monitor`, { at, note: "" })).statusCode).toBe(400);
    await ctx.req("DELETE", `/api/tickets/${t.id}/monitor`);
    expect((await row(t.id)).monitorAt).toBeNull();
  });

  it("after the last check tells the owner once and stops waking", async () => {
    const t = await working();
    const me = await agent(ctx.co.ceo.id);
    await schedule(me, t.id, { maxChecks: 2 });
    for (let i = 0; i < 2; i++) {
      await due(t.id);
      await ctx.scheduler.slow();
      expect(await checkWakes(t.id)).toHaveLength(1);
      await ctx.db.delete(wakes).where(eq(wakes.reason, "check due")); // the agent got it
      await schedule(me, t.id, { maxChecks: 2 });
    }
    expect((await row(t.id)).monitorAttempts).toBe(2);
    await due(t.id);
    await ctx.scheduler.slow();
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(0);
    const a = (await alerts()).filter((d) => d.question.includes("still isn't resolved"));
    expect(a).toHaveLength(1);
    expect(a[0]!.question).toBe("Boss Man CEO has checked 'CI on the PR' 2 times on 'Ship it' and it still isn't resolved.".replace("Boss Man CEO", (await ctx.db.select().from(agents).where(eq(agents.id, ctx.co.ceo.id)))[0]!.name));
    expect((await row(t.id)).monitorAt).toBeNull();
  });

  it("clears the monitor when the ticket is done, and ignores one that is due on a done ticket", async () => {
    const t = await working();
    await schedule(await agent(ctx.co.ceo.id), t.id);
    await ctx.work.updateTicket(t.id, { state: "done" });
    expect((await row(t.id)).monitorAt).toBeNull();
    await ctx.db.update(tickets).set({ monitorAt: new Date(Date.now() - 1000) }).where(eq(tickets.id, t.id));
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(0);
    expect((await row(t.id)).monitorAt).toBeNull();
  });

  it("does not fire in a paused company", async () => {
    const t = await working();
    await schedule(await agent(ctx.co.ceo.id), t.id);
    await due(t.id);
    await ctx.db.update(companies).set({ paused: true }).where(eq(companies.id, ctx.co.company.id));
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(0);
    expect((await row(t.id)).monitorAt).not.toBeNull();
    await ctx.db.update(companies).set({ paused: false }).where(eq(companies.id, ctx.co.company.id));
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(1);
  });
});

describe("carry on after a run", () => {
  const ranOn = async (ticketId: string, startedAt = new Date(Date.now() - 60_000)) =>
    (await ctx.db.insert(runs).values({ companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, ticketId, purpose: "ticket", startedAt, endedAt: new Date() }).returning())[0]!;

  it("wakes the agent in 15 minutes after a run that made progress and set no check, and says so", async () => {
    const t = await working();
    // The wake that started the run has been used.
    await ctx.db.delete(wakes);
    const run = await ranOn(t.id);
    await ctx.work.updateTicket(t.id, { stateNote: "Filed batch 5 of 9." });
    await ctx.db.update(tickets).set({ monitorAttempts: 3 }).where(eq(tickets.id, t.id));
    await ctx.scheduler.afterTicketRun(run.id);
    const r = await row(t.id);
    expect(r.monitorAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(r.monitorAt!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Progress resets the count, so a long job isn't reported as "checked 5 times and still not resolved".
    expect(r).toMatchObject({ monitorAttempts: 0, monitorNote: expect.stringContaining("Carry on") });
    const log = await ctx.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "monitor")));
    expect(log.map((a) => a.summary).join()).toMatch(/so Boss Man will wake CEO at \d\d:\d\d UTC to carry on/);
  });

  it("leaves a check the agent set, and never polls a run that did nothing", async () => {
    const t = await working();
    await ctx.db.delete(wakes);
    const idle = await ranOn(t.id);
    await ctx.scheduler.afterTicketRun(idle.id);
    expect((await row(t.id)).monitorAt).toBeNull();
    const own = new Date(Date.now() + 60 * 60_000);
    await ctx.db.update(tickets).set({ monitorAt: own, stateNote: "Waiting on CI.", stateNoteAt: new Date() }).where(eq(tickets.id, t.id));
    await ctx.scheduler.afterTicketRun(idle.id);
    expect((await row(t.id)).monitorAt).toEqual(own);
  });

  // BOS-1273: the check's result wakes the agent, so a carry-on wake meanwhile is a ~20 s run that sees "still queued" and stops.
  const ownCheck = async (ticketId: string, state = "queued", requestedBy: string | null = ctx.co.ceo.id) =>
    (await ctx.db.insert(checkJobs).values({ companyId: ctx.co.company.id, projectId: ctx.p.id, ticketId, kind: "pre_review", scope: "quick", commit: "c".repeat(40), tree: "t".repeat(40), state, requestedBy }).returning())[0]!;
  const progressed = async (ticketId: string) => {
    await ctx.db.delete(wakes);
    const run = await ranOn(ticketId);
    await ctx.work.updateTicket(ticketId, { stateNote: "Committed; quick check requested." });
    return run;
  };

  it("books no carry-on wake while the agent's own check is queued or running, and the result still wakes them", async () => {
    for (const state of ["queued", "running"]) {
      const t = await working();
      const job = await ownCheck(t.id, state);
      await ctx.scheduler.afterTicketRun((await progressed(t.id)).id);
      expect((await row(t.id)).monitorAt, state).toBeNull();
      // The check ending (any way) wakes the agent that asked, as before.
      await ctx.checks.cancel(job.id, "test");
      const [w] = await ctx.db.select().from(wakes).where(and(eq(wakes.ticketId, t.id), eq(wakes.reason, "check_result")));
      expect(w, state).toMatchObject({ agentId: ctx.co.ceo.id });
    }
  });

  it("still books it when the only check is finished, or was asked for by someone else", async () => {
    const t = await working();
    await ownCheck(t.id, "passed");
    await ownCheck(t.id, "queued", ctx.peer.id);
    await ownCheck(t.id, "queued", null);
    await ctx.scheduler.afterTicketRun((await progressed(t.id)).id);
    expect((await row(t.id)).monitorAt).not.toBeNull();
  });

  it("skips a carry-on wake that falls due while the agent's check is live, but an agent's own schedule_check still fires", async () => {
    const t = await working();
    await ctx.scheduler.afterTicketRun((await progressed(t.id)).id);
    expect((await row(t.id)).monitorNote).toBe(CARRY_ON_NOTE);
    // A later run asked for a check (it found the carry-on already set, so it left it).
    await ownCheck(t.id);
    await due(t.id);
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(0);
    expect((await row(t.id)).monitorAt).toBeNull();
    const log = await ctx.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "monitor")));
    expect(log.map((a) => a.summary).join()).toContain("Skipped the carry-on wake");

    const c = await agent(ctx.co.ceo.id);
    await schedule(c, t.id);
    await due(t.id);
    await ctx.scheduler.slow();
    expect(await checkWakes(t.id)).toHaveLength(1);
  });
});
