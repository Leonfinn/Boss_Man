import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, notifications, runs, tickets, wakes, watchdogActions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { alertLadder, type Ladder } from "../src/services/alert-ladder.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const companyId = co.company.id;
  const sm = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Scrum Master" })).json() as { id: string };
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const qa = (await req("POST", `/api/companies/${companyId}/agents`, { name: "QA" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const [ticket] = await db.insert(tickets).values({ companyId, projectId: project.id, title: "Export the designs", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const switchOn = async () => expect((await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true })).statusCode).toBe(200);
  await db.delete(wakes);
  return { ...built, db, close, base, req, companyId, sm, dev, qa, ceo: ceo!, ticket: ticket!, advance, switchOn, now: () => clock };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function client(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => !!(r as { isError?: boolean }).isError;

/** The alert from the owner's screenshot: a wake chain one deeper than the limit, caused by the QA's run. */
async function wakeChain() {
  const runId = randomUUID();
  await ctx.db.insert(runs).values({ id: runId, companyId: ctx.companyId, agentId: ctx.qa.id, ticketId: ctx.ticket.id });
  await ctx.db.insert(wakes).values({ companyId: ctx.companyId, agentId: ctx.qa.id, ticketId: ctx.ticket.id, reason: "nudge", status: "launched", runId, causationDepth: ctx.scheduler.limits.maxDepth });
  const w = await ctx.scheduler.wake({ agentId: ctx.dev.id, ticketId: ctx.ticket.id, reason: "nudge", causedByRunId: runId });
  expect(w.status).toBe("dropped");
  await ctx.db.delete(wakes).where(eq(wakes.reason, "nudge"));
  const [d] = await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId));
  return d!;
}
const ladderOf = async (id: string) => ((await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!.context as { ladder: Ladder; triedFirst?: string; steps?: string[] });
const alertWakes = () => ctx.db.select().from(wakes).where(eq(wakes.reason, "alert"));
const ownerNotified = async (id: string) => {
  await ctx.notes.syncDecisions();
  return ctx.db.select().from(notifications).where(eq(notifications.decisionId, id));
};

describe("the alert ladder (BOS-64)", () => {
  it("rung 1: the wake-chain alert goes to the Scrum Master, not the owner, and is logged on the ticket", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    expect(d).toMatchObject({ tier: "ceo", forAgentId: ctx.sm.id, status: "open" });
    expect((d.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "scrum_master", ticketId: ctx.ticket.id });
    const [w] = await alertWakes();
    expect(w).toMatchObject({ agentId: ctx.sm.id, priority: 3 });
    expect(w!.note).toContain(`alert ${d.id}`);
    expect(w!.note).toContain("rewake: true");
    expect(await ownerNotified(d.id)).toHaveLength(0);
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "alert_hop"))).toHaveLength(1);
    expect((await ctx.db.select().from(activity).where(and(eq(activity.ticketId, ctx.ticket.id), eq(activity.kind, "watchdog")))).map((a) => a.summary)).toEqual([expect.stringMatching(/^Alert handed to Scrum Master/)]);
  });

  it("the Scrum Master settles it and wakes the dropped agent again with a fresh chain", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    const sm = await client(ctx.sm.id);
    const listed = textOf(await sm.callTool({ name: "watchdog", arguments: { action: "alerts" } }));
    expect(JSON.parse(listed)).toEqual([expect.objectContaining({ alertId: d.id, canRewake: true })]);
    const r = await sm.callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: d.id, rewake: true, reason: "QA and Developer were trading review notes; it's settled now" } });
    expect(isError(r)).toBe(false);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]).toMatchObject({ status: "answered", answer: "Got it" });
    const [again] = await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.dev.id), eq(wakes.reason, "watchdog re-wake")));
    expect(again).toMatchObject({ causationDepth: 0, ticketId: ctx.ticket.id, status: "queued" });
    expect((await ctx.db.select().from(watchdogActions)).map((a) => a.kind).sort()).toEqual(["alert_hop", "alert_resolved", "rewake"]);
    // Settled before it climbed: the owner never heard about it.
    expect(await ownerNotified(d.id)).toHaveLength(0);
    // And it can't be settled twice.
    expect(isError(await sm.callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: d.id, reason: "again" } }))).toBe(true);
  });

  it("timeouts: past the limit it climbs to the CEO, then to the owner with what was tried", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    ctx.advance(29);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    let row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((await ladderOf(d.id)).ladder.rung).toBe("ceo");
    expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.sm.id, ctx.ceo.id]);
    expect(await ownerNotified(d.id)).toHaveLength(0);
    // The Scrum Master can't act on it any more.
    expect(isError(await (await client(ctx.sm.id)).callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: d.id, reason: "late answer" } }))).toBe(true);

    ctx.advance(31);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row).toMatchObject({ tier: "owner", status: "open" });
    const ctxNow = await ladderOf(d.id);
    expect(ctxNow.ladder.hops.map((h) => h.to)).toEqual(["scrum_master", "ceo", "owner"]);
    expect(ctxNow.triedFirst).toMatch(/the Scrum Master .* then the CEO/);
    expect((await ownerNotified(d.id)).map((n) => n.level)).toEqual(["flag"]);
    // At the top it stays put.
    ctx.advance(120);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
  });

  it("the time limit is a setting", async () => {
    await ctx.switchOn();
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}/watchdog`, { alertMinutes: 10 });
    const d = await wakeChain();
    ctx.advance(11);
    await ctx.alerts.sweep();
    expect((await ladderOf(d.id)).ladder.rung).toBe("ceo");
  });

  it("rung 2: the Scrum Master passes it on, and the CEO sends it to the owner only with what was tried", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    const pass = await (await client(ctx.sm.id)).callTool({ name: "watchdog", arguments: { action: "pass_alert", alertId: d.id, reason: "the ticket needs stopping, which is beyond me" } });
    expect(textOf(pass)).toMatch(/with the CEO/);
    expect((await ladderOf(d.id)).ladder.rung).toBe("ceo");
    const ceo = await client(ctx.ceo.id);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }))).toContain(d.id);
    const thin = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "nothing" } });
    expect(isError(thin)).toBe(true);
    expect((await ladderOf(d.id)).ladder.rung).toBe("ceo");
    const noSteps = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Parked the ticket and checked both agents' last runs", ownerMustDo: true } });
    expect(textOf(noSteps)).toMatch(/give steps/);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Parked the ticket and checked both agents' last runs; it needs the Penpot login", ownerMustDo: true, steps: ["Open Settings → Secrets", "Add PENPOT_PASSWORD"] } });
    expect(isError(ok)).toBe(false);
    const c = await ladderOf(d.id);
    expect(c).toMatchObject({ triedFirst: expect.stringContaining("Penpot login"), steps: ["Open Settings → Secrets", "Add PENPOT_PASSWORD"] });
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.tier).toBe("owner");
    expect(await ownerNotified(d.id)).toHaveLength(1);
  });

  it("the CEO can settle an alert with a plain answer", async () => {
    const d = await wakeChain();
    const r = await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Got it" } });
    expect(isError(r)).toBe(false);
    expect(await ownerNotified(d.id)).toHaveLength(0);
  });

  it("the CEO doesn't see alerts still with the Scrum Master", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    expect(textOf(await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "list" } }))).not.toContain(d.id);
  });

  describe("fall-through", () => {
    it("watchdog off: straight to the CEO", async () => {
      const d = await wakeChain();
      expect(d).toMatchObject({ tier: "ceo", forAgentId: null });
      expect((d.context as { ladder: Ladder }).ladder.hops).toEqual([expect.objectContaining({ to: "ceo", why: expect.stringContaining("the watchdog is off") })]);
      expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
    });

    it("Scrum Master paused and CEO paused: straight to the owner", async () => {
      await ctx.switchOn();
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.sm.id));
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
      const d = await wakeChain();
      expect(d).toMatchObject({ tier: "owner" });
      expect(await alertWakes()).toHaveLength(0);
      expect(await ownerNotified(d.id)).toHaveLength(1);
    });

    it("an alert about the Scrum Master itself skips it", async () => {
      await ctx.switchOn();
      await ctx.scheduler.nudge({ runId: randomUUID(), fromAgentId: ctx.sm.id, to: "Developer", ticketId: ctx.ticket.id, why: "ping" });
      for (let i = 0; i < 4; i++) {
        await ctx.scheduler.nudge({ runId: randomUUID(), fromAgentId: ctx.dev.id, to: "Scrum Master", ticketId: ctx.ticket.id, why: "pong" });
        await ctx.scheduler.nudge({ runId: randomUUID(), fromAgentId: ctx.sm.id, to: "Developer", ticketId: ctx.ticket.id, why: "ping" });
      }
      const [d] = await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId));
      expect(d!.question).toMatch(/keep nudging each other/);
      expect(d).toMatchObject({ tier: "ceo", forAgentId: null });
      expect((d!.context as { ladder: Ladder }).ladder.hops[0]!.why).toMatch(/about the Scrum Master/);
    });

    it("the Scrum Master over its hourly limit: the CEO takes it", async () => {
      await ctx.switchOn();
      for (let i = 0; i < 4; i++) await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "sweep_wake", targetAgentId: ctx.sm.id, reason: "x", createdAt: new Date() });
      const d = await wakeChain();
      expect(d).toMatchObject({ tier: "ceo", forAgentId: null });
    });

  });

  it("the stuck-review alert goes to the CEO, not the Scrum Master (stopping work is beyond it)", async () => {
    await ctx.switchOn();
    const r = await ctx.loops.reviewRound({ ticketId: ctx.ticket.id, reviewer: "CEO", comments: [], message: "again" });
    expect(r.escalated).toBeNull();
    await ctx.loops.reviewRound({ ticketId: ctx.ticket.id, reviewer: "CEO", comments: [], message: "again" });
    await ctx.loops.reviewRound({ ticketId: ctx.ticket.id, reviewer: "CEO", comments: [], message: "again" });
    const last = await ctx.loops.reviewRound({ ticketId: ctx.ticket.id, reviewer: "CEO", comments: [], message: "again" });
    expect(last.escalated).toBeTruthy();
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.id, last.escalated!));
    expect(d).toMatchObject({ kind: "approval", tier: "ceo", forAgentId: null });
    expect((d!.context as { type: string }).type).toBe("review_loop");
    expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
    expect(await ownerNotified(d!.id)).toHaveLength(0);
    // The CEO stops work through its decisions tool; the review-loop hook still runs.
    const ans = await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Stop work on it" } });
    expect(isError(ans)).toBe(false);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, ctx.ticket.id)))[0]).toMatchObject({ systemState: "done", outcome: "cancelled" });
  });

  it("the owner's queue leaves out alerts the team still holds, and lists them as being handled", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    const queue = async () => ((await ctx.req("GET", "/api/decisions")).json() as Array<{ id: string }>).map((x) => x.id);
    const team = async () => (await ctx.req("GET", "/api/decisions/with-team")).json() as Array<{ id: string; holder: string }>;
    expect(await queue()).not.toContain(d.id);
    expect(await team()).toEqual([expect.objectContaining({ id: d.id, holder: "Scrum Master" })]);
    ctx.advance(31);
    await ctx.alerts.sweep();
    expect(await queue()).not.toContain(d.id);
    expect(await team()).toEqual([expect.objectContaining({ id: d.id, holder: "the CEO" })]);
    ctx.advance(31);
    await ctx.alerts.sweep();
    expect(await queue()).toContain(d.id);
    expect(await team()).toEqual([]);
  });

  it("an alert answered while the sweep is moving it is left alone, and nobody is woken for it", async () => {
    await ctx.switchOn();
    const a = (await ctx.alerts.raise({ companyId: ctx.companyId, question: "First alert" }))!;
    const b = (await ctx.alerts.raise({ companyId: ctx.companyId, question: "Second alert" }))!;
    const before = (await ctx.db.select().from(decisions).where(eq(decisions.id, b.id)))[0]!;
    ctx.advance(31);
    // Both are due when the sweep reads them; the owner answers the second while the first is being moved.
    const woken: string[] = [];
    const ladder = alertLadder(ctx.db, {
      notify: async (agentId) => {
        woken.push(agentId);
        await ctx.decisions.answer(b.id, "Got it");
        return { id: randomUUID(), status: "queued" };
      },
      answer: (id, answer) => ctx.decisions.answer(id, answer),
      watchdog: ctx.watchdog,
      now: ctx.now,
    });
    expect((await ladder.sweep()).moved).toBe(1);
    expect(woken).toEqual([ctx.ceo.id]);
    expect((await ladderOf(a.id)).ladder.rung).toBe("ceo");
    const after = (await ctx.db.select().from(decisions).where(eq(decisions.id, b.id)))[0]!;
    expect(after).toMatchObject({ status: "answered", tier: before.tier, forAgentId: before.forAgentId });
    expect((after.context as { ladder: Ladder }).ladder.rung).toBe("scrum_master");
    // A late pass on it is refused.
    expect(isError(await (await client(ctx.sm.id)).callTool({ name: "watchdog", arguments: { action: "pass_alert", alertId: b.id, reason: "too late" } }))).toBe(true);
  });

  it("the CEO rung has an hourly cap; past it alerts go to the owner", async () => {
    for (let i = 0; i < 6; i++) await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "alert_hop", targetAgentId: ctx.ceo.id, reason: "x", createdAt: ctx.now() });
    const d = await wakeChain();
    expect(d).toMatchObject({ tier: "owner" });
    expect((d.context as { ladder: Ladder }).ladder.hops.at(-1)!.why).toMatch(/CEO has had its hourly limit/);
    expect(await alertWakes()).toHaveLength(0);
    // An hour later the CEO takes them again.
    ctx.advance(61);
    const e = (await ctx.alerts.raise({ companyId: ctx.companyId, question: "Later alert" }))!;
    expect(e.rung).toBe("ceo");
  });

  it("a looping agent raises one climbing alert while it is open, and a fresh one once it's answered", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    await wakeChain();
    await wakeChain();
    expect(await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId))).toHaveLength(1);
    expect(await alertWakes()).toHaveLength(1);
    await ctx.decisions.answer(d.id, "Got it");
    await wakeChain();
    const open = await ctx.db.select().from(decisions).where(and(eq(decisions.companyId, ctx.companyId), eq(decisions.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(d.id);
  });

  it("the Scrum Master can only settle a plain 'Got it' alert, not one that asks for a choice", async () => {
    await ctx.switchOn();
    const a = (await ctx.alerts.raise({ companyId: ctx.companyId, question: "Pick one", kind: "approval", options: ["Carry on", "Stop work on it"], recommended: "Stop work on it" }))!;
    expect(a.rung).toBe("scrum_master");
    const sm = await client(ctx.sm.id);
    const r = await sm.callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: a.id, reason: "looks fine to me" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/pass it to the CEO/);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, a.id)))[0]!.status).toBe("open");
    expect(textOf(await sm.callTool({ name: "watchdog", arguments: { action: "pass_alert", alertId: a.id, reason: "needs a choice" } }))).toMatch(/with the CEO/);
  });

  it("a repeated circular failure is raised once", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 4; i++) await ctx.loops.failure({ companyId: ctx.companyId, ticketId: ctx.ticket.id, agentId: ctx.dev.id, text: "Error: ENOENT build/out.js", what: "Developer" });
    const rows = await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "ceo", forAgentId: ctx.sm.id });
  });
});
