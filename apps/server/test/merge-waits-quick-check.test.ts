// BOS-2303 (BOS-2283 P6): no merge starts until the code's own quick check has passed once. On 22 Nov BOS-2285's approval
// (the CEO's overrule) came 54 s into its first quick check; the gate pushed a merge copy to GitHub at once, GitHub failed it
// 17 minutes later and the quick check failed 3 minutes after that. Here an approval that arrives while the check is
// queued or running waits in "Passed, held"; a pass starts the merge by itself and a failure sends it back before any
// merge copy is built. A fake runner prepares one tree and merges it on finish; the test plays the check queue by hand.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "200";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, checkJobs, reviewHolds, reviewRequests, settings, tickets } from "../src/db/schema.js";
import { checkHoldService } from "../src/services/check-hold.js";
import { mergeHolds } from "../src/services/review-holds.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  // test-lines-ok: lets the last background write settle before the database closes; nothing to poll for
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const HEAD = "b".repeat(40);
const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: HEAD, commits: [{ sha: HEAD, subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const PREP = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40), branchSha: HEAD };

async function setup() {
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const ceo = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Chief" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const state = { prepares: 0, finishes: 0 };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.merge") {
      const x = c as unknown as { phase?: string; commit?: string };
      if (x.phase === "prepare") {
        state.prepares++;
        reply(PREP);
      } else {
        state.finishes++;
        reply({ status: "merged", commit: x.commit });
      }
    }
    return true;
  }, ["carried-check"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: ceo.id, round: 1, seq: 0, status: "approved" });
  const waitFor = async (what: () => Promise<boolean>, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  const jobs = (kind: "pre_review" | "merge") => db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, t.id), eq(checkJobs.kind, kind)));
  // The author's quick check of the head, as holdForReview or request_check queues it.
  const quickCheck = async (s: "queued" | "running" | "passed" | "failed", commit = HEAD) =>
    (await db.insert(checkJobs).values({ companyId: company.id, projectId: project.id, ticketId: t.id, kind: "pre_review", scope: "quick", commit, tree: `tree-${Math.random()}`, state: s, requestedBy: worker.id }).returning())[0]!;
  const landing = async () => ((await req("GET", `/api/tickets/${t.id}/landing`)).json() as { landing: { state: string; outcome?: string; text?: string } | null }).landing;
  const lineRows = async (event: string) =>
    (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_line")))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  const ticketRow = async () => (await db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
  const openHolds = () => db.select().from(reviewHolds).where(and(eq(reviewHolds.ticketId, t.id), eq(reviewHolds.status, "open")));
  return { db, built, req, company, ticket: t, state, waitFor, jobs, quickCheck, landing, lineRows, ticketRow, openHolds };
}

