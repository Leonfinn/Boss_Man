import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, decisions, notifications, runs, ticketDependencies, ticketReviews, tickets, wakes, watchdogActions, watchdogFlags } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { WATCHDOG_ESCALATE_REASON, WATCHDOG_REASON } from "../src/services/watchdog.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];
const H = 3_600_000;

async function setup() {
  // The database stamps state changes with its own clock, so the test clock starts at the real time.
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
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId, projectId: project.id, title: "Add rate limiting", systemState: "in_progress", assigneeAgentId: dev.id, stateChangedAt: ago(10), ...patch }).returning())[0]!;
  const switchOn = async (extra: Record<string, unknown> = {}) => {
    const r = await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true, ...extra });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  const smWakes = () => db.select().from(wakes).where(and(eq(wakes.agentId, sm.id), eq(wakes.reason, WATCHDOG_REASON)));
  return { ...built, db, close, base, req, companyId, sm, dev, ceo: ceo!, project, advance, ago, ticket, switchOn, smWakes, now: () => clock };
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
const call = async (args: Record<string, unknown>) => (await client(ctx.sm.id)).callTool({ name: "watchdog", arguments: args });
const actionId = (r: unknown) => /action ([0-9a-f-]{36})/.exec(textOf(r))![1]!;

describe("the ticket state clock and 'blocked until' (BOS-58, BOS-59 shape)", () => {
  it("stamps every state change, keeps an explicit stamp, and clears 'blocked until' when the ticket leaves blocked", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const t = await ctx.ticket({ stateChangedAt: old });
    await ctx.db.update(tickets).set({ title: "Renamed" }).where(eq(tickets.id, t.id));
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.stateChangedAt).toEqual(old);
    // Any path that changes state, here a direct write like the scheduler's or the loop guards'.
    await ctx.db.update(tickets).set({ systemState: "blocked", blockedUntil: new Date("2026-12-01T00:00:00Z"), blockedUntilReason: "waiting on the deploy window" }).where(eq(tickets.id, t.id));
    const blocked = (await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
    expect(blocked.stateChangedAt.getTime()).toBeGreaterThan(old.getTime());
    expect(blocked.blockedUntilReason).toBe("waiting on the deploy window");
    await ctx.db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, t.id));
    const freed = (await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
    expect(freed.blockedUntil).toBeNull();
    expect(freed.blockedUntilReason).toBeNull();
    // A ticket that isn't blocked can't hold one.
    const other = await ctx.ticket({ blockedUntil: new Date(), blockedUntilReason: "x" });
    expect(other.blockedUntil).toBeNull();
  });
});

