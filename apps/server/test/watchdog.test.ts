import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, decisions, notifications, runs, ticketDependencies, ticketMessages, ticketReviews, tickets, wakes, watchdogActions, watchdogFlags } from "../src/db/schema.js";
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

  it("rule 2: only an answer to the card being waited on stops the reminder, not another card or a message on the same ticket (BOS-175)", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Penpot export", systemState: "blocked", stateChangedAt: ctx.ago(600) });
    const [waiting] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: "Add the secrets?", options: ["Done", "Not yet"], recommendedOption: "Done", createdAt: ctx.ago(479) }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: waiting!.id });
    // At the hour mark the flag opens, holding the card it is waiting on.
    await ctx.watchdog.run();
    ctx.advance(2);
    await ctx.watchdog.run();
    const [flag] = await ctx.db.select().from(watchdogFlags);
    expect(flag).toMatchObject({ rule: "owner_decision_waiting", status: "open" });
    expect((flag!.detail as { decisionId?: string }).decisionId).toBe(waiting!.id);

    // The owner answers a different question on the same ticket, and writes to the ticket.
    const other = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.companyId, kind: "question", question: "Which logo?", options: ["A", "B"], recommendedOption: "A", context: { type: "question", ticketId: t.id, triedFirst: "Read the brand guide" }, raisedByAgentId: ctx.dev.id, createdAt: ctx.ago(1) })
      .returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: other[0]!.id });
    await ctx.decisions.answer(other[0]!.id, "A");
    await ctx.db.insert(ticketMessages).values({ companyId: ctx.companyId, ticketId: t.id, author: "owner", text: "Still thinking about the secrets.", delivery: "woken" });

    // The flag's reminder is due a day after it opened: the next sweep must still send it, because
    // neither the other card's answer nor the message settles the card being waited on.
    ctx.advance(24 * 60);
    await ctx.watchdog.run();
    const told = () => ctx.db.select().from(notifications).where(sql`${notifications.title} like '%waited%for your decision'`);
    expect(await told()).toHaveLength(1);
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "owner_reminder"))).toHaveLength(1);
  });

  it("rule 2: does not remind the owner about a card they have answered (BOS-175)", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Penpot export", systemState: "blocked", stateChangedAt: ctx.ago(600) });
    const [waiting] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: "Add the secrets?", options: ["Done", "Not yet"], recommendedOption: "Done", createdAt: ctx.ago(479) }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: waiting!.id });
    await ctx.watchdog.run();
    await ctx.decisions.answer(waiting!.id, "Done");
    ctx.advance(2);
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(notifications).where(sql`${notifications.title} like '%waited%for your decision'`)).toHaveLength(0);
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

    // One action per problem: the decision needs a fresh hand-off.
    const handOff = async () => {
      ctx.advance(1);
      await ctx.db.update(watchdogFlags).set({ lastFlaggedAt: ctx.now() }).where(eq(watchdogFlags.ticketId, t.id));
    };
    expect(textOf(await call({ action: "raise_decision", ticketId: t.id, question: "Grant more memory to the runner?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Re-woke the run; memory is a host setting agents can't change.", reason: "Only the owner can change the host." }))).toContain("one action per problem");
    await handOff();
    const ask = await call({ action: "raise_decision", ticketId: t.id, question: "Grant more memory to the runner?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Re-woke the run; memory is a host setting agents can't change.", reason: "Only the owner can change the host." });
    expect(isError(ask)).toBe(false);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("blocked");
    await undo(ask);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.question, "Grant more memory to the runner?"));
    expect(d!.status).toBe("withdrawn");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
    expect((await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id))).map((a) => a.summary)).toContain("blocked -> in_progress");

    await handOff();
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
  it("pauses the watchdog for the hour, tells the owner once, refuses actions in that hour, and resumes by itself after it", async () => {
    await ctx.switchOn({ maxNudgesPerHour: 2 });
    const ts = [];
    for (const title of ["One", "Two", "Three"]) ts.push(await ctx.ticket({ title, stateChangedAt: ctx.ago(130) }));
    await ctx.watchdog.run();
    await call({ action: "nudge", ticketId: ts[0]!.id, reason: "first nudge here" });
    await call({ action: "nudge", ticketId: ts[1]!.id, reason: "second action" });
    const over = await call({ action: "nudge", ticketId: ts[2]!.id, reason: "third one trips it" });
    expect(textOf(over)).toContain("hourly limit");
    const st = await ctx.watchdog.status(ctx.companyId);
    // A breach pauses; it does not leave the watchdog switched off.
    expect(st.settings.enabled).toBe(true);
    expect(st.pausedUntil).not.toBeNull();
    expect(st.trippedReason).toContain("more than 2 actions");
    expect((await ctx.db.select().from(decisions)).filter((d) => d.question.includes("paused itself"))).toHaveLength(1);
    // The trip is the Page-level problem: the owner is paged straight away, once.
    const pages = (await ctx.db.select().from(notifications)).filter((n) => n.level === "page");
    expect(pages.map((n) => n.title)).toEqual(["The watchdog paused itself for an hour"]);
    // The cap still holds within the hour: actions and the sweep are refused, and nothing more is sent.
    expect(textOf(await call({ action: "nudge", ticketId: ts[2]!.id, reason: "after the trip" }))).toContain("paused");
    expect((await ctx.db.select().from(decisions)).filter((d) => d.question.includes("paused itself"))).toHaveLength(1);
    const wakesAtTrip = (await ctx.smWakes()).length;
    const sweptAtTrip = (await ctx.watchdog.status(ctx.companyId)).lastSweepAt ?? new Date(0);
    ctx.advance(30);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(wakesAtTrip);
    expect((await ctx.watchdog.status(ctx.companyId)).pausedUntil).not.toBeNull();
    // Once the hour is over the next sweep resumes it with no owner action, and the log is clear again.
    ctx.advance(31);
    await ctx.watchdog.run();
    const after = await ctx.watchdog.status(ctx.companyId);
    expect(after.trippedAt).toBeNull();
    expect(after.pausedUntil).toBeNull();
    expect(after.settings.enabled).toBe(true);
    expect(after.lastSweepAt!.getTime()).toBeGreaterThan(sweptAtTrip.getTime());
    expect(textOf(await call({ action: "nudge", ticketId: ts[2]!.id, reason: "next hour works" }))).not.toContain("paused");
  });

  it("a watchdog the owner switched off during a pause stays off after the hour", async () => {
    await ctx.switchOn({ maxNudgesPerHour: 1 });
    const ts = [await ctx.ticket({ title: "A", stateChangedAt: ctx.ago(130) }), await ctx.ticket({ title: "B", stateChangedAt: ctx.ago(130) })];
    await ctx.watchdog.run();
    await call({ action: "nudge", ticketId: ts[0]!.id, reason: "first nudge here" });
    await call({ action: "nudge", ticketId: ts[1]!.id, reason: "second trips it" });
    await ctx.watchdog.update(ctx.companyId, { enabled: false });
    ctx.advance(61);
    await ctx.watchdog.run();
    expect((await ctx.watchdog.status(ctx.companyId)).settings.enabled).toBe(false);
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

  it("G6 (BOS-78): switching the watchdog off in Settings stops the next sweep acting on an already-flagged ticket, and switching it on resumes", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Stuck for a while", stateChangedAt: ctx.ago(130) });
    // 1. On, with a due stuck ticket: the sweep acts (one wake, one open flag).
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    expect((await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id)))[0]!.status).toBe("open");
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    // 2. The owner switches it off, with the same call Settings makes.
    const off = await ctx.req("PATCH", `/api/companies/${ctx.companyId}/watchdog`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().settings.enabled).toBe(false);
    // 3. By the next sweep the flag's limit has passed, so it would be handed on again, but nothing happens.
    ctx.advance(130);
    const wakesBefore = (await ctx.db.select().from(wakes)).length;
    const activityBefore = (await ctx.db.select().from(activity)).length;
    const actionsBefore = (await ctx.db.select().from(watchdogActions)).length;
    const flagsBefore = await ctx.db.select().from(watchdogFlags);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    expect(await ctx.db.select().from(wakes)).toHaveLength(wakesBefore);
    expect(await ctx.db.select().from(activity)).toHaveLength(activityBefore);
    expect(await ctx.db.select().from(watchdogActions)).toHaveLength(actionsBefore);
    expect(await ctx.db.select().from(watchdogFlags)).toEqual(flagsBefore);
    // A nudge from the Scrum Master is refused too, and leaves no trace.
    expect(textOf(await call({ action: "nudge", ticketId: t.id, reason: "owner switched it off" }))).toContain("switched off");
    expect(await ctx.db.select().from(watchdogActions)).toHaveLength(actionsBefore);
    // 4. Switched back on, the next sweep acts again.
    expect((await ctx.switchOn()).settings.enabled).toBe(true);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(2);
    expect(isError(await call({ action: "nudge", ticketId: t.id, reason: "back on, chasing it" }))).toBe(false);
    expect(await ctx.db.select().from(watchdogActions).where(and(eq(watchdogActions.ticketId, t.id), eq(watchdogActions.kind, "nudge")))).toHaveLength(1);
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
    // After 08:00 owner time the same sweep also sends the daily summary, so look for the wake rather than the first row.
    expect(acts.find((a: { kind: string }) => a.kind === "sweep_wake")).toMatchObject({ kind: "sweep_wake", actorName: "Boss Man" });
    const bt = (await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/backtest?days=1`)).json();
    expect(bt.flags.some((f: { ticketId: string; rule: string }) => f.ticketId === t.id && f.rule === "unassigned")).toBe(true);
    expect(bt.scrumMasterWakes).toBeGreaterThan(0);
    expect(bt.caveats.length).toBeGreaterThan(0);
  });

  it("the backtest counts one wake per sweep, however many flags the sweep hands over", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 5; i++) await ctx.ticket({ title: `Loose ${i}`, assigneeAgentId: null, stateChangedAt: ctx.ago(60), createdAt: ctx.ago(60) });
    const bt = (await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/backtest?days=1`)).json();
    expect(bt.flags.length).toBeGreaterThanOrEqual(5);
    expect(bt.scrumMasterWakes).toBeLessThan(bt.flags.length);
    expect(bt.busiestHourWakes).toBeLessThanOrEqual(bt.scrumMasterWakes);
  });
});

