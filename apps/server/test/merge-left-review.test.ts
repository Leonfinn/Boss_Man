// BOS-1769: a landing whose ticket leaves review while its merge check waits is over, even if the ticket comes straight back.
// BOS-1706 (17 Nov) was moved out of review and back while its merge job waited; the old landing never noticed, kept its
// "running" marker alive with the heartbeat, and retry_merge and the back-in-review restart both said "already being checked
// and merged" for hours. A fake runner prepares one tree and merges it on finish; the test plays the check queue by hand.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.hoisted(() => {
  // Slow enough that the ticket can go out of review and back between two polls of the old landing.
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "300";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, checkJobs, reviewRequests, settings, tickets } from "../src/db/schema.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false };
const PREP = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40), branchSha: "b".repeat(40) };

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
  const state = { finishes: 0 };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.merge") {
      const x = c as unknown as { phase?: string; commit?: string };
      if (x.phase === "prepare") reply(PREP);
      else {
        state.finishes++;
        reply({ status: "merged", commit: x.commit });
      }
    }
    return true;
  }, ["carried-check"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  // A passed code review, so retry_merge counts the ticket approved.
  await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: ceo.id, round: 1, seq: 0, status: "approved" });
  const waitFor = async (what: () => Promise<boolean>, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  const jobs = () => db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
  const landing = async () => ((await req("GET", `/api/tickets/${t.id}/landing`)).json() as { landing: { state: string; outcome?: string; text?: string; startedBy?: string } | null }).landing;
  const lineRows = async (event: string) =>
    (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "merge_line")))).map((r) => r.detail as Record<string, unknown>).filter((d) => d.event === event);
  // Out of review the way an agent or the owner moves it (so the merge line records "left"), then straight back. The way back
  // is written directly so the test, not the back-in-review restart, decides when the next landing starts.
  const outOfReview = () => built.work.updateTicket(t.id, { state: "in_progress", overLimit: true, internal: true });
  const backInReview = () => db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
  const retry = () => built.review.retryMerge(t.id, { byAgentId: ceo.id, companyId: company.id });
  const pass = (id: string) => db.update(checkJobs).set({ state: "passed", exitCode: 0, startedAt: new Date(), endedAt: new Date() }).where(eq(checkJobs.id, id));
  return { db, req, ticket: t, state, waitFor, jobs, landing, lineRows, outOfReview, backInReview, retry, pass };
}

describe("a landing whose ticket left review is over (BOS-1769)", () => {
  it("out of review while the merge check waits: the job is cancelled, the landing ends unmerged, and a retry later starts a fresh attempt", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    expect(await c.waitFor(async () => (await c.jobs()).length === 1)).toBe(true);
    const [first] = await c.jobs();
    await c.outOfReview();
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ state: "finished", outcome: "check_stuck" });
    expect((await c.jobs()).find((j) => j.id === first!.id)).toMatchObject({ state: "cancelled", reason: "The ticket left review, so its merge check was stopped." });
    expect(await c.lineRows("check_ended")).toEqual([expect.objectContaining({ why: "the ticket left review" })]);
    expect(c.state.finishes).toBe(0);

    // Back in review: the retry is taken (before the fix it said "already being checked and merged"), queues again and lands.
    await c.backInReview();
    await expect(c.retry()).resolves.toMatchObject({ state: "running" });
    expect(await c.waitFor(async () => (await c.jobs()).some((j) => j.state === "queued"))).toBe(true);
    const fresh = (await c.jobs()).find((j) => j.state === "queued")!;
    await c.pass(fresh.id);
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ outcome: "merged" });
    expect(c.state.finishes).toBe(1);
  });

  it("out and straight back between two polls: retry_merge starts a fresh attempt at once, which keeps the waiting job and its place; the old landing stops without touching either", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    expect(await c.waitFor(async () => (await c.jobs()).length === 1)).toBe(true);
    const [job] = await c.jobs();
    // BOS-1706: out at 15:43, back a minute later, with the old landing still polling its queued job.
    await c.outOfReview();
    await c.backInReview();
    // The old landing is still "running", but its pass through the line is over, so the retry replaces it.
    await expect(c.retry()).resolves.toMatchObject({ state: "running", startedBy: "the CEO (retrying the merge)" });
    // The old landing notices on its next poll and ends; the job stays queued for the new attempt (same tree: reused, not re-queued).
    expect(await c.waitFor(async () => (await c.lineRows("check_ended")).some((d) => d.why === "the ticket left review"))).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    const now = await c.jobs();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ id: job!.id, state: "queued" });
    expect(now[0]!.queuedAt.getTime()).toBe(job!.queuedAt.getTime());
    // The marker is the new attempt's: the old landing's end did not overwrite it with its own "finished".
    expect(await c.landing()).toMatchObject({ state: "running", startedBy: "the CEO (retrying the merge)" });
    await c.pass(job!.id);
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ outcome: "merged" });
    expect(c.state.finishes).toBe(1);
  });

  it("a landing that is still on its first pass through the line keeps refusing a second press", async () => {
    const c = await setup();
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    expect(await c.waitFor(async () => (await c.jobs()).length === 1)).toBe(true);
    await expect(c.retry()).rejects.toThrow("This ticket is already being checked and merged.");
    const [job] = await c.jobs();
    await c.pass(job!.id);
    expect(await c.waitFor(async () => (await c.landing())?.state === "finished")).toBe(true);
    expect(await c.landing()).toMatchObject({ outcome: "merged" });
  });
});
