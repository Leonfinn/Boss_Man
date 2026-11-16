// BOS-1070: the merge gate waits for GitHub CI on the exact merge commit before it merges. A fake GitHub answers the
// check-suite, check-run and annotation reads; a fake runner answers the split merge (prepare, publish, finish).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Hoisted so it is set before review.ts reads it: a landing in server mode re-reads its check job row this often.
// The retarget interval is short too, so a refresh that shouldn't happen (CI gating on) would show within the test.
vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "20";
});
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, checkResults, decisions, settings, tickets, wakes } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.release();
  await new Promise((r) => setTimeout(r, 30));
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const API = "https://api.github.com/repos/leon/site";
const MAIN = "a".repeat(40);
const MERGE = "e".repeat(40);
const TREE = "f".repeat(40);
const FINAL = "c".repeat(40);

type Run = { id: number; name: string; status: string; conclusion: string | null; html_url?: string; output?: { title?: string; summary?: string } };
type Ci = { suites: Array<{ status: string; conclusion: string | null; latest_check_runs_count: number }>; runs: Run[] };
const green = (): Ci => ({ suites: [{ status: "completed", conclusion: "success", latest_check_runs_count: 2 }], runs: [{ id: 1, name: "check", status: "completed", conclusion: "success" }, { id: 2, name: "images (arm64)", status: "completed", conclusion: "success" }] });
const running = (): Ci => ({ suites: [{ status: "in_progress", conclusion: null, latest_check_runs_count: 2 }], runs: [{ id: 1, name: "changes", status: "completed", conclusion: "success" }, { id: 2, name: "images (arm64)", status: "in_progress", conclusion: null }] });

/** A fake GitHub: `ci(sha, nth)` says what CI looks like on the nth read of a commit; `status` forces an HTTP error. */
function fakeGitHub() {
  const calls: string[] = [];
  const reads = new Map<string, number>();
  const state = {
    ci: (_sha: string, _nth: number): Ci => green(),
    status: null as number | null,
    annotations: new Map<number, unknown[]>(),
  };
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (state.status) return json(state.status, { message: "Resource not accessible by personal access token" });
    const suites = /\/commits\/([0-9a-f]+)\/check-suites/.exec(url);
    const runs = /\/commits\/([0-9a-f]+)\/check-runs/.exec(url);
    const notes = /\/check-runs\/(\d+)\/annotations/.exec(url);
    if (suites) {
      const sha = suites[1]!;
      const nth = (reads.get(sha) ?? 0) + 1;
      reads.set(sha, nth);
      return json(200, { check_suites: state.ci(sha, nth).suites });
    }
    if (runs) return json(200, { check_runs: state.ci(runs[1]!, reads.get(runs[1]!) ?? 1).runs });
    if (notes) return json(200, state.annotations.get(Number(notes[1])) ?? []);
    return json(404, { message: `no fake for ${url}` });
  }) as typeof globalThis.fetch;
  return { fetch, calls, state, reads };
}

