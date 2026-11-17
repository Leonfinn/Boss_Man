import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, notifications, runs, tickets, wakes } from "../src/db/schema.js";
import { HELD_AGENT } from "../src/services/fair-share.js";
import { judge, OWNER_AFTER_MS, priorityWatchService, QUIET_AFTER_MS, stopped, type Facts } from "../src/services/priority-watch.js";
import { WAKE_CLASS } from "../src/services/wake-classes.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const facts = (over: Partial<Facts> = {}): Facts => ({
  state: "in_progress",
  lastActiveAt: ago(10 * MIN),
  liveRuns: [],
  queuedWakes: 0,
  deferredWakes: [],
  checkJobs: [],
  pendingReviews: 0,
  openCards: 0,
  openWaitsOn: 0,
  bookedUntil: null,
  line: null,
  seatsFree: false,
  lastRun: null,
  movedBack: null,
  left: null,
  ...over,
});
const causes = (f: Facts) => judge(f, NOW).alarms.map((a) => a.cause);

describe("priority watch: what counts as a next step", () => {
  it("alarms when nothing is under way and the ticket has been quiet", () => {
    const v = judge(facts({ deferredWakes: ["company at its run limit"] }), NOW);
    expect(v.alarms.map((a) => a.cause)).toEqual(["nothing"]);
    expect(v.alarms[0]!.text).toContain("company at its run limit");
  });

  it("does not alarm for a ticket that went quiet only just now", () => {
    expect(causes(facts({ lastActiveAt: ago(QUIET_AFTER_MS - MIN) }))).toEqual([]);
  });

  it.each([
    ["a live run", { liveRuns: [{ agent: "Zippy", startedAt: ago(MIN) }] }],
    ["a queued wake", { queuedWakes: 1 }],
    ["a queued check", { checkJobs: [{ kind: "pre_review", state: "queued", reason: null }] }],
    ["a running check", { checkJobs: [{ kind: "merge", state: "running", reason: null }] }],
    ["a review with a reviewer", { state: "review", pendingReviews: 1 }],
    ["a merge check on the line", { state: "review", line: { event: "check_started", at: ago(20 * MIN) } }],
    ["an open owner card", { openCards: 1 }],
    ["a blocker still open", { state: "blocked", openWaitsOn: 1 }],
    ["a booked check ahead", { bookedUntil: new Date(NOW.getTime() + 10 * MIN) }],
  ] as Array<[string, Partial<Facts>]>)("%s is a next step", (_n, over) => {
    expect(causes(facts(over))).toEqual([]);
  });

  it("a booked check in the past is not a next step", () => {
    expect(causes(facts({ bookedUntil: ago(MIN) }))).toEqual(["nothing"]);
  });

  it("a cut-off run alarms, quoting the run's outcome", () => {
    const v = judge(facts({ queuedWakes: 1, lastRun: { id: "r1", outcome: "lost: runner went away", endedAt: ago(2 * MIN) } }), NOW);
    expect(v.alarms.map((a) => a.cause)).toEqual(["cut_off"]);
    expect(v.alarms[0]!.text).toContain("lost: runner went away");
    // A normal end is not a cut-off.
    expect(causes(facts({ queuedWakes: 1, lastRun: { id: "r2", outcome: "end_turn", endedAt: ago(2 * MIN) } }))).toEqual([]);
  });

  it("a move backwards and a 'left' event alarm even while something is under way", () => {
    expect(causes(facts({ queuedWakes: 1, movedBack: { id: "a1", text: "review -> in_progress" } }))).toEqual(["moved_back"]);
    expect(causes(facts({ state: "in_progress", queuedWakes: 1, left: { id: "a2", to: "in_progress" } }))).toEqual(["left_line"]);
  });

  it("waiting for a train seat while a seat is free alarms; with the seats full it does not", () => {
    const line = { event: "hold_started", hold: "train", at: ago(8 * MIN) };
    expect(causes(facts({ state: "review", line, seatsFree: true }))).toEqual(["seat_free"]);
    expect(causes(facts({ state: "review", line, seatsFree: false }))).toEqual([]);
  });

  it("registers its wake as one that is never dropped", () => {
    expect(WAKE_CLASS["priority watch"]).toBe("waiting");
  });
});

describe("priority watch: held on a recorded hold (BOS-1717)", () => {
  const quietReview = { state: "review", lastActiveAt: ago(3 * 60 * MIN), movedBack: { id: "a1", text: "in_progress -> review" } } as const;
  it("raises no alarm for a review ticket held on a waits-on link or system hold", () => {
    expect(causes(facts({ ...quietReview, heldOnRecord: true }))).toEqual([]);
  });
  it("still alarms for the same quiet review ticket when no hold is recorded", () => {
    expect(causes(facts({ ...quietReview, heldOnRecord: false }))).toContain("nothing");
  });
  it("a hold on a ticket that isn't in review doesn't silence the alarm", () => {
    expect(causes(facts({ state: "in_progress", lastActiveAt: ago(3 * 60 * MIN), heldOnRecord: true }))).toContain("nothing");
  });
});