describe("back-off for repeat flags and scheduled checks (BOS-121)", () => {
  const MIN = 60_000;
  /** Sweeps every 5 minutes for the given time; returns the minutes (from the first sweep) at which the Scrum Master was woken. */
  const sweepFor = async (minutes: number) => {
    const woken: number[] = [];
    let seen = (await ctx.smWakes()).length;
    for (let m = 0; m <= minutes; m += 5) {
      await ctx.watchdog.run();
      const n = (await ctx.smWakes()).length;
      if (n > seen) woken.push(m);
      seen = n;
      await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
      ctx.advance(5);
    }
    return woken;
  };

  it("a ticket stuck for hours is handed on after the limit, then twice that, then four times, not every limit", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    await ctx.ticket({ stateChangedAt: ctx.ago(60) });
    // Without back-off this would be woken at 0, 60, 120, 180 and 240.
    expect(await sweepFor(300)).toEqual([0, 60, 180]);
  });

  it("starts over when the ticket gets a comment between hand-offs", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(60) });
    await ctx.watchdog.run();
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    ctx.advance(30);
    await ctx.db.insert(activity).values({ companyId: ctx.companyId, ticketId: t.id, kind: "message", summary: "Replied: still waiting", at: ctx.now() });
    ctx.advance(30);
    // Second hand-off at 60 minutes; the comment means the third waits one limit again, not two.
    expect((await sweepFor(90)).map((m) => m + 60)).toEqual([60, 120]);
  });

  it("still gives a flag to the CEO after two snoozes, however far the back-off has gone", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(60) });
    await ctx.watchdog.run();
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2, backoffSteps: 5, dueAt: ctx.now() }).where(eq(watchdogFlags.ticketId, t.id));
    await ctx.watchdog.run();
    const [f] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id));
    expect(f!.escalatedAt).not.toBeNull();
  });

  it("never flags a ticket whose assignee has a check scheduled for later, and flags it again once there is none", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(600), monitorAt: new Date(ctx.now().getTime() + 2 * H), monitorNote: "CI" });
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(watchdogFlags)).toHaveLength(0);
    expect(await ctx.smWakes()).toHaveLength(0);
    await ctx.db.update(tickets).set({ monitorAt: null }).where(eq(tickets.id, t.id));
    await ctx.watchdog.run();
    expect((await ctx.db.select().from(watchdogFlags)).map((f) => f.rule)).toEqual(["stale_in_progress"]);
  });

  it("the backtest gives an idle ticket at most two hand-offs in four hours", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(230), createdAt: ctx.ago(230) });
    const bt = await ctx.watchdog.backtest(ctx.companyId, 1);
    const flags = bt.flags.filter((f) => f.ticketId === t.id);
    expect(flags).toHaveLength(1);
    // Hand-offs at 1 h and 2 h idle; the next would be at 4 h.
    expect(flags[0]!.handOffs).toBe(2);
    expect(bt.scrumMasterWakes).toBe(2);
  });

  it("the backtest hands a review loop off again in the sweep where it is sent back once more", async () => {
    await ctx.switchOn({ reviewHours: 6 });
    const t = await ctx.ticket({ title: "Bouncy", stateChangedAt: ctx.ago(230), createdAt: ctx.ago(230) });
    for (const mins of [200, 190, 180, 100]) await ctx.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Senior Developer", verdict: "changes_requested", createdAt: ctx.ago(mins) });
    const bt = await ctx.watchdog.backtest(ctx.companyId, 1);
    const loop = bt.flags.filter((f) => f.ticketId === t.id && f.rule === "review_loop");
    expect(loop).toHaveLength(1);
    // Handed off when it first tripped (third send-back) and again at the fourth, long before the review limit ran out.
    expect(loop[0]!.handOffs).toBe(2);
  });

  it("the backtest reads scheduled checks back from the activity log", async () => {
    await ctx.switchOn({ inProgressHours: 1 });
    const checked = await ctx.ticket({ title: "Waiting on CI", stateChangedAt: ctx.ago(600), createdAt: ctx.ago(600) });
    const plain = await ctx.ticket({ title: "Forgotten", stateChangedAt: ctx.ago(600), createdAt: ctx.ago(600) });
    const until = ctx.ago(60);
    await ctx.db.insert(activity).values({ companyId: ctx.companyId, ticketId: checked.id, agentId: ctx.dev.id, kind: "monitor", summary: `Developer scheduled a check for ${until.toISOString()}: CI`, at: ctx.ago(590) });
    const bt = await ctx.watchdog.backtest(ctx.companyId, 1);
    const first = (id: string) => new Date(bt.flags.find((f) => f.ticketId === id)!.firstAt).getTime();
    expect(first(plain.id)).toBeLessThan(ctx.ago(400).getTime());
    // Quiet while the check was pending; flagged only after it ran out.
    expect(first(checked.id)).toBeGreaterThanOrEqual(until.getTime());
  });
});

