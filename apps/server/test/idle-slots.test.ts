// BOS-574 (DR-029): after a restart or an update, and whenever run slots are free, Boss Man wakes
// the agents with in-progress work by itself, and leaves alone the ones that are waiting on something.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, deploys, deployTargets, reviewRequests, runnerEvents, runners, runs, settings, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { CARRY_ON_NOTE, IDLE_AGENTS_REASON, IDLE_SLOT_REASON, URGENT_IDLE_REASON } from "../src/services/scheduler.js";
import type { SweepLimits } from "../src/services/sweeps.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(sweepLimits?: Partial<SweepLimits>) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", ...(sweepLimits ? { sweepLimits } : {}) });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  // A registered runner that is not connected: the server can't reach it.
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const hire = async (name: string) => (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
  /** An in-progress ticket, assigned straight in the database, quiet for `quietMs`. */
  const working = async (title: string, agentId: string, quietMs = 15 * MIN, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: agentId, systemState: "in_progress", lastActivityAt: new Date(Date.now() - quietMs), ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  /** A run on the ticket that is still going (or ended `endedAgoMs` ago with `outcome`). */
  const run = async (agentId: string, ticketId: string, o: { endedAgoMs?: number; outcome?: string; lastEventAgoMs?: number } = {}) => {
    const [r] = await db
      .insert(runs)
      .values({
        companyId: company.id,
        agentId,
        ticketId,
        startedAt: new Date(Date.now() - 60 * MIN),
        lastEventAt: o.lastEventAgoMs != null ? new Date(Date.now() - o.lastEventAgoMs) : null,
        endedAt: o.endedAgoMs != null ? new Date(Date.now() - o.endedAgoMs) : null,
        outcome: o.outcome ?? null,
      })
      .returning();
    return r!;
  };
  const wakesOf = (reason: string) => db.select().from(wakes).where(eq(wakes.reason, reason));
  const flush = () => new Promise((r) => setTimeout(r, 150));
  return { ...built, db, close, req, company, project, runnerId: reg.runnerId, emit, hire, working, run, wakesOf, flush };
}

describe("re-waking runs a restart cut off (BOS-574)", () => {
  it("a runner restart with 3 interrupted runs gives 3 resume wakes, each on its own ticket", async () => {
    const c = (ctx = await setup());
    const cut: Array<{ agentId: string; ticketId: string; runId: string }> = [];
    for (const name of ["Ann", "Bob", "Cat"]) {
      const a = await c.hire(name);
      const ticketId = await c.working(`${name}'s ticket`, a.id, 0);
      const r = await c.run(a.id, ticketId, { lastEventAgoMs: MIN });
      cut.push({ agentId: a.id, ticketId, runId: r.id });
    }
    // What a restarted runner sends for each run its last process left unfinished (R42).
    for (const x of cut) await c.emit({ type: "run.ended", runId: x.runId, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    await c.flush();
    const resumes = await c.wakesOf("resume");
    expect(resumes.map((w) => ({ agentId: w.agentId, ticketId: w.ticketId, resumeRunId: w.resumeRunId })).sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual(
      cut.map((x) => ({ agentId: x.agentId, ticketId: x.ticketId, resumeRunId: x.runId })).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
    for (const w of resumes) expect(w.note).toMatch(/interrupted when the runner restarted/);
  });

  it("a run the server closes because its runner went offline is resumed too; one a person stopped is not", async () => {
    const c = (ctx = await setup());
    const a = await c.hire("Ann");
    const b = await c.hire("Bob");
    const lostTicket = await c.working("Lost one", a.id, 0);
    const lost = await c.run(a.id, lostTicket, { lastEventAgoMs: 50 * MIN });
    const stoppedTicket = await c.working("Stopped one", b.id, 0);
    const stopped = await c.run(b.id, stoppedTicket, { lastEventAgoMs: MIN });
    // The owner stops Bob's run while the runner is offline: nobody can confirm, so the server ends it.
    expect(await c.runs.cancel(stopped.id)).toMatchObject({ endedHere: true });
    // A deploy's run lost the same way is not picked up: its deploy fails, and only a new approval restarts it (BOS-480).
    const d = await c.hire("Deployer");
    const deployTicket = await c.working("Deploy it", d.id, 0);
    const deployRun = await c.run(d.id, deployTicket, { lastEventAgoMs: 50 * MIN });
    const [target] = await c.db.insert(deployTargets).values({ companyId: c.company.id, name: "Site", kind: "ssh", endpoint: "deploy@example.invalid" }).returning();
    const [deploy] = await c.db.insert(deploys).values({ companyId: c.company.id, targetId: target!.id, ref: "main" }).returning();
    await c.db.insert(wakes).values({ companyId: c.company.id, agentId: d.id, ticketId: deployTicket, reason: "deploy approved", status: "launched", runId: deployRun.id, deployId: deploy!.id });

    await c.sweeps.run();
    await c.flush();
    expect((await c.db.select().from(runs).where(eq(runs.id, lost.id)))[0]!.outcome).toBe("lost: runner offline");
    const resumes = await c.wakesOf("resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ agentId: a.id, ticketId: lostTicket, resumeRunId: lost.id });
    expect(resumes[0]!.note).toMatch(/cut off when the runner went offline/);
  });

  it("when an update's hold lifts, the agents that ended their runs for it are woken on their tickets, with why", async () => {
    const c = (ctx = await setup());
    const [ann, bob, cat, dan] = [await c.hire("Ann"), await c.hire("Bob"), await c.hire("Cat"), await c.hire("Dan")];
    const annT = await c.working("Ann wraps up", ann.id, 0);
    const bobT = await c.working("Bob booked a check", bob.id, 0);
    const catT = await c.working("Cat is blocked", cat.id, 0);
    const danT = await c.working("Dan was cut off", dan.id, 0);
    const blocker = await c.working("Blocker", bob.id, 0, { systemState: "ready" });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: catT, blockerTicketId: blocker });
    const live = { ann: await c.run(ann.id, annT, { lastEventAgoMs: MIN }), bob: await c.run(bob.id, bobT, { lastEventAgoMs: MIN }), cat: await c.run(cat.id, catT, { lastEventAgoMs: MIN }), dan: await c.run(dan.id, danT, { lastEventAgoMs: MIN }) };

    await c.maintenance.start({ minutes: 30 });
    // Ann updates her ticket and ends her turn, as WRAP_UP asks: Boss Man sets its 15-minute carry-on.
    await c.db.update(tickets).set({ stateNote: "Committed; stopping for the update", stateNoteAt: new Date() }).where(eq(tickets.id, annT));
    await c.emit({ type: "run.ended", runId: live.ann.id, stopReason: "end_turn", error: null });
    // Bob books his own check first; Cat just stops; Dan's run is cut off by the swap.
    await c.db.update(tickets).set({ monitorAt: new Date(Date.now() + 30 * MIN), monitorNote: "quick check in the queue" }).where(eq(tickets.id, bobT));
    await c.emit({ type: "run.ended", runId: live.bob.id, stopReason: "end_turn", error: null });
    await c.emit({ type: "run.ended", runId: live.cat.id, stopReason: "end_turn", error: null });
    await c.emit({ type: "run.ended", runId: live.dan.id, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    await c.flush();
    expect((await c.db.select().from(tickets).where(eq(tickets.id, annT)))[0]!.monitorNote).toBe(CARRY_ON_NOTE);
    // Nothing is woken while the hold is on, other than Dan's resume (held in the queue).
    expect((await c.wakesOf("resume")).map((w) => w.ticketId)).toEqual([danT]);

    await c.maintenance.cancel();
    const resumes = await c.wakesOf("resume");
    expect(resumes.map((w) => w.ticketId).sort()).toEqual([annT, danT].sort());
    const annWake = resumes.find((w) => w.ticketId === annT)!;
    expect(annWake).toMatchObject({ agentId: ann.id, resumeRunId: null });
    expect(annWake.note).toMatch(/runner update asked every agent to stop/);
    // Ann's carry-on is replaced by the wake; Bob keeps the check he booked.
    expect((await c.db.select().from(tickets).where(eq(tickets.id, annT)))[0]!.monitorAt).toBeNull();
    expect((await c.db.select().from(tickets).where(eq(tickets.id, bobT)))[0]!.monitorNote).toBe("quick check in the queue");
  });
});

describe("free run slots go to idle in-progress work (BOS-574)", () => {
  it("wakes an idle agent with an in-progress ticket into a free slot, before missed work would", async () => {
    const c = (ctx = await setup());
    const a = await c.hire("Ann");
    const t = await c.working("Quiet for 15 minutes", a.id, 15 * MIN);
    await c.run(a.id, t, { endedAgoMs: 15 * MIN, lastEventAgoMs: 15 * MIN, outcome: "end_turn" });
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 1 }, missedWork: { woken: 0 } });
    const [w] = await c.wakesOf(IDLE_SLOT_REASON);
    expect(w).toMatchObject({ agentId: a.id, ticketId: t, priority: 1, status: "queued" });
    expect(w!.note).toMatch(/A run slot is free/);
    expect(w!.note).toMatch(/call schedule_check/);
    // It waits in the queue, so the next pass doesn't add another.
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 0 } });
    // Once that run is over, the ticket isn't woken again within the hour.
    await c.db.update(wakes).set({ status: "launched" }).where(eq(wakes.reason, IDLE_SLOT_REASON));
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 0 } });
  });

  it("leaves alone blocked tickets, booked checks, the check line, stopped runs, recent work and live runs", async () => {
    const c = (ctx = await setup());
    // Room for everyone, so only the rules below decide.
    await c.db.insert(settings).values({ key: "run_limits", value: { instance: 20, company: 20 } });
    const names = ["Blocked", "Booked", "Checking", "Stopped", "Recent", "Running", "Failed"];
    const who: Record<string, string> = {};
    for (const n of names) who[n] = (await c.hire(n)).id;
    const blockedT = await c.working("Blocked", who.Blocked!);
    const blocker = await c.working("Its blocker", who.Blocked!, 0, { systemState: "ready", assigneeAgentId: null });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: blockedT, blockerTicketId: blocker });
    await c.working("Booked", who.Booked!, 15 * MIN, { monitorAt: new Date(Date.now() + 20 * MIN), monitorNote: "CI" });
    // Checking: its last run started the quick check in the shared queue, then ended its turn.
    const checkingT = await c.working("Checking", who.Checking!);
    const checkRun = await c.run(who.Checking!, checkingT, { endedAgoMs: 15 * MIN, lastEventAgoMs: 15 * MIN, outcome: "end_turn" });
    await c.db.insert(runnerEvents).values({ runnerId: c.runnerId, seq: 1, type: "run.update", occurredAt: new Date(Date.now() - 16 * MIN), payload: { type: "run.update", runId: checkRun.id, update: { kind: "tool_call", status: "in_progress", title: "Run the quick check", rawInput: { command: "setsid nohup scripts/check-quick.sh > q.log 2>&1 &" } } } });
    const stoppedT = await c.working("Stopped", who.Stopped!);
    await c.run(who.Stopped!, stoppedT, { endedAgoMs: 15 * MIN, lastEventAgoMs: 15 * MIN, outcome: "cancelled" });
    const recentT = await c.working("Recent", who.Recent!);
    await c.run(who.Recent!, recentT, { endedAgoMs: 2 * MIN, lastEventAgoMs: 2 * MIN, outcome: "end_turn" });
    const runningT = await c.working("Running", who.Running!);
    await c.run(who.Running!, runningT, { lastEventAgoMs: MIN });
    const failedT = await c.working("Failed", who.Failed!);
    await c.run(who.Failed!, failedT, { endedAgoMs: 15 * MIN, lastEventAgoMs: 15 * MIN, outcome: "error: model overloaded" });

    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 0 } });
    expect(await c.wakesOf(IDLE_SLOT_REASON)).toEqual([]);

    // The blocker finishing frees the blocked ticket, and it gets the slot.
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, blocker));
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 1 } });
    expect((await c.wakesOf(IDLE_SLOT_REASON)).map((w) => w.ticketId)).toEqual([blockedT]);
  });

  it("fills only the free slots, urgent first, and nothing while an update hold is on", async () => {
    const c = (ctx = await setup());
    // Company limit 4 keeps one slot for cards, and one run is going: 2 free.
    await c.db.insert(settings).values({ key: "run_limits", value: { instance: 10, company: 4 } });
    const busy = await c.hire("Busy");
    await c.run(busy.id, await c.working("Being worked", busy.id, 0), { lastEventAgoMs: MIN });
    const ids: Record<string, string> = {};
    for (const [n, quiet, urgent] of [["Oldest", 25, false], ["Newer", 12, false], ["Urgent", 11, true]] as const) {
      const a = await c.hire(n);
      ids[n] = await c.working(n, a.id, quiet * MIN, { urgent });
    }
    // The update hold: no slot is free while nothing can start.
    await c.maintenance.start({ minutes: 30 });
    expect(await c.scheduler.freeSlots(c.company.id)).toBe(0);
    await c.db.delete(settings).where(eq(settings.key, "maintenance"));

    expect(await c.scheduler.freeSlots(c.company.id)).toBe(2);
    // urgentIdle may take the urgent one first; either way it holds one of the two slots.
    const result = await c.sweeps.run();
    expect(result.idleSlots.woken + result.urgentIdle.woken).toBe(2);
    const all = await c.db.select().from(wakes).where(and(eq(wakes.status, "queued")));
    // Other sweeps after this one (a status check on the busy run, the CEO's card wake) are not slot fillers.
    const woken = all.filter((w) => w.reason === IDLE_SLOT_REASON || w.reason === URGENT_IDLE_REASON).map((w) => w.ticketId).sort();
    expect(woken).toEqual([ids.Urgent!, ids.Oldest!].sort());
    expect(await c.scheduler.freeSlots(c.company.id)).toBe(0);
  });

  it("never takes a slot from a wake already held at the limit: that wake gets the next free slot", async () => {
    const c = (ctx = await setup());
    // A connected runner that accepts every command, so a wake that has room really starts.
    c.runners.connect(c.runnerId, () => true);
    // Company limit 4 keeps one slot for cards: three runs fill it.
    await c.db.insert(settings).values({ key: "run_limits", value: { instance: 10, company: 4 } });
    const busy: string[] = [];
    for (const n of ["Busy 1", "Busy 2", "Busy 3"]) {
      const a = await c.hire(n);
      busy.push((await c.run(a.id, await c.working(n, a.id, 0), { lastEventAgoMs: MIN })).id);
    }
    // Another company's message has waited 18 hours (the HolidayHours case, 6 Nov).
    const ceo = await c.hire("Gandalf");
    const [held] = await c.db.insert(wakes).values({ companyId: c.company.id, agentId: ceo.id, reason: "engagement", note: "Engagement: the server is back", createdAt: new Date(Date.now() - 18 * 60 * MIN) }).returning();
    // And an idle in-progress ticket the filler would otherwise wake.
    const idle = await c.hire("Idle");
    await c.working("Idle work", idle.id, 25 * MIN);

    await c.scheduler.tickOnce();
    expect((await c.db.select().from(wakes).where(eq(wakes.id, held!.id)))[0]).toMatchObject({ status: "queued", statusReason: "at a concurrency limit" });
    expect(await c.scheduler.freeSlots(c.company.id)).toBe(0);
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 0 } });

    // That sweep also raised a card for the CEO about the hour-long runs; someone waits on it, so it goes first.
    const [card] = await c.wakesOf("decision");
    expect(card).toMatchObject({ status: "queued" });

    // Two runs end: the slots they free go to the card and to the held wake, none to a new filler.
    for (const id of busy.slice(0, 2)) await c.emit({ type: "run.ended", runId: id, stopReason: "end_turn", error: null });
    await c.flush();
    expect(await c.scheduler.freeSlots(c.company.id)).toBe(0);
    await c.scheduler.tickOnce();
    expect((await c.db.select().from(wakes).where(eq(wakes.id, card!.id)))[0]!.status).toBe("launched");
    expect((await c.db.select().from(wakes).where(eq(wakes.id, held!.id)))[0]!.status).toBe("launched");
    expect(await c.wakesOf(IDLE_SLOT_REASON)).toEqual([]);
  });
});

