import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, notifications, quotaSamples, runners, runs, tickets, wakes, watchdogActions } from "../src/db/schema.js";
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
  const cookie = await signedInOwner(db);
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
  const switchOn = async (settings: Record<string, unknown> = {}) => expect((await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true, ...settings })).statusCode).toBe(200);
  // A fake runner the tests drive by hand, so a permission request is the same request a real one sends.
  const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const emit = (event: Parameters<typeof built.runners.ingest>[1]["event"]) => built.runners.ingest(runner!, { seq: ++seq, at: clock.toISOString(), event });
  const switchOff = async () => expect((await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: false })).statusCode).toBe(200);
  await db.delete(wakes);
  return { ...built, db, close, base, req, companyId, sm, dev, qa, ceo: ceo!, ticket: ticket!, runner: runner!, emit, advance, switchOn, switchOff, now: () => clock };
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
/** A raise by hand: the ladder itself, without a newer ticket's kinds, for the parts every card shares. */
const handRaise = (input: Parameters<typeof ctx.alerts.raise>[0]) => ctx.alerts.raise(input);
/** An owner-ceiling raise (only the owner can settle it), for the tests of the ladder's climb to the top. */
const ownerRaise = (why = "only the owner can act on it") =>
  handRaise({ companyId: ctx.companyId, kind: "owner", question: `Owner card: ${why}`, ticketId: ctx.ticket.id, from: "scrum_master", options: ["Got it"] });
