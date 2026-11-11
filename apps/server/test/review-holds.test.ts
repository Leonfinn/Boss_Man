// BOS-808: a reviewer passes the work but holds the merge. Each test fails on the code before this ticket
// (no hold table, no verdict, nothing refuses the merge) and passes on this one.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SENIOR_DEV_TEMPLATE, type RunnerCommand, type WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, reviewHolds, reviewRequests, tickets, wakes } from "../src/db/schema.js";
import { ReviewError, ReviewHeldError } from "../src/services/review.js";
import { requestReviews } from "../src/services/review-kinds.js";
import { holdView } from "../src/services/review-holds.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 24 * HOUR;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined as never;
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Add it" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts\n+x", truncated: false };

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
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: DIFF }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "none" } }));
    return true;
  }, ["carried-check"]);
  const hire = async (name: string, set: Partial<typeof agents.$inferInsert> = {}) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    if (Object.keys(set).length) await db.update(agents).set(set).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const reviewer = await hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
  const other = await hire("Bystander", { template: SENIOR_DEV_TEMPLATE });
  const ticket = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "review", branch: `bossman/${t.id}`, ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  /** A review slot for the reviewer, pending by default. */
  const slot = async (ticketId: string, status = "pending", kind = "code", agentId = reviewer.id, createdAt?: Date) =>
    (await db.insert(reviewRequests).values({ ticketId, kind, reviewerAgentId: agentId, round: 1, status, ...(status !== "pending" ? { decidedAt: new Date() } : {}), ...(createdAt ? { createdAt } : {}) }).returning())[0]!;
  const advance = (ms: number) => (offset += ms);
  const hold = (over: Partial<{ reason: string; waitsOn: Array<{ ticketId: string } | { decisionId: string }>; releaseAt: Date | null }> = {}) => ({ reason: "Waits for the vendor contract", waitsOn: [], releaseAt: new Date(Date.now() + 7 * DAY), ...over });
  /** A reviewer passes a ticket with a hold. */
  const holdIt = async (title: string, over: Parameters<typeof hold>[0] = {}) => {
    const id = await ticket(title);
    await slot(id);
    const out = await built.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: reviewer.id, hold: hold(over), background: true });
    return { id, out };
  };
  const wakesFor = (agentId: string, reason: string) => db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.reason, reason)));
  return { ...built, db, close, req, company, ceo, project, worker, reviewer, other, ticket, slot, hold, holdIt, advance, sent, wakesFor };
}

const merged = () => ctx.sent.filter((c) => c.type === "workspace.merge");

