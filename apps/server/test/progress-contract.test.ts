// BOS-314 (Arch fix 8): the progress contract. Silent runs are asked for a status and flagged,
// a review that ends without a verdict twice moves to another reviewer, a failed start is a card
// at once, and a cause left "likely / not proven" for hours is put in front of the CEO.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { DEFAULT_WATCHDOG, readWatchdogSettings, SENIOR_DEV_TEMPLATE } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, reviewRequests, runs, tickets, wakes } from "../src/db/schema.js";
import { REVIEW_REASON } from "../src/services/scheduler.js";
import { STATUS_REASON } from "../src/services/progress.js";
import { reviewAskPattern, reviewAskPrefix } from "../src/services/review-kinds.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined as never;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const hire = async (name: string, set: Partial<typeof agents.$inferInsert> = {}) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    if (Object.keys(set).length) await db.update(agents).set(set).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "in_progress", ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  /** A run that is still going and started `startedMinAgo` minutes ago. */
  const liveRun = async (ticketId: string, startedMinAgo: number, set: Partial<typeof runs.$inferInsert> = {}) =>
    (await db.insert(runs).values({ companyId: company.id, agentId: worker.id, ticketId, startedAt: new Date(Date.now() - startedMinAgo * MIN), lastEventAt: new Date(), ...set }).returning())[0]!;
  const statusWakes = (ticketId: string) => db.select().from(wakes).where(and(eq(wakes.ticketId, ticketId), eq(wakes.reason, STATUS_REASON)));
  const cards = (prefix: string) => db.select().from(decisions).where(like(decisions.dedupeKey, `${prefix}%`));
  return { ...built, db, close, req, company, worker, project, hire, ticket, liveRun, statusWakes, cards };
}

describe("progress contract settings", () => {
  it("defaults: 30 minutes to a status request, 60 to a flag, 2 hours for an unproven cause; on even with the watchdog off", () => {
    const s = readWatchdogSettings({});
    // On by default since BOS-762 (DR-041), but the progress contract runs whatever the switch says.
    expect(DEFAULT_WATCHDOG.enabled).toBe(true);
    expect(s).toMatchObject({ progressContract: true, silentSteerMinutes: 30, silentFlagMinutes: 60, unprovenHours: 2 });
    expect(readWatchdogSettings({ enabled: false })).toMatchObject({ enabled: false, progressContract: true });
  });
});

describe("last post time", () => {
  it("a ticket reply stamps the run and the ticket", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Fix it");
    const run = await ctx.liveRun(id, 5);
    await ctx.ticketChat.agentSays({ companyId: ctx.company.id, ticketId: id, agentId: ctx.worker.id, runId: run.id, text: "Status: halfway." });
    const [r] = await ctx.db.select().from(runs).where(eq(runs.id, run.id));
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, id));
    expect(r!.lastPostAt).not.toBeNull();
    expect(t!.lastPostAt).not.toBeNull();
  });
});

describe("silent working run", () => {
  it("steers a status request into a run after 30 minutes with no post, once", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Long job");
    await ctx.liveRun(id, 31);
    expect(await ctx.sweeps.run()).toMatchObject({ progress: { steered: 1 } });
    const w = await ctx.statusWakes(id);
    expect(w).toHaveLength(1);
    expect(w[0]!.note).toContain("status");
    await ctx.sweeps.run();
    expect(await ctx.statusWakes(id)).toHaveLength(1);
  });

  it("leaves a run alone that posted recently or started under 30 minutes ago", async () => {
    ctx = await setup();
    const posted = await ctx.ticket("Posted");
    await ctx.liveRun(posted, 90, { lastPostAt: new Date(Date.now() - 10 * MIN) });
    const fresh = await ctx.ticket("Fresh", { assigneeAgentId: (await ctx.hire("Other")).id });
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: (await ctx.db.select().from(tickets).where(eq(tickets.id, fresh)))[0]!.assigneeAgentId, ticketId: fresh, startedAt: new Date(Date.now() - 10 * MIN) });
    await ctx.sweeps.run();
    expect(await ctx.statusWakes(posted)).toHaveLength(0);
    expect(await ctx.statusWakes(fresh)).toHaveLength(0);
  });

  it("raises a Scrum Master flag after 60 minutes with no post, once, even with the watchdog off", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Very long job");
    const run = await ctx.liveRun(id, 61);
    expect(await ctx.sweeps.run()).toMatchObject({ progress: { flagged: 1 } });
    const [c] = await ctx.cards(`silent:${run.id}`);
    expect(c!.question).toContain("Very long job");
    await ctx.sweeps.run();
    expect(await ctx.cards(`silent:${run.id}`)).toHaveLength(1);
  });

  it("does nothing when the progress contract is switched off", async () => {
    ctx = await setup();
    await ctx.req("POST", "/api/companies", { name: "x" }).catch(() => undefined);
    await ctx.db.execute(`update companies set watchdog = '{"progressContract": false}'::jsonb`);
    const id = await ctx.ticket("Quiet allowed");
    await ctx.liveRun(id, 120);
    await ctx.sweeps.run();
    expect(await ctx.statusWakes(id)).toHaveLength(0);
  });
});

