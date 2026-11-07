import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, runs, ticketDependencies, tickets, wakes, watchdogActions, watchdogFlags } from "../src/db/schema.js";

// Rules 3 and 4 of the idle-capacity rules (BOS-659): the company is under-used while work waits, so the CEO is
// told. The company's run limit is 10 here, so rule 3 fires below 9 busy and rule 4 below 8 busy for 20 minutes.

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, company: 10, instance: 10 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
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
    (await db.insert(tickets).values({ companyId, projectId: project.id, title: "Add rate limiting", systemState: "ready", assigneeAgentId: dev.id, stateChangedAt: ago(10), ...patch }).returning())[0]!;
  const switchOn = async (extra: Record<string, unknown> = {}) => {
    const r = await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true, ...extra });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  // Occupy n company slots with live work runs.
  const busy = async (n: number) => {
    for (let i = 0; i < n; i++) await db.insert(runs).values({ companyId, agentId: dev.id, purpose: "work", startedAt: ago(1) });
  };
  const cards = () => db.select().from(decisions).where(eq(decisions.dedupeKey, `spare-capacity:${companyId}`));
  const smWakes = () => db.select().from(wakes).where(eq(wakes.agentId, sm.id));
  return { ...built, db, close, req, companyId, sm, dev, ceo: ceo!, project, advance, ago, ticket, switchOn, busy, cards, smWakes, now: () => clock };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("idle-capacity rules 3 and 4 (BOS-659)", () => {
  it("rules 3 and 4 follow the company's run limit, not a hardcoded 10", async () => {
    await ctx.switchOn();
    // 8 of 10 busy with work waiting: not rule 3 (needs fewer than 9), and rule 4 needs the whole 20 minutes.
    await ctx.busy(8);
    await ctx.ticket({ title: "Ready but not running", stateChangedAt: ctx.ago(120) });
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(0);
  });

  it("rule 3: one slot short of full with only merges left wakes the CEO at once, listing the idle agents", async () => {
    await ctx.switchOn();
    await ctx.busy(8); // 8 busy, 2 free, limit 10: fewer than 9 → rule 3.
    const merging = await ctx.ticket({ title: "Shipped work", systemState: "review" });
    await ctx.watchdog.run();
    const [card] = await ctx.cards();
    expect(card).toBeTruthy();
    expect(card!.question).toContain("8 of a limit of 10 run slots are busy");
    expect(card!.question).toContain("only work left is waiting to merge");
    expect(card!.question).toContain("Idle agents");
    expect(card!.question).toContain("Developer");
    expect(card!.question).toContain("Waiting to merge");
    void merging;
    expect((await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "spare_capacity_alert")))).toHaveLength(1);
  });

  it("rule 4: under eight busy for twenty minutes while ready work waits wakes the CEO once, then not again until it clears", async () => {
    await ctx.switchOn();
    await ctx.busy(2); // 2 busy, 8 free: below 8 → rule 4's count, but not for 20 minutes yet.
    await ctx.ticket({ title: "Ready but not running", stateChangedAt: ctx.ago(120) });
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(0);
    ctx.advance(10);
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(0);
    ctx.advance(11); // 21 minutes below the mark.
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(1);
    // Still low on the next check: not woken again for the same stretch.
    ctx.advance(30);
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(1);
    expect((await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "spare_capacity_alert")))).toHaveLength(1);
  });

  it("stays quiet when the company is busy enough, or nothing is waiting", async () => {
    await ctx.switchOn();
    // 9 busy (rule 3/4 clear) with ready work waiting: nothing to say.
    await ctx.busy(9);
    await ctx.ticket({ title: "Ready but not running", stateChangedAt: ctx.ago(120) });
    ctx.advance(30);
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(0);
  });

  it("says nothing was sent in record-only mode, and writes the rehearsal down instead", async () => {
    await ctx.switchOn({ recordOnly: true });
    await ctx.busy(8);
    await ctx.ticket({ title: "Shipped work", systemState: "review" });
    await ctx.watchdog.run();
    expect(await ctx.cards()).toHaveLength(0);
    expect((await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "record_spare_capacity_alert")))).toHaveLength(1);
  });
});

describe("rule 1 and 2 hand-offs reach the Scrum Master (BOS-659)", () => {
  it("rule 1: an in-progress ticket the agent never ran is handed to the Scrum Master, and again only after a run re-wakes it", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Never started", systemState: "in_progress", stateChangedAt: ctx.ago(20) });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    // Still idle on the next check: one flag, one hand-off, not a second wake.
    ctx.advance(5);
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    // The agent starts a run: the flag clears.
    await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, purpose: "work", startedAt: ctx.now() });
    await ctx.watchdog.run();
    expect((await ctx.db.select().from(watchdogFlags)).filter((f) => f.status === "open")).toHaveLength(0);
  });

  it("rule 2: a ready ticket released from a finished blocker and never run is handed to the Scrum Master", async () => {
    await ctx.switchOn();
    const blocker = await ctx.ticket({ title: "Blocker", systemState: "done", stateChangedAt: ctx.ago(30) });
    const released = await ctx.ticket({ title: "Was blocked", stateChangedAt: ctx.ago(30) });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: released.id, blockerTicketId: blocker.id });
    await ctx.watchdog.run();
    expect(await ctx.smWakes()).toHaveLength(1);
    const flags = await ctx.db.select().from(watchdogFlags).where(eq(watchdogFlags.ticketId, released.id));
    expect(flags.map((f) => f.rule)).toEqual(["unstarted"]);
  });
});