describe("Passed, hold merge (BOS-808)", () => {
  it("keeps the pass, opens a hold and starts no merge", async () => {
    ctx = await setup();
    const waited = await ctx.ticket("The vendor ticket", { assigneeAgentId: null, systemState: "in_progress" });
    const { id, out } = await ctx.holdIt("Held work", { waitsOn: [{ ticketId: waited }] });
    expect(out).toMatchObject({ verdict: "approved", outcome: "held" });
    const [row] = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, id));
    expect(row!.status).toBe("approved");
    const view = await holdView(ctx.db, id);
    expect(view).toMatchObject({ reviewer: "Reviewer", ready: false });
    expect(view!.label).toMatch(/^waits on .* \/ until \d+ \w+$/);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState).toBe("review");
    expect(merged()).toHaveLength(0);
  });

  it("asks for a reason and for something that ends the hold, and refuses a second hold", async () => {
    ctx = await setup();
    const a = await ctx.ticket("A");
    await ctx.slot(a);
    const submit = (hold: ReturnType<typeof ctx.hold>, id = a, agent: string | null = ctx.reviewer.id) => ctx.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: agent, hold });
    await expect(submit(ctx.hold({ reason: "  " }))).rejects.toThrow(/why the merge is held/);
    await expect(submit(ctx.hold({ releaseAt: null }))).rejects.toThrow(/needs something to end it/);
    await expect(submit(ctx.hold({ waitsOn: [{ ticketId: a }] }))).rejects.toThrow(/wait on itself/);
    const done = await ctx.ticket("Done already", { systemState: "done" });
    await expect(submit(ctx.hold({ waitsOn: [{ ticketId: done }] }))).rejects.toThrow(/already closed/);
    await expect(submit(ctx.hold({ releaseAt: new Date(Date.now() - HOUR) }))).rejects.toThrow(/already past/);
    await expect(submit(ctx.hold(), a, null)).rejects.toThrow(/Only a reviewer holds/);
    await submit(ctx.hold());
    await expect(submit(ctx.hold())).rejects.toThrow(ReviewError);
    expect(await ctx.db.select().from(reviewHolds)).toHaveLength(1);
  });

  it("fails every path into a merge closed while the hold is open", async () => {
    ctx = await setup();
    const { id } = await ctx.holdIt("Held work");
    await expect(ctx.review.startLanding(id, "someone")).rejects.toBeInstanceOf(ReviewHeldError);
    await expect(ctx.review.land(id, "someone")).rejects.toBeInstanceOf(ReviewHeldError);
    await expect(ctx.review.landOnce(id, "someone")).rejects.toBeInstanceOf(ReviewHeldError);
    await expect(ctx.review.retryMerge(id, { byAgentId: ctx.ceo.id, companyId: ctx.company.id })).rejects.toBeInstanceOf(ReviewHeldError);
    // The owner's own approval records nothing and merges nothing.
    expect(await ctx.review.approve((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!, { reviewer: "the owner" })).toMatchObject({ outcome: "held" });
    expect((await ctx.req("POST", `/api/tickets/${id}/approve-merge`)).statusCode).toBe(409);
    expect(merged()).toHaveLength(0);
    // And no merge-stuck card or failure trail came of it: held is a wait, not a failure.
    expect(await ctx.db.select().from(decisions)).toHaveLength(0);
    expect(await ctx.db.select().from(activity).where(eq(activity.kind, "merge_failed"))).toHaveLength(0);
  });

  it("holds the merge when the last of several reviewers approves", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Two reviews");
    await ctx.slot(id, "pending", "code");
    await ctx.slot(id, "pending", "security", ctx.other.id);
    await ctx.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: ctx.reviewer.id, hold: ctx.hold(), kind: "code" });
    const out = await ctx.review.submit(id, { verdict: "approved", reviewer: "Bystander", reviewerAgentId: ctx.other.id, kind: "security" });
    expect(out).toMatchObject({ outcome: "held" });
    expect(merged()).toHaveLength(0);
  });
});

describe("release and cancel (BOS-808)", () => {
  it("release by the holding reviewer takes the normal approve path and merges", async () => {
    ctx = await setup();
    const { id } = await ctx.holdIt("Held work");
    const r = await ctx.review.releaseHold(id, { name: "Reviewer", agentId: ctx.reviewer.id });
    expect(r.outcome).toBe("released");
    expect(merged()).toHaveLength(1);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState).toBe("done");
    expect((await ctx.db.select().from(reviewHolds))[0]).toMatchObject({ status: "released", closedBy: "Reviewer" });
  });

  it("the CEO and the owner can release; another agent cannot", async () => {
    ctx = await setup();
    const a = await ctx.holdIt("A");
    await expect(ctx.review.releaseHold(a.id, { name: "Bystander", agentId: ctx.other.id })).rejects.toThrow(/Only the reviewer who set the hold/);
    await expect(ctx.review.cancelHold(a.id, { name: "Bystander", agentId: ctx.other.id })).rejects.toThrow(/Only the reviewer who set the hold/);
    expect(merged()).toHaveLength(0);
    await ctx.review.releaseHold(a.id, { name: "CEO", agentId: ctx.ceo.id, isCeo: true });
    expect(merged()).toHaveLength(1);
    const b = await ctx.holdIt("B");
    const res = await ctx.req("POST", `/api/tickets/${b.id}/hold/release`);
    expect(res.statusCode).toBeLessThan(300);
    expect((await ctx.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, b.id)))[0]!.status).toBe("released");
    await expect(ctx.review.releaseHold(b.id, { name: "CEO", agentId: ctx.ceo.id, isCeo: true })).rejects.toThrow(/no hold/);
  });

  it("cancel withdraws the pass: the slot goes back to pending, the reviewer is asked again, nothing merges", async () => {
    ctx = await setup();
    const { id } = await ctx.holdIt("Held work");
    await ctx.db.delete(wakes);
    const res = await ctx.req("POST", `/api/tickets/${id}/hold/cancel`);
    expect(res.statusCode).toBe(200);
    const [slot] = await ctx.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, id));
    expect(slot!.status).toBe("pending");
    expect((await ctx.db.select().from(reviewHolds))[0]!.status).toBe("cancelled");
    expect(await ctx.wakesFor(ctx.reviewer.id, "review requested")).toHaveLength(1);
    expect(merged()).toHaveLength(0);
  });

  it("a new review round ends the old hold, without touching the new round", async () => {
    ctx = await setup();
    const { id } = await ctx.holdIt("Held work");
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, id));
    await requestReviews(ctx.db, t!);
    expect((await ctx.db.select().from(reviewHolds))[0]!.status).toBe("cancelled");
    expect(await holdView(ctx.db, id)).toBeNull();
  });
});

