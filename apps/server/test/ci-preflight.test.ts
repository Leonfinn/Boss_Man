// BOS-1664: GitHub's own CI jobs before review for a branch that changes CI or image files. Made-up refs, a fake host.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { MergeResult, WorkspaceDiff } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, checkResults, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY } from "../src/services/check-queue.js";
import { checkRequestService } from "../src/services/check-request.js";
import { ciPreflightService } from "../src/services/ci-preflight.js";
import { CI_IMAGES_PATHS, touchesGithubOnlyJobs } from "../src/services/ci-publish.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const FAST = { pollMs: 5, graceMs: 50, ceilingMs: 2000, retryMs: 1 };
const cfg = { kind: "github" as const, apiBase: "https://api.example.com", owner: "example-org", repo: "example-repo" };
// `wf` is an image-path change (runs early). A workflow edit is never pushed before review (security review F1): see below.
const wf = { path: "apps/runner/Dockerfile", added: 1, removed: 0 };
const wfEdit = { path: ".github/workflows/ci.yml", added: 1, removed: 0 };
const diff = (files: WorkspaceDiff["files"], head = "headcommit1"): WorkspaceDiff => ({ baseCommit: "b", head, tree: `tree-${head}`, commits: [{ sha: head, subject: "x" }], files, diff: "", truncated: false });

async function setup(opts: { files: WorkspaceDiff["files"]; ci?: "passed" | "failed"; head?: string; context?: boolean }) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  await db.insert(runners).values({ companyId: co!.id, name: "r", tokenHash: `h${Math.random()}` } as never);
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude" } as never).returning();
  const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: 1, assigneeAgentId: a!.id, systemState: "in_progress" } as never).returning();
  const wakes: Array<{ note: string; reason: string }> = [];
  const publish = vi.fn(async (commit: string): Promise<MergeResult> => ({ status: "published", branch: `bossman-ci/${t!.id}`, commit, hasWorkflows: true }));
  const unpublish = vi.fn(async () => ({ status: "unpublished" }));
  const ciStatus = vi.fn(async (_c: unknown, _t: string, sha: string) => {
    // The probe on main's head says "none yet"; the pushed merge commit gets the scripted answer.
    if (sha === "mainhead1") return { state: "none" as const, waiting: [], failed: [] };
    return opts.ci === "failed" ? { state: "failed" as const, waiting: [], failed: [{ name: "check-worker-image", url: "https://example.com/run/1" }] } : { state: "passed" as const, waiting: [], failed: [] };
  });
  const hosts = { ciStatus, failures: vi.fn(async (_c: unknown, _t: string, runs: Array<{ name: string }>) => runs.map((run) => ({ run, lines: ["docker build failed"], billing: false }))) };
  const d = diff(opts.files, opts.head);
  const preflight = ciPreflightService(db, {
    hosts: hosts as never,
    timing: FAST,
    wake: (_agent, w) => void wakes.push(w),
    context: async () =>
      opts.context === false
        ? null
        : { target: { cfg, token: "made-up-token" }, prepare: async () => ({ status: "prepared", commit: "mergecommit1", tree: "mergetree1", targetSha: "mainhead1" }), publish, unpublish },
  });
  const raw = checkRequestService(db, { diff: async () => d, preflight });
  // These tests are about the CI hold; the quick check hold (BOS-1922) is tested in check-request.test.ts, so a queued quick job counts as passed here.
  const svc = { ...raw, reviewRefusal: async (c: string, tk: string) => (await db.update(checkJobs).set({ state: "passed" }), raw.reviewRefusal(c, tk)) };
  return { svc, db, co: co!.id, agent: a!.id, ticket: t!.id, wakes, publish, unpublish, d };
}
const settled = async (s: Awaited<ReturnType<typeof setup>>) => {
  // Wait for the wake, not a fixed sleep.
  await vi.waitFor(() => expect(s.wakes.length).toBeGreaterThan(0), { timeout: 5000 });
};

