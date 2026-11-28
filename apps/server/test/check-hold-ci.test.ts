// BOS-2880: a branch that changes CI or image files is handed in to review like any other: the move is accepted and the ticket
// waits as "Being checked" until the quick check AND GitHub's CI before review have passed. A CI failure sends it back to
// In progress with the failing jobs. Only a move that can't be held (not the assignee's, not from In progress) is still refused.
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { checkHoldService } from "../src/services/check-hold.js";
import type { PreflightHoldState } from "../src/services/ci-preflight.js";
import { CHECK_QUEUE_MODE_KEY } from "../src/services/check-queue.js";
import { checkRequestService } from "../src/services/check-request.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const diff: WorkspaceDiff = { baseCommit: "b", head: "headcommit1", tree: "tree1", commits: [{ sha: "headcommit1", subject: "x" }], files: [{ path: ".github/workflows/ci.yml" }] as never, diff: "", truncated: false };

async function setup() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1, assigneeAgentId: a!.id, systemState: "in_progress" } as never).returning();
  let ci: PreflightHoldState = { state: "waiting" };
  const started: string[] = [];
  const woken: string[] = [];
  const opened: string[] = [];
  const preflight = {
    needsHold: async () => true,
    start: async (tk: { id: string }) => (started.push(tk.id), "started"),
    reviewRefusal: async () => "GitHub's CI jobs must pass before review.",
  };
  const svc = checkRequestService(db, { diff: async () => diff, preflight: preflight as never });
  const hold = checkHoldService(db, { openReviews: async (id) => void opened.push(id), wake: async (_a, w) => void woken.push(w.note), ci: async () => ci });
  return { db, co: co!.id, agent: a!.id, ticket: t!, svc, hold, started, woken, opened, setCi: (c: PreflightHoldState) => (ci = c) };
}

describe("hand-in of a branch that needs GitHub's CI", () => {
  it("is accepted: held, with GitHub's run started, and no refusal for the assignee", async () => {
    const s = await setup();
    expect(await s.svc.reviewRefusal(s.co, s.ticket.id, s.agent)).toBeNull();
    const r = await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: s.ticket.id });
    expect(r).toMatchObject({ held: true });
    expect(s.started).toEqual([s.ticket.id]);
  });

  it("is held even when the quick check already passed on the same code", async () => {
    const s = await setup();
    await s.db.insert(checkJobs).values({ companyId: s.co, projectId: s.ticket.projectId, ticketId: s.ticket.id, kind: "pre_review", scope: "quick", commit: "headcommit1", tree: "tree1", state: "passed" });
    const r = await s.svc.holdForReview({ companyId: s.co, agentId: s.agent, ticketId: s.ticket.id });
    expect(r).toMatchObject({ held: true });
    expect(s.started).toEqual([s.ticket.id]);
  });

  it("is still refused when the mover can't be held (not the assignee)", async () => {
    const s = await setup();
    expect(await s.svc.reviewRefusal(s.co, s.ticket.id, null)).toMatch(/must pass before review/);
  });
});

describe("the hold waits for the CI result too", () => {
  const held = async (s: Awaited<ReturnType<typeof setup>>) => {
    await s.db.update(tickets).set({ systemState: "review", checkHoldAt: new Date() }).where(eq(tickets.id, s.ticket.id));
    await s.db.insert(checkJobs).values({ companyId: s.co, projectId: s.ticket.projectId, ticketId: s.ticket.id, kind: "pre_review", scope: "quick", commit: "headcommit1", tree: "tree1", state: "passed" });
  };

  it("quick check passed, CI running: still Being checked, no reviews", async () => {
    const s = await setup();
    await held(s);
    expect(await s.hold.settle(s.ticket.id)).toBe("waiting");
    expect(s.opened).toEqual([]);
  });

  it("both passed: the reviews open and nobody is woken", async () => {
    const s = await setup();
    await held(s);
    s.setCi({ state: "passed" });
    expect(await s.hold.settle(s.ticket.id)).toBe("released");
    expect(s.opened).toEqual([s.ticket.id]);
    expect(s.woken).toEqual([]);
  });

  it("CI failed: back to In progress, the agent woken once with the failing job", async () => {
    const s = await setup();
    await held(s);
    s.setCi({ state: "failed", detail: "- web tests (job 7)" });
    expect(await s.hold.settle(s.ticket.id)).toBe("bounced");
    const [t] = await s.db.select().from(tickets).where(eq(tickets.id, s.ticket.id));
    expect(t).toMatchObject({ systemState: "in_progress", checkHoldAt: null });
    expect(s.opened).toEqual([]);
    expect(s.woken).toHaveLength(1);
    expect(s.woken[0]).toContain("web tests (job 7)");
  });
});
