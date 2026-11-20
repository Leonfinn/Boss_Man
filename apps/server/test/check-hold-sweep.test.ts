// BOS-2114: the standing sweep that moves an In progress ticket waiting only for its quick check into "Being checked",
// the hand-in path still holding and bouncing (BOS-1906), and a pass for a commit other than the branch head opening nothing.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, runners, runs, settings, tickets, workflowColumns } from "../src/db/schema.js";
import { countInProgress } from "../src/services/agent-wip.js";
import { checkHoldService } from "../src/services/check-hold.js";
import { CHECK_QUEUE_MODE_KEY } from "../src/services/check-queue.js";
import { checkRequestService } from "../src/services/check-request.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const HEAD = "headcommit1";
const diff: WorkspaceDiff = { baseCommit: "b", head: HEAD, tree: "tree1", commits: [{ sha: HEAD, subject: "x" }], files: [], diff: "", truncated: false };

async function setup(head: string | null = HEAD) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(workflowColumns).values([
    { projectId: p!.id, name: "In progress", systemState: "in_progress", position: 2 },
    { projectId: p!.id, name: "Review", systemState: "review", position: 3 },
  ]);
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  let n = 0;
  const ticket = async (state: "in_progress" | "review", patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, assigneeAgentId: a!.id, systemState: state, ...patch } as never).returning())[0]!;
  const woken: Array<{ ticketId: string; note: string }> = [];
  const hold = checkHoldService(db, { openReviews: async () => undefined, wake: async (_a, w) => void woken.push({ ticketId: w.ticketId, note: w.note }), branchHead: async () => head });
  const job = (ticketId: string, state: string, extra: Partial<typeof checkJobs.$inferInsert> = {}) =>
    db.insert(checkJobs).values({ companyId: co!.id, projectId: p!.id, ticketId, kind: "pre_review", scope: "quick", commit: HEAD, tree: `tree-${Math.random()}`, state, requestedBy: a!.id, ...extra }).returning().then((r) => r[0]!);
  const state = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  return { db, co: co!.id, project: p!.id, agent: a!.id, ticket, hold, woken, job, state };
}

describe("the standing sweep: In progress with only a queued check", () => {
  it("moves a ticket with a live check on its head and no run into Being checked", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress", { acceptanceCriteria: ["Works"], stateNote: "Done. 1 pass" });
    await s.job(t.id, "queued");
    expect(await s.hold.sweepProgress()).toEqual({ held: 1, returned: 0 });
    expect(await s.state(t.id)).toMatchObject({ systemState: "review" });
    expect((await s.state(t.id)).checkHoldAt).not.toBeNull();
  });

  it("a mid-work request_check (criteria not all reported) is not swept, opens no reviews on a pass, and still frees the company limit only", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress", { acceptanceCriteria: ["Works", "Fast"], stateNote: "Halfway. 1 pass" });
    await s.job(t.id, "queued");
    expect(await s.hold.sweepProgress()).toEqual({ held: 0, returned: 0 });
    expect((await s.state(t.id)).systemState).toBe("in_progress");
    expect(await countInProgress(s.db, eq(tickets.companyId, s.co), undefined, "company")).toBe(0);
    expect(await countInProgress(s.db, eq(tickets.companyId, s.co))).toBe(1);
    await s.db.update(checkJobs).set({ state: "passed" }).where(eq(checkJobs.ticketId, t.id));
    expect(await s.hold.sweepProgress()).toEqual({ held: 0, returned: 0 });
    expect(await s.hold.settle(t.id)).toBe("none");
    expect((await s.state(t.id)).systemState).toBe("in_progress");
  });

  it("leaves a ticket with a run of its own, a check on an older commit, a no-code ticket, or no check in In progress", async () => {
    const s = await setup();
    const running = await s.ticket("in_progress");
    await s.job(running.id, "running");
    await s.db.insert(runs).values({ companyId: s.co, agentId: s.agent, ticketId: running.id } as never);
    const older = await s.ticket("in_progress");
    await s.job(older.id, "queued", { commit: "oldercommit" });
    const noCode = await s.ticket("in_progress", { noCode: true });
    await s.job(noCode.id, "queued");
    const none = await s.ticket("in_progress");
    expect(await s.hold.sweepProgress()).toEqual({ held: 0, returned: 0 });
    for (const t of [running, older, noCode, none]) expect((await s.state(t.id)).systemState).toBe("in_progress");
  });

  it("sends a held ticket back to In progress once its agent runs again and the branch has moved past the checked commit", async () => {
    const s = await setup("newercommit");
    const t = await s.ticket("review", { checkHoldAt: new Date() });
    await s.job(t.id, "queued"); // for HEAD, no longer the branch head
    await s.db.insert(runs).values({ companyId: s.co, agentId: s.agent, ticketId: t.id } as never);
    expect(await s.hold.sweepProgress()).toEqual({ held: 0, returned: 1 });
    expect(await s.state(t.id)).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
  });
});

describe("hand-in path and stale passes", () => {
  it("a hand-in with only a queued check is held, and a failed check returns it to In progress with the failing step", async () => {
    const s = await setup();
    const t = await s.ticket("in_progress");
    const svc = checkRequestService(s.db, { diff: async () => diff });
    expect(await svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: t.id })).toMatchObject({ held: true });
    const [j] = await s.db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
    await s.db.update(tickets).set({ systemState: "review", checkHoldAt: new Date() }).where(eq(tickets.id, t.id)); // what the move to review does next
    await s.db.update(checkJobs).set({ state: "failed", reason: "typecheck failed in apps/web" }).where(eq(checkJobs.id, j!.id));
    await s.hold.onEnded({ ...j!, state: "failed", reason: "typecheck failed in apps/web" });
    expect(await s.state(t.id)).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
    expect(s.woken[0]!.note).toMatch(/typecheck failed in apps\/web/);
  });

  it("a pass for a commit other than the branch head opens no reviews: it goes back to In progress", async () => {
    const s = await setup("newercommit");
    const t = await s.ticket("review", { checkHoldAt: new Date() });
    await s.job(t.id, "passed");
    expect(await s.hold.settle(t.id)).toBe("bounced");
    expect(await s.state(t.id)).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
  });
});