const ladderOf = async (id: string) => ((await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!.context as { ladder: Ladder; triedFirst?: string; steps?: string[] });
const alertWakes = () => ctx.db.select().from(wakes).where(inArray(wakes.reason, ["alert", "decision", "ceo reply"]));
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
    const d = (await ownerRaise())!;
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

  it("a card no CEO run ever picks up still reaches the owner at the company's alert time (BOS-180)", async () => {
    await ctx.switchOn();
    const d = (await ownerRaise())!;
    ctx.advance(31);
    await ctx.alerts.sweep();
    ctx.advance(29);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    expect((await ladderOf(d.id)).ladder.rung).toBe("owner");
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
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Parked the ticket and checked both agents' last runs; it needs the Penpot login", ownerMustDo: true, openingWhy: "Penpot designs can be read again.", minutes: 3, steps: ["Open Settings → Secrets", "In Settings → Secrets, add PENPOT_PASSWORD"] } });
    expect(isError(ok)).toBe(false);
    const c = await ladderOf(d.id);
    expect(c).toMatchObject({ triedFirst: expect.stringContaining("Penpot login"), steps: ["Open Settings → Secrets", "In Settings → Secrets, add PENPOT_PASSWORD"] });
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.tier).toBe("owner");
    expect(await ownerNotified(d.id)).toHaveLength(1);
  });

  it("keeps the CEO's Recommend Allow/Deny tag and notes when an advised permission card is escalated to the owner (BOS-533)", async () => {
    await ctx.switchOn();
    // A permission card already on the CEO's rung, the owner having asked for advice on it.
    const at = new Date().toISOString();
    const [d] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.companyId,
        kind: "permission",
        question: "Run dd?",
        options: ["Allow once", "Deny"],
        recommendedOption: "Deny",
        tier: "ceo",
        context: {
          type: "permission",
          runnerId: randomUUID(),
          runId: randomUUID(),
          requestId: randomUUID(),
          explain: { title: "Engineer wants to run a command", summary: "Only reads information", effect: "reads", command: "dd if=/tmp/session.db count=40" },
          advice: { state: "asking", askedAt: at },
          ladder: { rung: "ceo", since: at, ticketId: null, about: [], topRung: "owner", hops: [{ to: "ceo", at, why: "the owner asked the CEO to decide" }] },
        },
      })
      .returning();
    const ceo = await client(ctx.ceo.id);
    const advised = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "advice", what: "Copies part of a database file into another file.", needed: "Yes, the ticket needs it to check the export.", recommendation: "allow", why: "It only reads a file in /tmp the agent made itself." } });
    expect(textOf(advised)).toMatch(/Advice saved/);
    // The CEO then passes the same card on to the owner, with the advice BOS-233 requires on every escalation.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d!.id, triedFirst: "Read the command and the ticket; only the owner can judge this one", adviceNeeded: "It is needed for the export check, to read the session file.", adviceDeny: "The export can't be checked, so the ticket stays blocked." } }))).toBe(false);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(after!.tier).toBe("owner");
    // The recommendation, needed and why survive the hand-over, so the owner still sees the Recommend tag;
    // the card's "What it's for" and "If you deny it" lines show the escalation's advice.
    expect(after!.context).toMatchObject({
      advice: { state: "advised", recommendation: "allow", needed: "Yes, the ticket needs it to check the export.", why: "It only reads a file in /tmp the agent made itself.", what: "It is needed for the export check, to read the session file.", denyStops: "The export can't be checked, so the ticket stays blocked." },
    });
  });

  it("the CEO can settle an alert with a plain answer, with a reason the owner can read", async () => {
    const d = await wakeChain();
    const bare = await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Got it" } });
    expect(isError(bare)).toBe(true);
    const r = await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Got it", note: "I checked the alert and the team has it." } });
    expect(isError(r)).toBe(false);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.context).toMatchObject({ settled: { note: "I checked the alert and the team has it." } });
    expect(await ownerNotified(d.id)).toHaveLength(0);
  });

  it("the CEO cannot see or settle alerts still with the Scrum Master (BOS-64), so the ladder still reaches the owner", async () => {
    await ctx.switchOn();
    const d = await wakeChain();
    // An alert still with the team is not the CEO's to settle: it stays off the CEO's list, as it does off the owner's.
    const ceo = await client(ctx.ceo.id);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }))).not.toContain(d.id);
    const answered = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Got it", note: "I looked into it and the team has it." } });
    expect(isError(answered)).toBe(true);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");
  });

  describe("fall-through", () => {
    it("watchdog off: straight to the CEO", async () => {
      await ctx.switchOff();
      const d = await wakeChain();
      expect(d).toMatchObject({ tier: "ceo", forAgentId: null });
      expect((d.context as { ladder: Ladder }).ladder.hops).toEqual([expect.objectContaining({ to: "ceo", why: expect.stringContaining("the watchdog is off") })]);
      expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
    });

    it("Scrum Master paused and CEO paused: an owner-ceiling card goes straight to the owner", async () => {
      await ctx.switchOn();
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.sm.id));
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
      const d = (await ownerRaise())!;
      expect(d).toMatchObject({ rung: "owner" });
      expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]).toMatchObject({ tier: "owner" });
      expect(await alertWakes()).toHaveLength(0);
      expect(await ownerNotified(d.id)).toHaveLength(1);
    });

    it("Scrum Master paused and CEO paused: a CEO-ceiling card parks with the CEO, not the owner (BOS-469)", async () => {
      await ctx.switchOn();
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.sm.id));
      await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
      const d = await wakeChain();
      expect(d).toMatchObject({ tier: "ceo", forAgentId: null });
      expect((d.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", parked: expect.stringContaining("paused") });
      expect(await ownerNotified(d.id)).toHaveLength(0);
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

    it("record only: Boss Man's own alerts skip the Scrum Master, go to the CEO, and an owner-ceiling card still climbs to the owner (BOS-166)", async () => {
      await ctx.switchOn({ recordOnly: true });
      const d = (await ownerRaise())!;
      // The Scrum Master isn't woken: the alert goes straight to the CEO, who is told.
      expect(d.rung).toBe("ceo");
      expect((await ladderOf(d.id)).ladder.hops.map((h) => h.to)).toEqual(["ceo"]);
      expect((await ladderOf(d.id)).ladder.hops[0]!.why).toMatch(/record-only mode/);
      expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
      // And the rehearsal says what it would have done, without sending anything.
      const [skip] = await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "record_alert_skip"));
      expect(skip).toMatchObject({ ticketId: ctx.ticket.id, reason: expect.stringContaining("record-only mode") });
      expect((skip!.after as { recorded?: boolean }).recorded).toBe(true);
      // Past the limits it still climbs to the owner, so a runaway on rehearsal day is never lost.
      ctx.advance(31);
      expect((await ctx.alerts.sweep()).moved).toBe(1);
      expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]).toMatchObject({ tier: "owner", status: "open" });
      expect(await ownerNotified(d.id)).toHaveLength(1);
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
    // A review loop stops at the CEO (DR-017 A): it is the CEO's work, not the owner's.
    expect(d).toMatchObject({ kind: "approval", tier: "ceo", forAgentId: null });
    expect((d!.context as { type: string }).type).toBe("review_loop");
    expect((d!.context as { ladder: Ladder }).ladder.topRung).toBe("ceo");
    expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
    expect(await ownerNotified(d!.id)).toHaveLength(0);
    // The CEO stops work through its decisions tool; the review-loop hook still runs.
    const ans = await (await client(ctx.ceo.id)).callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Stop work on it" } });
    expect(isError(ans)).toBe(false);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, ctx.ticket.id)))[0]).toMatchObject({ systemState: "done", outcome: "cancelled" });
  });

  it("the owner's queue leaves out alerts the team still holds, and lists them as being handled", async () => {
    await ctx.switchOn();
    const d = (await ownerRaise())!;
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

  it("the CEO rung has an hourly cap; past it an owner-ceiling alert goes to the owner", async () => {
    for (let i = 0; i < 6; i++) await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "alert_hop", targetAgentId: ctx.ceo.id, reason: "x", createdAt: ctx.now() });
    const d = (await ownerRaise())!;
    expect(d).toMatchObject({ rung: "owner" });
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]).toMatchObject({ tier: "owner" });
    expect(await alertWakes()).toHaveLength(0);
    // An hour later the CEO takes them again.
    ctx.advance(61);
    const e = (await ctx.alerts.raise({ companyId: ctx.companyId, kind: "alert", question: "Later alert" }))!;
    expect(e.rung).toBe("ceo");
  });

  it("a CEO-ceiling alert at the CEO's hourly cap parks with the CEO and never reaches the owner, and is offered again once the cap frees (BOS-469 point 7)", async () => {
    for (let i = 0; i < 6; i++) await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "alert_hop", targetAgentId: ctx.ceo.id, reason: "x", createdAt: ctx.now() });
    // A stalled run is CEO-ceiling: past the cap it must not jump to the owner, which is what happened on 4 Nov at 21:40.
    // A real, live run, so the closer finds it still active and the card stays open.
    const runId = randomUUID();
    await ctx.db.insert(runs).values({ id: runId, companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: ctx.ticket.id, startedAt: ctx.now(), lastEventAt: ctx.now() });
    const d = (await ctx.alerts.raise({ companyId: ctx.companyId, kind: "stalled_run", question: "A run went quiet", options: ["Keep waiting", "Cancel it"], ticketId: ctx.ticket.id, about: [ctx.dev.id], cause: { runId } }))!;
    expect(d.rung).toBe("ceo");
    let row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((row.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", topRung: "ceo", parked: expect.stringContaining("hourly limit") });
    expect(await alertWakes()).toHaveLength(0);
    expect(await ownerNotified(d.id)).toHaveLength(0);
    // However long it waits, it never reaches the owner.
    ctx.advance(600);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row).toMatchObject({ tier: "ceo" });
    expect(await ownerNotified(d.id)).toHaveLength(0);
    // Once the cap frees, the sweep has offered it to the CEO again.
    expect((row.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", parked: null });
    expect((await alertWakes()).map((w) => w.agentId)).toEqual([ctx.ceo.id]);
  });

  it("a card handed to a CEO that is failing on a usage/auth error does not reach the owner, but one only the owner can settle does (BOS-469 point 1)", async () => {
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await ctx.db.update(agents).set({ fundingSourceId: fs.id }).where(eq(agents.id, ctx.ceo.id));
    // The CEO's last runs ended on the weekly limit, with nothing successful since.
    const started = new Date(ctx.now().getTime() - 20 * 60_000);
    await ctx.db.insert(runs).values([
      { companyId: ctx.companyId, agentId: ctx.ceo.id, purpose: null, startedAt: started, endedAt: new Date(started.getTime() + 60_000), outcome: "error: 400 weekly limit reached" },
      { companyId: ctx.companyId, agentId: ctx.ceo.id, purpose: null, startedAt: new Date(started.getTime() + 120_000), endedAt: new Date(started.getTime() + 180_000), outcome: "error: 400 Identity verification is required" },
    ]);
    expect(await ctx.scheduler.ceoCanRun(ctx.companyId)).toBe(false);
    // The Scrum Master is paused, so a CEO-ceiling card would normally wait with the CEO; with the CEO unable
    // to run it is held there rather than passed to the owner.
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.sm.id));
    const held = await wakeChain();
    expect(held).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((held.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", topRung: "ceo", parked: expect.stringContaining("can't run") });
    // However long it waits, it doesn't reach the owner.
    ctx.advance(600);
    await ctx.alerts.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, held.id)))[0]).toMatchObject({ tier: "ceo" });
    expect(await ownerNotified(held.id)).toHaveLength(0);
    // A card only the owner can settle still goes on.
    const owner = (await ownerRaise())!;
    expect(owner.rung).toBe("owner");
    expect(await ownerNotified(owner.id)).toHaveLength(1);
  });

  it("a stalled-run alert whose CEO wake is dropped parks with the CEO, not the owner (BOS-469 point 7)", async () => {
    // The CEO's wake comes back dropped: over its hourly cap is how that happens in practice.
    for (let i = 0; i < 6; i++) await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "alert_hop", targetAgentId: ctx.ceo.id, reason: "x", createdAt: ctx.now() });
    const ladder = alertLadder(ctx.db, {
      notify: async () => ({ id: randomUUID(), status: "dropped", statusReason: "queue full" }),
      answer: (id, answer) => ctx.decisions.answer(id, answer),
      watchdog: ctx.watchdog,
      now: ctx.now,
    });
    const d = (await ladder.raise({ companyId: ctx.companyId, kind: "self_wake", question: "Brains keeps waking itself", ticketId: ctx.ticket.id, about: [ctx.dev.id], dedupeKey: `alert:self:${ctx.dev.id}` }))!;
    expect(d.rung).toBe("ceo");
    const row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row).toMatchObject({ tier: "ceo", forAgentId: null });
    expect((row.context as { ladder: Ladder }).ladder).toMatchObject({ rung: "ceo", topRung: "ceo", parked: expect.stringMatching(/hourly limit|wake was dropped/) });
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
    const a = (await ctx.alerts.raise({ companyId: ctx.companyId, question: "Pick one", options: ["Carry on", "Stop work on it"], recommended: "Stop work on it" }))!;
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

  it("a CEO not at the window and two raises with one cause key make one card listing both (BOS-469 point 6)", async () => {
    const ladder = alertLadder(ctx.db, {
      notify: async () => ({ id: randomUUID(), status: "queued" }),
      answer: (id, answer) => ctx.decisions.answer(id, answer),
      watchdog: ctx.watchdog,
      now: ctx.now,
    });
    const a = (await ladder.raise({ companyId: ctx.companyId, kind: "runner_boot", question: "First runner problem", cause: { agents: [ctx.dev.id], runnerId: "r1", bootId: "b1" } }))!;
    const b = (await ladder.raise({ companyId: ctx.companyId, kind: "runner_boot", question: "Second runner problem", cause: { agents: [ctx.qa.id], runnerId: "r1", bootId: "b1" } }))!;
    expect(b.id).toBe(a.id);
    const rows = await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId));
    expect(rows).toHaveLength(1);
    const ctxOf = rows[0]!.context as { items?: Array<{ question: string }> };
    expect(ctxOf.items?.map((i) => i.question)).toEqual(["First runner problem", "Second runner problem"]);
    // The heading is rewritten with the count.
    expect(rows[0]!.question).toMatch(/2 runs didn.t start/);
  });

  it("usage-limit failures on one account within the hour fold into one card naming the agents, not one per run (BOS-469 point 3)", async () => {
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await ctx.db.update(agents).set({ fundingSourceId: fs.id });
    // The account is out of room right now, so the card holds while the failures are grouped.
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: fs.id, window: "five_hour", utilization: 1, resetsAt: new Date(ctx.now().getTime() + 3_600_000), observedAt: ctx.now() });
    for (const agentId of [ctx.sm.id, ctx.dev.id, ctx.qa.id]) {
      for (let i = 0; i < 3; i++) await ctx.loops.failure({ companyId: ctx.companyId, ticketId: ctx.ticket.id, agentId, text: "Error: 429 weekly limit reached on Claude Max", what: "An agent run" });
    }
    const rows = await ctx.db.select().from(decisions).where(eq(decisions.companyId, ctx.companyId));
    expect(rows).toHaveLength(1);
    const card = rows[0]!;
    // One card for all three agents; its cause key names the account and its top rung is the owner.
    expect(card.question).toMatch(/Claude Max/);
    expect(card.question).toMatch(/3 agents/);
    expect((card.context as { ladder: Ladder }).ladder).toMatchObject({ groupBy: `account:${ctx.companyId}:${fs.id}:account_limit`, topRung: "owner" });
    // Point 2: once the account has room again (a fresh sample under the hold threshold), the sweep closes the
    // card by itself, on its rung, with the reason. The card is with the Scrum Master, and it still closes.
    await ctx.db.delete(quotaSamples).where(eq(quotaSamples.fundingSourceId, fs.id));
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: fs.id, window: "five_hour", utilization: 0.1, resetsAt: new Date(ctx.now().getTime() + 3_600_000), observedAt: ctx.now() });
    await ctx.alerts.sweep();
    const gone = (await ctx.db.select().from(decisions).where(eq(decisions.id, card.id)))[0]!;
    expect(gone.status).toBe("withdrawn");
    expect((gone.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/room again/);
  });

  it("two companies on one account get a card each: one company's open card doesn't swallow the other's raise (BOS-498)", async () => {
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await ctx.db.update(agents).set({ fundingSourceId: fs.id });
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: fs.id, window: "five_hour", utilization: 1, resetsAt: new Date(ctx.now().getTime() + 3_600_000), observedAt: ctx.now() });
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const otherCompanyId = other.company.id;
    const otherDev = (await ctx.req("POST", `/api/companies/${otherCompanyId}/agents`, { name: "Developer" })).json() as { id: string };
    await ctx.db.update(agents).set({ fundingSourceId: fs.id }).where(eq(agents.id, otherDev.id));
    for (const [companyId, agentId] of [[ctx.companyId, ctx.dev.id], [otherCompanyId, otherDev.id]] as const) {
      for (let i = 0; i < 3; i++) await ctx.loops.failure({ companyId, ticketId: null, agentId, text: "Error: 429 weekly limit reached on Claude Max", what: "An agent run" });
    }
    // Each company's raise lands on its own card, on its own owner's desk: neither is silently dropped.
    for (const companyId of [ctx.companyId, otherCompanyId]) {
      const rows = await ctx.db.select().from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")));
      expect(rows).toHaveLength(1);
      expect((rows[0]!.context as { ladder: Ladder }).ladder).toMatchObject({ groupBy: `account:${companyId}:${fs.id}:account_limit`, topRung: "owner" });
    }
  });

  it("a repeated failure alert closes itself once the agent finishes a clean run, on any tier (BOS-469 point 2)", async () => {
    const ladder = alertLadder(ctx.db, {
      notify: async () => ({ id: randomUUID(), status: "queued" }),
      answer: (id, answer) => ctx.decisions.answer(id, answer),
      watchdog: ctx.watchdog,
      now: ctx.now,
    });
    const d = (await ladder.raise({ companyId: ctx.companyId, kind: "self_wake", question: "Zippy keeps waking itself", ticketId: ctx.ticket.id, about: [ctx.dev.id], dedupeKey: `alert:self:${ctx.dev.id}`, cause: { agents: [ctx.dev.id] } }))!;
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");
    // No clean run yet: the card holds.
    ctx.advance(5);
    await ctx.alerts.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");
    // A clean run since the card: it closes by itself with the reason.
    const started = new Date(ctx.now().getTime() + 1000);
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, purpose: null, ticketId: ctx.ticket.id, startedAt: started, endedAt: new Date(started.getTime() + 60_000), outcome: "end_turn" });
    ctx.advance(5);
    await ctx.alerts.sweep();
    const after = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(after.status).toBe("withdrawn");
    expect((after.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/clean run/);
  });
});

