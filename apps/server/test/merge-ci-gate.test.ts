// BOS-1070: the merge gate waits for GitHub CI on the exact merge commit before it merges. A fake GitHub answers the
// Actions run and job reads (BOS-1630) and, only when a test says the token has Checks, the annotation reads; by default it
// is the owner's kind of token (Actions: Read-only, no Checks) and refuses every Checks API read with 403. A fake runner
// answers the split merge (prepare, publish, finish).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

// Hoisted so it is set before review.ts reads it: a landing in server mode re-reads its check job row this often.
// The retarget interval is short too, so a refresh that shouldn't happen (CI gating on) would show within the test.
vi.hoisted(() => {
  process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20";
  process.env.BOSSMAN_MERGE_RETARGET_MS = "20";
  // BOS-1821: a merge waiting for a landing turn asks again only when the gate pushes main, never on the clock, in these tests.
  process.env.BOSSMAN_TURN_WAIT_RECHECK_MS = "600000";
});
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, checkJobs, checkResults, decisions, reviewRequests, settings, ticketDependencies, ticketMessages, tickets, wakes } from "../src/db/schema.js";
import { createLeader } from "../src/leader.js";
import { CANT_RERUN_EXIT, FLAKE_RETRY_KIND, GATE_RERUN_MARK } from "../src/services/ci-flake.js";
import { landingTurns } from "../src/services/landing-turn.js";
import { MERGE_LINE_KIND } from "../src/services/merge-line.js";
import { holdView } from "../src/services/review-holds.js";
import { conversationLines } from "../src/services/ticket-chat.js";
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

type Job = { id: number; name: string; status: string; conclusion: string | null; html_url?: string; runner_name?: string | null; steps?: Array<{ number: number; name: string; status: string; conclusion: string | null; started_at?: string; completed_at?: string }> };
/** One workflow run on the commit and its jobs, as GitHub's Actions API gives them. */
type WorkflowRun = { id: number; name: string; workflow_id: number; event: string; status: string; conclusion: string | null; created_at: string; html_url?: string; jobs: Job[] };
type Ci = { runs: WorkflowRun[] };
const job = (name: string, conclusion: string, id: number, failedStep?: string): Job => ({ id, name, status: "completed", conclusion, runner_name: "GitHub Actions 1", steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }, { number: 2, name: failedStep ?? "Run tests", status: "completed", conclusion: failedStep ? "failure" : "success" }] });
const run = (status: string, conclusion: string | null, jobs: Job[], extra: Partial<WorkflowRun> = {}): WorkflowRun => ({ id: 9, name: "CI", workflow_id: 100, event: "push", status, conclusion, created_at: "2026-11-16T10:00:00Z", html_url: "https://github.com/leon/site/actions/runs/9", jobs, ...extra });
const green = (): Ci => ({ runs: [run("completed", "success", [job("check", "success", 1), job("images (arm64)", "success", 2)])] });
// GitHub makes a job only when it is reached: "images" hasn't begun, yet the run is still in progress, so the gate waits.
const running = (): Ci => ({ runs: [run("in_progress", null, [job("changes", "success", 1)])] });
const red = (jobs: Job[]): Ci => ({ runs: [run("completed", "failure", jobs)] });

/**
 * A fake GitHub: `ci(sha, nth)` says what CI looks like on the nth read of a commit; `status` forces an HTTP error on every
 * read; `checks` (off by default) lets the token read the Checks API, which only the annotations come from.
 */
/** A made-up 40-hex commit id for a branch name. */
const fakeSha = (name: string) => Buffer.from(name).toString("hex").padEnd(40, "0").slice(0, 40);
function fakeGitHub() {
  const calls: string[] = [];
  const reads = new Map<string, number>();
  const state = {
    ci: (_sha: string, _nth: number): Ci => green(),
    status: null as number | null,
    checks: false,
    annotations: new Map<number, unknown[]>(),
    /** A job's log text, or the HTTP status the log read is refused with. Absent: 404. */
    logs: new Map<number, string | number>(),
    /** The runs the CI branch lists (GitHub's `?branch=` read): used to tell a run replaced by a newer push from a lone cancel. */
    branchRuns: [] as Array<{ id: number; head_sha: string; created_at: string; status: string; conclusion: string | null }>,
    reruns: [] as string[],
    rerunStatus: 201,
    /** BOS-1733: "re-run failed jobs" requests, and the status GitHub answers them with. */
    failedReruns: [] as string[],
    failedRerunStatus: 201,
    /** BOS-1733: a public repo: annotations read without a token are answered even when the token has no Checks. */
    publicRepo: false,
    ciBranches: new Map<string, number>(),
    /** BOS-2082: the workflow's recent green runs (`/actions/workflows/<id>/runs?status=success`) and their jobs. */
    greenRuns: [] as Array<{ id: number; jobs: Job[] }>,
    /** BOS-2301: "cancel this run" requests, and the status GitHub answers them with. */
    cancels: [] as string[],
    cancelStatus: 202,
  };
  const last = new Map<number, WorkflowRun>();
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    // BOS-1749: the CI branches on the repo (name -> commit time), listed and deleted by the sweep.
    if (/\/git\/matching-refs\/heads\/bossman-ci\//.test(url)) return json(200, [...state.ciBranches].map(([name]) => ({ ref: `refs/heads/${name}`, object: { sha: fakeSha(name) } })));
    const commit = /\/git\/commits\/([0-9a-f]{40})/.exec(url);
    if (commit) {
      const hit = [...state.ciBranches].find(([name]) => fakeSha(name) === commit[1]);
      return hit ? json(200, { committer: { date: new Date(hit[1]).toISOString() } }) : json(404, {});
    }
    if (init?.method === "DELETE" && /\/git\/refs\/heads\//.test(url)) {
      state.ciBranches.delete(decodeURIComponent(url.split("/git/refs/heads/")[1]!));
      return new Response(null, { status: 204 });
    }
    if (state.status) return json(state.status, { message: "Resource not accessible by personal access token" });
    const authed = !!(init?.headers as Record<string, string> | undefined)?.authorization;
    if (/\/check-runs|\/check-suites/.test(url) && !state.checks && !(state.publicRepo && !authed)) return json(403, { message: "Resource not accessible by personal access token" });
    if (/\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(url)) {
      state.failedReruns.push(url);
      return state.failedRerunStatus === 201 ? json(201, {}) : json(state.failedRerunStatus, { message: "Resource not accessible by personal access token" });
    }
    const runs = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(url);
    const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    const notes = /\/check-runs\/(\d+)\/annotations/.exec(url);
    if (/\/actions\/runs\/\d+\/cancel$/.test(url)) {
      state.cancels.push(url);
      return state.cancelStatus === 202 ? json(202, {}) : json(state.cancelStatus, { message: "Resource not accessible by personal access token" });
    }
    if (/\/actions\/runs\/\d+\/rerun$/.test(url)) {
      state.reruns.push(url);
      return state.rerunStatus === 201 ? json(201, {}) : json(state.rerunStatus, { message: "Resource not accessible by personal access token" });
    }
    if (/\/actions\/runs\?branch=/.test(url)) return json(200, { total_count: state.branchRuns.length, workflow_runs: state.branchRuns });
    if (runs) {
      const sha = runs[1]!;
      const nth = (reads.get(sha) ?? 0) + 1;
      reads.set(sha, nth);
      const list = state.ci(sha, nth).runs;
      for (const r of list) last.set(r.id, r);
      return json(200, { total_count: list.length, workflow_runs: list.map(({ jobs: _jobs, ...r }) => ({ ...r, head_sha: sha })) });
    }
    if (/\/actions\/workflows\/\d+\/runs\?status=success/.test(url)) return json(200, { total_count: state.greenRuns.length, workflow_runs: state.greenRuns.map((r) => ({ id: r.id, status: "completed", conclusion: "success" })) });
    if (jobs) return json(200, { jobs: last.get(Number(jobs[1]))?.jobs ?? state.greenRuns.find((r) => r.id === Number(jobs[1]))?.jobs ?? [] });
    const logUrl = /\/actions\/jobs\/(\d+)\/logs/.exec(url);
    if (logUrl) {
      const l = state.logs.get(Number(logUrl[1]));
      return typeof l === "number" ? json(l, { message: "Resource not accessible by personal access token" }) : l === undefined ? json(404, { message: "Not Found" }) : new Response(l, { status: 200 });
    }
    if (notes) return json(200, state.annotations.get(Number(notes[1])) ?? []);
    return json(404, { message: `no fake for ${url}` });
  }) as typeof globalThis.fetch;
  return { fetch, calls, state, reads };
}

async function setup(opts: { features?: string[]; holdVerify?: boolean; verifyRed?: boolean; workflows?: boolean; switchOn?: boolean; finishes?: unknown[]; prepares?: unknown[]; prepare?: (c: Extract<RunnerCommand, { type: "workspace.merge" }>) => unknown; changed?: string[]; noCiToken?: boolean } = {}) {
  const gh = fakeGitHub();
  const { db, close } = await openPglite();
  // In charge until a test hands over (BOS-1752): `lead.on = false` plays the blue/green switch on this copy.
  const lead = { on: true };
  const leader = { ...createLeader(), isLeader: () => lead.on };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: gh.fetch, leader, ciTiming: { pollMs: 10, graceMs: 60, ceilingMs: 3_000, retryMs: 5 } });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/leon/site.git", verifyCommand: "pnpm test" });
  const { secret } = (await req("POST", "/api/secrets", { name: "GitHub", kind: "generic", value: "github-token-value" })).json();
  await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  // BOS-2285: with no second account's token the gate raises the "CI identity" owner card; the tests below that count
  // open cards run with one granted, and noCiToken tests that card itself.
  if (!opts.noCiToken) {
    const { secret: ciSecret } = (await req("POST", "/api/secrets", { name: "GitHub CI", kind: "generic", value: "made-up-ci-token-value" })).json();
    await req("POST", `/api/secrets/${ciSecret.id}/grants`, { companyId: company.id, envName: "GIT_CI_TOKEN" });
  }
  if (opts.switchOn !== false) expect((await req("PUT", "/api/settings/wait-for-ci", { on: true })).json()).toEqual({ on: true });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  const held: Array<() => void> = [];
  const reply = (c: { requestId: string }, data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data }));
  built.runners.connect(
    reg.runnerId,
    (c) => {
      sent.push(c);
      if (c.type === "workspace.diff") reply(c, { baseCommit: MAIN, head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: (opts.changed ?? ["src/a.ts"]).map((path) => ({ path, added: 1, removed: 0 })), diff: "", truncated: false });
      if (c.type === "workspace.carried") reply(c, { carried: [] });
      if (c.type === "workspace.migrations") reply(c, { needed: false, reason: "No other branch uses this ticket's migration numbers." });
      if (c.type === "workspace.verify") {
        const answer = () => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: opts.verifyRed ? { ok: false, exitCode: 1, timedOut: false, output: "1 test failed in the gate's own check", ms: 5 } : { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 } });
        if (opts.holdVerify) held.push(answer);
        else queueMicrotask(answer);
      }
      if (c.type === "workspace.merge") {
        if (c.phase === "prepare" && opts.prepare) {
          const a = opts.prepare(c) as { runnerError?: string } | null;
          // BOS-2119: a runner that fails the request (the merge attempt throws).
          if (a && typeof a === "object" && a.runnerError) queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: false, error: a.runnerError }));
          else reply(c, a);
        }
        else if (c.phase === "prepare") reply(c, opts.prepares?.length ? opts.prepares.shift() : { status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN });
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
  return { ...built, db, close, req, company, worker, project, ticket, sent, gh, state, merges, events, release, held, lead };
}