async function setup(opts: { features?: string[]; holdVerify?: boolean; workflows?: boolean; switchOn?: boolean; finishes?: unknown[] } = {}) {
  const gh = fakeGitHub();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: gh.fetch, ciTiming: { pollMs: 10, graceMs: 60, ceilingMs: 3_000, retryMs: 5 } });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/leon/site.git", verifyCommand: "pnpm test" });
  const { secret } = (await req("POST", "/api/secrets", { name: "GitHub", kind: "generic", value: "github-token-value" })).json();
  await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  if (opts.switchOn !== false) expect((await req("PUT", "/api/settings/wait-for-ci", { on: true })).json()).toEqual({ on: true });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  const held: Array<() => void> = [];
  const reply = (c: { requestId: string }, data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data }));
  built.runners.connect(
    reg.runnerId,
    (c) => {
      sent.push(c);
      if (c.type === "workspace.diff") reply(c, { baseCommit: MAIN, head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "", truncated: false });
      if (c.type === "workspace.carried") reply(c, { carried: [] });
      if (c.type === "workspace.migrations") reply(c, { needed: false, reason: "No other branch uses this ticket's migration numbers." });
      if (c.type === "workspace.verify") {
        const answer = () => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 } });
        if (opts.holdVerify) held.push(answer);
        else queueMicrotask(answer);
      }
      if (c.type === "workspace.merge") {
        if (c.phase === "prepare") reply(c, { status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN });
        else if (c.phase === "publish") reply(c, { status: "published", branch: `bossman-ci/${c.ticketId}`, commit: c.commit, hasWorkflows: opts.workflows !== false });
        else if (c.phase === "unpublish") reply(c, { status: "unpublished", branch: `bossman-ci/${c.ticketId}` });
        else if (c.phase === "finish" && opts.finishes?.length) reply(c, opts.finishes.shift());
        else reply(c, { status: "merged", commit: FINAL, ...(c.phase === "finish" ? { checked: { sha: MERGE, tree: TREE, ms: 0 } } : {}) });
      }
      return true;
    },
    opts.features ?? ["carried-check", "ci-publish"],
  );
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${ticket.id}` }).where(eq(tickets.id, ticket.id));
  await db.delete(wakes);
  const state = async () => (await db.select().from(tickets).where(eq(tickets.id, ticket.id)))[0]!;
  const merges = () => sent.filter((c): c is Extract<RunnerCommand, { type: "workspace.merge" }> => c.type === "workspace.merge").map((c) => c.phase ?? "plain");
  const events = async () => (await db.select({ kind: activity.kind, summary: activity.summary }).from(activity).where(eq(activity.ticketId, ticket.id))).filter((e) => e.kind === "merge_ci").map((e) => e.summary);
  const release = () => held.splice(0).forEach((r) => r());
  return { ...built, db, close, req, company, worker, project, ticket, sent, gh, state, merges, events, release, held };
}

describe("merge gate waits for GitHub CI (BOS-1070)", () => {
  it("publishes the merge commit, merges once CI passes on it, records the pass and deletes the CI branch", async () => {
    const c = (ctx = await setup());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
    expect(c.sent.find((x) => x.type === "workspace.merge" && x.phase === "publish")).toMatchObject({ commit: MERGE });
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: FINAL });
    const ci = await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")));
    expect(ci).toEqual([expect.objectContaining({ sha: MERGE, passed: true })]);
    // The token was tried on main's head before anything was pushed.
    expect(c.gh.calls.findIndex((u) => u.includes(`/commits/${MAIN}/`))).toBeLessThan(c.gh.calls.findIndex((u) => u.includes(`/commits/${MERGE}/`)));
  });

  it("doesn't merge a red CI: the ticket goes back naming the failing job and test", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) =>
      sha === MERGE
        ? { suites: [{ status: "completed", conclusion: "failure", latest_check_runs_count: 2 }], runs: [{ id: 1, name: "check", status: "completed", conclusion: "success" }, { id: 7, name: "images (arm64)", status: "completed", conclusion: "failure", html_url: "https://github.com/leon/site/actions/runs/9/job/7" }] }
        : green();
    c.gh.state.annotations.set(7, [
      { annotation_level: "failure", path: "apps/server/test/fence.test.ts", start_line: 42, title: "fence > blocks a write outside the clone", message: "AssertionError: expected 0 to be 1" },
      { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
    ]);
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    expect(res.message).toMatch(/GitHub CI failed .*images \(arm64\)/);
    expect(c.merges()).toEqual(["prepare", "publish"]);
    expect(await c.state()).toMatchObject({ systemState: "in_progress", mergeCommit: null });
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("images (arm64) (https://github.com/leon/site/actions/runs/9/job/7)");
    expect(wake!.note).toContain("apps/server/test/fence.test.ts:42: fence > blocks a write outside the clone: AssertionError: expected 0 to be 1");
    expect(wake!.note).not.toContain("Process completed with exit code");
    expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([expect.objectContaining({ passed: false, detail: "images (arm64)" })]);
  });

  it("waits while CI runs, says so on the merge queue, and runs its own check at the same time", async () => {
    const c = (ctx = await setup({ holdVerify: true }));
    let done = false;
    c.gh.state.ci = (sha) => (sha === MERGE && !done ? running() : green());
    const approved = approveAndWait(c.req, c.ticket.id);
    // Both under way at once: the gate's own check is out with the runner and CI is being read.
    for (let i = 0; i < 200 && !(c.held.length && (c.gh.reads.get(MERGE) ?? 0) >= 2); i++) await new Promise((r) => setTimeout(r, 10));
    expect(c.held.length).toBe(1);
    expect(c.gh.reads.get(MERGE)).toBeGreaterThanOrEqual(2);
    const queue = (await c.req("GET", `/api/companies/${c.company.id}/merge-queue`)).json() as { running: Array<{ ticketId: string; ci?: { minutes: number; waiting: string[] } }> };
    expect(queue.running).toEqual([expect.objectContaining({ ticketId: c.ticket.id, ci: { minutes: 0, waiting: ["images (arm64)"] } })]);
    expect(c.merges()).toEqual(["prepare", "publish"]);
    // The check passes first; still no merge until CI is green.
    c.release();
    await new Promise((r) => setTimeout(r, 60));
    expect(c.merges()).toEqual(["prepare", "publish"]);
    done = true;
    expect((await approved).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
  });

  it("a token that can't read checks never merges and raises one owner card for the project, before pushing anything", async () => {
    const c = (ctx = await setup());
    c.gh.state.status = 403;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "check_stuck" });
    expect(c.merges()).toEqual(["prepare"]);
    expect((await c.state()).systemState).toBe("review");
    const cards = await c.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(cards).toEqual([expect.objectContaining({ tier: "owner", dedupeKey: `ci-access:${c.project.id}` })]);
    expect(cards[0]!.question).toMatch(/can't read GitHub's checks.*Repository permissions → Checks: Read-only/);
    expect(cards[0]!.context).toMatchObject({ type: "check_stuck", ticketId: c.ticket.id });
    // A second ticket in the project waits on the same card instead of adding its own.
    const second = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${second.id}` }).where(eq(tickets.id, second.id));
    expect((await approveAndWait(c.req, second.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toHaveLength(1);
  });

  it("a checks API that keeps failing is retried, then never merges and raises a card", async () => {
    const c = (ctx = await setup());
    c.gh.state.status = 502;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "check_stuck" });
    // The first read and three retries, all on main's head: nothing was pushed.
    expect(c.gh.calls.filter((u) => u.includes("/check-suites"))).toHaveLength(4);
    expect(c.merges()).toEqual(["prepare"]);
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey, tier: decisions.tier }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `ci-error:${c.project.id}`, tier: "owner" }]);
  });

  it("a billing refusal is the owner's card, not a send-back", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) =>
      sha === MERGE
        ? { suites: [{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }], runs: [{ id: 3, name: "check", status: "completed", conclusion: "failure", output: { title: "", summary: "The job was not started because your account's spending limit needs to be increased." } }] }
        : green();
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect((await c.state()).systemState).toBe("review");
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `ci-billing:${c.project.id}` }]);
  });

  it("a failing test whose name or message mentions billing still goes back to the assignee, with no owner card", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) =>
      sha === MERGE ? { suites: [{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }], runs: [{ id: 7, name: "check", status: "completed", conclusion: "failure" }] } : green();
    c.gh.state.annotations.set(7, [
      { annotation_level: "failure", path: "apps/server/test/billing.test.ts", start_line: 5, title: "billing > spending limit card", message: "AssertionError: payment failed text not matched" },
    ]);
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("apps/server/test/billing.test.ts:5: billing > spending limit card");
  });

  it("no CI run at all after the grace period: merges on its own check and says so", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? { suites: [], runs: [] } : green());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect((await c.events()).some((e) => /didn't start for this push.*own check only/.test(e))).toBe(true);
  });

  it("a merge with no workflows waits for nothing", async () => {
    const c = (ctx = await setup({ workflows: false }));
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.gh.reads.get(MERGE)).toBeUndefined();
    expect((await c.events()).some((e) => /no GitHub workflows/.test(e))).toBe(true);
  });

  it("CI still running at the ceiling: no merge, a card", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? running() : green());
    // The ceiling here is 3 s; approveAndWait gives up at 2 s, so wait for the landing by hand.
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    let landing: { state?: string; outcome?: string } | undefined;
    for (let i = 0; i < 600 && landing?.state !== "finished"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      landing = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
    }
    expect(landing).toMatchObject({ state: "finished", outcome: "check_stuck" });
    expect(c.merges()).toEqual(["prepare", "publish"]);
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `merge-stuck:${c.ticket.id}` }]);
  });

  it("switch off: today's merge, nothing pushed for CI and nothing read from GitHub", async () => {
    const c = (ctx = await setup({ switchOn: false }));
    expect((await c.req("GET", "/api/settings/wait-for-ci")).json()).toEqual({ on: false });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["plain"]);
    expect(c.gh.calls.filter((u) => u.includes("check-"))).toEqual([]);
  });

  describe("with the server check queue (DR-003)", () => {
    const serverMode = (c: Awaited<ReturnType<typeof setup>>) => c.db.insert(settings).values({ key: "check_queue_mode", value: "server" });
    // Plays the dispatcher: ends the next open merge job with the given state.
    const finishJob = async (c: Awaited<ReturnType<typeof setup>>, patch: Record<string, unknown>) => {
      for (let i = 0; i < 100; i++) {
        const open = (await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).find((j) => j.state === "queued" || j.state === "running");
        if (open) {
          await c.db.update(checkJobs).set({ endedAt: new Date(), ...patch }).where(eq(checkJobs.id, open.id));
          return open;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("no job was queued");
    };

    it("CI failing while the queued check runs ends the attempt at once: sent back, nothing merged", async () => {
      const c = (ctx = await setup());
      await serverMode(c);
      c.gh.state.ci = (sha) => (sha === MERGE ? { suites: [{ status: "completed", conclusion: "failure", latest_check_runs_count: 1 }], runs: [{ id: 4, name: "check", status: "completed", conclusion: "failure" }] } : green());
      // The queued job is never finished here: CI's failure alone ends the attempt.
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
      expect(c.merges()).toEqual(["prepare", "publish"]);
      expect(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(1);
      expect((await c.state()).systemState).toBe("in_progress");
    });

    it("main moved to the same merged tree: the CI pass holds, nothing is published again", async () => {
      const c = (ctx = await setup({ finishes: [{ status: "main_moved" }] }));
      await serverMode(c);
      const res = approveAndWait(c.req, c.ticket.id);
      await finishJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
      // Round two built the same tree: its queued check is the passed one again, and CI isn't asked for twice.
      expect(c.merges()).toEqual(["prepare", "publish", "finish", "prepare", "finish", "unpublish"]);
      expect(c.gh.reads.get(MERGE)).toBe(1);
    });

    it("a queued check isn't moved to a new main while CI gates the merge (BOS-1344 retarget stays off)", async () => {
      const c = (ctx = await setup());
      await serverMode(c);
      let done = false;
      c.gh.state.ci = (sha) => (sha === MERGE && !done ? running() : green());
      const res = approveAndWait(c.req, c.ticket.id);
      for (let i = 0; i < 200 && !(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).length; i++) await new Promise((r) => setTimeout(r, 10));
      // Many retarget intervals pass with the job queued: no fresh prepare, since CI was published for this commit only.
      await new Promise((r) => setTimeout(r, 300));
      expect(c.merges()).toEqual(["prepare", "publish"]);
      done = true;
      await finishJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
      expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
    });

    it("with the merge train on too, the merge skips the train and still waits for CI (BOS-1366)", async () => {
      const c = (ctx = await setup({ features: ["carried-check", "ci-publish", "check-jobs", "merge-base"] }));
      await serverMode(c);
      await c.db.insert(settings).values({ key: "merge_train", value: true });
      const res = approveAndWait(c.req, c.ticket.id);
      await finishJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
      // Published and read like any CI-gated merge; no train base was sent, since CI only ever runs on a merge with main.
      expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
      expect(c.gh.reads.get(MERGE)).toBeGreaterThan(0);
      const merges = c.sent.filter((m): m is Extract<RunnerCommand, { type: "workspace.merge" }> => m.type === "workspace.merge");
      expect(merges.some((m) => m.base || m.expectBase)).toBe(false);
    });
  });

  it("a runner too old to publish merges as before and says why", async () => {
    const c = (ctx = await setup({ features: ["carried-check"] }));
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["plain"]);
    expect((await c.events()).some((e) => /runner is too old/.test(e))).toBe(true);
  });
});