// BOS-233, advice half: every permission card that reaches the owner carries the CEO's advice (what
// it's needed for, what a Deny stops), the CEO must give it to escalate a permission card, and a card
// whose handover runs out says so and wakes the CEO for the advice.
describe("permission cards carry the CEO's advice (BOS-233)", () => {
  async function permissionAtCeo() {
    const now = new Date().toISOString();
    const ladder: Ladder = { rung: "ceo", since: now, ticketId: ctx.ticket.id, about: [], minutes: 5, hops: [{ to: "ceo", at: now, why: "a company rule sends it to the CEO" }] };
    const [d] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.companyId,
        kind: "permission",
        question: "An agent wants to run a command",
        options: ["Allow once", "Deny"],
        recommendedOption: "Deny",
        tier: "ceo",
        dedupeKey: `permission:${randomUUID()}`,
        context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), explain: { title: "An agent wants to run a command", summary: "Reads a file", effect: "reads", command: "dd if=/tmp/x count=1" }, ladder },
      })
      .returning();
    return d!;
  }

  it("refuses to pass a permission card on without the CEO's advice, then carries it to the owner", async () => {
    const d = await permissionAtCeo();
    expect(await ctx.db.select().from(wakes)).toHaveLength(0);
    const ceo = await client(ctx.ceo.id);
    // No advice: refused, stays with the CEO.
    const thin = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Checked the command and the ticket, which needs the data" } });
    expect(isError(thin)).toBe(true);
    expect(textOf(thin)).toMatch(/adviceNeeded/);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.tier).toBe("ceo");
    // With advice: it moves to the owner and the card carries it.
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Checked the command and the ticket, which needs the data", adviceNeeded: "It is needed for BOS-1, to read the exported session file.", adviceDeny: "The session export cannot be checked, so BOS-1 stays blocked." } });
    expect(isError(ok)).toBe(false);
    const row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row.tier).toBe("owner");
    expect(row.context).toMatchObject({ advice: { state: "advised", what: expect.stringContaining("BOS-1"), denyStops: expect.stringContaining("blocked") } });
  });

  it("a permission card whose handover runs out reaches the owner marked, and wakes the CEO for the advice", async () => {
    const d = await permissionAtCeo();
    ctx.advance(21);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row.tier).toBe("owner");
    expect(row.context).toMatchObject({ handoverRanOut: { at: expect.any(String) } });
    const w = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(w.some((x) => x.note?.includes("without your advice") && x.note.includes(d.id))).toBe(true);
    // The owner sees it in the queue; the CEO can still add the advice afterwards.
    const ceo = await client(ctx.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, outcome: "advice", what: "It reads the exported session file.", needed: "Yes, the ticket needs it to check the export.", recommendation: "allow", why: "It only reads a file in /tmp the agent made itself." } });
    expect(isError(r)).toBe(false);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.context).toMatchObject({ advice: { state: "advised", recommendation: "allow" }, handoverRanOut: { at: expect.any(String) } });
  });

  // BOS-636 (Freddy's BOS-233 review): escalating a card the CEO has already advised on keeps that
  // earlier recommendation and why, and the fields given at escalation win where they overlap.
  it("escalating a card the CEO already advised on keeps the recommendation and why", async () => {
    const d = await permissionAtCeo();
    const ceo = await client(ctx.ceo.id);
    const advised = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, outcome: "advice", what: "It copies part of a database file.", needed: "Yes, the ticket needs it to check the export.", recommendation: "allow", why: "It only reads a file in /tmp the agent made itself." } });
    expect(isError(advised)).toBe(false);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "escalate", id: d.id, triedFirst: "Checked the command and the ticket, which needs the data", adviceNeeded: "It is needed for BOS-1, to read the exported session file.", adviceDeny: "The session export cannot be checked, so BOS-1 stays blocked." } });
    expect(isError(ok)).toBe(false);
    const row = (await ctx.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!;
    expect(row.tier).toBe("owner");
    expect(row.context).toMatchObject({
      advice: {
        state: "advised",
        recommendation: "allow",
        why: "It only reads a file in /tmp the agent made itself.",
        what: expect.stringContaining("BOS-1"),
        denyStops: expect.stringContaining("blocked"),
      },
    });
  });
});