describe("priority watch: merged, waiting for go-live (BOS-1547)", () => {
  const blocked = (over: Partial<Facts> = {}) => facts({ state: "blocked", ...over });
  it("a fresh go-live wait is a step under way, named for the server update, and raises no alarm", () => {
    const v = judge(blocked({ goLive: { wait: "server", since: ago(10 * MIN) } }), NOW);
    expect(v.underWay).toContain("merged, waiting for the server update");
    expect(v.alarms).toEqual([]);
  });
  it("a company that puts its own work live is named for its own deploy", () => {
    expect(judge(blocked({ goLive: { wait: "own", since: ago(10 * MIN) } }), NOW).underWay).toContain("merged, waiting for the company's own deploy");
  });
  it("a long wait tells the CEO once-per-wait, never 'stopped'", () => {
    const v = judge(blocked({ goLive: { wait: "server", since: ago(3 * 60 * MIN) } }), NOW);
    expect(v.alarms.map((a) => a.cause)).toEqual(["go_live_slow"]);
    expect(stopped(v)).toBe(false);
  });
  it("once it is live (no wait) and nothing else is under way, the ordinary rules apply again", () => {
    expect(causes(blocked({ goLive: null }))).toEqual(["nothing"]);
  });
  it("the sweep tells the CEO of a slow wait but never the owner, and drops it when live", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Merged urgent");
    await ctx.db.update(tickets).set({ urgent: true, systemState: "blocked", goLiveWait: "server", goLiveWaitSince: ago(10 * MIN), lastActivityAt: ago(10 * MIN) }).where(eq(tickets.id, t.id));
    expect(await ctx.watch.run(true)).toMatchObject({ checked: 1, told: 0 });
    ctx.advance(3 * 60 * MIN);
    expect(await ctx.watch.run(true)).toMatchObject({ told: 1, ownerTold: 0 });
    expect(ctx.told[0]!.note).toContain("waiting for the server update");
    ctx.advance(OWNER_AFTER_MS + 5 * MIN);
    expect(await ctx.watch.run(true)).toMatchObject({ told: 0, ownerTold: 0 });
    expect(ctx.sent).toHaveLength(0);
    // Live: the wait is cleared and the ticket woken in progress; the watch finds it moving or done.
    await ctx.db.update(tickets).set({ goLiveWait: null, goLiveWaitSince: null, systemState: "done" }).where(eq(tickets.id, t.id));
    expect(await ctx.watch.run(true)).toMatchObject({ checked: 0, cleared: 1 });
  });
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(NOW.getTime() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string; number: number };
  const told: Array<{ ticketId: string; note: string }> = [];
  const sent: Array<{ id: string; title: string; body: string }> = [];
  const watch = priorityWatchService(db, {
    tellCeo: async ({ ticketId, note }) => void told.push({ ticketId, note }),
    notify: async (input) => {
      const row = await built.notes.notify(input);
      if (row) sent.push({ id: row.id, title: input.title, body: input.body });
      return row;
    },
    now: clock,
  });
  return { ...built, db, close, company, ticket, watch, told, sent, advance: (ms: number) => (offset += ms), clock };
}

