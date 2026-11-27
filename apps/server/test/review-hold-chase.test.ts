// BOS-2870: a reviewer's hold whose wait is done must never sit silently. BOS-2713 stayed held by the CEO for 22 hours
// after BOS-2663 merged: the holder had one wake, and nothing looked again. These tests drive the real sweep pass.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SENIOR_DEV_TEMPLATE, type WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, reviewHolds, reviewRequests, tickets, wakes } from "../src/db/schema.js";
import { HOLD_ESCALATE_MS, HOLD_REMIND_MS, holdView } from "../src/services/review-holds.js";

const MIN = 60_000;
const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add it" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+x", truncated: false };

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined as never;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/site.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: DIFF }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "d".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "none" } }));
    return true;
  }, ["carried-check"]);
  const hire = async (name: string) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    await db.update(agents).set({ template: SENIOR_DEV_TEMPLATE }).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const reviewer = await hire("Reviewer");
  const ticket = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "review", branch: `bossman/${t.id}`, ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  /** The BOS-2713 shape: a ticket in review whose one review slot (held by `holderId`) passes with a hold on another ticket. */
  const heldOn = async (holderId: string, holderName: string) => {
    const waited = await ticket("The wait", { systemState: "in_progress" });
    const id = await ticket("Held work");
    await db.insert(reviewRequests).values({ ticketId: id, kind: "infra", reviewerAgentId: holderId, round: 1, status: "pending" });
    const out = await built.review.submit(id, { verdict: "approved", reviewer: holderName, reviewerAgentId: holderId, kind: "infra", hold: { reason: "Waits for the wait to merge", waitsOn: [{ ticketId: waited }], releaseAt: null }, background: true });
    expect(out).toMatchObject({ outcome: "held" });
    await db.delete(wakes);
    return { id, waited };
  };
  /** The waited-on ticket merges, as BOS-2663 did: a merge commit, then "merged, watching". */
  const merge = (waited: string) => db.update(tickets).set({ systemState: "blocked", mergeCommit: "c".repeat(40), mergedAt: clock() }).where(eq(tickets.id, waited));
  const holdWakes = (agentId: string) => db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.reason, "review hold ready")));
  /** The holder's run took the wake (and did nothing with it): later wakes are new rows, not folded into this one. */
  const launchAll = () => db.update(wakes).set({ status: "launched" }).where(eq(wakes.reason, "review hold ready"));
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, ceo, worker, reviewer, ticket, heldOn, merge, holdWakes, launchAll, advance, clock };
}

const cardsFor = async (ticketId: string) => (await ctx.db.select().from(decisions)).filter((d) => JSON.stringify(d.context).includes(ticketId) && (d.dedupeKey ?? "").startsWith("review-hold-unreleased:"));

describe("a ready hold wakes its holder once (BOS-2870 criterion 2)", () => {
  it("the CEO holding a review is woken exactly once when the wait merges, and the ticket page says it waits for the CEO", async () => {
    ctx = await setup();
    const { id, waited } = await ctx.heldOn(ctx.ceo.id, "CEO");
    await ctx.sweeps.run();
    expect(await ctx.holdWakes(ctx.ceo.id)).toHaveLength(0);
    await ctx.merge(waited);
    expect((await ctx.sweeps.run()).holdWakes).toBe(1);
    ctx.advance(5 * MIN);
    await ctx.sweeps.run();
    const woke = await ctx.holdWakes(ctx.ceo.id);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.ticketId).toBe(id);
    const view = await holdView(ctx.db, id, ctx.clock());
    expect(view).toMatchObject({ reviewer: "CEO", ready: true });
    expect(view!.readySince).not.toBeNull();
  });

  it("a sweep step that throws every pass doesn't stop the holder's wake (it used to run after 20 unguarded steps)", async () => {
    ctx = await setup();
    const { id, waited } = await ctx.heldOn(ctx.ceo.id, "CEO");
    await ctx.merge(waited);
    // An early step of the pass fails, as any unguarded read can on a live database.
    ctx.runs.endUnconfirmedCancels = async () => {
      throw new Error("relation lock timeout");
    };
    await ctx.sweeps.run().catch(() => undefined);
    ctx.advance(MIN);
    await ctx.sweeps.run().catch(() => undefined);
    const woke = await ctx.holdWakes(ctx.ceo.id);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.ticketId).toBe(id);
  });

  it("the live failure: a stranded Blocked ticket with no assignee broke every pass, and the holder is still woken", async () => {
    // The owner's live reads (27 Nov): every server-blue log line was "sweep failed" from releaseStrandedBlocked
    // looking up agents.id = "" for an unassigned Blocked ticket (BOS-2871), and both holds kept woken_at null.
    ctx = await setup();
    const { id, waited } = await ctx.heldOn(ctx.ceo.id, "CEO");
    await ctx.ticket("Parked, nobody on it", { systemState: "blocked", assigneeAgentId: null, stateChangedAt: new Date(ctx.clock().getTime() - 60 * MIN) });
    await ctx.merge(waited);
    await ctx.sweeps.run().catch(() => undefined);
    const woke = await ctx.holdWakes(ctx.ceo.id);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.ticketId).toBe(id);
  });

  it("a wake the scheduler dropped is tried again on the next pass, not counted as sent", async () => {
    ctx = await setup();
    const { waited } = await ctx.heldOn(ctx.reviewer.id, "Reviewer");
    await ctx.merge(waited);
    // The holder's wake is dropped, as the loop brakes drop agent wakes; the stamp must not stay claimed.
    const orig = ctx.scheduler.notify.bind(ctx.scheduler);
    let drop = true;
    ctx.scheduler.notify = (async (agentId: string, input: Parameters<typeof orig>[1]) => {
      const r = await orig(agentId, input);
      if (!drop || input.reason !== "review hold ready") return r;
      await ctx.db.update(wakes).set({ status: "dropped" }).where(eq(wakes.id, r.id));
      return { ...r, status: "dropped", outcome: "dropped" };
    }) as typeof ctx.scheduler.notify;
    expect((await ctx.sweeps.run()).holdWakes).toBe(0);
    expect((await ctx.db.select().from(reviewHolds))[0]!.wokenAt).toBeNull();
    drop = false;
    ctx.advance(MIN);
    expect((await ctx.sweeps.run()).holdWakes).toBe(1);
    ctx.scheduler.notify = orig;
  });
});