// DR-048 #3 (BOS-933): the runner denies an unanswered permission request after 10 minutes. An agent that
// asks again for the same command gets a new card. This checks whether that new card restarts the 20-minute
// clock that hands a card with the CEO to the owner, so a card the CEO can't settle could be held for ever.
describe("a re-asked permission card and the CEO's handover clock (DR-048 #3)", () => {
  // Temp-file cleanup: a destructive command whose only paths are entries directly in /tmp, so the built-in
  // guard sends it to the CEO first (TEMP_CLEANUP_RULE). This is the shape of card DR-048 describes.
  // It re-creates the folder, so it still needs the CEO: a plain delete of /tmp entries is allowed with no card (BOS-1453).
  const CMD = "rm -rf /tmp/kit-0aefe522-export /tmp/kit-0aefe522-export.log && mkdir /tmp/kit-0aefe522-export";
  // The runners deny a request after 10 minutes (session-manager.ts); the ladder's outer cap is 20 minutes from
  // the raise (CEO_OUTER_CAP_MINUTES), which is the one that must reach the owner when the CEO never settles it.

  it("the first card reaches the owner on its own 20-minute clock", async () => {
    const runId = randomUUID();
    await ctx.emit({ type: "run.started", runId, agentId: ctx.dev.id, acpSessionId: "s", model: null });
    const requestId = randomUUID();
    await ctx.emit({ type: "run.permission_request", runId, requestId, title: CMD, kind: "execute", rawInput: { command: CMD }, optionKinds: ["allow_once", "reject_once"] });
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    expect(card).toBeDefined();
    expect(card!).toMatchObject({ tier: "ceo", status: "open" });
    expect((await ladderOf(card!.id)).ladder).toMatchObject({ rung: "ceo", minutes: 5 });
    // Before the cap it stays with the CEO.
    ctx.advance(19);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.tier).toBe("ceo");
    // At the cap it goes to the owner, marked as tried by the CEO first.
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.tier).toBe("owner");
  });

  // This is the DR-048 #3 case: card 1, the runner's 10-minute deny, then the same command asked again in the
  // same run (a new requestId, as a harness retry sends). Question: does card 2's new raise restart the
  // 20-minute clock for this run and command, so the owner is never reached by the first card's timer?
  it("shows whether a re-ask for the same run and command restarts the 20-minute handover clock", async () => {
    const runId = randomUUID();
    await ctx.emit({ type: "run.started", runId, agentId: ctx.dev.id, acpSessionId: "s", model: null });
    // Card 1's request. The runner denies it at 10 minutes, unnoticed by the server.
    const first = randomUUID();
    await ctx.emit({ type: "run.permission_request", runId, requestId: first, title: CMD, kind: "execute", rawInput: { command: CMD }, optionKinds: ["allow_once", "reject_once"] });
    const [card1] = await ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${first}`));
    expect(card1).toBeDefined();
    // Ten minutes pass; the server sweeps, but card 1 is still with the CEO (its 20-minute cap hasn't run out).
    ctx.advance(10);
    await ctx.alerts.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card1!.id)))[0]!.tier).toBe("ceo");
    // The agent asks again for the same command: a new request with a fresh tool call id, the way a retried
    // call comes back. It is a card of its own unless it is a repeat of card 1.
    const second = randomUUID();
    await ctx.emit({ type: "run.permission_request", runId, requestId: second, title: CMD, kind: "execute", rawInput: { command: CMD }, optionKinds: ["allow_once", "reject_once"], toolCallId: "call-retry" });
    const [card2] = await ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${second}`));
    // Ruled out on today's code: the re-ask is a repeat of card 1's ask while card 1 is still open, so it rides
    // on it (one ask, one card, BOS-376). There is no second raise, so there is no second clock to start, and the
    // CEO card keeps card 1's own 20-minute clock from when it was first raised.
    expect(card2).toBeUndefined();
    const [rode] = await ctx.db.select().from(decisions).where(eq(decisions.id, card1!.id));
    expect((rode!.context as { repeats?: Array<{ requestId: string }> }).repeats?.map((r) => r.requestId)).toEqual([second]);
    // Sweep once a minute and record the first minute card 1 is seen at the owner's tier, from its raise.
    let reachedAt: number | null = null;
    for (let minute = 11; minute <= 40; minute++) {
      await ctx.alerts.sweep();
      const [row] = await ctx.db.select().from(decisions).where(eq(decisions.id, card1!.id));
      if (row!.tier === "owner") {
        reachedAt = minute;
        break;
      }
      ctx.advance(1);
    }
    // Reached at its own 20-minute cap (the first sweep after), not pushed back by the re-ask: if the re-ask had
    // started a fresh clock at +10, the card would still be with the CEO at +20 and only reach the owner at +30.
    expect(reachedAt).toBe(21);
  });
});