describe("the sweep of leftover CI branches (BOS-1749)", () => {
  it("deletes old bossman-ci branches (a restart mid-check left them) and keeps recent ones; no other branch is ever read or deleted", async () => {
    const c = (ctx = await setup());
    const now = Date.now();
    c.gh.state.ciBranches.set("bossman-ci/old-one", now - 7 * 3_600_000);
    c.gh.state.ciBranches.set("bossman-ci/old-two", now - 30 * 3_600_000);
    c.gh.state.ciBranches.set("bossman-ci/recent", now - 30 * 60_000);
    const r = await c.review.sweepCiBranches();
    expect(r.deleted.sort()).toEqual(["bossman-ci/old-one", "bossman-ci/old-two"]);
    expect([...c.gh.state.ciBranches.keys()]).toEqual(["bossman-ci/recent"]);
    expect(c.gh.calls.every((u) => !/heads\/(main|bossman\/)/.test(u))).toBe(true);
    // Run twice: nothing more to delete.
    expect((await c.review.sweepCiBranches()).deleted).toEqual([]);
  });
});

/** BOS-1871: the ticket's ci_wait_* merge-line rows, oldest first. */
const ciWaitRows = async (c: Awaited<ReturnType<typeof setup>>) =>
  (await c.db.select({ detail: activity.detail, at: activity.at }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND))).orderBy(activity.at))
    .map((r) => r.detail as { event: string; outcome?: string })
    .filter((e) => e.event.startsWith("ci_wait_"));

