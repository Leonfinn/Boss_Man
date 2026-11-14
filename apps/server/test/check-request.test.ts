import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { activity, agents, checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, checkQueue } from "../src/services/check-queue.js";
import { CHECK_REUSED_KIND, checkRequestService, CheckRequestError } from "../src/services/check-request.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const diff = (over: Partial<WorkspaceDiff> = {}): WorkspaceDiff => ({ baseCommit: "b", head: "headcommit1", tree: "tree1", commits: [{ sha: "headcommit1", subject: "x" }], files: [], diff: "", truncated: false, ...over });

async function setup(d: WorkspaceDiff = diff(), mode: "server" | "legacy" = "server") {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  if (mode === "server") await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1, assigneeAgentId: a!.id, systemState: "in_progress" } as never).returning();
  const svc = checkRequestService(db, { diff: async () => d });
  return { svc, db, co: co!.id, agent: a!.id, ticket: t!.id };
}

describe("request_check", () => {
  it("queues a quick pre-review job on the committed head and tree, and says its place", async () => {
    const s = await setup();
    const msg = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(msg).toMatch(/quick check of commit headcomm is queued/);
    expect(msg).toMatch(/number 1 in line/);
    const [job] = await s.db.select().from(checkJobs);
    expect(job).toMatchObject({ kind: "pre_review", scope: "quick", commit: "headcommit1", tree: "tree1", requestedBy: s.agent, state: "queued" });
  });
  it("asking twice for the same code queues one job", async () => {
    const s = await setup();
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(await s.db.select().from(checkJobs)).toHaveLength(1);
  });
  // BOS-1412: asking again for code that is already waiting hands back the same job and place, never a re-queue.
  it("asking again for a commit that is already waiting keeps that job and its place", async () => {
    const s = await setup();
    // Another ticket is ahead in line, so this ticket's job is number 2: a re-queue would send it behind.
    const spare = await s.db.insert(tickets).values({ companyId: s.co, projectId: (await s.db.select().from(tickets))[0]!.projectId, title: "Ahead", number: 2 } as never).returning();
    await checkQueue(s.db).enqueue({ companyId: s.co, projectId: spare[0]!.projectId, ticketId: spare[0]!.id, kind: "pre_review", scope: "quick", commit: "c".repeat(40), tree: "t".repeat(40), command: "scripts/check-quick.sh" });
    const first = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(first).toMatch(/number 2 in line/);
    const [job] = await s.db.select().from(checkJobs).where(eq(checkJobs.ticketId, s.ticket));
    const started = job!.queuedAt;
    for (let i = 0; i < 3; i++) {
      const again = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
      expect(again).toMatch(/already queued at no\. 2/);
      expect(again).toMatch(/its result will wake you/);
    }
    const jobs = await s.db.select().from(checkJobs).where(eq(checkJobs.ticketId, s.ticket));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe("queued");
    expect(jobs[0]!.queuedAt.getTime()).toBe(started.getTime());
    expect(jobs[0]!.reason).toBeNull();
  });
  it("a running check is handed back as running, and a different tree still supersedes the waiting one", async () => {
    const s = await setup();
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    const [job] = await s.db.select().from(checkJobs);
    await s.db.update(checkJobs).set({ state: "running" }).where(eq(checkJobs.id, job!.id));
    const again = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(again).toMatch(/already running now/);
    expect(await s.db.select().from(checkJobs)).toHaveLength(1);
    // Other code is a new request: the running one is left to finish, and the new commit queues.
    const moved = await setup(diff({ head: "headcommit2", tree: "tree2" }));
    await moved.svc.request({ companyId: moved.co, agentId: moved.agent, ticketId: moved.ticket });
    await moved.svc.request({ companyId: moved.co, agentId: moved.agent, ticketId: moved.ticket });
    const fresh = checkRequestService(moved.db, { diff: async () => diff({ head: "headcommit3", tree: "tree3" }) });
    await fresh.request({ companyId: moved.co, agentId: moved.agent, ticketId: moved.ticket });
    const rows = await moved.db.select().from(checkJobs).where(eq(checkJobs.ticketId, moved.ticket));
    expect(rows.map((r) => [r.tree, r.state]).sort()).toEqual([
      ["tree2", "cancelled"],
      ["tree3", "queued"],
    ]);
    expect(rows.find((r) => r.tree === "tree2")!.reason).toMatch(/newer commit/);
  });
  it("a reused request leaves one check_reused row (no agent) for the check-line export; a fresh one leaves none (BOS-1309)", async () => {
    const s = await setup();
    const mine = () => s.db.select().from(activity).where(and(eq(activity.ticketId, s.ticket), eq(activity.kind, CHECK_REUSED_KIND)));
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(await mine()).toHaveLength(0);
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await s.db.update(checkJobs).set({ state: "passed" });
    expect(await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket })).toMatch(/Already answered/);
    const rows = await mine();
    // Sorted by value, not time: two rows can share a millisecond.
    expect(rows.map((r) => r.detail).sort((a, b) => String(a!.reused).localeCompare(String(b!.reused)))).toEqual([
      { reused: "live", scope: "quick", outcome: "queued" },
      { reused: "passed", scope: "quick", outcome: "passed" },
    ]);
    expect(rows.every((r) => r.agentId === null && r.companyId === s.co)).toBe(true);
  });
  it("an urgent ticket's check gets the urgent priority (0), ahead of a normal one", async () => {
    const s = await setup();
    await s.db.update(tickets).set({ urgent: true } as never);
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    const [job] = await s.db.select().from(checkJobs);
    expect(job!.priority).toBe(0);
  });
  it("a full request carries the full command, never the quick script", async () => {
    const s = await setup();
    const svc = checkRequestService(s.db, { diff: async () => diff(), command: async (scope) => (scope === "full" ? "pnpm run full-check" : "scripts/check-quick.sh") });
    await svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket, scope: "full" });
    const [job] = await s.db.select().from(checkJobs);
    expect(job).toMatchObject({ scope: "full", command: "pnpm run full-check" });
  });
  it("refuses while the queue is off, for another agent, and with nothing committed", async () => {
    const off = await setup(diff(), "legacy");
    await expect(off.svc.request({ companyId: off.co, agentId: off.agent, ticketId: off.ticket })).rejects.toThrow(/not switched on/);
    const s = await setup();
    await expect(s.svc.request({ companyId: s.co, agentId: "00000000-0000-4000-8000-000000000000", ticketId: s.ticket })).rejects.toBeInstanceOf(CheckRequestError);
    const dirty = await setup(diff({ commits: [], files: [{ path: "a", added: 1, removed: 0 }] }));
    await expect(dirty.svc.request({ companyId: dirty.co, agentId: dirty.agent, ticketId: dirty.ticket })).rejects.toThrow(/commit your work first/);
  });
});