describe("the watchdog sweep (BOS-58)", () => {
  it("is off by default and needs a Scrum Master to switch on", async () => {
    await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(0);
    const r = await ctx.req("PATCH", `/api/companies/${ctx.companyId}/watchdog`, { enabled: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain("Pick the Scrum Master");
    const bad = await ctx.req("PATCH", `/api/companies/${ctx.companyId}/watchdog`, { inProgressHours: -1 });
    expect(bad.statusCode).toBe(400);
  });

  it("wakes the Scrum Master once per sweep with every due problem, and not at all when nothing trips", async () => {
    await ctx.switchOn();
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(0);
    const loose = await ctx.ticket({ title: "Design the filter bar", assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    const quiet = await ctx.ticket({ title: "Fix login", stateChangedAt: ctx.ago(130) });
    await ctx.ticket({ title: "Fresh", stateChangedAt: ctx.ago(5) });
    await ctx.watchdog.run();
    const [w, ...more] = await ctx.smWakes();
    expect(more).toHaveLength(0);
    expect(w!.ticketId).toBeNull();
    expect(w!.note).toContain('"Design the filter bar"');
    expect(w!.note).toContain("nobody is assigned");
    expect(w!.note).toContain('"Fix login"');
    expect(w!.note).toContain("no movement in progress");
    expect(w!.note).not.toContain("Fresh");
    // No model ran: the only thing it did was queue one wake.
    expect(await ctx.db.select().from(runs)).toHaveLength(0);
    const flags = await ctx.db.select().from(watchdogFlags);
    expect(flags.map((f) => f.ticketId).sort()).toEqual([loose.id, quiet.id].sort());
    expect((await ctx.watchdog.status(ctx.companyId)).openFlags).toBe(2);
    expect((await ctx.watchdog.status(ctx.companyId)).lastSweepAt).toEqual(ctx.now());

    // De-duplicated: the same problems aren't handed on again until their limit passes.
    ctx.advance(5);
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    ctx.advance(16);
    await ctx.watchdog.run();
    const second = await ctx.smWakes();
    expect(second).toHaveLength(2);
    expect(second[1]!.note).toContain("Design the filter bar");
    expect(second[1]!.note).not.toContain("Fix login");

    // A problem that clears closes its flag.
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.dev.id }).where(eq(tickets.id, loose.id));
    await ctx.watchdog.run();
    const [closed] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, loose.id));
    expect(closed!.status).toBe("closed");
  });

  it("does nothing while the company is paused, the maintenance hold is on, or the Scrum Master is paused", async () => {
    await ctx.switchOn();
    await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    await ctx.db.update(companies).set({ paused: true }).where(eq(companies.id, ctx.companyId));
    await ctx.watchdog.run();
    await ctx.db.update(companies).set({ paused: false }).where(eq(companies.id, ctx.companyId));
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.sm.id));
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(0);
  });

  it("rule 1: chases the holder, not the ticket it holds", async () => {
    await ctx.switchOn();
    const holder = await ctx.ticket({ title: "Pick a provider", stateChangedAt: ctx.ago(130) });
    const held = await ctx.ticket({ title: "Add checkout", systemState: "blocked", stateChangedAt: ctx.ago(1000) });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: held.id, blockerTicketId: holder.id });
    await ctx.watchdog.run();
    const [w] = await ctx.smWakes();
    expect(w!.note).toContain("Pick a provider");
    expect(w!.note).toContain("holds up 1 other ticket");
    expect(w!.note).not.toContain("Add checkout");
  });

  it("rule 2: reminds the owner once about a decision blocking a ticket, and never wakes the Scrum Master for it", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Penpot export", systemState: "blocked", stateChangedAt: ctx.ago(600) });
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: "Add the secrets?", options: ["Done", "Not yet"], recommendedOption: "Done", createdAt: ctx.ago(479) }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(watchdogFlags)).toHaveLength(0);
    ctx.advance(2);
    await ctx.watchdog.run();
    const told = () => ctx.db.select().from(notifications).where(sql`${notifications.title} like '%waited%for your decision'`);
    expect(await told()).toHaveLength(1);
    ctx.advance(25 * 60);
    await ctx.watchdog.run();
    expect(await told()).toHaveLength(1);
    expect(await ctx.smWakes()).toHaveLength(0);
    const [f] = await ctx.db.select().from(watchdogFlags);
    expect(f).toMatchObject({ rule: "owner_decision_waiting", status: "open" });
  });

  it("rule 3: stays quiet until 'blocked until' plus 2 h", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ systemState: "blocked", stateChangedAt: ctx.ago(2000), blockedUntil: new Date(ctx.now().getTime() + H), blockedUntilReason: "deploy window at noon" });
    await ctx.watchdog.run();
    ctx.advance(179);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(0);
    ctx.advance(1);
    await ctx.watchdog.run();
    const [w] = await ctx.smWakes();
    expect(w!.note).toContain("'blocked until' time has passed");
    expect((await ctx.db.select().from(watchdogFlags))[0]!.ticketId).toBe(t.id);
  });

  it("re-flags a review loop on each further send-back", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Bouncy", stateChangedAt: ctx.ago(5) });
    for (let i = 0; i < 3; i++) await ctx.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Senior Developer", verdict: "changes_requested" });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    ctx.advance(5);
    await ctx.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Senior Developer", verdict: "changes_requested" });
    await ctx.watchdog.run();
    const all = await ctx.smWakes();
    expect(all).toHaveLength(2);
    expect(all[1]!.note).toContain("sent back 4 times");
  });
});

