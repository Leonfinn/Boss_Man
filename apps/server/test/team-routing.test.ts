import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, notifications, nudges, reviewRequests, runners, runs, tickets, wakes, watchdogActions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import type { Ladder } from "../src/services/alert-ladder.js";

// BOS-119: cards meant for the CEO stay off the owner's queue until escalated, and stalled runs
// reach the Scrum Master first (even with the watchdog off).

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];
const CEO_RULE = "^systemctl\\s+restart\\b";

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Senior Developer" })).json() as { id: string };
  const sm = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Scrum Master" })).json() as { id: string };
  await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: false });
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Restart the API", assigneeAgentId: dev.id, state: "ready", risk: "medium" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (cmd) => (sent.push(cmd), true));
  await req("POST", "/api/policy-rules", { companyId, name: "Service restarts go to the CEO", match: { commandPattern: CEO_RULE }, outcome: "ceo" });
  let seq = 0;
  const start = async (agentId = dev.id) => {
    const runId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.started", runId, agentId, acpSessionId: "s", model: null } });
    return runId;
  };
  const ask = async (command = "systemctl restart api") => {
    const runId = await start();
    const requestId = randomUUID();
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.permission_request", runId, requestId, title: "Restart the API", kind: "execute", rawInput: { command }, optionKinds: ["allow_once", "reject_once"] } });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d: d!, runId, requestId };
  };
  const plan = async (requestId = randomUUID()) => {
    const runId = await start();
    await db.update(runs).set({ ticketId: ticket.id }).where(eq(runs.id, runId));
    await built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event: { type: "run.permission_request", runId, requestId, title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once"], detail: "1. Change the API." } });
    const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return { d: d!, runId };
  };
  /** A run that has been quiet for `minutes`, as the stall sweep sees it. */
  const quietRun = async (minutes = 6) => {
    const at = new Date(clock.getTime() - minutes * 60_000);
    const [r] = await db.insert(runs).values({ companyId, agentId: dev.id, ticketId: ticket.id, startedAt: at, lastEventAt: at }).returning();
    return r!;
  };
  await db.delete(wakes);
  return { ...built, db, close, base, req, companyId, dev, sm, ceo: ceo!, project, ticket, sent, ask, plan, quietRun, now: () => clock, advance: (m: number) => (clock = new Date(clock.getTime() + m * 60_000)) };
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
const reload = async (id: string) => (await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const ownerNotified = async (id: string) => {
  await ctx.notes.syncDecisions();
  return ctx.db.select().from(notifications).where(eq(notifications.decisionId, id));
};
const teamIds = async () => (await ctx.decisions.withTeam()).map((d) => d.id);
const queueIds = async () => (await ctx.decisions.queue()).map((d) => d.id);

describe("CEO-tier cards on the alert ladder (BOS-119)", () => {
  it("a permission request sent to the CEO stays off the owner's queue and moves to them after 5 minutes", async () => {
    const { d } = await ctx.ask();
    expect(d).toMatchObject({ tier: "ceo", status: "open" });
    expect((d.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    expect(await queueIds()).not.toContain(d.id);
    expect(await teamIds()).toContain(d.id);
    expect(await ownerNotified(d.id)).toEqual([]);
    expect(await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.ceo.id), eq(wakes.reason, "decision")))).toEqual([expect.objectContaining({ priority: 3 })]);

    // The 5 minutes start when a CEO run does (BOS-180), not when the card was raised.
    ctx.advance(10);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.ceo.id, startedAt: ctx.now() });
    ctx.advance(4);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const moved = await reload(d.id);
    expect(moved).toMatchObject({ tier: "owner", status: "open" });
    expect((moved.context as { triedFirst?: string }).triedFirst).toMatch(/the CEO/);
    expect(await queueIds()).toContain(d.id);
    expect((await ownerNotified(d.id)).map((n) => n.level)).toEqual(["ask"]);
    expect(ctx.sent).toEqual([]);
  });

  it("the CEO settles it with a reason, and the owner sees who, what and why", async () => {
    const { d, runId, requestId } = await ctx.ask();
    const ceo = await client(ctx.ceo.id);
    const bare = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Allow once" } });
    expect(isError(bare)).toBe(true);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Allow once", note: "It restarts the company's own service." } });
    expect(isError(ok)).toBe(false);
    expect(ctx.sent).toEqual([{ type: "permission.decide", runId, requestId, verdict: "allow" }]);
    expect(await ownerNotified(d.id)).toEqual([]);
    const listed = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; settled?: { by: string; answer: string; note: string } }>;
    expect(listed.find((x) => x.id === d.id)?.settled).toMatchObject({ by: expect.any(String), answer: "Allow once", note: "It restarts the company's own service." });
  });

  it("a card no CEO run picks up moves to the owner 20 minutes after it was raised (BOS-180)", async () => {
    const { d } = await ctx.ask();
    ctx.advance(19);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    expect(await reload(d.id)).toMatchObject({ tier: "owner", status: "open" });
  });

  it("several cards waiting on the CEO wake it once (BOS-180)", async () => {
    await ctx.ask();
    await ctx.ask();
    expect(await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.ceo.id), eq(wakes.reason, "decision")))).toHaveLength(1);
  });

  it("a plan addressed to the CEO also waits 5 minutes on the ladder, then reaches the owner", async () => {
    const { d } = await ctx.plan();
    expect(d).toMatchObject({ tier: "ceo", status: "open" });
    expect((d.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    expect(await queueIds()).not.toContain(d.id);
    expect(await teamIds()).toContain(d.id);
    expect(await ownerNotified(d.id)).toEqual([]);

    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.ceo.id, startedAt: ctx.now() });
    ctx.advance(4);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const moved = await reload(d.id);
    expect(moved).toMatchObject({ tier: "owner", status: "open" });
    expect((moved.context as { triedFirst?: string }).triedFirst).toMatch(/the CEO/);
    expect(await queueIds()).toContain(d.id);
  });
});