describe("free run slots offer idle agents their next ticket (BOS-615)", () => {
  /** Ann's only work sits in review. The company came with its CEO. */
  async function team(c: Awaited<ReturnType<typeof setup>>) {
    const ann = await c.hire("Ann");
    const [gandalf] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.role, "ceo")));
    const inReview = await c.working("Ann's finished work", ann.id, 40 * MIN, { systemState: "review" });
    await c.run(ann.id, inReview, { endedAgoMs: 40 * MIN, lastEventAgoMs: 40 * MIN, outcome: "end_turn" });
    return { ann, gandalf, inReview };
  }

  it("an agent whose work is all in review is started on its assigned ready ticket within one sweep", async () => {
    const c = (ctx = await setup());
    const { ann } = await team(c);
    // Assigned and ready, quiet for 15 minutes: missed work would wait half an hour for it.
    const next = await c.working("Ann's next up", ann.id, 15 * MIN, { systemState: "ready" });
    // An unassigned ticket the CEO could hand out, so the CEO would be asked if Ann were left out.
    await c.working("Unassigned", ann.id, 0, { systemState: "backlog", assigneeAgentId: null });
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { woken: 0, ready: 1, asked: 0 }, missedWork: { woken: 0 } });
    const [w] = await c.wakesOf(IDLE_SLOT_REASON);
    expect(w).toMatchObject({ agentId: ann.id, ticketId: next, priority: 1, status: "queued" });
    expect(w!.note).toMatch(/ready, which makes it your next up/);
    // Ann now has a waiting wake, so she is not idle: neither tier offers her anything more.
    expect(await c.sweeps.run()).toMatchObject({ idleSlots: { ready: 0, asked: 0 } });
    expect(await c.wakesOf(IDLE_AGENTS_REASON)).toEqual([]);
  });

  it("an idle agent with nothing ready gets the CEO one wake naming them, with the unassigned work; not a reviewer who owes a review", async () => {
    const c = (ctx = await setup({ mergeLineLongAt: 0 }));
    const { ann, gandalf, inReview } = await team(c);
    const rex = await c.hire("Rex");
    await c.db.insert(reviewRequests).values({ ticketId: inReview, kind: "code", reviewerAgentId: rex.id, round: 1 });
    await c.working("Important code work", ann.id, 0, { systemState: "backlog", assigneeAgentId: null, urgent: true });
    await c.working("Write up the research", ann.id, 0, { systemState: "backlog", assigneeAgentId: null, noCode: true });
    const result = await c.sweeps.run();
    expect(result.idleSlots).toMatchObject({ woken: 0, ready: 0, asked: 1 });
    const asks = await c.wakesOf(IDLE_AGENTS_REASON);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ agentId: gandalf!.id, ticketId: null, priority: 1 });
    const note = asks[0]!.note!;
    expect(note).toMatch(/^\d+ run slots are free and an agent has nothing to work on/);
    expect(note).toContain("- Ann (worker)");
    expect(note).not.toContain("Rex");
    expect(note).not.toContain(gandalf!.name);
    // One ticket waits to merge, past the (test) limit of 0: the no-code ticket is listed before the urgent one.
    expect(note).toContain("no-code first: 1 tickets wait to merge");
    expect(note.indexOf("Write up the research")).toBeLessThan(note.indexOf("Important code work"));
    expect(note).toMatch(/assign_ticket/);

    // Not again within the half hour, nor after it while the list is the same.
    expect((await c.sweeps.run()).idleSlots).toMatchObject({ asked: 0 });
    await c.db.update(wakes).set({ status: "launched", createdAt: new Date(Date.now() - 31 * MIN) }).where(eq(wakes.reason, IDLE_AGENTS_REASON));
    expect((await c.sweeps.run()).idleSlots).toMatchObject({ asked: 0 });
    // Rex's review is done and he is idle too: the list changed, so the CEO is asked again.
    await c.db.update(reviewRequests).set({ status: "approved", decidedAt: new Date() }).where(eq(reviewRequests.reviewerAgentId, rex.id));
    expect((await c.sweeps.run()).idleSlots).toMatchObject({ asked: 1 });
    const [latest] = (await c.wakesOf(IDLE_AGENTS_REASON)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(latest!.note).toContain("- Rex (worker)");
  });

  it("offers nothing while no run slot is free", async () => {
    const c = (ctx = await setup());
    // Company limit 4 keeps one slot for cards: three live runs fill it.
    await c.db.insert(settings).values({ key: "run_limits", value: { instance: 10, company: 4 } });
    for (const n of ["Busy 1", "Busy 2", "Busy 3"]) {
      const a = await c.hire(n);
      await c.run(a.id, await c.working(n, a.id, 0), { lastEventAgoMs: MIN });
    }
    const { ann } = await team(c);
    await c.working("Ann's next up", ann.id, 15 * MIN, { systemState: "ready" });
    await c.working("Unassigned", ann.id, 0, { systemState: "backlog", assigneeAgentId: null });
    expect(await c.scheduler.freeSlots(c.company.id)).toBe(0);
    expect((await c.sweeps.run()).idleSlots).toMatchObject({ woken: 0, ready: 0, asked: 0 });
    expect(await c.wakesOf(IDLE_SLOT_REASON)).toEqual([]);
    expect(await c.wakesOf(IDLE_AGENTS_REASON)).toEqual([]);
  });
});
