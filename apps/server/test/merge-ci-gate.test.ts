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
});
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, checkJobs, checkResults, decisions, settings, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
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

type Job = { id: number; name: string; status: string; conclusion: string | null; html_url?: string; runner_name?: string | null; steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }> };
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
  };
  const last = new Map<number, WorkflowRun>();
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (state.status) return json(state.status, { message: "Resource not accessible by personal access token" });
    if (/\/check-runs|\/check-suites/.test(url) && !state.checks) return json(403, { message: "Resource not accessible by personal access token" });
    const runs = /\/actions\/runs\?head_sha=([0-9a-f]+)/.exec(url);
    const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    const notes = /\/check-runs\/(\d+)\/annotations/.exec(url);
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
    if (jobs) return json(200, { jobs: last.get(Number(jobs[1]))?.jobs ?? [] });
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
    expect(c.gh.calls.findIndex((u) => u.includes(`head_sha=${MAIN}`))).toBeLessThan(c.gh.calls.findIndex((u) => u.includes(`head_sha=${MERGE}`)));
    // The owner's kind of token: nothing was asked of the Checks API, and no card.
    expect(c.gh.calls.filter((u) => /check-runs|check-suites/.test(u))).toEqual([]);
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
  });

  it("a token with Actions: Read-only and no Checks: a red CI goes back naming the failing job and step, with no card (BOS-1630)", async () => {
    const c = (ctx = await setup());
    c.gh.state.ci = (sha) => (sha === MERGE ? red([job("check", "success", 1), { ...job("images (arm64)", "failure", 7, "Build image"), html_url: "https://github.com/leon/site/actions/runs/9/job/7" }]) : green());
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "verify_failed" });
    expect(res.message).toMatch(/GitHub CI failed .*images \(arm64\)/);
    expect(res.message).not.toMatch(/- check\b/);
    expect(c.merges()).toEqual(["prepare", "publish"]);
    const [wake] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    expect(wake!.note).toContain("images (arm64) (https://github.com/leon/site/actions/runs/9/job/7)");
    expect(wake!.note).toContain('failed at step "Build image"');
    // The annotation read was refused (no Checks permission) and that cost nothing: no access card, no billing card.
    expect(c.gh.calls.some((u) => u.includes("/check-runs/7/annotations"))).toBe(true);
    expect(await c.db.select().from(decisions).where(eq(decisions.status, "open"))).toEqual([]);
    expect(await c.db.select().from(checkResults).where(and(eq(checkResults.ticketId, c.ticket.id), eq(checkResults.kind, "ci")))).toEqual([expect.objectContaining({ passed: false, detail: "images (arm64)" })]);
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
    expect(c.merges()).toEqual(["prepare", "publish"]);
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
    expect(c.merges()).toEqual(["prepare", "publish"]);
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

  it("an Actions API that keeps failing is retried, then never merges and raises a card", async () => {
    const c = (ctx = await setup());
    c.gh.state.status = 502;
    const res = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(res).toMatchObject({ outcome: "check_stuck" });
    // The first read and three retries, all on main's head: nothing was pushed.
    expect(c.gh.calls.filter((u) => u.includes(`/actions/runs?head_sha=${MAIN}`))).toHaveLength(4);
    expect(c.merges()).toEqual(["prepare"]);
    expect(await c.db.select({ dedupeKey: decisions.dedupeKey, tier: decisions.tier }).from(decisions).where(eq(decisions.status, "open"))).toEqual([{ dedupeKey: `ci-error:${c.project.id}`, tier: "owner" }]);
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
    expect(c.merges()).toEqual(["prepare", "publish"]);
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
    expect(c.merges()).toEqual(["prepare", "publish"]);
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
