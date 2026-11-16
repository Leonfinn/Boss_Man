// BOS-582 (DR-032): fair share at the all-companies run limit. When a slot frees, a company with
// nothing running gets it ahead of a busy company, even ahead of the busy company's cards; the busy
// company's card gets the slot after that. Each company's own limits still hold, and server_status
// says which limit a wake is held by.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, runs, settings, wakes } from "../src/db/schema.js";
import { fairOrder, HELD_ALL_COMPANIES, HELD_COMPANY } from "../src/services/fair-share.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

/** Two companies, each with a connected runner that accepts every command, under the given run limits. */
async function setup(limits: { instance: number; company: number }) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (url: string, payload?: object) => built.app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const company = async (name: string) => {
    const { company } = (await req("/api/companies", { name })).json() as { company: { id: string } };
    const { runnerId } = (await req(`/api/companies/${company.id}/runner`)).json() as { runnerId: string };
    built.runners.connect(runnerId, () => true);
    return company.id;
  };
  const A = await company("Busy Co");
  const B = await company("Idle Co");
  await db.insert(settings).values({ key: "run_limits", value: limits });
  const hire = async (companyId: string, name: string) => ((await req(`/api/companies/${companyId}/agents`, { name })).json() as { id: string }).id;
  /** An agent of the company with a work run going. */
  const running = async (companyId: string, name: string) => {
    const agentId = await hire(companyId, name);
    const [r] = await db.insert(runs).values({ companyId, agentId, startedAt: new Date(Date.now() - 30 * MIN), lastEventAt: new Date() }).returning();
    return r!.id;
  };
  /** A queued wake for a new agent of the company, `agoMin` minutes old. */
  const queued = async (companyId: string, name: string, reason: string, agoMin: number) => {
    const agentId = await hire(companyId, name);
    const [w] = await db.insert(wakes).values({ companyId, agentId, reason, note: `${name}: ${reason}`, createdAt: new Date(Date.now() - agoMin * MIN) }).returning();
    return w!;
  };
  const end = (runId: string) => db.update(runs).set({ endedAt: new Date(), outcome: "end_turn" }).where(eq(runs.id, runId));
  const wake = async (id: string) => (await db.select().from(wakes).where(eq(wakes.id, id)))[0]!;
  const live = async (companyId: string) => (await db.select().from(runs).where(and(eq(runs.companyId, companyId), isNull(runs.endedAt)))).length;
  // Only the wakes each test queues: company setup's own wakes would compete for the same slots.
  const clearWakes = () => db.delete(wakes);
  return { ...built, db, close, cookie, A, B, hire, running, queued, end, wake, live, clearWakes };
}

describe("a server update waiting for a quiet machine caps runs (BOS-420)", () => {
  it("caps the all-companies limit while the wait is on; runs going are not cut off, and the cap lifts with it", async () => {
    const c = (ctx = await setup({ instance: 8, company: 8 }));
    for (const n of ["A1", "A2", "A3"]) await c.running(c.A, n);
    await c.clearWakes();
    await c.db.insert(settings).values({ key: "deploy_wait", value: { phase: "waiting", approvedAt: new Date().toISOString() } });
    const w = await c.queued(c.A, "A4", "check due", 5);
    expect((await c.serverStatus.status(c.A)).runLimits).toMatchObject({ allCompanies: { limit: 3, running: 3 } });
    expect(await c.scheduler.tickOnce()).toMatchObject({ launched: 0 });
    expect(await c.live(c.A)).toBe(3); // nothing was stopped
    expect((await c.wake(w.id)).status).toBe("queued");
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    expect((await c.serverStatus.status(c.A)).runLimits).toMatchObject({ allCompanies: { limit: 8 } });
    expect(await c.scheduler.tickOnce()).toMatchObject({ launched: 1 });
  });

  // BOS-1634: the owner saw 16 in Settings while 3 were enforced, with nothing saying why.
  it("saved 16: in force 16 with no hold; during a hold server_status and Settings show 3, the saved 16 and the reason", async () => {
    const c = (ctx = await setup({ instance: 16, company: 12 }));
    const settingsView = async () => (await c.app.inject({ method: "GET", url: "/api/run-limits", headers: { cookie: c.cookie } })).json();

    expect((await c.serverStatus.status(c.A)).runLimits).toEqual({ allCompanies: { limit: 16, running: 0, saved: 16 }, company: { limit: 12, running: 0 } });
    expect(await settingsView()).toMatchObject({ instance: 16, inForce: { limit: 16, saved: 16, because: null, until: null } });

    const approvedAt = new Date();
    await c.db.insert(settings).values({ key: "deploy_wait", value: { phase: "waiting", approvedAt: approvedAt.toISOString() } });
    const until = new Date(approvedAt.getTime() + 3 * 60 * MIN).toISOString();
    expect((await c.serverStatus.status(c.A)).runLimits).toMatchObject({
      allCompanies: { limit: 3, saved: 16, cappedBecause: expect.stringContaining("a server update is waiting for a quiet machine"), cappedUntil: until },
      company: { limit: 12 },
    });
    expect(await settingsView()).toMatchObject({ instance: 16, inForce: { limit: 3, saved: 16, because: expect.stringContaining("at most 3 runs"), until } });
  });

  it("a hold that would not lower the saved number reports no cap", async () => {
    const c = (ctx = await setup({ instance: 2, company: 2 }));
    await c.db.insert(settings).values({ key: "deploy_wait", value: { phase: "window", approvedAt: new Date().toISOString() } });
    expect((await c.serverStatus.status(c.A)).runLimits).toEqual({ allCompanies: { limit: 2, running: 0, saved: 2 }, company: { limit: 2, running: 0 } });
  });
});

