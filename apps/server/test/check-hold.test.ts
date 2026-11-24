// BOS-1906: a ticket handed in with no passing quick check waits in review as "Being checked": its check is queued by Boss Man,
// no review round opens and nobody is woken until it passes; a failure sends it back to its agent; it counts toward neither
// WIP limit but its agent's next start waits at two of them; and the migration moves existing waiting tickets once.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, reviewRequests, runners, settings, tickets, workflowColumns } from "../src/db/schema.js";
import { agentWipHold, countInProgress } from "../src/services/agent-wip.js";
import { checkHoldService } from "../src/services/check-hold.js";
import { CHECK_QUEUE_MODE_KEY, checkQueue } from "../src/services/check-queue.js";
import { checkRequestService } from "../src/services/check-request.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const diff = (over: Partial<WorkspaceDiff> = {}): WorkspaceDiff => ({ baseCommit: "b", head: "headcommit1", tree: "tree1", commits: [{ sha: "headcommit1", subject: "x" }], files: [], diff: "", truncated: false, ...over });

async function setup(d: WorkspaceDiff = diff()) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [reviewer] = await db.insert(agents).values({ companyId: co!.id, name: "R", role: "worker", agentKind: "claude" } as never).returning();
  let n = 0;
  const ticket = async (state: "in_progress" | "review" | "ready", patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, assigneeAgentId: a!.id, systemState: state, ...patch } as never).returning())[0]!;
  const woken: Array<{ agentId: string; ticketId: string; note: string }> = [];
  const opened: string[] = [];
  const hold = checkHoldService(db, { openReviews: async (id) => void opened.push(id), wake: async (agentId, w) => void woken.push({ agentId, ticketId: w.ticketId, note: w.note }) });
  const svc = checkRequestService(db, { diff: async () => d });
  const job = (ticketId: string, state: string, extra: Partial<typeof checkJobs.$inferInsert> = {}) =>
    db.insert(checkJobs).values({ companyId: co!.id, projectId: p!.id, ticketId, kind: "pre_review", scope: "quick", commit: "headcommit1", tree: `tree-${Math.random()}`, state, ...extra }).returning().then((r) => r[0]!);
  return { db, co: co!.id, project: p!.id, agent: a!.id, reviewer: reviewer!.id, ticket, hold, svc, woken, opened, job };
}

describe("handing in: holdForReview", () => {
  it("queues the quick check itself, with nobody to wake on a pass, and says it is held", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress");
    const r = await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: t.id });
    expect(r).toMatchObject({ held: true });
    const jobs = await s.db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "pre_review", scope: "quick", commit: "headcommit1", requestedBy: null, state: "queued" });
  });

  it("is not held when the same code already passed, the queue is off, or the ticket has no code", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress");
    await checkQueue(s.db).enqueue({ companyId: s.co, projectId: s.project, ticketId: t.id, kind: "pre_review", scope: "quick", commit: "headcommit1", tree: "tree1" });
    await s.db.update(checkJobs).set({ state: "passed" }).where(eq(checkJobs.ticketId, t.id));
    expect(await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: t.id })).toEqual({ held: false });
    const noCode = await s.ticket("in_progress", { noCode: true });
    expect(await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: noCode.id })).toEqual({ held: false });
    const other = await s.ticket("in_progress");
    await s.db.update(settings).set({ value: "legacy" }).where(eq(settings.key, CHECK_QUEUE_MODE_KEY));
    expect(await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: other.id })).toEqual({ held: false });
    expect(await s.db.select().from(checkJobs).where(eq(checkJobs.ticketId, other.id))).toHaveLength(0);
  });
});