describe("quiet while held (BOS-808)", () => {
  it("does not retry the merge or raise a merge card for a held ticket, but still does for an unheld one", async () => {
    ctx = await setup();
    const { id: heldId } = await ctx.holdIt("Held");
    const plain = await ctx.ticket("Plain approved");
    await ctx.slot(plain, "approved");
    const old = new Date(Date.now() - 6 * HOUR);
    for (const t of [heldId, plain]) {
      await ctx.db.update(reviewRequests).set({ decidedAt: old }).where(eq(reviewRequests.ticketId, t));
      await ctx.db.update(tickets).set({ lastActivityAt: old }).where(eq(tickets.id, t));
    }
    const pass = await ctx.sweeps.run();
    // Only the unheld one is picked up.
    expect(pass.unmergedApprovals).toBe(1);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, heldId)))[0]!.systemState).toBe("review");
    expect(merged().length).toBeLessThanOrEqual(1);
    expect((await ctx.db.select().from(decisions)).every((d) => !JSON.stringify(d.context).includes(heldId))).toBe(true);
  });

  it("sends no stale-review wake and no 'review clash' wake to the author of a held ticket", async () => {
    ctx = await setup();
    // A held ticket whose second review is still open and old: the case that woke HOL-585's author twice.
    const id = await ctx.ticket("Clashing but held");
    await ctx.slot(id, "pending", "code", ctx.reviewer.id, new Date(Date.now() - 4 * HOUR));
    await ctx.slot(id, "pending", "security", ctx.other.id, new Date(Date.now() - 4 * HOUR));
    await ctx.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: ctx.reviewer.id, hold: ctx.hold(), kind: "code" });
    await ctx.db.delete(wakes);
    const spy = vi.spyOn(ctx.review, "branchClash").mockResolvedValue(["src/a.ts"]);
    const pass = await ctx.sweeps.run();
    expect(pass.stalledReviews).toEqual({ woken: 0, gaveUp: 0 });
    expect(await ctx.wakesFor(ctx.worker.id, "review clash")).toHaveLength(0);
    expect(await ctx.wakesFor(ctx.other.id, "review requested")).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    // Control: the same ticket without the hold does wake its author about the clash.
    await ctx.review.cancelHold(id, { name: "CEO", agentId: ctx.ceo.id, isCeo: true });
    await ctx.db.delete(wakes);
    await ctx.sweeps.run();
    expect(await ctx.wakesFor(ctx.worker.id, "review clash")).toHaveLength(1);
    spy.mockRestore();
  });

  it("wakes the reviewer once when what it waits on closes, and not again", async () => {
    ctx = await setup();
    const waited = await ctx.ticket("The wait", { assigneeAgentId: null, systemState: "in_progress" });
    const { id } = await ctx.holdIt("Held", { waitsOn: [{ ticketId: waited }], releaseAt: null });
    await ctx.db.delete(wakes);
    expect((await ctx.sweeps.run()).holdWakes).toBe(0);
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, waited));
    expect((await ctx.sweeps.run()).holdWakes).toBe(1);
    const woke = await ctx.wakesFor(ctx.reviewer.id, "review hold ready");
    expect(woke).toHaveLength(1);
    expect(woke[0]!.note).toMatch(/git diff origin\/main\.\.\.HEAD/);
    expect(woke[0]!.note).toMatch(/release_hold/);
    expect((await holdView(ctx.db, id))!.ready).toBe(true);
    ctx.advance(10 * MIN);
    expect((await ctx.sweeps.run()).holdWakes).toBe(0);
    expect(await ctx.wakesFor(ctx.reviewer.id, "review hold ready")).toHaveLength(1);
    // It woke nobody else and merged nothing: release is the reviewer's call.
    expect(merged()).toHaveLength(0);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState).toBe("review");
  });

  it("wakes the reviewer when the date comes, and when a waited-on decision is answered", async () => {
    ctx = await setup();
    const dated = await ctx.holdIt("Dated", { releaseAt: new Date(Date.now() + 2 * HOUR) });
    const [card] = await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "question", question: "Which vendor?", options: ["A", "B"], recommendedOption: "A", tier: "owner" }).returning();
    const asked = await ctx.holdIt("Asked", { waitsOn: [{ decisionId: card!.id }], releaseAt: null });
    await ctx.db.delete(wakes);
    expect((await ctx.sweeps.run()).holdWakes).toBe(0);
    ctx.advance(3 * HOUR);
    expect((await ctx.sweeps.run()).holdWakes).toBe(1);
    await ctx.db.update(decisions).set({ status: "answered", answer: "A" }).where(eq(decisions.id, card!.id));
    expect((await ctx.sweeps.run()).holdWakes).toBe(1);
    const woke = await ctx.wakesFor(ctx.reviewer.id, "review hold ready");
    expect(woke.map((w) => w.ticketId).sort()).toEqual([dated.id, asked.id].sort());
  });
});