describe("the Scrum Master's actions (BOS-58)", () => {
  /** A ticket the watchdog has flagged and handed to the Scrum Master. */
  const handed = async (patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(130), ...patch });
    await ctx.watchdog.run();
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    return t;
  };
  const undo = (r: unknown) => ctx.req("POST", `/api/watchdog-actions/${actionId(r)}/undo`, { reason: "Not needed after all." });

  it("has only reads, ticket_reply and the watchdog tool: it can't move, re-rate, reassign or close tickets", async () => {
    await ctx.switchOn();
    const tools = (await (await client(ctx.sm.id)).listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["board", "list_my_work", "open_attachment", "ticket_reply", "tickets", "watchdog", "whats_new", "wiki"]);
    for (const name of ["set_ticket_state", "update_ticket", "set_ticket_risk", "assign_ticket", "create_ticket", "nudge", "raise_decision", "schedule_check", "deploy", "review"]) expect(tools).not.toContain(name);
    const t = await ctx.ticket();
    const r = await (await client(ctx.sm.id)).callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "x" } });
    expect(isError(r)).toBe(true);
    const w = await (await client(ctx.sm.id)).callTool({ name: "wiki", arguments: { action: "write", title: "x", body: "y" } });
    expect(textOf(w)).toContain("only read");
    // Other agents keep their tools, and don't get the watchdog's.
    const devTools = (await (await client(ctx.dev.id)).listTools()).tools.map((x) => x.name);
    expect(devTools).toContain("set_ticket_state");
    expect(devTools).not.toContain("watchdog");
  });

  it("acts only on problems it was handed: a ticket the watchdog never flagged is refused", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket();
    const r = await call({ action: "nudge", ticketId: t.id, reason: "Just checking in on this one." });
    expect(textOf(r)).toContain("isn't among the problems");
    expect(await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.dev.id))).toHaveLength(0);
  });

  it("nudges with a logged reason, once per hand-off, and the owner's undo takes back a wake not yet delivered", async () => {
    await ctx.switchOn();
    const t = await handed();
    const r = await call({ action: "nudge", ticketId: t.id, reason: "No movement for 2 h; please pick it up or say why it's stuck." });
    expect(isError(r)).toBe(false);
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.dev.id));
    expect(w!.note).toContain("please pick it up");
    expect(w!.note).toContain("<untrusted");
    const [a] = await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "nudge"));
    expect(a).toMatchObject({ actorAgentId: ctx.sm.id, targetAgentId: ctx.dev.id, ticketId: t.id, undoable: true });
    expect(a!.actorRunId).toBeTruthy();
    expect((await ctx.db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "watchdog"))))[0]!.summary).toContain("Scrum Master nudged Developer");
    // A reason is required, and a second nudge on the same hand-off is refused.
    expect(isError(await call({ action: "nudge", ticketId: t.id, reason: "" }))).toBe(true);
    expect(textOf(await call({ action: "nudge", ticketId: t.id, reason: "Nudging once more." }))).toContain("already used nudge");

    expect((await undo(r)).statusCode).toBe(200);
    expect((await ctx.db.select().from(wakes).where(eq(wakes.id, w!.id)))[0]!.status).toBe("dropped");
    expect((await undo(r)).statusCode).toBe(409);
    // Undo isn't one of the Scrum Master's tools.
    expect(isError(await call({ action: "undo", actionId: actionId(r) }))).toBe(true);
  });

  it("refuses to undo a wake that was already delivered", async () => {
    await ctx.switchOn();
    const t = await handed();
    const r = await call({ action: "nudge", ticketId: t.id, reason: "Checking in after the stall alert." });
    await ctx.db.update(wakes).set({ status: "launched", runId: randomUUID() }).where(eq(wakes.agentId, ctx.dev.id));
    const u = await undo(r);
    expect(u.statusCode).toBe(409);
    expect(u.json().message).toContain("already delivered");
  });

  it("assigns only unassigned flagged tickets, to a colleague or the CEO, and undo unassigns while nobody changed it since", async () => {
    await ctx.switchOn();
    const t = await handed({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    const stale = await handed();
    expect(textOf(await call({ action: "assign", ticketId: stale.id, to: "ceo", reason: "x".repeat(10) }))).toContain("already assigned");
    expect(isError(await call({ action: "assign", ticketId: t.id, to: "Scrum Master", reason: "self assignment" }))).toBe(true);
    expect(isError(await call({ action: "assign", ticketId: t.id, to: "Wiki Maintainer", reason: "a standing job" }))).toBe(true);
    const r = await call({ action: "assign", ticketId: t.id, to: "ceo", reason: "No obvious role; handing to the CEO." });
    expect(isError(r)).toBe(false);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.assigneeAgentId).toBe(ctx.ceo.id);
    const u = await undo(r);
    expect(u.json().what).toBe("unassigned it again");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.assigneeAgentId).toBeNull();
    // Once per hand-off, an undone one included.
    expect(textOf(await call({ action: "assign", ticketId: t.id, to: "Developer", reason: "It's code work." }))).toContain("already used assign");

    const other = await handed({ assigneeAgentId: null, stateChangedAt: ctx.ago(60), title: "Another" });
    const again = await call({ action: "assign", ticketId: other.id, to: "Developer", reason: "It's code work." });
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.ceo.id }).where(eq(tickets.id, other.id));
    expect((await undo(again)).json().message).toContain("changed since");
  });

  it("snoozes up to 48 h, refuses a third snooze in a row, and hands a twice-snoozed flag to the CEO", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Slow burner", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    const [f] = await ctx.db.select().from(watchdogFlags);
    expect(isError(await call({ action: "snooze", flagId: f!.id, hours: 49, reason: "too long" }))).toBe(true);
    const s1 = await call({ action: "snooze", flagId: f!.id, hours: 4, reason: "Waiting on CI, it is fine." });
    expect(isError(s1)).toBe(false);
    // The first wake has run; a still-waiting one would just take the new list into its note.
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    ctx.advance(5 * 60);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(2);
    await call({ action: "snooze", flagId: f!.id, hours: 4, reason: "Still on CI, fine." });
    const third = await call({ action: "snooze", flagId: f!.id, hours: 4, reason: "Once more please." });
    expect(textOf(third)).toContain("snoozed twice in a row");
    ctx.advance(5 * 60);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(2);
    const [esc] = await ctx.db.select().from(wakes).where(eq(wakes.reason, WATCHDOG_ESCALATE_REASON));
    expect(esc).toMatchObject({ agentId: ctx.ceo.id, ticketId: t.id });
    expect(esc!.note).toContain("snoozed it twice in a row");
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "auto_escalate"))).toHaveLength(1);
    // Undoing a snooze clears it.
    const [snoozed] = await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "snooze")).orderBy(watchdogActions.createdAt);
    expect((await ctx.req("POST", `/api/watchdog-actions/${snoozed!.id}/undo`)).json().what).toBe("cleared the snooze");
  });

  it("re-wakes only after a crashed or ended run and only once, raises an owner decision undo withdraws, and escalates to the CEO", async () => {
    await ctx.switchOn();
    const t = await handed({ stateChangedAt: ctx.ago(300) });
    expect(textOf(await call({ action: "rewake", ticketId: t.id, reason: "try again please" }))).toContain("its last run crashed");
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.ago(120), endedAt: ctx.ago(60), outcome: "error: Out of memory" });
    ctx.advance(130);
    await ctx.watchdog.run();
    expect((await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.status, "open"))).map((f) => f.rule)).toContain("run_crashed");
    expect(isError(await call({ action: "rewake", ticketId: t.id, reason: "The run ran out of memory; carry on." }))).toBe(false);
    expect((await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.dev.id)))[0]!.note).toContain("crashed");
    expect(textOf(await call({ action: "rewake", ticketId: t.id, reason: "And again." }))).toContain("already used rewake");

    const ask = await call({ action: "raise_decision", ticketId: t.id, question: "Grant more memory to the runner?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Re-woke the run; memory is a host setting agents can't change.", reason: "Only the owner can change the host." });
    expect(isError(ask)).toBe(false);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("blocked");
    await undo(ask);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.question, "Grant more memory to the runner?"));
    expect(d!.status).toBe("withdrawn");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
    expect((await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary)).toContain("blocked -> in_progress");

    expect(isError(await call({ action: "escalate", ticketId: t.id, reason: "Crashed; needs a decision on approach." }))).toBe(false);
    expect((await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id)))[0]!.note).toContain("escalated");
    // Escalated: it's the CEO's now, so the Scrum Master's actions on it stop.
    expect(isError(await call({ action: "nudge", ticketId: t.id, reason: "One more nudge." }))).toBe(true);
  });

  it("hands an escalated ticket to the Scrum Master again once its limit passes with nobody acting, with fresh snoozes", async () => {
    await ctx.switchOn();
    const t = await handed();
    expect(isError(await call({ action: "escalate", ticketId: t.id, reason: "Needs the CEO." }))).toBe(false);
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.ceo.id));
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2 });
    // Still inside the limit: the CEO has it, nothing new goes out.
    ctx.advance(60);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    expect((await ctx.db.select().from(watchdogFlags))[0]!.escalatedAt).not.toBeNull();
    // Limit passed and the ticket is still stuck: it starts over.
    ctx.advance(70);
    await ctx.watchdog.run();
    const [f] = await ctx.db.select().from(watchdogFlags);
    expect(f).toMatchObject({ escalatedAt: null, snoozeCount: 0, status: "open" });
    expect(await ctx.smWakes()).toHaveLength(2);
  });

  it("an auto-escalation with no CEO doesn't hold back the rest of the list", async () => {
    await ctx.switchOn();
    const a = await ctx.ticket({ title: "Twice snoozed", stateChangedAt: ctx.ago(130) });
    const b = await ctx.ticket({ title: "Fresh one", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2, dueAt: ctx.now() }).where(eq(watchdogFlags.ticketId, a.id));
    await ctx.db.update(watchdogFlags).set({ dueAt: ctx.now() }).where(eq(watchdogFlags.ticketId, b.id));
    await ctx.db.update(agents).set({ retiredAt: ctx.now() }).where(eq(agents.id, ctx.ceo.id));
    await ctx.watchdog.run();
    const wakesNow = await ctx.smWakes();
    expect(wakesNow).toHaveLength(2);
    expect(wakesNow[1]!.note).toContain("Fresh one");
  });

  it("doesn't re-flag a problem that cleared and came back until its limit has passed since the last hand-off", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(300) });
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.ago(120), endedAt: ctx.ago(60), outcome: "end_turn" });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    // Re-woken: a run starts (the flag clears), then ends without moving the ticket again.
    const [r] = await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.now() }).returning();
    ctx.advance(5);
    await ctx.watchdog.run();
    expect((await ctx.db.select().from(watchdogFlags))[0]!.status).toBe("closed");
    await ctx.db.update(runs).set({ endedAt: ctx.now(), outcome: "end_turn" }).where(eq(runs.id, r!.id));
    ctx.advance(50);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    ctx.advance(70);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(2);
  });

  it("only the Scrum Master can act, and only on its own company's tickets", async () => {
    await ctx.switchOn();
    const t = await handed();
    await expect(ctx.watchdog.nudge(ctx.companyId, ctx.dev.id, randomUUID(), { ticketId: t.id, reason: "not me" })).rejects.toThrow("Only the company's Scrum Master");
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const [foreign] = await ctx.db.insert(tickets).values({ companyId: other.company.id, projectId: (await ctx.req("POST", `/api/companies/${other.company.id}/projects`, { name: "P" })).json().id, title: "Theirs" }).returning();
    expect(textOf(await call({ action: "nudge", ticketId: foreign!.id, reason: "cross company" }))).toContain("No ticket with that ID");
  });
});