describe("a review that ends without a verdict twice", () => {
  it("moves to another reviewer and tells the CEO", async () => {
    ctx = await setup();
    const a = await ctx.hire("Reviewer A", { template: SENIOR_DEV_TEMPLATE });
    const b = await ctx.hire("Reviewer B", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Needs review", { systemState: "review" });
    const [req] = await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: a.id, round: 1, createdAt: new Date(Date.now() - 3 * 60 * MIN) }).returning();
    // Each run was woken after the review was asked and started after this round began (BOS-433).
    for (const ago of [150, 60]) {
      const [run] = await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: a.id, startedAt: new Date(Date.now() - ago * MIN + 60_000), endedAt: new Date(Date.now() - (ago - 10) * MIN), outcome: "end_turn" }).returning();
      await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: a.id, reason: REVIEW_REASON, status: "launched", runId: run!.id, note: `- ${id} "Needs review": x`, createdAt: new Date(Date.now() - ago * MIN + 120_000) });
    }
    expect(await ctx.sweeps.run()).toMatchObject({ progress: { reviewsMoved: 1 } });
    const [after] = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.id, req!.id));
    expect(after!.reviewerAgentId).toBe(b.id);
    expect(await ctx.cards(`review-silent:${req!.id}`)).toHaveLength(1);
  });

  it("leaves a review alone after one verdict-less run", async () => {
    ctx = await setup();
    const a = await ctx.hire("Reviewer A", { template: SENIOR_DEV_TEMPLATE });
    await ctx.hire("Reviewer B", { template: SENIOR_DEV_TEMPLATE });
    const id = await ctx.ticket("Needs review", { systemState: "review" });
    const [req] = await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: a.id, round: 1, createdAt: new Date(Date.now() - 3 * 60 * MIN) }).returning();
    const [run] = await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: a.id, startedAt: new Date(Date.now() - 60 * MIN), endedAt: new Date(Date.now() - 50 * MIN), outcome: "end_turn" }).returning();
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: a.id, reason: REVIEW_REASON, status: "launched", runId: run!.id, note: `- ${id} "Needs review": x` });
    await ctx.sweeps.run();
    const [after] = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.id, req!.id));
    expect(after!.reviewerAgentId).toBe(a.id);
  });
});

describe("a run that fails to start", () => {
  it("raises no card when the runner is offline: the wake waits for it, and the runner watch is the one alert (BOS-480)", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Start me");
    await ctx.scheduler.wake({ agentId: ctx.worker.id, ticketId: id, reason: "assigned" });
    await ctx.scheduler.tick();
    await ctx.scheduler.tick();
    expect(await ctx.cards("start-fail:")).toEqual([]);
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, id));
    expect(w).toMatchObject({ status: "queued", statusReason: "runner offline" });
  });
});

describe("a cause left unproven", () => {
  it("flags the CEO when an in-progress note says 'likely' for over 2 hours, once per note", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Mystery bug", { stateNote: "The cache is the likely cause, not proven.", stateNoteAt: new Date(Date.now() - 3 * 60 * MIN) });
    expect(await ctx.sweeps.run()).toMatchObject({ progress: { unproven: 1 } });
    const cards = await ctx.cards(`unproven:${id}`);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toMatch(/reassign|architect/i);
    await ctx.sweeps.run();
    expect(await ctx.cards(`unproven:${id}`)).toHaveLength(1);
  });

  it("ignores a recent note, a note without the words, and tickets not in progress", async () => {
    ctx = await setup();
    await ctx.ticket("Recent", { stateNote: "Likely the cache.", stateNoteAt: new Date(Date.now() - 30 * MIN) });
    await ctx.ticket("Proven", { stateNote: "Cause confirmed: the cache.", stateNoteAt: new Date(Date.now() - 5 * 60 * MIN) });
    await ctx.ticket("In review", { systemState: "review", stateNote: "Unconfirmed.", stateNoteAt: new Date(Date.now() - 5 * 60 * MIN) });
    expect(await ctx.sweeps.run()).toMatchObject({ progress: { unproven: 0 } });
  });
});

describe("the review wake note format", () => {
  it("names the ticket so the progress sweep's match keeps working if the note changes", () => {
    expect(reviewAskPrefix("abc-123")).toBe("- abc-123 ");
    expect(reviewAskPattern("abc-123")).toBe("- abc-123 %");
    const note = `${reviewAskPrefix("abc-123")}"Needs review": half done`;
    expect(note).toContain(reviewAskPrefix("abc-123"));
  });
});