describe("shown as held (BOS-808)", () => {
  it("the board, the ticket page and the merge queue show it held, apart from tickets waiting for a reviewer", async () => {
    ctx = await setup();
    const waiting = await ctx.ticket("Waiting for a reviewer");
    await ctx.slot(waiting);
    const { id } = await ctx.holdIt("Held work");
    const board = (await ctx.req("GET", `/api/projects/${ctx.project.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; reviewStage?: string; hold?: { label: string; reviewer: string; reason: string } | null }> }> };
    const all = board.columns.flatMap((c) => c.tickets);
    const card = all.find((t) => t.id === id)!;
    expect(card.reviewStage).toBe("held");
    expect(card.hold).toMatchObject({ reviewer: "Reviewer", reason: "Waits for the vendor contract" });
    expect(card.hold!.label).toMatch(/until/);
    expect(all.find((t) => t.id === waiting)!.reviewStage).toBe("awaiting_review");
    expect(all.find((t) => t.id === waiting)!.hold).toBeNull();

    const detail = (await ctx.req("GET", `/api/tickets/${id}`)).json() as { hold: { label: string; reviewer: string } | null };
    expect(detail.hold).toMatchObject({ reviewer: "Reviewer" });

    const q = (await ctx.req("GET", `/api/companies/${ctx.company.id}/merge-queue`)).json() as { waiting: Array<{ ticketId: string; state: string; label: string; stuck: boolean }>; stuckCount: number };
    const row = q.waiting.find((w) => w.ticketId === id)!;
    expect(row).toMatchObject({ state: "held", stuck: false });
    expect(row.label).toMatch(/^held by Reviewer: /);
    // An old held ticket is never "stuck".
    await ctx.db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 9 * HOUR) }).where(eq(tickets.id, id));
    const later = (await ctx.req("GET", `/api/companies/${ctx.company.id}/merge-queue`)).json() as { stuckCount: number };
    expect(later.stuckCount).toBe(0);
  });
});