describe("no held ticket sits silently (BOS-2870 criterion 3)", () => {
  it("unreleased after 1 hour the holder is woken again; after 2 hours one CEO card names it; it closes when the hold is released", async () => {
    ctx = await setup();
    const { id, waited } = await ctx.heldOn(ctx.reviewer.id, "Reviewer");
    await ctx.merge(waited);
    await ctx.sweeps.run();
    await ctx.launchAll();
    expect(await ctx.holdWakes(ctx.reviewer.id)).toHaveLength(1);
    // Just under the hour: nothing new.
    ctx.advance(HOLD_REMIND_MS - MIN);
    await ctx.sweeps.run();
    expect(await ctx.holdWakes(ctx.reviewer.id)).toHaveLength(1);
    // Past the hour: the second wake, once.
    ctx.advance(2 * MIN);
    await ctx.sweeps.run();
    ctx.advance(5 * MIN);
    await ctx.sweeps.run();
    const woke = await ctx.holdWakes(ctx.reviewer.id);
    expect(woke).toHaveLength(2);
    expect(woke.find((w) => w.status !== "launched")!.note).toMatch(/second reminder/);
    expect(await cardsFor(id)).toHaveLength(0);
    // Past two hours: one card on the CEO's queue (not the owner's), naming the ticket, the holder and the wait.
    ctx.advance(HOLD_ESCALATE_MS - HOLD_REMIND_MS);
    await ctx.sweeps.run();
    ctx.advance(10 * MIN);
    await ctx.sweeps.run();
    const cards = await cardsFor(id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.tier).toBe("ceo");
    expect(cards[0]!.status).toBe("open");
    expect(cards[0]!.question).toMatch(/held by Reviewer/);
    expect(cards[0]!.question).toMatch(/release_hold/);
    expect((await ctx.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "review_hold_escalated"))))).toHaveLength(1);
    // The hold is released (the release's own merge is review-holds.test.ts's): the card closes by itself on the next pass.
    await ctx.db.update(reviewHolds).set({ status: "released", closedBy: "CEO", closedAt: ctx.clock() }).where(eq(reviewHolds.ticketId, id));
    await ctx.sweeps.run();
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, cards[0]!.id));
    expect(after!.status).not.toBe("open");
  });

  it("when the CEO is the holder, the 2-hour card goes to the owner, naming the CEO", async () => {
    ctx = await setup();
    const { id, waited } = await ctx.heldOn(ctx.ceo.id, "CEO");
    await ctx.merge(waited);
    await ctx.sweeps.run();
    await ctx.launchAll();
    ctx.advance(HOLD_REMIND_MS + MIN);
    await ctx.sweeps.run();
    await ctx.launchAll();
    expect(await ctx.holdWakes(ctx.ceo.id)).toHaveLength(2);
    ctx.advance(HOLD_ESCALATE_MS - HOLD_REMIND_MS);
    await ctx.sweeps.run();
    const cards = await cardsFor(id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.tier).toBe("owner");
    expect(cards[0]!.question).toMatch(/held by CEO/);
    expect(cards[0]!.question).toMatch(/Release hold/);
    // No third wake and no second card on later passes.
    ctx.advance(3 * HOLD_ESCALATE_MS);
    await ctx.sweeps.run();
    expect(await ctx.holdWakes(ctx.ceo.id)).toHaveLength(2);
    expect(await cardsFor(id)).toHaveLength(1);
  });

  it("a hold whose wait is still open is never chased, however old", async () => {
    ctx = await setup();
    const { id } = await ctx.heldOn(ctx.reviewer.id, "Reviewer");
    ctx.advance(3 * HOLD_ESCALATE_MS);
    await ctx.sweeps.run();
    expect(await ctx.holdWakes(ctx.reviewer.id)).toHaveLength(0);
    expect(await cardsFor(id)).toHaveLength(0);
  });
});