describe("the hourly cap (BOS-58)", () => {
  it("switches the watchdog off, tells the owner once, and refuses further actions until the owner switches it back on", async () => {
    await ctx.switchOn({ maxNudgesPerHour: 2 });
    const ts = [];
    for (const title of ["One", "Two", "Three"]) ts.push(await ctx.ticket({ title, stateChangedAt: ctx.ago(130) }));
    await ctx.watchdog.run();
    await call({ action: "nudge", ticketId: ts[0]!.id, reason: "first nudge here" });
    await call({ action: "nudge", ticketId: ts[1]!.id, reason: "second action" });
    const over = await call({ action: "nudge", ticketId: ts[2]!.id, reason: "third one trips it" });
    expect(textOf(over)).toContain("hourly limit");
    const st = await ctx.watchdog.status(ctx.companyId);
    expect(st.settings.enabled).toBe(false);
    expect(st.trippedReason).toContain("more than 2 actions");
    expect((await ctx.db.select().from(decisions)).filter((d) => d.question.includes("switched itself off"))).toHaveLength(1);
    expect(textOf(await call({ action: "nudge", ticketId: ts[2]!.id, reason: "after the trip" }))).toContain("switched off");
    expect((await ctx.db.select().from(decisions)).filter((d) => d.question.includes("switched itself off"))).toHaveLength(1);
    // The sweep stays off too.
    ctx.advance(130);
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    // Switching back on clears the trip.
    const back = await ctx.switchOn();
    expect(back.trippedAt).toBeNull();
    expect(back.settings.enabled).toBe(true);
  });


  it("caps Scrum Master wakes per hour too", async () => {
    await ctx.switchOn({ maxSmRunsPerHour: 1, unassignedMinutes: 1 });
    await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    ctx.advance(2);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    expect((await ctx.watchdog.status(ctx.companyId)).trippedAt).not.toBeNull();
  });
});

describe("the read API and backtest (BOS-58)", () => {
  it("lists flags and actions for the activity view, and backtests the rules over history", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60), createdAt: ctx.ago(60) });
    await ctx.watchdog.run();
    const flags = (await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/flags?status=open`)).json();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ ticketId: t.id, rule: "unassigned", ticketTitle: "Add rate limiting" });
    const acts = (await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/actions`)).json();
    expect(acts[0]).toMatchObject({ kind: "sweep_wake", actorName: "Boss Man" });
    const bt = (await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/backtest?days=1`)).json();
    expect(bt.flags.some((f: { ticketId: string; rule: string }) => f.ticketId === t.id && f.rule === "unassigned")).toBe(true);
    expect(bt.scrumMasterWakes).toBeGreaterThan(0);
    expect(bt.caveats.length).toBeGreaterThan(0);
  });
});