describe("an approval that arrives while the code's own quick check runs (BOS-2303)", () => {
  it("waits in Passed, held with no merge copy, then merges by itself once the check passes", async () => {
    const c = await setup();
    const job = await c.quickCheck("running");
    expect(await mergeHolds(c.db, c.ticket.id)).toEqual([{ kind: "check", id: job.id, commit: HEAD }]);
    const r = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    expect(r.statusCode).toBeLessThan(300);
    expect(r.json()).toMatchObject({ outcome: "held" });
    // Held by Boss Man, approvals kept, nothing built, checked or pushed.
    expect(await c.openHolds()).toEqual([expect.objectContaining({ reviewerAgentId: null, reviewRequestId: null })]);
    expect((await c.ticketRow()).systemState).toBe("review");
    expect(await c.jobs("merge")).toEqual([]);
    expect(c.state.prepares).toBe(0);
    expect(await c.lineRows("hold_started")).toEqual([expect.objectContaining({ hold: "quick_check" })]);
    // The release sweep leaves it alone while the check runs.
    expect(await c.built.review.releaseHolds(c.ticket.id)).toEqual([]);
    const queue = (await c.req("GET", `/api/companies/${c.company.id}/merge-queue`)).json() as { waiting: Array<{ ticketId: string; state: string; label: string; stuck: boolean }> };
    expect(queue.waiting.find((w) => w.ticketId === c.ticket.id)).toMatchObject({ state: "held", stuck: false, label: expect.stringContaining("waits for its quick check") });

    // The check passes: its end releases the hold and the merge starts, with the gate's own check.
    await c.db.update(checkJobs).set({ state: "passed", endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    expect((await mergeHolds(c.db, c.ticket.id)).map((h) => h.kind)).toEqual(["hold"]);
    expect(await c.built.review.releaseHolds(c.ticket.id)).toEqual([c.ticket.id]);
    expect(await c.openHolds()).toEqual([]);
    expect(await c.waitFor(async () => (await c.jobs("merge")).length === 1)).toBe(true);
    const [gate] = await c.jobs("merge");
    await c.db.update(checkJobs).set({ state: "passed", startedAt: new Date(), endedAt: new Date(), exitCode: 0 }).where(eq(checkJobs.id, gate!.id));
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(c.state.finishes).toBe(1);
  });

  it("goes back to its agent before any merge copy is built when the check fails", async () => {
    const c = await setup();
    const job = await c.quickCheck("queued");
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).json()).toMatchObject({ outcome: "held" });
    await c.db.update(checkJobs).set({ state: "failed", endedAt: new Date(), reason: "vitest: 15 tests failed in 2 files", logTail: "FAIL test/merge-ci-gate.test.ts" }).where(eq(checkJobs.id, job.id));
    expect(await c.built.review.releaseHolds(c.ticket.id)).toEqual([c.ticket.id]);
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ outcome: "verify_failed" });
    expect((await c.ticketRow()).systemState).toBe("in_progress");
    expect(await c.jobs("merge")).toEqual([]);
    expect(c.state.prepares).toBe(0);
    expect(c.state.finishes).toBe(0);
  });

  it("an approval after the head's quick check already failed is sent back too; a pass on the same commit lifts it", async () => {
    const c = await setup();
    await c.quickCheck("failed");
    expect(await mergeHolds(c.db, c.ticket.id)).toEqual([]);
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    expect(await c.waitFor(async () => (await c.ticketRow()).systemState === "in_progress")).toBe(true);
    expect(c.state.prepares).toBe(0);
  });

  it("holds nothing for a re-run of a commit that already passed, or for a failure on code since replaced", async () => {
    const c = await setup();
    await c.quickCheck("passed");
    await c.quickCheck("running");
    expect(await mergeHolds(c.db, c.ticket.id)).toEqual([]);
    await c.db.delete(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
    await c.quickCheck("failed", "c".repeat(40));
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    // The failure was on older code, so the merge goes ahead to the gate's own check.
    expect(await c.waitFor(async () => (await c.jobs("merge")).length === 1)).toBe(true);
    const [gate] = await c.jobs("merge");
    await c.db.update(checkJobs).set({ state: "passed", startedAt: new Date(), endedAt: new Date(), exitCode: 0 }).where(eq(checkJobs.id, gate!.id));
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
  });
});

describe("checkHold.onEnded (BOS-2303)", () => {
  it("starts the held merge when a ticket's quick check ends, and never for a merge check", async () => {
    const released: string[] = [];
    const hold = checkHoldService(shared.db, { openReviews: async () => undefined, wake: async () => undefined, releaseHolds: async (id) => void released.push(id) });
    const base = { id: "j", companyId: "c", projectId: "p", ticketId: "00000000-0000-4000-8000-000000000001", scope: "quick", commit: HEAD, tree: "t", state: "passed" } as never as Parameters<typeof hold.onEnded>[0];
    await hold.onEnded({ ...base, kind: "merge" });
    await hold.onEnded({ ...base, kind: "pre_review" });
    expect(released).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });
});