describe("GitHub CI before review (BOS-1664)", () => {
  it("a CI change publishes the merge, reads the run, stores the pass and wakes the author", async () => {
    const s = await setup({ files: [wf], ci: "passed" });
    const msg = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(msg).toMatch(/GitHub's own CI jobs run on it/);
    await settled(s);
    expect(s.publish).toHaveBeenCalledWith("mergecommit1");
    expect(s.wakes[0]).toMatchObject({ reason: "check_result" });
    expect(s.wakes[0]!.note).toMatch(/passed/);
    const rows = await s.db.select().from(checkResults).where(eq(checkResults.ticketId, s.ticket));
    expect(rows.find((r) => r.kind === "ci_preflight")).toMatchObject({ passed: true, sha: "headcommit1" });
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });

  it("a failing run names the failed jobs in the wake and keeps the move to review refused", async () => {
    const s = await setup({ files: [{ path: "apps/runner/Dockerfile", added: 1, removed: 0 }], ci: "failed" });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await settled(s);
    expect(s.wakes[0]!.note).toMatch(/FAILED/);
    expect(s.wakes[0]!.note).toMatch(/check-worker-image/);
    expect(s.wakes[0]!.note).toMatch(/docker build failed/);
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toMatch(/did not pass/);
  });

  it("before any run, the move to review is refused with what to do", async () => {
    const s = await setup({ files: [wf] });
    const why = await s.svc.reviewRefusal(s.co, s.ticket);
    expect(why).toMatch(/request_check/);
    expect(why).toMatch(/ciNotApplicable/);
  });

  it("a reason marks the job not applicable and lifts the refusal", async () => {
    const s = await setup({ files: [wf] });
    const msg = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket, ciNotApplicable: "comment-only change to a workflow" });
    expect(msg).toMatch(/not applicable/);
    expect(s.publish).not.toHaveBeenCalled();
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });

  it("a pass on an older commit doesn't cover a new one", async () => {
    const s = await setup({ files: [wf], ci: "passed", head: "headcommit1" });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await settled(s);
    const moved = checkRequestService(s.db, { diff: async () => diff([wf], "headcommit2"), preflight: ciPreflightService(s.db, { hosts: {} as never, context: async () => ({ target: { cfg, token: "x" }, prepare: async () => ({ status: "main_moved" }), publish: s.publish, unpublish: s.unpublish }) }) });
    expect(await moved.reviewRefusal(s.co, s.ticket)).toMatch(/request_check/);
  });

  it("a workflow edit is never pushed before review and never holds the move to review", async () => {
    const s = await setup({ files: [wfEdit, wf] });
    const msg = await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(msg).toMatch(/not pushed to GitHub before review/);
    expect(s.publish).not.toHaveBeenCalled();
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });

  it("with the check queue off the move to review is not held (request_check would refuse)", async () => {
    const s = await setup({ files: [wf] });
    await s.db.delete(settings);
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });

  it("a not-applicable mark covers that commit only; a new commit re-arms the hold", async () => {
    const s = await setup({ files: [wf], head: "headcommit1" });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket, ciNotApplicable: "docs-only touch" });
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
    const next = checkRequestService(s.db, { diff: async () => diff([wf], "headcommit2"), preflight: ciPreflightService(s.db, { hosts: {} as never, context: async () => ({ target: { cfg, token: "x" }, prepare: async () => ({ status: "main_moved" }), publish: s.publish, unpublish: s.unpublish }) }) });
    expect(await next.reviewRefusal(s.co, s.ticket)).toMatch(/request_check/);
  });

  it("a run lost to a restart is started again and wakes the author", async () => {
    const s = await setup({ files: [wf], ci: "passed" });
    // The state a restart leaves: a started row, no result row, nothing in memory.
    await s.db.insert(checkResults).values({ companyId: s.co, ticketId: s.ticket, sha: "headcommit1", kind: "ci_preflight_started", passed: false, detail: s.agent });
    const fresh = ciPreflightService(s.db, { hosts: { ciStatus: async () => ({ state: "passed", waiting: [], failed: [] }), failures: async () => [] } as never, timing: FAST, wake: (_a, w) => void s.wakes.push(w), context: async () => ({ target: { cfg, token: "x" }, prepare: async () => ({ status: "prepared", commit: "mergecommit1", tree: "t", targetSha: "mainhead1" }), publish: s.publish, unpublish: s.unpublish }) });
    expect(await fresh.recover()).toEqual({ launched: 1, skipped: 0 });
    await settled(s);
    expect(s.wakes[0]!.note).toMatch(/passed/);
    expect(await fresh.recover()).toEqual({ launched: 0, skipped: 0 });
  });

  it("a run whose runner isn't connected yet is skipped, logged, and retried until it is (once per head)", async () => {
    const s = await setup({ files: [wf], ci: "passed" });
    await s.db.insert(checkResults).values({ companyId: s.co, ticketId: s.ticket, sha: "headcommit1", kind: "ci_preflight_started", passed: false, detail: s.agent });
    let connected = false;
    const logs: string[] = [];
    const ctx = { target: { cfg, token: "x" }, prepare: async () => ({ status: "prepared", commit: "mergecommit1", tree: "t", targetSha: "mainhead1" }) as MergeResult, publish: s.publish, unpublish: s.unpublish };
    const fresh = ciPreflightService(s.db, { hosts: { ciStatus: async () => ({ state: "passed", waiting: [], failed: [] }), failures: async () => [] } as never, timing: FAST, log: (l) => void logs.push(l), wake: (_a, w) => void s.wakes.push(w), context: async () => (connected ? ctx : null) });
    expect(await fresh.recover()).toEqual({ launched: 0, skipped: 1 });
    expect(logs.at(-1)).toMatch(/0 relaunched, 1 skipped/);
    const stop = fresh.recoverRepeatedly({ firstMs: 1, everyMs: 5, forMs: 10_000 });
    connected = true;
    await settled(s);
    stop();
    expect(s.wakes).toHaveLength(1);
    expect(logs.some((l) => /1 relaunched, 0 skipped/.test(l))).toBe(true);
    expect(await fresh.recover()).toEqual({ launched: 0, skipped: 0 });
  });

  it("an error while setting up a skipped run is logged", async () => {
    const s = await setup({ files: [wf] });
    await s.db.insert(checkResults).values({ companyId: s.co, ticketId: s.ticket, sha: "headcommit1", kind: "ci_preflight_started", passed: false, detail: s.agent });
    const logs: string[] = [];
    const fresh = ciPreflightService(s.db, { hosts: {} as never, log: (l) => void logs.push(l), context: async () => Promise.reject(new Error("runner lookup broke")) });
    expect(await fresh.recover()).toEqual({ launched: 0, skipped: 1 });
    expect(logs.some((l) => /runner lookup broke/.test(l))).toBe(true);
  });

  it("the pushed branch is removed even when the run throws after publishing", async () => {
    const s = await setup({ files: [wf] });
    s.publish.mockRejectedValueOnce(new Error("push failed"));
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    await settled(s);
    expect(s.wakes[0]!.note).toMatch(/FAILED/);
    await vi.waitFor(() => expect(s.unpublish).toHaveBeenCalled(), { timeout: 5000 });
  });

  it("a branch that changes neither workflows nor image files is never held or run", async () => {
    const s = await setup({ files: [{ path: "apps/server/src/x.ts", added: 1, removed: 0 }] });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(s.publish).not.toHaveBeenCalled();
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });

  it("a project GitHub CI can't be used for (no token, not GitHub) is neither run nor held", async () => {
    const s = await setup({ files: [wf], context: false });
    await s.svc.request({ companyId: s.co, agentId: s.agent, ticketId: s.ticket });
    expect(s.publish).not.toHaveBeenCalled();
    expect(await s.svc.reviewRefusal(s.co, s.ticket)).toBeNull();
  });
});

describe("the images_paths copy", () => {
  it("matches the changes job in ci.yml", () => {
    const yml = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const found = /images_paths='([^']+)'/.exec(yml);
    expect(found, "ci.yml should set images_paths in single quotes").toBeTruthy();
    // Same pattern, whatever the escaping of "/" and ".": compare with backslashes removed.
    expect(CI_IMAGES_PATHS.source.replace(/\\/g, "")).toBe(found![1]!.replace(/\\/g, ""));
    expect(touchesGithubOnlyJobs(["README.md"])).toBe(false);
  });
});