describe("stalled runs go to the Scrum Master first (BOS-119)", () => {
  it("reaches the Scrum Master with the watchdog off, and stays off the owner's queue", async () => {
    const run = await ctx.quietRun();
    const before = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(before).toHaveLength(0);
    expect((await ctx.sweeps.run()).stalledRuns.raised).toBe(1);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(d).toMatchObject({ tier: "ceo", forAgentId: ctx.sm.id, status: "open", answer: null });
    expect((d!.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "scrum_master", duty: true });
    expect((d!.context as { runId: string }).runId).toBe(run.id);
    expect(await queueIds()).not.toContain(d!.id);
    expect(await teamIds()).toContain(d!.id);
    expect(await ownerNotified(d!.id)).toEqual([]);
    const [w] = await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.sm.id), eq(wakes.reason, "alert")));
    expect(w).toBeTruthy();
    // The tool lists it even though the watchdog is off.
    const sm = await client(ctx.sm.id);
    expect(JSON.parse(textOf(await sm.callTool({ name: "watchdog", arguments: { action: "alerts" } })))).toEqual([expect.objectContaining({ alertId: d!.id })]);
  });

  it("the Scrum Master keeps waiting, nudges the agent, then cancels another run", async () => {
    await ctx.quietRun();
    await ctx.sweeps.run();
    const [first] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    const sm = await client(ctx.sm.id);
    const wait = await sm.callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: first!.id, answer: "Keep waiting", nudge: true, reason: "It is probably on a long install; asking for a sign of life." } });
    expect(isError(wait)).toBe(false);
    expect(await reload(first!.id)).toMatchObject({ status: "answered", answer: "Keep waiting" });
    expect(await ctx.db.select().from(nudges)).toEqual([expect.objectContaining({ toAgentId: ctx.dev.id })]);
    const audit = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; settled?: { by: string; answer: string; note: string } }>;
    expect(audit.find((x) => x.id === first!.id)?.settled).toMatchObject({ by: "Scrum Master", answer: "Keep waiting", note: expect.stringContaining("long install") });
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "alert_resolved"))).toHaveLength(1);

    const run2 = await ctx.quietRun();
    await ctx.sweeps.run();
    const open = (await ctx.db.select().from(decisions).where(and(eq(decisions.kind, "stalled_run"), eq(decisions.status, "open"))))[0]!;
    const cancel = await sm.callTool({ name: "watchdog", arguments: { action: "resolve_alert", alertId: open.id, answer: "Cancel run", reason: "It will not come back; start it again on the ticket." } });
    expect(isError(cancel)).toBe(false);
    expect(ctx.sent.filter((c) => c.type === "run.cancel")).toEqual([{ type: "run.cancel", runId: run2.id }]);
  });

  it("the Scrum Master passes it to the CEO, who can send it to the owner with what was tried", async () => {
    await ctx.quietRun();
    await ctx.sweeps.run();
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    const sm = await client(ctx.sm.id);
    expect(textOf(await sm.callTool({ name: "watchdog", arguments: { action: "pass_alert", alertId: d!.id, reason: "Only the CEO can decide whether to write off this run." } }))).toMatch(/with the CEO/);
    expect(await reload(d!.id)).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((await reload(d!.id).then((r) => (r.context as { ladder: Ladder }).ladder)).rung).toBe("ceo");
    const ceo = await client(ctx.ceo.id);
    const esc = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d!.id, triedFirst: "Checked the runner and the agent's last output; the run cannot finish without the owner's service credentials.", ownerMustDo: true, steps: ["Open Settings → Secrets", "Add API_TOKEN"] } });
    expect(isError(esc)).toBe(false);
    const owner = await reload(d!.id);
    expect(owner).toMatchObject({ tier: "owner", status: "open" });
    expect((owner.context as { triedFirst?: string }).triedFirst).toMatch(/service credentials/);
    expect(await queueIds()).toContain(d!.id);
  });

  it("a stuck review goes to the CEO first, and the owner only sees it if the CEO doesn't settle it", async () => {
    await ctx.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, ctx.ticket.id));
    const review = async (round = 1) => {
      const [r] = await ctx.db.insert(reviewRequests).values({ ticketId: ctx.ticket.id, kind: "code", reviewerAgentId: ctx.dev.id, round, createdAt: new Date(ctx.now().getTime() - 2 * 3_600_000) }).returning();
      for (const hours of [3, 2, 1]) {
        await ctx.db.insert(wakes).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: ctx.ticket.id, reason: "review requested", status: "launched", note: `- ${ctx.ticket.id} "Restart the API": still waiting for your code review`, createdAt: new Date(ctx.now().getTime() - hours * 3_600_000) });
      }
      return r!;
    };
    const stalled = () => ctx.db.select().from(decisions).where(like(decisions.dedupeKey, "review-stall:%"));

    const first = await review();
    expect((await ctx.sweeps.run()).stalledReviews.gaveUp).toBe(1);
    const [a] = await stalled();
    expect(a).toMatchObject({ tier: "ceo", forAgentId: null, status: "open" });
    expect((a!.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo" });
    expect(await queueIds()).not.toContain(a!.id);
    expect(await teamIds()).toContain(a!.id);
    expect(await ownerNotified(a!.id)).toEqual([]);
    // The CEO settles it: the owner never hears about it.
    expect(isError(await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: a!.id, answer: "Got it" } }))).toBe(false);
    expect(await ownerNotified(a!.id)).toEqual([]);

    // A second stuck review the CEO leaves alone reaches the owner with what was tried.
    await ctx.db.update(reviewRequests).set({ status: "approved" }).where(eq(reviewRequests.id, first.id));
    await review(2);
    expect((await ctx.sweeps.run()).stalledReviews.gaveUp).toBe(1);
    const open = (await stalled()).find((d) => d.id !== a!.id)!;
    ctx.advance(31);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const owner = await reload(open.id);
    expect(owner.tier).toBe("owner");
    expect((owner.context as { triedFirst?: string }).triedFirst).toMatch(/the CEO/);
    expect(await queueIds()).toContain(open.id);
    expect((await ownerNotified(open.id)).length).toBe(1);
  });

  it("without a Scrum Master it starts at the CEO", async () => {
    await ctx.req("PATCH", `/api/companies/${ctx.companyId}/watchdog`, { scrumMasterAgentId: null, enabled: false });
    await ctx.quietRun();
    await ctx.sweeps.run();
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(d).toMatchObject({ tier: "ceo", forAgentId: null, status: "open" });
    expect((d!.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", duty: true });
    expect(await queueIds()).not.toContain(d!.id);
    expect(await teamIds()).toContain(d!.id);
  });
});