describe("merge gate waits for GitHub CI (BOS-1070)", () => {
  it("BOS-2285: with no second account's token the gate raises one CI identity card and still merges", async () => {
    const c = (ctx = await setup({ noCiToken: true }));
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    const open = await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"));
    expect(open).toEqual([{ dedupeKey: expect.stringContaining("owner-todo:ci-identity:") }]);
  });

  it("publishes the merge commit, merges once CI passes on it, records the pass and deletes the CI branch", async () => {
    const c = (ctx = await setup());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
    expect(c.sent.find((x) => x.type === "workspace.merge" && x.phase === "publish")).toMatchObject({ commit: MERGE });
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: FINAL });
    const ci = await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")));
    expect(ci).toEqual([expect.objectContaining({ sha: MERGE, passed: true })]);
    // The token was tried on main's head before anything was pushed.
    expect(c.gh.calls.findIndex((u) => u.includes(`head_sha=${MAIN}`))).toBeLessThan(c.gh.calls.findIndex((u) => u.includes(`head_sha=${MERGE}`)));
    // The owner's kind of token: nothing was asked of the Checks API, and no card.
    expect(c.gh.calls.filter((u) => /check-runs|check-suites/.test(u))).toEqual([]);
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
    // BOS-1871: the CI wait's start and end are in the merge-line records, the end saying how it ended.
    expect(await ciWaitRows(c)).toEqual([
      { event: "ci_wait_started", commit: MERGE },
      { event: "ci_wait_ended", commit: MERGE, outcome: "passed", waitedMs: expect.any(Number) },
    ]);
  });

  it("a token with Actions: Read-only and no Checks: a red CI goes back naming the failing job and step, with no card (BOS-1630)", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "success", 1), { ...job("images (arm64)", "failure", 7, "Build image"), html_url: "https://github.com/leon/site/actions/runs/9/job/7" }]) : green());
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    expect(res.message).toMatch(/GitHub CI failed .*images \(arm64\)/);
    expect(res.message).not.toMatch(/- check\b/);
    // BOS-1749: a red CI deletes the CI branch at once.
    expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("images (arm64) (https://github.com/leon/site/actions/runs/9/job/7)");
    expect(wake!.note).toContain('failed at step "Build image"');
    // The annotation read was refused (no Checks permission) and that cost nothing: no access card, no billing card.
    expect(c.gh.calls.some((u) => u.includes("/check-runs/7/annotations"))).toBe(true);
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
    expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([expect.objectContaining({ passed: false, detail: "images (arm64)" })]);
    expect((await ciWaitRows(c)).map((e) => `${e.event}:${e.outcome ?? ""}`)).toEqual(["ci_wait_started:", "ci_wait_ended:failed"]);
  });

  it("a red CI goes back with the failed job's log lines, secrets redacted, and says plainly when the log can't be read (BOS-1667)", async () => {
    // Built at run time so the source holds no token-shaped string for the secrets scan to flag.
    const fakeToken = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz", "0123456789ABCD"].join("");
    const redRun = (sha: string) => (sha === MERGE ? red([{ ...job("images (amd64)", "failure", 7, "Shell tests"), html_url: "https://github.com/leon/site/actions/runs/9/job/7" }, { ...job("images (arm64)", "failure", 8, "Shell tests") }]) : green());
    const c = (ctx = await setup());
    c.gh.state.ci = redRun;
    c.gh.state.logs.set(7, ["2026-11-16T10:00:01Z starting", "2026-11-16T10:00:02Z FAIL host-deployer.test.sh: expected 3 got 4", `2026-11-16T10:00:03Z token ${fakeToken} used`, "2026-11-16T10:00:04Z ##[error]Process completed with exit code 1."].join("\n"));
    c.gh.state.logs.set(8, 403);
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("Log lines (secrets redacted):");
    expect(wake!.note).toContain("> FAIL host-deployer.test.sh: expected 3 got 4");
    expect(wake!.note).toContain("> … end of the log:");
    expect(wake!.note).not.toContain(fakeToken);
    expect(wake!.note).toContain("The job log couldn't be read: the git token isn't allowed to read job logs");
    // BOS-1723: the bounce stays readable on the ticket once the wake note is gone: job link and failing lines, redacted.
    await c.db.delete(wakes);
    const talk = (await conversationLines(c.db, c.ticket.id)).join("\n");
    expect(talk).toContain("GitHub CI bounced the merge of this branch");
    expect(talk).toContain("https://github.com/leon/site/actions/runs/9/job/7");
    expect(talk).toContain("FAIL host-deployer.test.sh: expected 3 got 4");
    expect(talk).not.toContain(fakeToken);
  });

  it("a workflow run that failed before any job (a broken workflow file) goes back naming the run", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? { runs: [run("completed", "startup_failure", [])] } : green());
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("- CI (https://github.com/leon/site/actions/runs/9)");
  });

  it("only the newest run of a workflow counts: an older red run replaced by a green re-run merges", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) =>
      sha === MERGE ? { runs: [run("completed", "success", [job("check", "success", 1)], { id: 11, created_at: "2026-11-16T10:05:00Z" }), run("completed", "failure", [job("check", "failure", 2, "Run tests")], { id: 10 })] } : green();
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
  });

  it("doesn't merge a red CI: with Checks readable too, the ticket goes back naming the failing job and test", async () => {
    const c = (ctx = await setup());
    c.gh.state.checks = true;
    c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "success", 1), { ...job("images (arm64)", "failure", 7, "Run tests"), html_url: "https://github.com/leon/site/actions/runs/9/job/7" }]) : green());
    c.gh.state.annotations.set(7, [
      { annotation_level: "failure", path: "apps/server/test/fence.test.ts", start_line: 42, title: "fence > blocks a write outside the clone", message: "AssertionError: expected 0 to be 1" },
      { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
    ]);
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    expect(res.message).toMatch(/GitHub CI failed .*images \(arm64\)/);
    expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
    // BOS-1733: legacy check mode has no gate re-run, so no GitHub retry either: today's send-back.
    expect(c.gh.state.failedReruns).toEqual([]);
    expect(await c.state()).toMatchObject({ systemState: "in_progress", mergeCommit: null });
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("images (arm64) (https://github.com/leon/site/actions/runs/9/job/7)");
    expect(wake!.note).toContain("apps/server/test/fence.test.ts:42: fence > blocks a write outside the clone: AssertionError: expected 0 to be 1");
    expect(wake!.note).not.toContain("Process completed with exit code");
    expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([expect.objectContaining({ passed: false, detail: "images (arm64)" })]);
  });

  // BOS-1643: main's CI broke while this merge's CI ran, and the CEO marked a fix (or linked a waits-on) meanwhile. The red
  // CI is main's, so the ticket stays approved in "Passed, held", as a failed own check does (BOS-1173), and isn't sent back.
  const markedMidCi = async (mark: (c: Awaited<ReturnType<typeof setup>>, fix: string) => Promise<unknown>) => {
    const c = (ctx = await setup());
    const fix = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix main's CI", state: "in_progress" })).json() as { id: string };
    let marked = false;
    c.gh.state.ci = (sha) => (sha === MERGE ? (marked ? red([job("check", "failure", 3, "Run tests")]) : running()) : green());
    const approved = approveAndWait(c.req, c.ticket.id);
    for (let i = 0; i < 300 && !(c.gh.reads.get(MERGE) ?? 0); i++) await new Promise((r) => setTimeout(r, 10));
    await mark(c, fix.id);
    marked = true;
    const res = (await approved).json();
    expect(res).toMatchObject({ outcome: "held", message: expect.stringMatching(/^This ticket's merge waits on .*"Passed, held"/) });
    expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
    expect(await c.state()).toMatchObject({ systemState: "review", mergeCommit: null });
    expect(await holdView(c.db, c.ticket.id)).toMatchObject({ system: true });
    // Not sent back: no wake for the author, no loop failure, no CI failure recorded against the ticket.
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
    expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([]);
  };

  it("a red CI after a merge-check fix was marked mid-CI holds the ticket instead of sending it back (BOS-1643)", async () => {
    await markedMidCi((c, fix) => c.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, fix)));
  });

  it("a red CI after a waits-on link was added mid-CI holds the ticket instead of sending it back (BOS-1643)", async () => {
    await markedMidCi((c, fix) => c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerTicketId: fix }));
  });

  // R40 (BOS-1685): once a GitHub-only red holds only what touches it, a released ticket's GitHub run still fails in
  // main's red job. That failure is main's, and the ticket merges on the gate's own check, only when every condition
  // holds: the failure matches main's open red exactly, the branch doesn't touch it, and the gate's own check passed.
  describe("a failure that is only main's known GitHub-only red (R40)", () => {
    const FENCE = { annotation_level: "failure", path: "apps/server/test/fence.test.ts", start_line: 42, title: "fence > blocks a write", message: "AssertionError: expected 0 to be 1" };
    const knownRed = async (o: Parameters<typeof setup>[0] = {}, annotations: unknown[] = [FENCE], failing = job("check", "failure", 7, "Run tests")) => {
      const c = (ctx = await setup({ changed: ["apps/web/src/page.tsx"], ...o }));
      const fix = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Main's CI is failing: CI / check / Run tests", state: "in_progress" })).json() as { id: string };
      await c.db.insert(settings).values({ key: `main_ci:${c.project.id}`, value: { status: { state: "failing", detail: "", at: "" }, seen: {}, open: { "ci / check / run tests": { ticketId: fix.id, workflow: "CI", runs: [], job: "check", step: "Run tests", named: ["test/fence.test.ts"], scope: [".github/workflows/ci.yml", "apps/server/"] } } } });
      c.gh.state.checks = true;
      c.gh.state.annotations.set(failing.id, annotations);
      c.gh.state.ci = (sha) => (sha === MERGE ? red([failing]) : green());
      return c;
    };
    const ciRows = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")));

    it("an exact match, on a branch that doesn't touch it, merges on the gate's own check: recorded, and no CI pass row", async () => {
      const c = await knownRed();
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
      expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: FINAL });
      expect((await c.events()).some((e) => /GitHub CI failed only in check, which also fails on main/.test(e))).toBe(true);
      expect(await ciRows(c)).toEqual([]);
      expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
    });

    it("a failing test main's red doesn't name: sent back", async () => {
      const c = await knownRed({}, [FENCE, { ...FENCE, path: "apps/server/test/new.test.ts" }]);
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    });

    it("another failing job: sent back", async () => {
      const c = await knownRed({}, [FENCE], job("images (arm64)", "failure", 8, "Run tests"));
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    });

    it("a branch that touches the red's files: sent back", async () => {
      const c = await knownRed({ changed: ["apps/server/src/fence.ts"] });
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    });

    it("the gate's own check fails: not merged, and not taken as main's", async () => {
      const c = await knownRed({ verifyRed: true });
      expect((await approveAndWait(c.req, c.ticket.id)).json()).not.toMatchObject({ outcome: "merged" });
      expect((await c.state()).mergeCommit).toBeNull();
      expect((await c.events()).some((e) => /also fails on main/.test(e))).toBe(false);
    });

    it("main's red closed (its ticket done): sent back as before", async () => {
      const c = await knownRed();
      await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.title, "Main's CI is failing: CI / check / Run tests"));
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    });
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
    expect(queue.running).toEqual([expect.objectContaining({ ticketId: c.ticket.id, ci: { minutes: 0, waiting: ["CI"] } })]);
    expect(c.merges()).toEqual(["prepare", "publish"]);
    // The check passes first; still no merge until CI is green.
    c.release();
    await new Promise((r) => setTimeout(r, 60));
    expect(c.merges()).toEqual(["prepare", "publish"]);
    done = true;
    expect((await approved).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
    // Waited and merged with the owner's kind of token (Checks refused): no card at any point.
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
  });

  it("a token that can't read Actions runs never merges and raises one owner card for the project, before pushing anything", async () => {
    const c = (ctx = await setup());
    c.gh.state.status = 403;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "check_stuck" });
    expect(c.merges()).toEqual(["prepare"]);
    expect((await c.state()).systemState).toBe("review");
    const cards = await c.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(cards).toEqual([expect.objectContaining({ tier: "owner", dedupeKey: `ci-access:${c.project.id}` })]);
    // BOS-1873: only the owner can change the token, so it carries no CEO ladder.
    expect((cards[0]!.context as { ladder?: unknown }).ladder).toBeUndefined();
    expect(cards[0]!.question).toMatch(/can't read GitHub Actions runs.*Repository permissions → Actions: Read-only/);
    // No GitHub Checks permission named ("Settings → Server and runner → Checks" is Boss Man's own page).
    expect(cards[0]!.question).not.toMatch(/Checks:/);
    expect(cards[0]!.context).toMatchObject({ type: "check_stuck", ticketId: c.ticket.id });
    // A second ticket in the project waits on the same card instead of adding its own.
    const second = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${second.id}` }).where(eq(tickets.id, second.id));
    expect((await approveAndWait(c.req, second.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toHaveLength(1);
  });

  it("an Actions API that keeps failing is retried, then never merges and raises a card, with the CEO first (BOS-1873)", async () => {
    const c = (ctx = await setup());
    c.gh.state.status = 502;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "check_stuck" });
    // The first read and three retries, all on main's head: nothing was pushed.
    expect(c.gh.calls.filter((u) => u.includes(`/actions/runs?head_sha=${MAIN}`))).toHaveLength(4);
    expect(c.merges()).toEqual(["prepare"]);
    const open = await c.db.select({ dedupeKey: decisions.dedupeKey, tier: decisions.tier, context: decisions.context }).from(decisions).where(eq(decisions.status, "open"));
    expect(open).toEqual([expect.objectContaining({ dedupeKey: `ci-error:${c.project.id}`, tier: "ceo" })]);
    // A GitHub outage needs no token or money: the CEO retries it first, and it reaches the owner only after the handover.
    expect((open[0]!.context as { ladder?: unknown }).ladder).toMatchObject({ rung: "ceo", minutes: 60 });
  });

  // GitHub's jobs data for a job it refused to start: failed, no steps, no runner.
  const unstarted = (id: number): Job => ({ id, name: "check", status: "completed", conclusion: "failure", runner_name: null, steps: [] });

  it("a billing refusal is the owner's card, not a send-back: read from the annotation when Checks is readable", async () => {
    const c = (ctx = await setup());
    c.gh.state.checks = true;
    c.gh.state.ci = (sha) => (sha === MERGE ? red([unstarted(3)]) : green());
    c.gh.state.annotations.set(3, [{ annotation_level: "failure", path: ".github", message: "The job was not started because your account's spending limit needs to be increased." }]);
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect((await c.state()).systemState).toBe("review");
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `ci-billing:${c.project.id}` }]);
  });

  it("a billing refusal with Actions: Read-only only: a job that never started is the owner's billing card (BOS-1630)", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? red([unstarted(3)]) : green());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `ci-billing:${c.project.id}` }]);
  });

  it("a job cancelled before it started is a send-back, not a billing card", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? red([{ ...unstarted(3), conclusion: "cancelled" }]) : green());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
  });

  // The cancelled-run cases: GitHub stops a run when a newer run on the same branch replaces it. Nothing was tested, so it's never a send-back.
  const cancelledRun = (): Ci => ({ runs: [run("completed", "cancelled", [{ ...job("check", "cancelled", 1), steps: [] }])] });
  const landingEnds = async (c: NonNullable<typeof ctx>) => {
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    let landing: { state?: string; outcome?: string } | undefined;
    for (let i = 0; i < 600 && landing?.state !== "finished"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      landing = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
    }
    return landing;
  };

  it("a run cancelled because a newer run on the CI branch replaced it is no failure: nothing goes back and no card", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? cancelledRun() : green());
    c.gh.state.branchRuns = [
      { id: 10, head_sha: "9".repeat(40), created_at: "2026-11-16T10:05:00Z", status: "in_progress", conclusion: null },
      { id: 9, head_sha: MERGE, created_at: "2026-11-16T10:00:00Z", status: "completed", conclusion: "cancelled" },
    ];
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    for (let i = 0; i < 300 && !(await c.events()).some((e) => /newer run/.test(e)); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await c.events()).some((e) => /replaced it\. No test failed/.test(e))).toBe(true);
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
    expect(c.gh.state.reruns).toEqual([]);
  });

  it("a run cancelled with no newer run is run once more, and merges when that passes", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha, nth) => (sha === MERGE ? (nth < 2 ? cancelledRun() : green()) : green());
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.gh.state.reruns).toEqual([`${API}/actions/runs/9/rerun`]);
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
  });

  it("a run cancelled with no newer run and a refused re-run says plainly that GitHub cancelled it, with a card and no send-back", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? cancelledRun() : green());
    c.gh.state.rerunStatus = 403;
    expect(await landingEnds(c)).toMatchObject({ state: "finished", outcome: "check_stuck" });
    expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
    expect((await c.events()).some((e) => /GitHub cancelled the run/.test(e))).toBe(true);
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `merge-stuck:${c.ticket.id}` }]);
  });

  it("a failing test whose name or message mentions billing still goes back to the assignee, with no owner card", async () => {
    const c = (ctx = await setup());
    c.gh.state.checks = true;
    c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "failure", 7, "Run tests")]) : green());
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
    c.gh.state.ci = (sha) => (sha === MERGE ? { runs: [] } : green());
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
    expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `merge-stuck:${c.ticket.id}` }]);
  });

  it("switch off: today's merge, nothing pushed for CI and nothing read from GitHub", async () => {
    const c = (ctx = await setup({ switchOn: false }));
    expect((await c.req("GET", "/api/settings/wait-for-ci")).json()).toEqual({ on: false });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["plain"]);
    expect(c.gh.calls.filter((u) => /check-|\/actions\//.test(u))).toEqual([]);
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
      c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "failure", 4, "Run tests")]) : green());
      // The queued job is never finished here: CI's failure alone ends the attempt.
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
      expect(c.merges()).toEqual(["prepare", "publish", "unpublish"]);
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

    it("an older runner (no merge-refresh): a queued check isn't moved to a new main while CI gates the merge (BOS-1344 retarget stays off)", async () => {
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

    // BOS-1752: after a blue/green hand-over the old copy's merge loop kept polling the shared check job. It wrote a second
    // check_started, then a check_ended while the job ran on (the new leader's CI push superseded its run), and acted on CI.
    describe("a copy that handed over leaves the merge to the server now in charge (BOS-1752)", () => {
      const lineEvents = async (c: NonNullable<typeof ctx>) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => (r.detail as { event: string }).event);
      const landing = async (c: NonNullable<typeof ctx>) => (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing as { state?: string; outcome?: string } | undefined;
      const jobs = (c: NonNullable<typeof ctx>) => c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      /** Approves, waits for the merge's check job to be queued, then hands over: this copy is no longer in charge. */
      const approveThenHandOver = async (c: NonNullable<typeof ctx>, before?: () => Promise<void>) => {
        await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
        await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(1), { timeout: 5_000 });
        await before?.();
        c.lead.on = false;
      };
      /** What a standby must never leave: line rows past the hand-over, retries, cards, send-backs or a cancelled job. */
      const leftNothing = async (c: NonNullable<typeof ctx>) => {
        await vi.waitFor(async () => expect(await landing(c)).toMatchObject({ state: "finished", outcome: "check_stuck" }), { timeout: 5_000 });
        expect((await lineEvents(c)).filter((e) => e === "check_ended" || e === "attempt_failed")).toEqual([]);
        expect((await c.db.select({ kind: activity.kind }).from(activity).where(eq(activity.ticketId, c.ticket.id))).filter((a) => a.kind === "merge_check_lock_wait")).toEqual([]);
        expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
        expect(await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id))).toEqual([]);
        expect((await c.state()).systemState).toBe("review");
        expect(c.merges()).not.toContain("finish");
        // BOS-2301: nor cancels a GitHub run: the server now in charge may be waiting on the same commit.
        expect(c.gh.state.cancels).toEqual([]);
      };

      it("the new leader's CI push supersedes this copy's run: no check_ended, no retry, and the job is left queued for the leader", async () => {
        const c = (ctx = await setup());
        await serverMode(c);
        let handed = false;
        c.gh.state.ci = (sha) => (sha === MERGE ? (handed ? cancelledRun() : running()) : green());
        await approveThenHandOver(c, async () => {
          c.gh.state.branchRuns = [
            { id: 10, head_sha: "9".repeat(40), created_at: "2026-11-16T10:05:00Z", status: "in_progress", conclusion: null },
            { id: 9, head_sha: MERGE, created_at: "2026-11-16T10:00:00Z", status: "completed", conclusion: "cancelled" },
          ];
          handed = true;
        });
        await leftNothing(c);
        expect((await jobs(c)).map((j) => j.state)).toEqual(["queued"]);
        expect(c.gh.state.reruns).toEqual([]);
      });

      it("a red CI read after the hand-over sends nothing back: the leader reads CI on its own commit", async () => {
        const c = (ctx = await setup());
        await serverMode(c);
        let handed = false;
        c.gh.state.ci = (sha) => (sha === MERGE ? (handed ? red([job("check", "failure", 4, "Run tests")]) : running()) : green());
        await approveThenHandOver(c, async () => {
          handed = true;
        });
        await leftNothing(c);
        expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([]);
      });

      it("without CI: a job that passes after the hand-over is not landed or recorded by this copy", async () => {
        const c = (ctx = await setup({ switchOn: false }));
        await serverMode(c);
        // No dispatcher runs here: the test plays it, starting the job while this copy is in charge and passing it right
        // after the hand-over, before the copy's next poll (the race the real hand-over has).
        await approveThenHandOver(c, async () => {
          const [j] = await jobs(c);
          await c.db.update(checkJobs).set({ state: "running", startedAt: new Date() }).where(eq(checkJobs.id, j!.id));
          await vi.waitFor(async () => expect(await lineEvents(c)).toContain("check_started"), { timeout: 5_000 });
        });
        const [j] = await jobs(c);
        await c.db.update(checkJobs).set({ state: "passed", exitCode: 0, endedAt: new Date() }).where(eq(checkJobs.id, j!.id));
        await leftNothing(c);
        expect((await lineEvents(c)).filter((e) => e === "check_started")).toHaveLength(1);
      });

      it("handed over while waiting for another ticket's landing turn (BOS-1762): this copy never pushes", async () => {
        const c = (ctx = await setup({ features: ["carried-check", "ci-publish", "merge-carry"] }));
        await serverMode(c);
        const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Hot-file change", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
        landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000);
        expect(landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000).turn).toBe("taken");
        try {
          await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
          await finishJob(c, { state: "passed", exitCode: 0 });
          await vi.waitFor(async () => expect(await lineEvents(c)).toContain("hold_started"), { timeout: 20_000 });
          c.lead.on = false;
          await vi.waitFor(async () => expect(await landing(c)).toMatchObject({ state: "finished", outcome: "check_stuck" }), { timeout: 5_000 });
          expect(c.merges()).not.toContain("finish");
          expect((await c.state()).systemState).toBe("review");
        } finally {
          landingTurns.done(c.project.id, other.id);
        }
      });
    });

    describe("carrying a passed merge across a main move (BOS-1762)", () => {
      const CARRY = ["carried-check", "ci-publish", "merge-carry"];
      const MERGE2 = "d".repeat(40);
      const TREE2 = "9".repeat(40);
      const NEW_MAIN = "8".repeat(40);
      const finishes = (c: Awaited<ReturnType<typeof setup>>) => c.sent.filter((m): m is Extract<RunnerCommand, { type: "workspace.merge" }> => m.type === "workspace.merge" && m.phase === "finish");
      const lineEvents = async (c: Awaited<ReturnType<typeof setup>>) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, "merge_line")))).map((r) => r.detail as { event: string; [k: string]: unknown });

      it("main moved without touching the ticket's files: lands at once, with no new prepare, check or GitHub run, and says so", async () => {
        const carried = { from: MAIN, to: NEW_MAIN, commits: 2, files: 3 };
        const c = (ctx = await setup({ features: CARRY, finishes: [{ status: "merged", commit: FINAL, checked: { sha: MERGE, tree: TREE, ms: 0 }, carried }] }));
        await serverMode(c);
        const res = approveAndWait(c.req, c.ticket.id);
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
        expect(finishes(c)[0]).toMatchObject({ carry: true, commit: MERGE, tree: TREE });
        expect(c.gh.reads.get(MERGE)).toBe(1);
        expect(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(1);
        expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: FINAL });
        expect((await lineEvents(c)).find((e) => e.event === "carried_across")).toMatchObject(carried);
        const note = (await c.db.select({ summary: activity.summary }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, "merge_carried"))))[0]?.summary;
        expect(note).toMatch(/2 commits .* touch 3 files, none of this ticket's/);
      });

      it("main moved touching the ticket's files: built, checked and run on GitHub again, and the record says why", async () => {
        const c = (ctx = await setup({
          features: CARRY,
          prepares: [{ status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN }, { status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN }],
          finishes: [{ status: "main_moved", notCarried: { why: "main changed files this ticket changes", files: ["src/a.ts"] } }],
        }));
        await serverMode(c);
        const res = approveAndWait(c.req, c.ticket.id);
        await finishJob(c, { state: "passed", exitCode: 0 });
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        expect(c.merges()).toEqual(["prepare", "publish", "finish", "prepare", "publish", "finish", "unpublish"]);
        expect(finishes(c).map((f) => [f.commit, f.carry])).toEqual([[MERGE, true], [MERGE2, true]]);
        expect(c.gh.reads.get(MERGE2)).toBeGreaterThan(0);
        expect(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).toHaveLength(2);
        expect((await lineEvents(c)).find((e) => e.event === "rebuilt")).toMatchObject({ rebuilds: 1, why: "main changed files this ticket changes", files: ["src/a.ts"] });
      });

      it("rebuilt twice after passing: takes the landing turn for its third try, and gives it up once it lands", async () => {
        const TREE3 = "7".repeat(40);
        const MERGE3 = "6".repeat(40);
        const c = (ctx = await setup({
          features: CARRY,
          prepares: [{ status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN }, { status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN }, { status: "prepared", commit: MERGE3, tree: TREE3, targetSha: NEW_MAIN }],
          finishes: [{ status: "main_moved", notCarried: { why: "main changed files this ticket changes" } }, { status: "main_moved", notCarried: { why: "main changed files this ticket changes" } }],
        }));
        await serverMode(c);
        const res = approveAndWait(c.req, c.ticket.id);
        for (let i = 0; i < 3; i++) await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        const ev = await lineEvents(c);
        expect(ev.filter((e) => e.event === "rebuilt").map((e) => e.rebuilds)).toEqual([1, 2]);
        expect(ev.filter((e) => e.event === "landing_turn").map((e) => e.action)).toEqual(["taken", "ended"]);
        expect(landingTurns.check(c.project.id).holder).toBeNull();
      });

      it("a push race the runner calls carryEligible is finished again on the newer main without preparing", async () => {
        const c = (ctx = await setup({ features: CARRY, finishes: [{ status: "main_moved", carryEligible: true }, { status: "merged", commit: FINAL, checked: { sha: MERGE, tree: TREE, ms: 0 }, carried: { from: MAIN, to: NEW_MAIN, commits: 1, files: 1 } }] }));
        await serverMode(c);
        const res = approveAndWait(c.req, c.ticket.id);
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        expect(c.merges()).toEqual(["prepare", "publish", "finish", "finish", "unpublish"]);
      });

      it("switch off, or a runner without merge-carry: finish asks for no carry (today's sequence)", async () => {
        for (const o of [{ features: CARRY, off: true }, { features: ["carried-check", "ci-publish"], off: false }]) {
          const c = (ctx = await setup({ features: o.features }));
          await serverMode(c);
          if (o.off) expect((await c.req("PUT", "/api/settings/merge-carry", { on: false })).json()).toEqual({ on: false, turnMinutes: 60, refresh: true });
          const res = approveAndWait(c.req, c.ticket.id);
          await finishJob(c, { state: "passed", exitCode: 0 });
          expect((await res).json()).toMatchObject({ outcome: "merged" });
          expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
          expect(finishes(c)[0]!.carry).toBeUndefined();
          ctx.release();
          await ctx.app.close();
          await ctx.close();
          ctx = undefined;
        }
      });

      it("never skips the gate's own check: a failed merge check lands nothing and finish is never asked", async () => {
        const c = (ctx = await setup({ features: CARRY }));
        await serverMode(c);
        const res = approveAndWait(c.req, c.ticket.id);
        await finishJob(c, { state: "failed", exitCode: 1, logTail: "1 test failed" });
        expect((await res).json()).not.toMatchObject({ outcome: "merged" });
        expect(finishes(c)).toEqual([]);
        expect((await c.state()).mergeCommit).toBeNull();
      });

      it("never skips GitHub: a red CI lands nothing and finish is never asked", async () => {
        const c = (ctx = await setup({ features: CARRY }));
        await serverMode(c);
        c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "failure", 4, "Run tests")]) : green());
        expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
        expect(finishes(c)).toEqual([]);
      });

      it("never skips the owner's sign-off: a high-risk ticket without it never reaches the merge", async () => {
        const c = (ctx = await setup({ features: CARRY }));
        await serverMode(c);
        await c.db.update(tickets).set({ risk: "high" }).where(eq(tickets.id, c.ticket.id));
        // A landing started without the owner's approval (a sweep or retry): refused before anything is built or pushed.
        await expect(c.review.landOnce(c.ticket.id, "Boss Man")).rejects.toThrow(/sign-off/);
        expect(c.merges()).toEqual([]);
        expect((await c.state()).mergeCommit).toBeNull();
      });

      it.each([
        ["lands", "done"],
        ["leaves review", "left"],
      ] as const)("while another ticket has the landing turn, a passed merge waits to push until that ticket %s", async (_what, how) => {
        const c = (ctx = await setup({ features: CARRY }));
        await serverMode(c);
        const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Hot-file change", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
        landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000);
        expect(landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000).turn).toBe("taken");
        try {
          const res = approveAndWait(c.req, c.ticket.id);
          await finishJob(c, { state: "passed", exitCode: 0 });
          // Wait for the hold to be recorded (a deadline, not a fixed sleep): both checks passed, and the push waits.
          const deadline = Date.now() + 20_000;
          while (!(await lineEvents(c)).some((e) => e.event === "hold_started" && e.hold === "turn") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          expect((await lineEvents(c)).find((e) => e.event === "hold_started")).toMatchObject({ hold: "turn", note: expect.stringContaining("Hot-file change") });
          expect(finishes(c)).toEqual([]);
          if (how === "done") landingTurns.done(c.project.id, other.id);
          else await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, other.id));
          expect((await res).json()).toMatchObject({ outcome: "merged" });
          expect(c.merges()).toEqual(["prepare", "publish", "finish", "unpublish"]);
          expect((await lineEvents(c)).some((e) => e.event === "hold_ended" && e.hold === "turn")).toBe(true);
          expect(landingTurns.check(c.project.id).holder).toBeNull();
        } finally {
          landingTurns.done(c.project.id, other.id);
        }
      });

      it("the switch and the turn's cap are owner settings, on and 60 minutes by default", async () => {
        const c = (ctx = await setup({ features: CARRY }));
        expect((await c.req("GET", "/api/settings/merge-carry")).json()).toEqual({ on: true, turnMinutes: 60, refresh: true });
        expect((await c.req("PUT", "/api/settings/merge-carry", { turnMinutes: 0 })).json()).toEqual({ on: true, turnMinutes: 0, refresh: true });
        expect((await c.req("PUT", "/api/settings/merge-carry", { turnMinutes: 999 })).statusCode).toBe(400);
        // BOS-1900: the merge_retarget switch (rebuild a waiting merge on a moved main) has its own field, stored as before.
        expect((await c.req("PUT", "/api/settings/merge-carry", { refresh: false })).json()).toEqual({ on: true, turnMinutes: 0, refresh: false });
        expect((await c.db.select().from(settings).where(eq(settings.key, "merge_retarget")))[0]?.value).toBe(false);
        expect((await c.req("PUT", "/api/settings/merge-carry", { refresh: "no" })).statusCode).toBe(400);
        expect((await c.req("PUT", "/api/settings/merge-carry", { refresh: true })).json()).toMatchObject({ refresh: true });
      });
    });

    // BOS-1820: on 18 Nov 14 of 16 rebuilt merges had passed their check and GitHub run on a merge the carry rule already
    // refused (main changed scripts/check-test-lines.mjs while they waited hours for a slot). With CI gating, a queued merge is
    // now asked, while it waits, whether its pass could still be carried; a refusal moves the job to the new merge (same place)
    // and restarts GitHub on it, before the check starts.
    describe("refreshing a queued merge the carry would refuse (BOS-1820)", () => {
      const REFRESH = ["carried-check", "ci-publish", "merge-carry", "merge-refresh"];
      const MERGE2 = "d".repeat(40);
      const TREE2 = "9".repeat(40);
      const NEW_MAIN = "8".repeat(40);
      const mergeCmds = (c: Awaited<ReturnType<typeof setup>>) => c.sent.filter((m): m is Extract<RunnerCommand, { type: "workspace.merge" }> => m.type === "workspace.merge");
      const lineEvents = async (c: Awaited<ReturnType<typeof setup>>) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => r.detail as { event: string; [k: string]: unknown });
      const jobs = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      /** The first prepare builds the old merge; every later one (the refresh polls) finds main moved to `later`. */
      const preparesThen = (later: Record<string, unknown>) => [{ status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN }, ...Array.from({ length: 200 }, () => ({ status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN, ...later }))];
      const refused = { ok: false, why: "main changed dependencies, build, CI or migration files", files: ["scripts/check-x.mjs"] };

      it("main changed an always-re-test file while the check waited: the one job takes the new merge before it starts, GitHub runs on it, and it lands with no rebuild", async () => {
        const c = (ctx = await setup({ features: REFRESH, prepares: preparesThen({ carry: refused }), finishes: [{ status: "merged", commit: FINAL, checked: { sha: MERGE2, tree: TREE2, ms: 0 } }] }));
        await serverMode(c);
        // The old merge's GitHub run never ends on its own; the new one passes.
        c.gh.state.ci = (sha) => (sha === MERGE ? running() : green());
        const res = approveAndWait(c.req, c.ticket.id);
        await vi.waitFor(async () => expect((await lineEvents(c)).map((e) => e.event)).toContain("refreshed"), { timeout: 10_000 });
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        // One job, moved in place to the new merge.
        const js = await jobs(c);
        expect(js).toHaveLength(1);
        expect(js[0]).toMatchObject({ commit: MERGE2, tree: TREE2 });
        // The refresh asked about the old merge; GitHub got the new commit, after the old CI branch was deleted.
        const cmds = mergeCmds(c);
        expect(cmds.filter((m) => m.phase === "prepare")[1]).toMatchObject({ carryFrom: { commit: MERGE, tree: TREE } });
        const steps = cmds.filter((m) => m.phase !== "prepare").map((m) => (m.phase === "publish" ? `publish ${m.commit!.slice(0, 1)}` : m.phase));
        expect(steps).toEqual(["publish e", "unpublish", "publish d", "finish", "unpublish"]);
        // BOS-2301: the old copy's run, still going, was cancelled rather than left to finish with nobody waiting.
        expect(c.gh.state.cancels).toEqual([`${API}/actions/runs/9/cancel`]);
        expect(cmds.find((m) => m.phase === "finish")).toMatchObject({ commit: MERGE2, tree: TREE2, carry: true });
        expect(c.gh.reads.get(MERGE2)).toBeGreaterThan(0);
        // Recorded as a refresh, never as a rebuild, and it earned no landing turn.
        const ev = await lineEvents(c);
        expect(ev.find((e) => e.event === "refreshed")).toMatchObject({ why: refused.why, files: refused.files, refreshes: 1 });
        expect(ev.filter((e) => e.event === "rebuilt" || e.event === "landing_turn")).toEqual([]);
        expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: FINAL });
      });

      it("main moved but the pass could still be carried: nothing is moved or published again, and finish carries it", async () => {
        const c = (ctx = await setup({ features: REFRESH, prepares: preparesThen({ carry: { ok: true } }) }));
        await serverMode(c);
        let done = false;
        c.gh.state.ci = (sha) => (sha === MERGE && !done ? running() : green());
        const res = approveAndWait(c.req, c.ticket.id);
        // Several refresh polls answer "carry ok" while the job waits.
        await vi.waitFor(() => expect(mergeCmds(c).filter((m) => m.phase === "prepare").length).toBeGreaterThan(2), { timeout: 10_000 });
        done = true;
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        expect((await jobs(c))[0]).toMatchObject({ commit: MERGE, tree: TREE });
        expect(mergeCmds(c).filter((m) => m.phase !== "prepare").map((m) => m.phase)).toEqual(["publish", "finish", "unpublish"]);
        expect(mergeCmds(c).find((m) => m.phase === "finish")).toMatchObject({ commit: MERGE, carry: true });
        expect(c.gh.reads.get(MERGE2)).toBeUndefined();
        expect((await lineEvents(c)).filter((e) => e.event === "refreshed")).toEqual([]);
      });

      it("the owner's merge_retarget switch off: no refresh is asked for (today's sequence)", async () => {
        const c = (ctx = await setup({ features: REFRESH, prepares: preparesThen({ carry: refused }) }));
        await serverMode(c);
        // BOS-1900: turned off the way the owner does it, with the Settings → Checks switch's route.
        expect((await c.req("PUT", "/api/settings/merge-carry", { refresh: false })).json()).toMatchObject({ refresh: false });
        let done = false;
        c.gh.state.ci = (sha) => (sha === MERGE && !done ? running() : green());
        const res = approveAndWait(c.req, c.ticket.id);
        await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(1), { timeout: 5_000 });
        // Many refresh intervals pass with the job queued.
        await vi.waitFor(() => expect(c.gh.reads.get(MERGE) ?? 0).toBeGreaterThan(5), { timeout: 5_000 });
        expect(mergeCmds(c).map((m) => m.phase)).toEqual(["prepare", "publish"]);
        done = true;
        await finishJob(c, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
      });
    });

    // BOS-1821: on 18 Nov merges that passed while another ticket held the landing turn learned only when the turn ended
    // (up to 65 minutes later) that main had moved under them in a way the carry refuses, or that they conflicted. The merge
    // now asks the runner's carry question (BOS-1820) when its wait starts and whenever the gate pushes main.
    // GitHub CI gating is off here, so the only prepares that carry `carryFrom` are the turn-wait asks.
    describe("a merge waiting for another ticket's landing turn asks whether it can still be carried (BOS-1821)", () => {
      const REFRESH = ["carried-check", "ci-publish", "merge-carry", "merge-refresh"];
      const MERGE2 = "d".repeat(40);
      const TREE2 = "9".repeat(40);
      const NEW_MAIN = "8".repeat(40);
      const refused = { ok: false, why: "main changed dependencies, build, CI or migration files", files: ["scripts/check-x.mjs"] };
      type MergeCmd = Extract<RunnerCommand, { type: "workspace.merge" }>;
      const mergeCmds = (c: Awaited<ReturnType<typeof setup>>) => c.sent.filter((m): m is MergeCmd => m.type === "workspace.merge");
      const asks = (c: Awaited<ReturnType<typeof setup>>) => mergeCmds(c).filter((m) => m.phase === "prepare" && m.carryFrom);
      const finishes = (c: Awaited<ReturnType<typeof setup>>) => mergeCmds(c).filter((m) => m.phase === "finish");
      const lineEvents = async (c: Awaited<ReturnType<typeof setup>>) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => r.detail as { event: string; [k: string]: unknown });
      const jobs = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      const landing = async (c: Awaited<ReturnType<typeof setup>>) => (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing as { state?: string; outcome?: string } | undefined;
      const finished = async (c: Awaited<ReturnType<typeof setup>>) => {
        await vi.waitFor(async () => expect((await landing(c))?.state).toBe("finished"), { timeout: 20_000 });
        return (await landing(c))!;
      };
      /**
       * The runner: a turn-wait ask (carryFrom) gets `wait`; a plain prepare builds the old merge until an ask was refused,
       * then the new one (the rebuild). The BOS-1344 queue-time refresh is a plain prepare, so it finds the same tree.
       */
      const runner = (wait: () => Record<string, unknown>) => {
        let moved = false;
        return (m: MergeCmd) => {
          if (m.carryFrom) {
            const a = wait();
            if ((a.carry as { ok?: boolean } | undefined)?.ok === false) moved = true;
            return a;
          }
          return moved ? { status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN } : { status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN };
        };
      };
      /** Another ticket in review holds the project's landing turn. */
      const holdTurn = async (c: Awaited<ReturnType<typeof setup>>) => {
        const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Hot-file change", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
        landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000);
        expect(landingTurns.rebuilt(c.project.id, other.id, 60 * 60_000).turn).toBe("taken");
        return other;
      };
      /** Approves, passes the merge's check, and waits until the push is held behind the other ticket's turn. */
      const passAndHold = async (c: Awaited<ReturnType<typeof setup>>) => {
        await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
        await finishJob(c, { state: "passed", exitCode: 0 });
        await vi.waitFor(async () => expect((await lineEvents(c)).some((e) => e.event === "hold_started" && e.hold === "turn")).toBe(true), { timeout: 20_000 });
      };
      /** The wait loop goes round `n` more times (it reads the turn on every round): a deadline poll, not a fixed sleep. */
      const rounds = async (spy: { mock: { calls: unknown[] } }, n: number) => {
        const from = spy.mock.calls.length;
        await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(from + n), { timeout: 20_000 });
      };

      it("main changed a file the carry refuses while it waited: rebuilt and queued again before the other ticket's turn ends", async () => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner(() => ({ status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN, carry: refused })) }));
        await serverMode(c);
        const other = await holdTurn(c);
        try {
          await passAndHold(c);
          // The proof: the rebuild and its new check happen while the other ticket still holds the turn.
          await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(2), { timeout: 20_000 });
          expect(landingTurns.check(c.project.id).holder?.ticketId).toBe(other.id);
          const ev = await lineEvents(c);
          expect(ev.find((e) => e.event === "rebuilt")).toMatchObject({ rebuilds: 1, why: refused.why, files: refused.files });
          expect(ev.filter((e) => e.event === "check_queued")).toHaveLength(2);
          expect(ev.some((e) => e.event === "hold_ended" && e.hold === "turn")).toBe(true);
          // The old merge was never pushed or finished; the ask named it.
          expect(finishes(c)).toEqual([]);
          expect(asks(c)[0]).toMatchObject({ carryFrom: { commit: MERGE, tree: TREE } });
          const note = (await c.db.select({ summary: activity.summary }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, "merge_check_lock_wait")))).map((a) => a.summary);
          expect(note.join("\n")).toMatch(/scripts\/check-x\.mjs while this merge waited for another ticket's landing turn/);
          // The turn ends; the rebuilt merge's check passes and it lands.
          landingTurns.done(c.project.id, other.id);
          await finishJob(c, { state: "passed", exitCode: 0 });
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          expect(finishes(c).map((f) => f.commit)).toEqual([MERGE2]);
        } finally {
          landingTurns.done(c.project.id, other.id);
        }
      });

      it("a pass that can still be carried: asked once, again only when the gate pushes main, and finish carries it when the turn ends", async () => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner(() => ({ status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN, carry: { ok: true } })) }));
        await serverMode(c);
        const other = await holdTurn(c);
        const spy = vi.spyOn(landingTurns, "check");
        try {
          await passAndHold(c);
          await vi.waitFor(() => expect(asks(c)).toHaveLength(1), { timeout: 20_000 });
          await rounds(spy, 10);
          expect(asks(c)).toHaveLength(1);
          // Another ticket's merge pushed main.
          landingTurns.landed(c.project.id);
          await vi.waitFor(() => expect(asks(c)).toHaveLength(2), { timeout: 20_000 });
          await rounds(spy, 10);
          expect(asks(c)).toHaveLength(2);
          landingTurns.done(c.project.id, other.id);
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          expect(finishes(c)).toHaveLength(1);
          expect(finishes(c)[0]).toMatchObject({ commit: MERGE, tree: TREE, carry: true });
          expect(await jobs(c)).toHaveLength(1);
          expect((await lineEvents(c)).filter((e) => e.event === "rebuilt")).toEqual([]);
        } finally {
          spy.mockRestore();
          landingTurns.done(c.project.id, other.id);
        }
      });

      it("a conflict found while it waited goes back to the author at once, before the turn ends, and nothing is pushed", async () => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner(() => ({ status: "conflicts", files: ["src/a.ts"] })) }));
        await serverMode(c);
        const other = await holdTurn(c);
        try {
          await passAndHold(c);
          expect(await finished(c)).toMatchObject({ outcome: "conflicts" });
          expect(landingTurns.check(c.project.id).holder?.ticketId).toBe(other.id);
          expect(finishes(c)).toEqual([]);
          expect((await c.state()).systemState).toBe("in_progress");
        } finally {
          landingTurns.done(c.project.id, other.id);
        }
      });

      it.each([
        ["a runner without merge-refresh", ["carried-check", "ci-publish", "merge-carry"], false],
        ["the owner's merge_retarget switch off", REFRESH, true],
      ] as const)("%s: nothing is asked while it waits, and finish decides when the turn ends (today's sequence)", async (_what, features, off) => {
        const c = (ctx = await setup({ features: [...features], switchOn: false, prepare: runner(() => ({ status: "prepared", commit: MERGE2, tree: TREE2, targetSha: NEW_MAIN, carry: refused })) }));
        await serverMode(c);
        if (off) await c.db.insert(settings).values({ key: "merge_retarget", value: false });
        const other = await holdTurn(c);
        const spy = vi.spyOn(landingTurns, "check");
        try {
          await passAndHold(c);
          await rounds(spy, 10);
          expect(asks(c)).toEqual([]);
          landingTurns.done(c.project.id, other.id);
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          expect(finishes(c).map((f) => f.commit)).toEqual([MERGE]);
        } finally {
          spy.mockRestore();
          landingTurns.done(c.project.id, other.id);
        }
      });
    });

    // BOS-2119: on 19 Nov eight tickets went "landing_turn queued" behind 0e87d19a and each built and queued a new check at
    // once. 0e87d19a's own landing then moved main under them: c5008b3b and 9c9b4596 were rebuilt a third time and ran out
    // of rounds (main_moved). A merge in line for the turn now waits for it before it builds its next round.
    // GitHub CI gating is off; every turn-wait ask (carryFrom) is refused, so each wait to push ends in a rebuild.
    describe("a ticket queued for the landing turn waits to re-prepare (BOS-2119)", () => {
      const REFRESH = ["carried-check", "ci-publish", "merge-carry", "merge-refresh"];
      const HOUR = 60 * 60_000;
      const refused = { ok: false, why: "main changed files this ticket changes", files: ["src/a.ts"] };
      type MergeCmd = Extract<RunnerCommand, { type: "workspace.merge" }>;
      type C = Awaited<ReturnType<typeof setup>>;
      const mergeCmds = (c: C) => c.sent.filter((m): m is MergeCmd => m.type === "workspace.merge");
      const plainPrepares = (c: C) => mergeCmds(c).filter((m) => m.phase === "prepare" && !m.carryFrom);
      const finishes = (c: C) => mergeCmds(c).filter((m) => m.phase === "finish");
      const lineEvents = async (c: C) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => r.detail as { event: string; [k: string]: unknown });
      const jobs = (c: C) => c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      const landing = async (c: C) => (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing as { state?: string; outcome?: string } | undefined;
      const finished = async (c: C) => {
        await vi.waitFor(async () => expect((await landing(c))?.state).toBe("finished"), { timeout: 20_000 });
        return (await landing(c))!;
      };
      const tree = (k: number) => `${k}`.repeat(39) + "f";
      const commit = (k: number) => `${k}`.repeat(39) + "e";
      /**
       * The runner: main moves under the merge on every turn-wait ask (the carry is refused, with the next merge's tree); a
       * plain prepare builds the merge for the main of the latest refusal. While `fail()` says so, a plain prepare is a runner error.
       */
      const runner = (fail?: () => boolean) => {
        let refusals = 0;
        return (m: MergeCmd) => {
          if (m.carryFrom) {
            refusals++;
            return { status: "prepared", commit: commit(refusals), tree: tree(refusals), targetSha: MAIN, carry: refused };
          }
          if (fail?.()) return { runnerError: "the runner lost its workspace" };
          return { status: "prepared", commit: commit(refusals), tree: tree(refusals), targetSha: MAIN };
        };
      };
      const newTicket = async (c: C, title: string) => (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title, assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
      /** A ticket earns the turn: its second rebuild. */
      const earn = (c: C, id: string) => [landingTurns.rebuilt(c.project.id, id, HOUR), landingTurns.rebuilt(c.project.id, id, HOUR)][1]!.turn;
      /** Approves; the check passes and the push waits behind the turn twice, each wait ending in a rebuild; the second queues it. */
      const rebuildTwiceIntoLine = async (c: C) => {
        await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
        await finishJob(c, { state: "passed", exitCode: 0 });
        await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(2), { timeout: 20_000 });
        await finishJob(c, { state: "passed", exitCode: 0 });
        await vi.waitFor(async () => expect((await lineEvents(c)).some((e) => e.event === "landing_turn" && e.action === "queued")).toBe(true), { timeout: 20_000 });
        expect(landingTurns.queued(c.project.id, c.ticket.id)).toBe(true);
      };
      /** The wait loop goes round `n` more times (it reads the turn on every round): a deadline poll, not a fixed sleep. */
      const rounds = async (spy: { mock: { calls: unknown[] } }, n: number) => {
        const from = spy.mock.calls.length;
        await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(from + n), { timeout: 20_000 });
      };
      /** The words the Merges tab, the ticket's merge line and server_status give the wait: they must be one. */
      const threeViews = async (c: C) => {
        const row = (await c.mergeQueue.get(c.company.id)).waiting.find((w) => w.ticketId === c.ticket.id);
        const state = await c.review.mergeState(c.ticket.id);
        const status = (await c.serverStatus.status(c.company.id)) as { landingTurns: Array<{ projectId: string; holder: { ticketId: string } | null; line: Array<{ ticketId: string; label: string | null }> }> };
        const turn = status.landingTurns.find((p) => p.projectId === c.project.id);
        return { row, state, turn, waiter: turn?.line.find((l) => l.ticketId === c.ticket.id) };
      };
      const cleanUp = (c: C, ...ids: string[]) => {
        for (const id of [...ids, c.ticket.id]) landingTurns.done(c.project.id, id);
      };

      it("in line behind another ticket: nothing is built or checked until it holds the turn, then it builds once and lands", async () => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner() }));
        await serverMode(c);
        const x = await newTicket(c, "Holder change");
        const y = await newTicket(c, "First in line");
        expect(earn(c, x.id)).toBe("taken");
        expect(earn(c, y.id)).toBe("queued");
        const spy = vi.spyOn(landingTurns, "check");
        try {
          await rebuildTwiceIntoLine(c);
          expect(landingTurns.line(c.project.id)).toEqual([y.id, c.ticket.id]);
          const built = plainPrepares(c).length;
          // The proof: while X holds the turn, no third merge is built and no third check queued (on main both happened at once).
          await rounds(spy, 10);
          expect(plainPrepares(c)).toHaveLength(built);
          expect(await jobs(c)).toHaveLength(2);
          expect((await lineEvents(c)).filter((e) => e.event === "hold_started" && e.hold === "turn").at(-1)).toMatchObject({ note: expect.stringContaining("Holder change") });
          // R43: one line, read from one marker, on all three screens; never "next in line for a check".
          // The Merges tab lists approved work only: its review round, as a reviewer would leave it.
          await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", round: 1, status: "approved" });
          const v = await threeViews(c);
          expect(v.row).toMatchObject({ state: "waiting_for_turn", label: expect.stringMatching(/^waiting for \S+ to land, then re-checks$/) });
          expect(v.state?.startsWith(`merge ${v.row!.label} (since `)).toBe(true);
          expect(v.turn?.holder?.ticketId).toBe(x.id);
          expect(v.waiter?.label).toBe(v.row!.label);
          // X lands: Y takes the turn, and this ticket still waits, now for Y.
          landingTurns.landed(c.project.id);
          landingTurns.done(c.project.id, x.id);
          expect(landingTurns.holds(c.project.id, y.id)).toBe(true);
          await rounds(spy, 10);
          expect(plainPrepares(c)).toHaveLength(built);
          expect(await jobs(c)).toHaveLength(2);
          const v2 = await threeViews(c);
          expect(v2.row!.label).not.toBe(v.row!.label);
          expect(v2.waiter?.label).toBe(v2.row!.label);
          // Y lands: this ticket holds the turn, builds once on that main, checks it and lands.
          landingTurns.landed(c.project.id);
          landingTurns.done(c.project.id, y.id);
          await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(3), { timeout: 20_000 });
          // (More plain prepares may follow: the queued job's BOS-1344 refresh polls find the same tree.)
          expect(plainPrepares(c).length).toBeGreaterThan(built);
          await finishJob(c, { state: "passed", exitCode: 0 });
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          expect(finishes(c).map((f) => f.commit)).toEqual([commit(2)]);
          const ev = await lineEvents(c);
          expect(ev.filter((e) => e.event === "rebuilt").map((e) => e.rebuilds)).toEqual([1, 2]);
          expect(ev.filter((e) => e.event === "landing_turn").map((e) => e.action)).toEqual(["queued", "ended"]);
          expect(landingTurns.check(c.project.id).holder).toBeNull();
        } finally {
          spy.mockRestore();
          cleanUp(c, x.id, y.id);
        }
      });

      it.each([
        ["the holder leaves review", "holder_left"],
        ["the holder's turn runs out its cap", "expired"],
      ] as const)("in line: the wait ends when %s, and it builds and lands", async (_what, how) => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner() }));
        await serverMode(c);
        const x = await newTicket(c, "Holder change");
        expect(earn(c, x.id)).toBe("taken");
        try {
          await rebuildTwiceIntoLine(c);
          expect(await jobs(c)).toHaveLength(2);
          if (how === "holder_left") await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, x.id));
          // The turn's clock is the module's own (no injection on the shared instance): move its start back past the cap.
          else (landingTurns as unknown as { turns: Map<string, { since: number }> }).turns.get(c.project.id)!.since -= 2 * HOUR;
          await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(3), { timeout: 20_000 });
          await finishJob(c, { state: "passed", exitCode: 0 });
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          const turnRows = (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, x.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => r.detail as { event: string; action?: string });
          expect(turnRows.filter((e) => e.event === "landing_turn").map((e) => e.action)).toEqual([how === "holder_left" ? "ended" : "expired"]);
        } finally {
          cleanUp(c, x.id);
        }
      });

      it.each([
        ["this ticket leaves review", "left"],
        ["this copy hands over", "handover"],
      ] as const)("in line: when %s it stops waiting, builds nothing and gives up its place", async (_what, how) => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner() }));
        await serverMode(c);
        const x = await newTicket(c, "Holder change");
        expect(earn(c, x.id)).toBe("taken");
        try {
          await rebuildTwiceIntoLine(c);
          const built = plainPrepares(c).length;
          if (how === "left") await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, c.ticket.id));
          else c.lead.on = false;
          expect(await finished(c)).toMatchObject({ outcome: "check_stuck" });
          expect(plainPrepares(c)).toHaveLength(built);
          expect(await jobs(c)).toHaveLength(2);
          expect(finishes(c)).toEqual([]);
          expect(landingTurns.holds(c.project.id, x.id)).toBe(true);
          expect(landingTurns.queued(c.project.id, c.ticket.id)).toBe(false);
          expect((await c.review.runningMerges()).find((m) => m.ticketId === c.ticket.id)).toBeUndefined();
        } finally {
          cleanUp(c, x.id);
        }
      });

      it("promoted, then main moves once more: the round cap doesn't end it, it gets the turn's round and lands", async () => {
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner(), finishes: [{ status: "main_moved", notCarried: { why: "main changed files this ticket changes" } }] }));
        await serverMode(c);
        const x = await newTicket(c, "Holder change");
        expect(earn(c, x.id)).toBe("taken");
        try {
          await rebuildTwiceIntoLine(c);
          landingTurns.done(c.project.id, x.id);
          await vi.waitFor(async () => expect(await jobs(c)).toHaveLength(3), { timeout: 20_000 });
          await finishJob(c, { state: "passed", exitCode: 0 });
          // The first finish finds main moved again (rebuild 3): a fourth round, since it holds the turn. The runner builds
          // the same tree again, so that round reuses the passed check and finishes.
          expect(await finished(c)).toMatchObject({ outcome: "merged" });
          expect((await lineEvents(c)).filter((e) => e.event === "rebuilt").map((e) => e.rebuilds)).toEqual([1, 2, 3]);
          expect(finishes(c)).toHaveLength(2);
        } finally {
          cleanUp(c, x.id);
        }
      });

      it("a holder whose attempt throws gives the turn to the next in line at once, not at the cap", async () => {
        // This ticket takes the turn (no holder), then its next build fails on the runner: the attempt throws.
        let broken = false;
        const c = (ctx = await setup({ features: REFRESH, switchOn: false, prepare: runner(() => broken) }));
        await serverMode(c);
        const y = await newTicket(c, "Next in line");
        const x = await newTicket(c, "Earlier holder");
        try {
          // The ticket has one rebuild from an earlier attempt; its push waits behind X; the ask refuses: rebuild 2 queues it.
          expect(earn(c, x.id)).toBe("taken");
          landingTurns.rebuilt(c.project.id, c.ticket.id, HOUR);
          await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
          await finishJob(c, { state: "passed", exitCode: 0 });
          await vi.waitFor(async () => expect(landingTurns.queued(c.project.id, c.ticket.id)).toBe(true), { timeout: 20_000 });
          // Y earns the turn after it: next in line behind this ticket.
          expect(earn(c, y.id)).toBe("queued");
          // X lands: this ticket holds the turn, and its build fails.
          broken = true;
          landingTurns.done(c.project.id, x.id);
          await finished(c);
          expect(landingTurns.holds(c.project.id, y.id)).toBe(true);
          expect((await lineEvents(c)).filter((e) => e.event === "landing_turn").map((e) => e.action)).toEqual(["queued", "ended"]);
        } finally {
          cleanUp(c, x.id, y.id);
        }
      });
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

    // BOS-1733 (CI fix 2): GitHub fails in a named test the branch doesn't change. The gate re-runs it on the same merge
    // commit first; only a pass there buys one recorded GitHub retry of the failed jobs.
    describe("a GitHub failure in a test the branch didn't touch (BOS-1733)", () => {
      const FILE = "apps/server/test/fence.test.ts";
      const isRerun = (j: { command: string | null }) => !!j.command?.startsWith(GATE_RERUN_MARK);
      /** Plays the dispatcher for one job: waits for an open job that matches, then ends it with the given patch. */
      const finish = async (c: Awaited<ReturnType<typeof setup>>, match: (j: typeof checkJobs.$inferSelect) => boolean, patch: Record<string, unknown>) => {
        const open = await vi.waitFor(
          async () => {
            const job = (await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).find((j) => (j.state === "queued" || j.state === "running") && match(j));
            if (!job) throw new Error("no matching job was queued");
            return job;
          },
          { timeout: 5_000, interval: 20 },
        );
        await c.db.update(checkJobs).set({ endedAt: new Date(), ...patch }).where(eq(checkJobs.id, open.id));
        return open;
      };
      /** CI red on the merge commit with one annotation on FILE until GitHub was asked to re-run the failed jobs; then `after`. */
      const flaky = async (opts: { after?: "green" | "red"; changed?: string[] } = {}) => {
        const c = (ctx = await setup(opts.changed ? { changed: opts.changed } : {}));
        await serverMode(c);
        // The owner's token has no Checks permission, but the repo is public: the annotations are read without the token.
        c.gh.state.publicRepo = true;
        c.gh.state.ci = (sha) => (sha !== MERGE ? green() : c.gh.state.failedReruns.length && opts.after !== "red" ? green() : red([job("check", "success", 1), { ...job("check (server)", "failure", 4, "Run tests"), html_url: "https://github.com/leon/site/actions/runs/9/job/4" }]));
        c.gh.state.annotations.set(4, [
          { annotation_level: "failure", path: FILE, start_line: 42, title: "fence > blocks a write", message: "AssertionError: expected 0 to be 1" },
          { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
        ]);
        return c;
      };
      const retryRows = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(checkResults).where(eq(checkResults.kind, FLAKE_RETRY_KIND));
      const authorWake = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id)))[0];

      it("passes at the gate, then GitHub's one retry passes: merges, records the retry and opens one CEO ticket for the flaky file", async () => {
        const c = await flaky();
        // A ticket for this file is already open from an earlier flake: it gets a note instead of a second ticket.
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, (j) => !isRerun(j), { state: "passed", exitCode: 0 });
        const rerun = await finish(c, isRerun, { state: "passed", exitCode: 0, logTail: "boss-man re-run: passed" });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        // The gate's re-run ran on the exact merge commit and tree, as a merge job, and named the file safely quoted.
        expect(rerun).toMatchObject({ kind: "merge", commit: MERGE, tree: TREE, requestedBy: null });
        expect(rerun.command).toContain(`rerun '${FILE}'`);
        expect(c.gh.state.failedReruns).toEqual([`${API}/actions/runs/9/rerun-failed-jobs`]);
        expect(await retryRows(c)).toEqual([expect.objectContaining({ ticketId: c.ticket.id, sha: MERGE, passed: true, detail: FILE })]);
        const flakes = await c.db.select().from(tickets).where(eq(tickets.title, `Flaky on GitHub: ${FILE}`));
        expect(flakes).toHaveLength(1);
        expect(flakes[0]!.body).toContain("Retry 1 of 3 this week");
        expect(flakes[0]!.body).toContain("https://github.com/leon/site/actions/runs/9/job/4");
        const said = (await c.events()).join("\n");
        expect(said).toMatch(/GitHub CI failed in apps\/server\/test\/fence\.test\.ts, which this branch doesn't change/);
        expect(said).toMatch(/asked GitHub to re-run the failed jobs once \(apps\/server\/test\/fence\.test\.ts: retry 1 of 3 this week\)/);
        expect(await authorWake(c)).toBeUndefined();
      });

      it("a second flaky merge of the same file adds to the open CEO ticket instead of opening another", async () => {
        const c = await flaky();
        const open = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: `Flaky on GitHub: ${FILE}`, state: "ready" })).json() as { id: string };
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, (j) => !isRerun(j), { state: "passed", exitCode: 0 });
        await finish(c, isRerun, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "merged" });
        expect(await c.db.select().from(tickets).where(eq(tickets.title, `Flaky on GitHub: ${FILE}`))).toHaveLength(1);
        const notes = await c.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, open.id));
        expect(notes.some((m) => m.author === "system" && m.text.includes("It passed when Boss Man re-ran it on the same commit"))).toBe(true);
      });

      it("fails again at the gate: sent back with the gate's output, no GitHub retry, nothing recorded", async () => {
        const c = await flaky();
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, isRerun, { state: "failed", exitCode: 1, logTail: "FAIL test/fence.test.ts > blocks a write\n Tests  1 failed" });
        const out = (await res).json();
        expect(out).toMatchObject({ outcome: "verify_failed" });
        expect(c.gh.state.failedReruns).toEqual([]);
        expect(await retryRows(c)).toEqual([]);
        const wake = await authorWake(c);
        expect(wake!.note).toContain("failed again when Boss Man re-ran it on the same merge commit, so the failure is real");
        expect(wake!.note).toContain("FAIL test/fence.test.ts > blocks a write");
      });

      it("can't re-run at the gate (exit 78): sent back as before, with why, and no GitHub retry", async () => {
        const c = await flaky();
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, isRerun, { state: "failed", exitCode: CANT_RERUN_EXIT, logTail: "boss-man re-run: no vitest for apps/server/test/fence.test.ts" });
        expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
        expect(c.gh.state.failedReruns).toEqual([]);
        expect((await authorWake(c))!.note).toContain("Boss Man couldn't re-run it at its gate (no vitest for apps/server/test/fence.test.ts)");
      });

      it("a test the branch changes: sent back at once, no gate re-run queued", async () => {
        const c = await flaky({ changed: ["src/a.ts", FILE] });
        expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
        expect((await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).filter(isRerun)).toEqual([]);
        expect(c.gh.state.failedReruns).toEqual([]);
        expect((await authorWake(c))!.note).toContain(`Boss Man didn't ask GitHub for a retry: the branch changes ${FILE}`);
      });

      it("a file with 3 recorded retries this week gets no more: sent back, no gate re-run", async () => {
        const c = await flaky();
        for (let i = 0; i < 3; i++) await c.db.insert(checkResults).values({ companyId: c.company.id, ticketId: c.ticket.id, sha: `${i}`.repeat(40), kind: FLAKE_RETRY_KIND, passed: true, detail: FILE });
        expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
        expect((await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).filter(isRerun)).toEqual([]);
        expect((await authorWake(c))!.note).toContain("has had 3 retries in 7 days; no more retries for it until it is fixed");
      });

      it("GitHub fails again after its one retry: sent back saying it failed twice", async () => {
        const c = await flaky({ after: "red" });
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, isRerun, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
        expect(c.gh.state.failedReruns).toHaveLength(1);
        expect((await authorWake(c))!.note).toContain("It failed on GitHub twice");
        // The retry was spent and stays recorded, so this commit can't get another.
        expect(await retryRows(c)).toHaveLength(1);
      });

      it("a token that can't re-run jobs: sent back as before, saying so, and the retry isn't recorded", async () => {
        const c = await flaky();
        c.gh.state.failedRerunStatus = 403;
        const res = approveAndWait(c.req, c.ticket.id);
        await finish(c, isRerun, { state: "passed", exitCode: 0 });
        expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
        expect(await retryRows(c)).toEqual([]);
        expect((await authorWake(c))!.note).toContain("Actions: Read and write");
      });

      it("the gate's own check fails during the re-run: its send-back wins and the re-run job is cancelled", async () => {
        const c = await flaky();
        const res = approveAndWait(c.req, c.ticket.id);
        // Wait until the re-run is queued, then fail the merge's own check.
        for (let i = 0; i < 200 && !(await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).some(isRerun); i++) await new Promise((r) => setTimeout(r, 10));
        await finish(c, (j) => !isRerun(j), { state: "failed", exitCode: 1, logTail: "own check failed here" });
        expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
        for (let i = 0; i < 100 && (await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).find(isRerun)?.state !== "cancelled"; i++) await new Promise((r) => setTimeout(r, 10));
        expect((await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).find(isRerun)).toMatchObject({ state: "cancelled" });
        expect(c.gh.state.failedReruns).toEqual([]);
        expect((await authorWake(c))!.note).toContain("own check failed here");
      });

      it("handed over during the gate's re-run (BOS-1752): this copy asks GitHub for no retry, records none and leaves the re-run job alone", async () => {
        const c = await flaky();
        const res = approveAndWait(c.req, c.ticket.id);
        const rerun = await vi.waitFor(
          async () => {
            const j = (await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).find(isRerun);
            if (!j) throw new Error("no re-run queued yet");
            return j;
          },
          { timeout: 5_000, interval: 20 },
        );
        c.lead.on = false;
        expect((await res).json()).toMatchObject({ outcome: "check_stuck" });
        expect(c.gh.state.failedReruns).toEqual([]);
        expect(await retryRows(c)).toEqual([]);
        expect(await authorWake(c)).toBeUndefined();
        expect((await c.state()).systemState).toBe("review");
        // Not cancelled: the server now in charge reuses it for the same commit and tree.
        expect((await c.db.select().from(checkJobs).where(eq(checkJobs.id, rerun.id)))[0]!.state).toBe("queued");
      });

      // BOS-2082: BOS-2066's docs-only merge (run 44731483832): the web-browser step took 698 s against 209 to 343 s that
      // day, and 4 browser files timed out. More than 3 files, so BOS-1733's table bounced it.
      describe("a slow GitHub machine (BOS-2082)", () => {
        const STEP = "Web tests in a real browser";
        const timed = (seconds: number) => ({ started_at: "2026-11-20T11:00:00Z", completed_at: new Date(Date.parse("2026-11-20T11:00:00Z") + seconds * 1000).toISOString() });
        const webJob = (id: number, conclusion: string, seconds: number): Job => ({
          id,
          name: "web-browser",
          status: "completed",
          conclusion,
          runner_name: "GitHub Actions 2",
          html_url: `https://github.com/leon/site/actions/runs/9/job/${id}`,
          steps: [
            { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
            { number: 2, name: STEP, status: "completed", conclusion, ...timed(seconds) },
          ],
        });
        const FILES = ["apps/web/test/board-wheel.test.ts", "apps/web/test/decisions-closed-fold.test.ts", "apps/web/test/readonly-text-contrast.test.ts", "apps/web/test/wrap-up-layout.test.ts"];
        const slow = async (seconds: number, opts: { after?: "green" | "red" } = {}) => {
          const c = (ctx = await setup({ changed: ["docs/02-install.md"] }));
          await serverMode(c);
          c.gh.state.publicRepo = true;
          c.gh.state.greenRuns = [211, 343, 209, 260, 298, 275, 240, 330].map((s, i) => ({ id: 200 + i, jobs: [webJob(300 + i, "success", s)] }));
          c.gh.state.ci = (sha) => (sha !== MERGE ? green() : c.gh.state.failedReruns.length && opts.after !== "red" ? green() : red([job("check", "success", 1), webJob(5, "failure", seconds)]));
          // The real shape (ci.yml's web-browser step, BOS-1590): one summary annotation on ".github", no file, entries
          // joined by " | ", so the job names no test file and BOS-1733's table bounced it as unnamed (Morph, on BOS-2081).
          const summary = FILES.map((f, i) => `${f.split("/").pop()}: renders the page: Error: Test timed out in ${15_000 * 2 ** (i % 3)}ms.`).join(" | ");
          c.gh.state.annotations.set(5, [
            { annotation_level: "failure", path: ".github", title: "web tests failed", message: summary },
            { annotation_level: "failure", path: ".github", message: "Process completed with exit code 1." },
          ]);
          return c;
        };

        it("698 s against a usual 268 s, all timeouts in 4 files (one summary annotation naming no file): one GitHub retry on a fresh machine, no gate re-run, recorded, merged", async () => {
          const c = await slow(698);
          const res = approveAndWait(c.req, c.ticket.id);
          await finish(c, (j) => !isRerun(j), { state: "passed", exitCode: 0 });
          expect((await res).json()).toMatchObject({ outcome: "merged" });
          expect((await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).filter(isRerun)).toEqual([]);
          expect(c.gh.state.failedReruns).toEqual([`${API}/actions/runs/9/rerun-failed-jobs`]);
          expect(await retryRows(c)).toEqual([expect.objectContaining({ sha: MERGE, detail: "slow machine: web-browser" })]);
          const said = (await c.events()).join("\n");
          expect(said).toContain(`web-browser's "${STEP}" step took 698 s against a usual 268 s (median of 8 green runs)`);
          expect(said).toContain("asked GitHub to re-run the failed jobs once on a fresh machine (web-browser: slow-machine retry 1 of 5 this week)");
          expect(said).toContain("the timeouts came from a slow GitHub machine, not this branch");
          // A slow machine is not a flaky test: no "Flaky on GitHub" ticket for the CEO.
          expect((await c.db.select().from(tickets)).filter((t) => t.title.startsWith("Flaky on GitHub"))).toEqual([]);
          expect(await authorWake(c)).toBeUndefined();
        });

        it("the retry fails too: sent back saying it failed twice, the retry stays recorded", async () => {
          const c = await slow(698, { after: "red" });
          expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
          expect(c.gh.state.failedReruns).toHaveLength(1);
          expect((await authorWake(c))!.note).toContain("It failed on GitHub twice");
          expect(await retryRows(c)).toHaveLength(1);
        });

        it("a usual time (300 s) with the same 4 timeouts: sent back as before, no retry asked", async () => {
          const c = await slow(300);
          expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
          expect(c.gh.state.failedReruns).toEqual([]);
          expect(await retryRows(c)).toEqual([]);
          expect((await authorWake(c))!.note).toContain("Boss Man didn't ask GitHub for a retry: the failure in web-browser doesn't name a test file");
        });
      });
    });

    // BOS-2301 (BOS-2283 P4): the gate and its GitHub runs stay in step. On 21 Nov main moved twice while GitHub's failure on
    // BOS-2196's merge copy waited for the gate's re-run of the failed test; each refresh stopped the re-run, swallowed the
    // failure and pushed a fresh copy with the same fault (three red runs, three emails). On 22 Nov the gate stopped waiting
    // for BOS-2285's run 3 s after pushing it (the ticket wasn't in review), and the run went on for 17 minutes and went red.
    describe("the gate and its GitHub runs stay in step (BOS-2301)", () => {
      const REFRESH = ["carried-check", "ci-publish", "merge-carry", "merge-refresh"];
      const MERGE2 = "d".repeat(40);
      const TREE2 = "9".repeat(40);
      const FILE = "apps/server/test/fence.test.ts";
      const isRerun = (j: { command: string | null }) => !!j.command?.startsWith(GATE_RERUN_MARK);
      const jobs = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      const lineEvents = async (c: Awaited<ReturnType<typeof setup>>) =>
        (await c.db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, MERGE_LINE_KIND)))).map((r) => (r.detail as { event: string }).event);
      const landing = async (c: Awaited<ReturnType<typeof setup>>) => (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing as { state?: string; outcome?: string; text?: string } | undefined;

      it("main moves while GitHub's failure waits for the gate's re-run: no fresh copy is pushed, and the real failure goes back once", async () => {
        // Until `moved`, every refresh prepare finds the same merge; after it, main changed files the carry refuses.
        const s = { moved: false, refreshAsks: 0 };
        const c = (ctx = await setup({
          features: REFRESH,
          prepare: (cmd) => {
            if (!cmd.carryFrom) return { status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN };
            if (!s.moved) return { status: "prepared", commit: MERGE, tree: TREE, targetSha: MAIN, carry: { ok: true } };
            s.refreshAsks++;
            return { status: "prepared", commit: MERGE2, tree: TREE2, targetSha: "8".repeat(40), carry: { ok: false, why: "main changed dependencies, build, CI or migration files", files: ["apps/server/src/app.ts"] } };
          },
        }));
        await serverMode(c);
        c.gh.state.publicRepo = true;
        c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "success", 1), { ...job("check (server)", "failure", 4, "Run tests"), html_url: "https://github.com/leon/site/actions/runs/9/job/4" }]) : green());
        c.gh.state.annotations.set(4, [{ annotation_level: "failure", path: FILE, start_line: 42, title: "fence > blocks a write", message: "AssertionError: expected 0 to be 1" }]);
        const res = approveAndWait(c.req, c.ticket.id);
        // GitHub's failure was seen and the gate queued its re-run of the named test, which waits for a slot.
        const rerun = await vi.waitFor(
          async () => {
            const j = (await jobs(c)).find(isRerun);
            if (!j) throw new Error("no re-run queued yet");
            return j;
          },
          { timeout: 5_000, interval: 20 },
        );
        s.moved = true;
        // A check that nothing happens: 300 ms is 15 refresh intervals here (BOSSMAN_MERGE_RETARGET_MS = 20); before BOS-2301
        // the refresh came within the first two (10 asks in this window), stopped the re-run and published MERGE2.
        // test-lines-ok: a negative check over many refresh intervals, not a wait for the other side to be ready
        await new Promise((r) => setTimeout(r, 300));
        expect(s.refreshAsks).toBe(0);
        expect(c.merges().filter((p) => p === "publish")).toHaveLength(1);
        // The re-run fails: the failure is real, and this copy sends the ticket back.
        await c.db.update(checkJobs).set({ state: "failed", exitCode: 1, endedAt: new Date(), logTail: "FAIL test/fence.test.ts > blocks a write" }).where(eq(checkJobs.id, rerun.id));
        expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
        expect(c.merges().filter((p) => p === "publish")).toHaveLength(1);
        expect(await lineEvents(c)).not.toContain("refreshed");
        expect(c.gh.reads.get(MERGE2)).toBeUndefined();
        expect((await c.state()).systemState).toBe("in_progress");
      });

      /** Approves, waits until the merge copy is pushed and its GitHub run read, then moves the ticket out of review. */
      const approveThenLeave = async (c: Awaited<ReturnType<typeof setup>>) => {
        await serverMode(c);
        c.gh.state.ci = (sha) => (sha === MERGE ? running() : green());
        await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
        await vi.waitFor(() => expect(c.gh.reads.get(MERGE) ?? 0).toBeGreaterThan(0), { timeout: 5_000 });
        await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, c.ticket.id));
        return vi.waitFor(
          async () => {
            const l = await landing(c);
            if (l?.state !== "finished") throw new Error("landing still running");
            return l;
          },
          { timeout: 5_000, interval: 20 },
        );
      };

      it("the gate stops waiting (the ticket left review): it cancels the run still going on the copy and says so", async () => {
        const c = (ctx = await setup());
        const l = await approveThenLeave(c);
        await vi.waitFor(() => expect(c.gh.state.cancels).toEqual([`${API}/actions/runs/9/cancel`]), { timeout: 5_000 });
        await vi.waitFor(async () => expect((await c.events()).join("\n")).toContain(`Stopped waiting for GitHub CI on ${MERGE.slice(0, 12)} (the ticket left review) and cancelled its GitHub run, so no result comes for a merge copy Boss Man dropped. Nothing to do.`), { timeout: 5_000 });
        // The ticket says what happened: no merge card was raised, so it doesn't claim one is open.
        expect(l).toMatchObject({ outcome: "check_stuck" });
        expect(l.text).toContain("left review");
        expect(l.text).not.toContain("merge card");
        expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
      });

      it("a token that can't cancel runs: says on the ticket the run is still going, that its result doesn't count, and why", async () => {
        const c = (ctx = await setup());
        c.gh.state.cancelStatus = 403;
        await approveThenLeave(c);
        const sha = MERGE.slice(0, 12);
        await vi.waitFor(async () => expect((await c.events()).join("\n")).toContain(`Stopped waiting for GitHub CI on ${sha} (the ticket left review). Its GitHub run is still going and no longer counts: ignore a GitHub email about ${sha}. Couldn't cancel: the git token can't cancel GitHub runs (it needs Actions: Read and write)`), { timeout: 5_000 });
        expect((await c.events()).join("\n")).not.toContain("cancelled its GitHub run");
      });
    });
  });

  describe("a ticket holding the merge line sent back by GitHub CI wakes the CEO (R32, BOS-1669)", () => {
    const redImages = () => red([job("check", "success", 1), { ...job("images (amd64)", "failure", 7, "Shell tests"), html_url: "https://github.com/leon/site/actions/runs/9/job/7" }]);
    const ceoWakes = async (c: Awaited<ReturnType<typeof setup>>) => {
      const [ceo] = await c.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.role, "ceo")));
      return c.db.select().from(wakes).where(and(eq(wakes.agentId, ceo!.id), eq(wakes.reason, "line holder sent back")));
    };
    const waiter = async (c: Awaited<ReturnType<typeof setup>>) => {
      const w = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Waits on the fix", assigneeAgentId: c.worker.id })).json() as { id: string };
      await c.db.insert(ticketDependencies).values({ blockedTicketId: w.id, blockerTicketId: c.ticket.id, until: "merged" });
    };

    it("marked fixesMergeCheck: the assignee and the CEO are both told, once, with what failed and the attempt", async () => {
      const c = (ctx = await setup());
      await c.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, c.ticket.id));
      c.gh.state.ci = (sha) => (sha === MERGE ? redImages() : green());
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
      expect(await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "ci failed")))).toHaveLength(1);
      const told = await ceoWakes(c);
      expect(told).toHaveLength(1);
      expect(told[0]!.ticketId).toBe(c.ticket.id);
      expect(told[0]!.note).toContain("GitHub CI failed on commit eeeeeeeeeeee (images (amd64))");
      expect(told[0]!.note).toContain("back to Engineer on merge attempt 1");
      expect(told[0]!.note).toContain("marked as fixing the merge check");
    });

    it("a main-CI fix ticket another ticket waits on: the CEO hears how many wait", async () => {
      const c = (ctx = await setup());
      await c.db.insert(activity).values({ companyId: c.company.id, ticketId: c.ticket.id, kind: "main_ci_failure", summary: "Opened for a failing step on main" });
      await waiter(c);
      c.gh.state.ci = (sha) => (sha === MERGE ? redImages() : green());
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
      const told = await ceoWakes(c);
      expect(told).toHaveLength(1);
      expect(told[0]!.note).toContain("the fix for main's failing CI; 1 ticket waits on it");
    });

    it("an ordinary ticket, a main-CI ticket nobody waits on, or a plain waits-on link: only the assignee is told", async () => {
      for (const kind of ["plain", "main_ci_alone", "waited_on"] as const) {
        const c = (ctx = await setup());
        if (kind === "main_ci_alone") await c.db.insert(activity).values({ companyId: c.company.id, ticketId: c.ticket.id, kind: "main_ci_failure", summary: "Opened" });
        if (kind === "waited_on") await waiter(c);
        c.gh.state.ci = (sha) => (sha === MERGE ? redImages() : green());
        expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
        expect(await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "ci failed")))).toHaveLength(1);
        expect(await ceoWakes(c), kind).toEqual([]);
        c.release();
        await c.app.close();
        await c.close();
        ctx = undefined;
      }
    });
  });

  it("a runner too old to publish merges as before and says why", async () => {
    const c = (ctx = await setup({ features: ["carried-check"] }));
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.merges()).toEqual(["plain"]);
    expect((await c.events()).some((e) => /runner is too old/.test(e))).toBe(true);
  });
});
