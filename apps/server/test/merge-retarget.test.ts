// BOS-1344: a merge waiting in the check queue takes the new merged tree when main moves, before its check starts.
// A fake runner answers "prepare" with one tree, then (main moved) another; "finish" only merges the tree it was handed last.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "20";
});
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { checkJobs, projects, settings, tickets } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

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
const OLD = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40) };
const NEW = { status: "prepared", commit: "e".repeat(40), tree: "8".repeat(40), targetSha: "2".repeat(40) };

async function setup() {
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const state = { mainMoved: false, prepares: 0, finishTree: null as string | null };
  built.runners.connect(reg.runnerId, (c: RunnerCommand) => {
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.verify") reply({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 });
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    if (c.type === "workspace.merge") {
      const x = c as unknown as { phase?: string; tree?: string; commit?: string };
      if (x.phase === "prepare") {
        state.prepares++;
        reply(state.mainMoved ? NEW : OLD);
      } else {
        state.finishTree = x.tree ?? null;
        reply(x.tree === (state.mainMoved ? NEW.tree : OLD.tree) ? { status: "merged", commit: x.commit } : { status: "main_moved" });
      }
    }
    return true;
  }, ["carried-check"]);
  const [t] = [(await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string }];
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(settings).values({ key: "check_queue_mode", value: "server" });
  const jobOf = async () => {
    for (let i = 0; i < 200; i++) {
      const [job] = await db.select().from(checkJobs).where(eq(checkJobs.ticketId, t.id));
      if (job) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no job queued");
  };
  const waitFor = async (what: () => Promise<boolean>) => {
    for (let i = 0; i < 300; i++) {
      if (await what()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  return { db, req, ticket: t, state, jobOf, waitFor };
}

describe("a waiting merge takes the new main (BOS-1344)", () => {
  it("moves its queued job to the new tree, keeps its place, and finishes on the new tree", async () => {
    const c = await setup();
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    expect(job.tree).toBe(OLD.tree);
    c.state.mainMoved = true;
    const moved = await c.waitFor(async () => (await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id)))[0]!.tree === NEW.tree);
    expect(moved).toBe(true);
    const [after] = await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id));
    expect(after!.commit).toBe(NEW.commit);
    expect(after!.state).toBe("queued");
    expect(after!.queuedAt.getTime()).toBe(job.queuedAt.getTime());
    await c.db.update(checkJobs).set({ state: "passed", exitCode: 0, startedAt: new Date(), endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.finishTree).toBe(NEW.tree);
    expect(await c.db.select({ id: checkJobs.id }).from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(1);
  });

  it("leaves the job alone when the setting is off", async () => {
    const c = await setup();
    await c.db.insert(settings).values({ key: "merge_retarget", value: false });
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    c.state.mainMoved = true;
    const before = c.state.prepares;
    await new Promise((r) => setTimeout(r, 300));
    expect(c.state.prepares).toBe(before);
    const [after] = await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id));
    expect(after!.tree).toBe(OLD.tree);
    // Finish is the safety net: the old tree is refused as main_moved, and the landing prepares again on its own.
    await c.db.update(checkJobs).set({ state: "passed", exitCode: 0, startedAt: new Date(), endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    await c.waitFor(async () => c.state.finishTree === OLD.tree);
    await c.db.update(checkJobs).set({ state: "cancelled", reason: "test over", endedAt: new Date() }).where(eq(checkJobs.state, "queued"));
    await res;
  });

  it("queues one job for a high-risk merge (the deep check alone, BOS-1365) and moves it to the new main", async () => {
    const c = await setup();
    await c.db.update(projects).set({ deepVerifyCommand: "pnpm test:e2e" });
    await c.db.update(tickets).set({ risk: "high" }).where(eq(tickets.id, c.ticket.id));
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    expect(job.command).toBe("pnpm test:e2e");
    c.state.mainMoved = true;
    const moved = await c.waitFor(async () => (await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id)))[0]!.tree === NEW.tree);
    expect(moved).toBe(true);
    await c.db.update(checkJobs).set({ state: "passed", exitCode: 0, startedAt: new Date(), endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    expect(c.state.finishTree).toBe(NEW.tree);
    expect(await c.db.select({ id: checkJobs.id }).from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(1);
  });

  it("gives a merge job for a ticket fixing the merge check priority 0", async () => {
    const c = await setup();
    await c.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, c.ticket.id));
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    expect(job.priority).toBe(0);
    await c.db.update(checkJobs).set({ state: "cancelled", reason: "test over", endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    await res;
  });

  it("does not touch a job a runner has already started", async () => {
    const c = await setup();
    const res = approveAndWait(c.req, c.ticket.id);
    const job = await c.jobOf();
    await c.db.update(checkJobs).set({ state: "running", startedAt: new Date() }).where(eq(checkJobs.id, job.id));
    c.state.mainMoved = true;
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await c.db.select().from(checkJobs).where(eq(checkJobs.id, job.id));
    expect(after!.tree).toBe(OLD.tree);
    await c.db.update(checkJobs).set({ state: "cancelled", reason: "test over", endedAt: new Date() }).where(eq(checkJobs.id, job.id));
    await res;
  });
});