describe("fair share at the all-companies run limit (BOS-582)", () => {
  it("an idle company's wake gets the next free slot ahead of a busy company's card; the card gets the one after", async () => {
    const c = (ctx = await setup({ instance: 4, company: 4 }));
    const aRuns: string[] = [];
    for (const n of ["A1", "A2", "A3", "A4"]) aRuns.push(await c.running(c.A, n));
    await c.clearWakes();
    // Busy Co: a card someone waits on, and a booked check. Idle Co: one message, newer than both.
    const card = await c.queued(c.A, "A card", "decision", 30);
    const check = await c.queued(c.A, "A check", "check due", 20);
    const msg = await c.queued(c.B, "B CEO", "engagement", 1);

    // The server is full: nothing starts, and each wake says which limit holds it.
    expect(await c.scheduler.tickOnce()).toMatchObject({ launched: 0 });
    expect((await c.wake(card.id)).statusReason).toBe(HELD_COMPANY);
    expect((await c.wake(msg.id)).statusReason).toBe(HELD_ALL_COMPANIES);
    // server_status shows it to Idle Co's CEO, with the limits and counts (no other company's names).
    const status = await c.serverStatus.status(c.B);
    expect(status.wakes.waiting.find((w) => w.id === msg.id)?.held).toBe("at a concurrency limit: all companies");
    expect(status.runLimits).toEqual({ allCompanies: { limit: 4, running: 4, saved: 4 }, company: { limit: 4, running: 0 } });

    // One slot frees (the one kept for cards): Idle Co gets it.
    await c.end(aRuns[0]!);
    await c.scheduler.tickOnce();
    expect((await c.wake(msg.id)).status).toBe("launched");
    expect(await c.wake(card.id)).toMatchObject({ status: "queued", statusReason: HELD_ALL_COMPANIES });
    expect(await c.live(c.B)).toBe(1);

    // The next slot goes to Busy Co's card; its booked check still waits for a slot past the card's.
    await c.end(aRuns[1]!);
    await c.scheduler.tickOnce();
    expect((await c.wake(card.id)).status).toBe("launched");
    expect((await c.wake(check.id)).status).toBe("queued");
  });

  it("no company is starved: after the idle company's first run starts, the busy company's card is next, not the idle company's second wake", async () => {
    const c = (ctx = await setup({ instance: 4, company: 4 }));
    const aRuns: string[] = [];
    for (const n of ["A1", "A2", "A3", "A4"]) aRuns.push(await c.running(c.A, n));
    await c.clearWakes();
    const card = await c.queued(c.A, "A card", "decision", 30);
    const first = await c.queued(c.B, "B CEO", "engagement", 60);
    const second = await c.queued(c.B, "B dev", "nudge", 50);

    await c.end(aRuns[0]!);
    await c.scheduler.tickOnce();
    expect((await c.wake(first.id)).status).toBe("launched");
    // Idle Co now has a run: its second wake competes in the normal order, and the card goes first.
    expect((await c.wake(second.id)).status).toBe("queued");
    expect((await c.wake(card.id)).status).toBe("queued");

    await c.end(aRuns[1]!);
    await c.scheduler.tickOnce();
    expect((await c.wake(card.id)).status).toBe("launched");
    expect((await c.wake(second.id)).status).toBe("queued");
  });

  it("an idle company's wake held by its own limits doesn't hold the slot: the busy company's card takes it", async () => {
    const c = (ctx = await setup({ instance: 4, company: 4 }));
    const aRuns: string[] = [];
    for (const n of ["A1", "A2", "A3", "A4"]) aRuns.push(await c.running(c.A, n));
    await c.clearWakes();
    const card = await c.queued(c.A, "A card", "decision", 30);
    const msg = await c.queued(c.B, "B CEO", "engagement", 60);
    // Its agent is paused: the wake stays held whatever the slots.
    await c.db.update(agents).set({ paused: true }).where(eq(agents.id, msg.agentId));

    await c.end(aRuns[0]!);
    await c.scheduler.tickOnce();
    expect(await c.wake(msg.id)).toMatchObject({ status: "queued", statusReason: "agent paused" });
    expect((await c.wake(card.id)).status).toBe("launched");
  });

  it("the idle-slot filler gives a company with nothing running or waiting one slot, within its own limit", async () => {
    const c = (ctx = await setup({ instance: 4, company: 4 }));
    for (const n of ["A1", "A2", "A3", "A4"]) await c.running(c.A, n);
    await c.clearWakes();
    await c.queued(c.A, "A card", "decision", 30);
    await c.queued(c.A, "A check", "check due", 20);
    // Busy Co's runs and queue fill the server, but Idle Co still gets one.
    expect(await c.scheduler.freeSlots(c.A)).toBe(0);
    expect(await c.scheduler.freeSlots(c.B)).toBe(1);
    // Once it has a wake waiting, it isn't idle: nothing more.
    await c.queued(c.B, "B CEO", "engagement", 1);
    expect(await c.scheduler.freeSlots(c.B)).toBe(0);
  });

  it("counts only wakes that could start now: not one whose agent is already running, held until later, or held by the quota (BOS-667)", async () => {
    const c = (ctx = await setup({ instance: 10, company: 10 }));
    const busy: string[] = [];
    for (const n of ["A1", "A2", "A3"]) busy.push(await c.running(c.A, n));
    await c.clearWakes();
    const [first] = await c.db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, busy[0]!));
    const later = new Date(Date.now() + 60 * MIN);
    // A review wake for a reviewer who is mid-run: it starts in the slot that run frees, not a new one.
    await c.db.insert(wakes).values({ companyId: c.A, agentId: first!.agentId!, reason: "review requested", note: "review" });
    await c.db.insert(wakes).values({ companyId: c.A, agentId: first!.agentId!, reason: "nudge", note: "and a nudge" });
    // Held until later (quiet hours), and held by the quota: neither can start now.
    const quiet = await c.queued(c.A, "A quiet", "check due", 5);
    await c.db.update(wakes).set({ status: "deferred", statusReason: "quiet hours", notBefore: later }).where(eq(wakes.id, quiet.id));
    const quota = await c.queued(c.A, "A quota", "missed work", 5);
    await c.db.update(wakes).set({ status: "deferred", statusReason: "subscription 5-hour window nearly used up", notBefore: later }).where(eq(wakes.id, quota.id));
    // One wake that really will take a slot: an idle agent's.
    await c.queued(c.A, "A next", "nudge", 1);
    // 10, less the one kept for cards, less 3 runs and the one startable wake. Before, every queued or held wake took a slot (1).
    expect(await c.scheduler.freeSlots(c.A)).toBe(5);
  });
});

describe("fairOrder", () => {
  it("puts an idle company's best wake first, keeps chats in place, and re-asks after every wake", () => {
    const busy = new Set(["A"]);
    const q = [
      { id: "a-card", companyId: "A" },
      { id: "b-chat", companyId: "B", chat: true },
      { id: "b-1", companyId: "B" },
      { id: "b-2", companyId: "B" },
      { id: "a-2", companyId: "A" },
    ];
    const order: string[] = [];
    for (const w of fairOrder(q, (id) => !busy.has(id), (w) => !!w.chat)) {
      order.push(w.id);
      // b-1 starts, so Idle Co is busy from here on.
      if (w.id === "b-1") busy.add("B");
    }
    expect(order).toEqual(["b-1", "a-card", "b-chat", "b-2", "a-2"]);
  });
});