describe("priority watch: the sweep", () => {
  it("tells the CEO once for a stop, the owner once 15 minutes later, and clears the owner's card when it moves", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Docker check worker");
    // The clock starts at NOW; the ticket's own activity timestamp is 10 minutes before it.
    await ctx.db.update(tickets).set({ urgent: true, systemState: "in_progress", lastActivityAt: ago(10 * MIN) }).where(eq(tickets.id, t.id));
    // Not urgent and not done: another ticket is never watched.
    await ctx.ticket("Ordinary work");

    expect(await ctx.watch.run(true)).toMatchObject({ checked: 1, told: 1, ownerTold: 0 });
    expect(ctx.told).toHaveLength(1);
    expect(ctx.told[0]!.note).toContain("nothing is under way");

    // Same stop, next pass: no second CEO wake, and the owner is not told yet.
    ctx.advance(5 * MIN);
    expect(await ctx.watch.run(true)).toMatchObject({ told: 0, ownerTold: 0 });
    expect(ctx.told).toHaveLength(1);

    // 15 minutes after the first alarm: the owner hears, once.
    ctx.advance(OWNER_AFTER_MS);
    expect(await ctx.watch.run(true)).toMatchObject({ ownerTold: 1 });
    ctx.advance(5 * MIN);
    expect(await ctx.watch.run(true)).toMatchObject({ ownerTold: 0 });
    expect(ctx.sent).toHaveLength(1);

    // A check job starts: the ticket is moving, the notification is read, and the stop is over.
    await ctx.db.insert(checkJobs).values({ companyId: ctx.company.id, projectId: (await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.projectId, ticketId: t.id, kind: "pre_review", commit: "abc", tree: "def", state: "running" });
    expect(await ctx.watch.run(true)).toMatchObject({ cleared: 1, told: 0 });
    const [n] = await ctx.db.select().from(notifications).where(eq(notifications.id, ctx.sent[0]!.id));
    expect(n!.readAt).not.toBeNull();
  });

  it("an urgent Ready ticket whose wake waits 30 minutes behind a busy agent wakes the CEO once, naming the agent, the run and the free foreground agents (BOS-1635)", async () => {
    ctx = await setup();
    const c = ctx;
    const [dylan] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Dylan", title: "Background Developer", role: "worker", agentKind: "claude" }).returning();
    await c.db.insert(agents).values({ companyId: c.company.id, name: "Ada", title: "Developer", role: "worker", agentKind: "claude" });
    await c.db.insert(agents).values({ companyId: c.company.id, name: "Bea", title: "Background Developer", role: "worker", agentKind: "claude" });
    const long = await c.ticket("Long low-priority job");
    const t = await c.ticket("Main's CI is failing");
    await c.db.update(tickets).set({ assigneeAgentId: dylan!.id }).where(eq(tickets.id, long.id));
    await c.db.update(tickets).set({ urgent: true, systemState: "ready", assigneeAgentId: dylan!.id, lastActivityAt: ago(MIN) }).where(eq(tickets.id, t.id));
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: dylan!.id, ticketId: long.id, startedAt: ago(100 * MIN) });
    const held = async (heldFor: number) => {
      await c.db.delete(wakes).where(eq(wakes.ticketId, t.id));
      await c.db.insert(wakes).values({ companyId: c.company.id, agentId: dylan!.id, ticketId: t.id, reason: "assigned", status: "queued", statusReason: HELD_AGENT, createdAt: ago(heldFor) });
    };
    // Held 29 minutes: not yet.
    await held(29 * MIN);
    await c.watch.run(true);
    expect(c.told.filter((x) => x.note.includes("is busy"))).toHaveLength(0);
    // Held 31 minutes: the CEO hears once, with the agent, the run, and the free foreground agent (not the background one).
    await held(31 * MIN);
    await c.watch.run(true);
    const heard = c.told.filter((x) => x.note.includes("is busy"));
    expect(heard).toHaveLength(1);
    expect(heard[0]!.note).toContain("Dylan is busy");
    expect(heard[0]!.note).toContain("Long low-priority job");
    expect(heard[0]!.note).toContain("Ada (Developer)");
    expect(heard[0]!.note).not.toContain("Bea");
    // Later passes on the same held wake say nothing more.
    c.advance(10 * MIN);
    await c.watch.run(true);
    expect(c.told.filter((x) => x.note.includes("is busy"))).toHaveLength(1);
  });

  it("a non-urgent ticket held behind a busy agent does not wake the CEO (BOS-1635)", async () => {
    ctx = await setup();
    const c = ctx;
    const [dylan] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Dylan", role: "worker", agentKind: "claude" }).returning();
    const t = await c.ticket("Ordinary work");
    await c.db.update(tickets).set({ systemState: "ready", assigneeAgentId: dylan!.id }).where(eq(tickets.id, t.id));
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: dylan!.id, ticketId: t.id, reason: "assigned", status: "queued", statusReason: HELD_AGENT, createdAt: ago(90 * MIN) });
    expect(await c.watch.run(true)).toMatchObject({ checked: 0, told: 0 });
  });

  it("a cut-off run is told to the CEO with the run's outcome, and a ticket with a live run is left alone", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Urgent thing");
    await ctx.db.update(tickets).set({ urgent: true, systemState: "in_progress", lastActivityAt: ago(MIN) }).where(eq(tickets.id, t.id));
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, ticketId: t.id, startedAt: ago(30 * MIN), endedAt: ago(2 * MIN), outcome: "interrupted" });
    await ctx.watch.run(true);
    expect(ctx.told).toHaveLength(1);
    expect(ctx.told[0]!.note).toContain("cut off (interrupted");
    ctx.told.length = 0;
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, ticketId: t.id, startedAt: ago(MIN) });
    expect(await ctx.watch.run(true)).toMatchObject({ told: 0, cleared: 1 });
  });
});