describe("when the check ends", () => {
  it("waits while the check is live, and a pass opens the reviews with no agent woken", async () => {
    const s = await setup();
    const t = await s.ticket("review", { checkHoldAt: new Date() });
    const j = await s.job(t.id, "running");
    expect(await s.hold.settle(t.id)).toBe("waiting");
    expect(s.opened).toEqual([]);
    await s.db.update(checkJobs).set({ state: "passed" }).where(eq(checkJobs.id, j.id));
    await s.hold.onEnded({ ...j, state: "passed" });
    expect(s.opened).toEqual([t.id]);
    expect(s.woken).toEqual([]);
    const [row] = await s.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row).toMatchObject({ systemState: "review", checkHoldAt: null });
    // Settling again (the sweep) opens nothing twice.
    expect(await s.hold.settle(t.id)).toBe("none");
    expect(s.opened).toEqual([t.id]);
  });

  it("a failure moves the ticket to In progress, wakes its agent with the failing step, and leaves reviewers' records alone", async () => {
    const s = await setup();
    const t = await s.ticket("review", { checkHoldAt: new Date() });
    await s.db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: s.reviewer, round: 1, status: "approved" });
    const j = await s.job(t.id, "failed", { reason: "typecheck failed in apps/server" });
    await s.hold.onEnded(j);
    const [row] = await s.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
    expect(s.woken).toHaveLength(1);
    expect(s.woken[0]).toMatchObject({ agentId: s.agent, ticketId: t.id });
    expect(s.woken[0]!.note).toMatch(/typecheck failed in apps\/server/);
    expect(s.opened).toEqual([]);
    const rows = await s.db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "approved", round: 1 });
  });

  it("the sweep settles a ticket whose check ended while no one was listening, and leaves unheld review tickets alone", async () => {
    const s = await setup();
    const passed = await s.ticket("review", { checkHoldAt: new Date() });
    await s.job(passed.id, "passed");
    const failed = await s.ticket("review", { checkHoldAt: new Date() });
    await s.job(failed.id, "failed", { reason: "boom" });
    const waiting = await s.ticket("review", { checkHoldAt: new Date() });
    await s.job(waiting.id, "queued");
    const plain = await s.ticket("review");
    expect(await s.hold.sweep()).toEqual({ released: 1, bounced: 1 });
    expect(s.opened).toEqual([passed.id]);
    const states = await s.db.select({ id: tickets.id, state: tickets.systemState }).from(tickets).where(eq(tickets.companyId, s.co));
    expect(Object.fromEntries(states.map((x) => [x.id, x.state]))).toMatchObject({ [failed.id]: "in_progress", [waiting.id]: "review", [plain.id]: "review" });
  });

  it("moving a held ticket out of review by hand clears the mark", async () => {
    const s = await setup();
    const t = await s.ticket("review", { checkHoldAt: new Date() });
    const { moveTicket } = await import("../src/services/ticket-moves.js");
    await moveTicket(s.db, t.id, "in_progress", { overLimit: true });
    const [row] = await s.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.checkHoldAt).toBeNull();
  });
});

describe("limits", () => {
  it("tickets being checked count toward neither limit and never hold the agent's next start (BOS-2385); one sent back counts again", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: "wip_limits", value: { agent: 2, company: 2 } });
    const a = await s.ticket("review", { checkHoldAt: new Date() });
    const next = await s.ticket("ready");
    expect(await countInProgress(s.db, eq(tickets.companyId, s.co))).toBe(0);
    expect(await countInProgress(s.db, eq(tickets.companyId, s.co), undefined, "company")).toBe(0);
    expect((await agentWipHold(s.db, next)).hold).toBeNull(); // one waiting on its check: room to start
    await s.ticket("review", { checkHoldAt: new Date() });
    expect((await agentWipHold(s.db, next)).hold).toBeNull(); // two being checked: still room (was held before BOS-2385)
    await s.ticket("review", { checkHoldAt: new Date() });
    expect((await agentWipHold(s.db, next)).hold).toBeNull();
    // A ticket the check sends back returns to in progress and counts again.
    await s.db.update(tickets).set({ systemState: "in_progress", checkHoldAt: null }).where(eq(tickets.id, a.id));
    expect(await countInProgress(s.db, eq(tickets.assigneeAgentId, s.agent))).toBe(1);
  });
});

describe("migration 0173 moves waiting tickets into Being checked once", () => {
  const migration = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0173_being_checked.sql"), "utf8");
  const update = migration.slice(migration.indexOf('UPDATE "tickets"')).trim();

  it("moves an in-progress ticket with a queued or running agent check, and nothing else", async () => {
    const s = await setup();
    const col = (name: string, systemState: "in_progress" | "review", position: number) => s.db.insert(workflowColumns).values({ projectId: s.project, name, systemState, position }).returning().then((r) => r[0]!);
    await col("In progress", "in_progress", 1);
    const review = await col("Review", "review", 2);
    const waiting = await s.ticket("in_progress");
    await s.job(waiting.id, "queued", { requestedBy: s.agent });
    const running = await s.ticket("in_progress");
    await s.job(running.id, "running", { requestedBy: s.agent });
    const noCheck = await s.ticket("in_progress");
    const finished = await s.ticket("in_progress");
    await s.job(finished.id, "passed", { requestedBy: s.agent });
    const gateCheck = await s.ticket("in_progress");
    await s.job(gateCheck.id, "queued", { kind: "merge", requestedBy: s.agent });
    await s.db.execute(sql.raw(update));
    const rows = await s.db.select().from(tickets).where(eq(tickets.companyId, s.co));
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const t of [waiting, running]) expect(by.get(t.id)).toMatchObject({ systemState: "review", columnId: review.id });
    for (const t of [waiting, running]) expect(by.get(t.id)!.checkHoldAt).not.toBeNull();
    for (const t of [noCheck, finished, gateCheck]) expect(by.get(t.id)).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
  });
});