describe("hardening from the adversarial review (BOS-74, BOS-75)", () => {
  const handed = async (patch: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(130), ...patch });
    await ctx.watchdog.run();
    await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
    return t;
  };

  it("F1: a busy board is one run per sweep, lists every problem, and does not trip the cap", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 40; i++) await ctx.ticket({ title: `Loose ${i}`, assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    for (let i = 0; i < 6; i++) {
      await ctx.watchdog.run();
      await ctx.db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, ctx.sm.id));
      ctx.advance(5);
    }
    const ws = await ctx.smWakes();
    // Sweeps at 0, 5, 10, 15, 20 and 25 minutes: one wake with all 40, then the next one when the 15-minute limit passes.
    expect(ws).toHaveLength(2);
    expect(ws[0]!.note).toContain("40 ticket problems");
    expect(ws[0]!.note).toContain('"Loose 39"');
    expect((await ctx.watchdog.status(ctx.companyId)).trippedAt).toBeNull();
  });

  it("F1: when the cap does trip, the owner is told how many problems were due and from which rule", async () => {
    await ctx.switchOn({ maxSmRunsPerHour: 1, unassignedMinutes: 1 });
    for (let i = 0; i < 3; i++) await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    await ctx.watchdog.run();
    ctx.advance(2);
    await ctx.watchdog.run();
    expect((await ctx.watchdog.status(ctx.companyId)).trippedReason).toContain("3 problems were due: 3 nobody is assigned");
  });

  it("F1: the backtest counts a sweep as one wake and reports when the cap would trip", async () => {
    for (let i = 0; i < 40; i++) await ctx.ticket({ title: `Loose ${i}`, assigneeAgentId: null, stateChangedAt: ctx.ago(120), createdAt: ctx.ago(120) });
    const quiet = await ctx.watchdog.backtest(ctx.companyId, 1);
    expect(quiet.wouldTripCap).toBe(false);
    expect(quiet.tripAt).toBeNull();
    await ctx.watchdog.update(ctx.companyId, { maxSmRunsPerHour: 1, unassignedMinutes: 15 });
    const tight = await ctx.watchdog.backtest(ctx.companyId, 1);
    expect(tight.wouldTripCap).toBe(true);
    expect(tight.tripAt).not.toBeNull();
  });

  it("F3: a stuck ticket with a queued wake is flagged when its assignee is paused, and not when the wake will happen", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ stateChangedAt: ctx.ago(600) });
    await ctx.db.insert(wakes).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, reason: "message", status: "queued", priority: 2, causationDepth: 0 });
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(watchdogFlags)).toHaveLength(0);
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.dev.id));
    await ctx.db.update(wakes).set({ statusReason: "agent paused" }).where(eq(wakes.agentId, ctx.dev.id));
    await ctx.watchdog.run();
    expect((await ctx.db.select().from(watchdogFlags)).map((f) => f.rule)).toEqual(["stale_in_progress"]);
  });

  it("F4: one action per problem, whichever kind: a snooze closes the nudge, and a nudge closes the snooze", async () => {
    await ctx.switchOn();
    const a = await handed();
    const [fa] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, a.id));
    expect(isError(await call({ action: "snooze", flagId: fa!.id, hours: 2, reason: "Waiting on CI, fine." }))).toBe(false);
    expect(textOf(await call({ action: "nudge", ticketId: a.id, reason: "Nudging as well." }))).toContain("one action per problem");
    expect(textOf(await call({ action: "escalate", ticketId: a.id, reason: "And escalating too." }))).toContain("one action per problem");
    const b = await handed({ title: "Other" });
    const [fb] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, b.id));
    expect(isError(await call({ action: "nudge", ticketId: b.id, reason: "Please pick it up." }))).toBe(false);
    expect(textOf(await call({ action: "snooze", flagId: fb!.id, hours: 2, reason: "Snoozing after the nudge." }))).toContain("one action per problem");
    expect(await ctx.db.select().from(watchdogActions).where(inArray(watchdogActions.kind, ["nudge", "snooze", "escalate"]))).toHaveLength(2);
  });

  it("F5: a pile of tickets waiting on the owner is one notification, not one each", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 25; i++) {
      const t = await ctx.ticket({ title: `Wait ${i}`, systemState: "blocked", stateChangedAt: ctx.ago(600) });
      const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: `Q${i}?`, options: ["Done", "Not yet"], recommendedOption: "Done", createdAt: ctx.ago(479) }).returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    }
    ctx.advance(2);
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(notifications).where(sql`${notifications.title} like '%waiting for your decision'`)).toHaveLength(1);
    expect(await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "owner_reminder"))).toHaveLength(25);
    // And not again for the same tickets.
    ctx.advance(25 * 60);
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(notifications).where(sql`${notifications.title} like '%waiting for your decision'`)).toHaveLength(1);
  });

  it("F6: a dropped sweep wake leaves the flags due and is not counted toward the cap", async () => {
    await ctx.switchOn({ maxSmRunsPerHour: 1 });
    const t = await ctx.ticket({ assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    const real = ctx.scheduler.notify.bind(ctx.scheduler);
    const spy = vi.spyOn(ctx.scheduler, "notify").mockImplementationOnce(async (agentId, input) => ({ ...(await real(agentId, input)), status: "dropped", statusReason: "company paused" }));
    await ctx.watchdog.run();
    spy.mockRestore();
    const [f] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id));
    expect(f!.lastFlaggedAt).toBeNull();
    expect(f!.dueAt.getTime()).toBeLessThan(ctx.now().getTime() + 20 * 60_000);
    ctx.advance(16);
    await ctx.watchdog.run();
    expect((await ctx.watchdog.status(ctx.companyId)).trippedAt).toBeNull();
    expect((await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id)))[0]!.lastFlaggedAt).not.toBeNull();
  });

  it("escalate takes only the flag it was given, and the owner can undo an automatic escalation", async () => {
    await ctx.switchOn();
    const t = await handed({ stateChangedAt: ctx.ago(600) });
    await ctx.db.insert(watchdogFlags).values({ companyId: ctx.companyId, ticketId: t.id, rule: "review_loop", dueAt: ctx.now(), lastFlaggedAt: ctx.now(), detail: { bounces: 5 } });
    const [stale] = await ctx.db.select().from(watchdogFlags).where(and(eq(watchdogFlags.ticketId, t.id), eq(watchdogFlags.rule, "stale_in_progress")));
    expect(isError(await call({ action: "escalate", ticketId: t.id, reason: "Stuck for ten hours." }))).toBe(false);
    const flags = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id));
    expect(flags.filter((f) => f.escalatedAt)).toHaveLength(1);

    const auto = await handed({ title: "Twice snoozed" });
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2, dueAt: ctx.now() }).where(eq(watchdogFlags.ticketId, auto.id));
    await ctx.watchdog.run();
    const [act] = await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "auto_escalate"));
    const r = await ctx.req("POST", `/api/watchdog-actions/${act!.id}/undo`);
    expect(r.statusCode).toBe(200);
    expect(stale).toBeTruthy();
    expect((await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, auto.id)))[0]).toMatchObject({ escalatedAt: null, snoozeCount: 0 });
  });
  const undo = (r: unknown) => ctx.req("POST", `/api/watchdog-actions/${actionId(r)}/undo`, { reason: "Not needed after all." });

  it("a trip on the nudge cap during the sweep ends the sweep: no Scrum Master wake after the watchdog pauses itself", async () => {
    await ctx.switchOn({ maxNudgesPerHour: 1 });
    const a = await handed({ title: "Twice snoozed" });
    await ctx.switchOn({ maxNudgesPerHour: 1 });
    await ctx.db.insert(watchdogActions).values({ companyId: ctx.companyId, kind: "nudge", ticketId: a.id, reason: "used the hour's allowance" });
    await ctx.ticket({ title: "Another due one", stateChangedAt: ctx.ago(130) });
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2, dueAt: ctx.now() }).where(eq(watchdogFlags.ticketId, a.id));
    const before = (await ctx.smWakes()).length;
    await ctx.watchdog.run();
    expect((await ctx.watchdog.status(ctx.companyId)).pausedUntil).not.toBeNull();
    expect(await ctx.smWakes()).toHaveLength(before);
  });

  it("undoing a raised decision still puts the ticket back when its old column is full", async () => {
    await ctx.switchOn();
    const t = await handed({ stateChangedAt: ctx.ago(300) });
    await ctx.db.update(watchdogFlags).set({ lastFlaggedAt: ctx.now() }).where(eq(watchdogFlags.ticketId, t.id));
    const ask = await call({ action: "raise_decision", ticketId: t.id, question: "Grant more memory?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Looked at it; it is a host setting.", reason: "Only the owner can change the host." });
    expect(isError(ask)).toBe(false);
    const { workflowColumns } = await import("../src/db/schema.js");
    const [col] = await ctx.db.select().from(workflowColumns).where(and(eq(workflowColumns.projectId, ctx.project.id), eq(workflowColumns.systemState, "in_progress")));
    await ctx.ticket({ title: "Fills the column", columnId: col!.id });
    await ctx.db.update(workflowColumns).set({ wipLimit: 1 }).where(eq(workflowColumns.id, col!.id));
    expect((await undo(ask)).statusCode).toBe(200);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });
});

describe("open issues and the timeline (BOS-199)", () => {
  it("lists the open warnings the badge counts, and settles a finished ticket with a plain note", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Merged one", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    const res = await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/issues`);
    expect(res.statusCode).toBe(200);
    const issues = res.json() as Array<{ ticketId: string; warning: string; holder: string; done: unknown[]; nextText: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ticketId: t.id, holder: "scrum_master" });
    expect(issues[0]!.warning).toContain("no movement in progress");
    expect(issues[0]!.nextText).toBe("Checks again");
    expect((await ctx.watchdog.status(ctx.companyId)).openFlags).toBe(issues.length);

    await ctx.db.update(tickets).set({ systemState: "done", outcome: "completed", mergeCommit: "abc123" }).where(eq(tickets.id, t.id));
    const after = await ctx.req("GET", `/api/companies/${ctx.companyId}/watchdog/issues`);
    expect(after.json()).toEqual([]);
    expect((await ctx.watchdog.status(ctx.companyId)).openFlags).toBe(0);
    const [flag] = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id));
    expect(flag!.status).toBe("closed");
    const [settled] = await ctx.db.select().from(watchdogActions).where(and(eq(watchdogActions.ticketId, t.id), eq(watchdogActions.kind, "alert_resolved")));
    expect(settled!.reason).toContain("merged");
    expect(settled!.reason).toContain("Settled:");
  });

  it("settles an open alert whose ticket finished, and its warning text has no dangling comma", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Quiet developer", stateChangedAt: ctx.ago(1) });
    const question = 'Zippy has sent nothing for 5 minutes while working on "Quiet developer". It may be stuck, or busy with a long command.';
    expect(await ctx.alerts.raise({ companyId: ctx.companyId, question, ticketId: t.id, options: ["Keep waiting", "Cancel run"], recommended: "Keep waiting", from: "scrum_master", duty: true })).not.toBeNull();
    const before = await ctx.watchdog.issues(ctx.companyId);
    const issue = before.find((x) => x.ticketId === t.id)!;
    expect(issue.warning).toBe(question.split(". ")[0] + ".");
    expect(issue.warning.endsWith(",")).toBe(false);
    expect(issue.holder).toBe("scrum_master");

    await ctx.db.update(tickets).set({ systemState: "done", outcome: "completed", mergeCommit: "def456" }).where(eq(tickets.id, t.id));
    const after = await ctx.watchdog.issues(ctx.companyId);
    expect(after.some((x) => x.ticketId === t.id)).toBe(false);
    const alert = (await ctx.db.select().from(decisions).where(and(eq(decisions.companyId, ctx.companyId), sql`${decisions.context}->'ladder' is not null`)))[0]!;
    expect(alert.status).toBe("answered");
  });

  it("keeps a stuck ticket open when a run or activity happened after the warning", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Still stuck", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    const flagged = (await ctx.watchdog.issues(ctx.companyId)).find((x) => x.ticketId === t.id);
    expect(flagged).toBeTruthy();
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.now() });
    await ctx.db.insert(activity).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, kind: "message", summary: "Woke and kept working", at: ctx.now() });
    const after = await ctx.watchdog.issues(ctx.companyId);
    expect(after.some((x) => x.ticketId === t.id)).toBe(true);
    expect((await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, t.id)))[0]!.status).toBe("open");
  });

  it("does not auto-answer an owner-rung alert on a live ticket", async () => {
    const t = await ctx.ticket({ title: "Owner is deciding", stateChangedAt: ctx.ago(1) });
    const ladder = { rung: "owner", since: ctx.now().toISOString(), minutes: 5, ticketId: t.id, about: [], hops: [] };
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: "The deploy is stuck. Keep waiting?", options: ["Keep waiting"], recommendedOption: "Keep waiting", context: { type: "alert", ladder } }).returning();
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.now() });
    await ctx.db.insert(activity).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, kind: "message", summary: "A nudge reached the ticket", at: ctx.now() });
    const issues = await ctx.watchdog.issues(ctx.companyId);
    expect(issues.some((x) => x.ticketId === t.id && x.holder === "owner")).toBe(true);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("open");
  });

  it("leaves plan and permission hand-overs on the ladder alone", async () => {
    const t = await ctx.ticket({ title: "Needs approval", stateChangedAt: ctx.ago(1) });
    const ladder = { rung: "ceo", since: ctx.now().toISOString(), minutes: 5, ticketId: t.id, about: [], hops: [] };
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "permission", question: "Allow this command?", options: ["Allow"], recommendedOption: "Allow", context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), ladder } }).returning();
    expect(await ctx.watchdog.issues(ctx.companyId)).toEqual([]);
    await ctx.db.update(tickets).set({ systemState: "done", outcome: "completed" }).where(eq(tickets.id, t.id));
    expect((await ctx.watchdog.status(ctx.companyId)).openFlags).toBe(0);
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.status).toBe("open");
  });

  it("labels each timeline entry with its issue, its open or settled state, and a repeat warning on the same ticket", async () => {
    const t = await ctx.ticket({ title: "Two warnings", stateChangedAt: ctx.ago(1) });
    const opened = ctx.now();
    const [first] = await ctx.db.insert(watchdogFlags).values({ companyId: ctx.companyId, ticketId: t.id, rule: "stale_in_progress", status: "closed", openedAt: new Date(opened.getTime() - 60_000), closedAt: opened, dueAt: opened }).returning();
    const [second] = await ctx.db.insert(watchdogFlags).values({ companyId: ctx.companyId, ticketId: t.id, rule: "review_loop", status: "open", openedAt: opened, dueAt: opened }).returning();
    await ctx.db.insert(watchdogActions).values([
      { companyId: ctx.companyId, kind: "nudge", ticketId: t.id, flagId: first!.id, reason: "first warning action", createdAt: new Date(opened.getTime() - 30_000) },
      { companyId: ctx.companyId, kind: "nudge", ticketId: t.id, flagId: second!.id, reason: "second warning action", createdAt: opened },
    ]);
    const rows = await ctx.watchdog.actions(ctx.companyId, { ticketId: t.id });
    const a = rows.find((r) => r.reason === "first warning action")!;
    const b = rows.find((r) => r.reason === "second warning action")!;
    expect(a.issueStatus).toBe("settled");
    expect(b.issueStatus).toBe("open");
    expect(a.issueLabel).toMatch(/1st warning on .* today/);
    expect(b.issueLabel).toMatch(/2nd warning on .* today/);
  });
});
