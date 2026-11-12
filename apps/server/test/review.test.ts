import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// Hoisted so it is set before review.ts reads it: the landing re-reads its check job row this often.
vi.hoisted(() => { process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20"; });
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { SUPERSEDED_TEXT } from "../src/services/check-queue.js";
import { activity, checkJobs, projects, reviewRequests, checkResults, decisions, runs, tickets, ticketDependencies, wakes } from "../src/db/schema.js";
import { checkNeverFinished, checkQueueStuck, checkWaitedForLock, INFRA_RETRY_ATTEMPTS, LOCK_RETRY_ATTEMPTS, setInfraRetryBase, setLockRetryBase, landingText } from "../src/services/review.js";
import { supersedeSignoffs } from "../src/services/decisions.js";
import { MERGE_CHECK_LIMIT_KEY } from "../src/services/check-gate.js";
import { settings } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;

// One database and one app for the file, the database emptied before each test (BOS-686). Every test makes
// its own company, agents, project and ticket and reads only those.
let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  // A fake-runner reply still held open would let a landing run on into the next test's emptied tables.
  ctx?.held.splice(0).forEach((release) => release());
  if (ctx) await new Promise((resolve) => setTimeout(resolve, 50));
  ctx = undefined;
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = {
  baseCommit: "a".repeat(40),
  head: "b".repeat(40),
  commits: [{ sha: "b".repeat(40), subject: "Add rate limiting" }],
  files: [{ path: "src/limit.ts", added: 2, removed: 0 }],
  diff: ["diff --git a/src/limit.ts b/src/limit.ts", "--- /dev/null", "+++ b/src/limit.ts", "@@ -0,0 +1,2 @@", "+export const LIMIT = 1000;", "+export const WINDOW = 60;"].join("\n"),
  truncated: false,
};

type Answers = { verify?: unknown; merge?: unknown | ((c: { phase?: string }) => unknown); diff?: unknown; carried?: unknown; migrations?: unknown; carriedFailures?: number };

async function setup(opts: { online?: boolean; answers?: Answers; hold?: boolean } = {}) {
  const held: Array<() => void> = [];
  const answers: Answers = { merge: { status: "merged", commit: "c".repeat(40) }, migrations: { needed: false, reason: "No other branch uses this ticket's migration numbers." }, ...opts.answers };
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  if (opts.online !== false) {
    // A fake runner that answers diff requests.
    built.runners.connect(reg.runnerId, (c) => {
      sent.push(c);
      if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.diff ?? DIFF }));
      if (c.type === "workspace.verify") {
        const reply = () => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.verify });
        if (opts.hold) held.push(reply);
        else queueMicrotask(reply);
      }
      if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: typeof answers.merge === "function" ? (answers.merge as (c: unknown) => unknown)(c) : answers.merge }));
      if (c.type === "workspace.carried") {
        const a = answers.carried as { error?: string } | undefined;
        // carriedFailures: the runner is busy and answers with an error that many times first.
        const failing = (answers.carriedFailures ?? 0) > 0 && (answers.carriedFailures = answers.carriedFailures! - 1, true);
        queueMicrotask(() => built.runners.resolveReply(failing ? { requestId: c.requestId, ok: false, error: "runner busy" } : a?.error ? { requestId: c.requestId, ok: false, error: a.error } : { requestId: c.requestId, ok: true, data: a ?? { carried: [] } }));
      }
      if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.migrations }));
      return true;
    }, ["carried-check"]);
  }
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${ticket.id}` }).where(eq(tickets.id, ticket.id));
  await db.delete(wakes);
  return { ...built, db, req, company, ceo, worker, project, ticket, sent, answers, held };
}

describe("review (R39)", () => {
  it("tells the ticket page the project's check and whether the owner signs off at its risk tier", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    const get = async () => (await c.req("GET", `/api/tickets/${c.ticket.id}`)).json() as { verifyCommand: string; ownerSignoff: boolean };
    expect(await get()).toMatchObject({ verifyCommand: "pnpm test", ownerSignoff: false });
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { risk: "high" });
    expect((await get()).ownerSignoff).toBe(true);
  });

  it("fetches the diff from the runner holding the worktree", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/diff`)).json()).toEqual(DIFF);
    expect(c.sent.at(-1)).toMatchObject({ type: "workspace.diff", projectId: c.project.id, ticketId: c.ticket.id });
    expect(c.sent.at(-1)).not.toHaveProperty("range");
    // The last turn's changes come from the runner's checkpoints (R39).
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/diff?range=last_turn`)).statusCode).toBe(200);
    expect(c.sent.at(-1)).toMatchObject({ type: "workspace.diff", ticketId: c.ticket.id, range: "last_turn" });
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/diff?range=yesterday`)).statusCode).toBe(400);
  });

  it("says so when the runner is offline", async () => {
    const c = (ctx = await setup({ online: false }));
    const res = await c.req("GET", `/api/tickets/${c.ticket.id}/diff`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/offline/);
  });

  it("sends changes requested to the running agent as one message, with the code under each comment", async () => {
    const c = (ctx = await setup());
    const runId = "00000000-0000-4000-8000-0000000000aa";
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: c.ticket.id });
    const res = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested", comments: [{ path: "src/limit.ts", line: 1, body: "Read this from config." }] });
    expect(res.json()).toMatchObject({ verdict: "changes_requested", delivered: "sent to the running agent" });
    const msg = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.message" }> => x.type === "run.message")!;
    expect(msg.text).toContain("src/limit.ts:1 | export const LIMIT = 1000;\n> Read this from config.");
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("in_progress");
  });

  it("wakes the assignee when nothing is running, and approval finishes the ticket", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested", summary: "Add tests for the window." });
    expect(await c.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: c.worker.id, reason: "review", ticketId: c.ticket.id })]);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ verdict: "approved", outcome: "merged" });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]).toMatchObject({ systemState: "done", outcome: "completed", mergeCommit: "c".repeat(40) });
    expect(c.sent.at(-1)).toMatchObject({ type: "workspace.release", ticketId: c.ticket.id });
    expect((await approveAndWait(c.req, c.ticket.id)).statusCode).toBe(409);
  });

  it("needs something to act on, and the coder can't review their own ticket", async () => {
    const c = (ctx = await setup());
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested" })).statusCode).toBe(422);
    await expect(c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "Engineer", reviewerAgentId: c.worker.id })).rejects.toThrow(/assigned to you/);
  });

  it("asks the agent to commit or open a PR from editable templates", async () => {
    const c = (ctx = await setup());
    const pr = (await c.req("POST", `/api/tickets/${c.ticket.id}/git-action`, { action: "pr" })).json();
    expect(pr.message).toMatch(new RegExp(`^Push bossman/${c.ticket.id} and open a pull request against main\\.`));
    await c.req("PUT", `/api/companies/${c.company.id}/git-templates`, { commit: "Commit on {{branch}} using Conventional Commits." });
    const commit = (await c.req("POST", `/api/tickets/${c.ticket.id}/git-action`, { action: "commit" })).json();
    expect(commit.message).toBe(`Commit on bossman/${c.ticket.id} using Conventional Commits.`);
    expect((await c.req("GET", `/api/companies/${c.company.id}/git-templates`)).json().pr).toMatch(/^Push/);
  });

});

describe("approval lands in the background (B)", () => {
  it("returns 202 at once, shows the running check, then the outcome in plain words", async () => {
    const c = (ctx = await setup({ hold: true, answers: { verify: { ok: false, exitCode: 2, timedOut: false, output: "boom", ms: 900 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    const res = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ outcome: "landing", landing: { state: "running", command: "pnpm test" } });
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toMatchObject({ state: "running" });
    // A second approval while the check runs is refused.
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(409);
    await vi.waitFor(() => expect(c.held).toHaveLength(1));
    c.held[0]!();
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
    const { landing } = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json();
    expect(landing.text).toBe("Approved, but not merged: the check failed (exit code 2). It's gone back to Engineer to fix; the check's output is in the conversation below.");
    expect(await c.db.select().from(checkResults)).toEqual([expect.objectContaining({ ticketId: c.ticket.id, kind: "verify", passed: false, detail: "boom" })]);
  });

  it("treats a running marker as stale once the ticket has gone quiet, so the owner can try again", async () => {
    const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    const running = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
    expect(running).toMatchObject({ state: "running", startedBy: "the owner" });
    expect(running.stale).toBe(false);
    // The check stopped saying it is alive: the marker is a leftover, so approving again starts a fresh landing.
    await c.db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(tickets.id, c.ticket.id));
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toMatchObject({ state: "running", stale: true });
    const again = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
    expect(again.statusCode).toBe(202);
    expect(again.json().landing).toMatchObject({ state: "running", startedBy: "the owner" });
    await vi.waitFor(() => expect(c.held.length).toBeGreaterThanOrEqual(2));
    c.held.forEach((release) => release());
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
  });

  it("is not called stale on its first poll because the ticket was quiet before the last review", async () => {
    const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    // The ticket sat in review for hours before anyone finished reviewing it.
    await c.db.update(tickets).set({ lastActivityAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(tickets.id, c.ticket.id));
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
    const landing = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
    expect(landing).toMatchObject({ state: "running", startedBy: "the owner", stale: false });
    c.held.forEach((release) => release());
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
  });

  it("shows a merge started by the last reviewer's approval while it runs", async () => {
    const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "pending" });
    expect(await c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "CEO", reviewerAgentId: c.ceo.id, background: true })).toMatchObject({ outcome: "landing" });
    const landing = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
    expect(landing).toMatchObject({ state: "running", startedBy: "CEO", stale: false });
    c.held.forEach((release) => release());
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
  });

  it("shows a merge the owner starts from the sign-off card while it runs", async () => {
    const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: c.ticket.id, reviewer: "Senior Developer" } })
      .returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerDecisionId: d!.id });
    const answering = c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Approve and merge" });
    try {
      await vi.waitFor(async () => {
        const landing = (await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing;
        expect(landing).toMatchObject({ state: "running", startedBy: "the owner", stale: false });
      });
    } finally {
      c.held.forEach((release) => release());
      await answering;
    }
    // The merge runs in the background, so its outcome is kept for the page to show (BOS-559).
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toMatchObject({ state: "finished", outcome: "merged" }));
  });

  it("says each outcome in plain words", () => {
    const ctx = { branch: "main", assignee: "Engineer" };
    expect(landingText({ outcome: "merged" }, ctx)).toBe("Merged into main.");
    expect(landingText({ outcome: "pull_request", detail: { url: "https://h/pr/1", note: "needs an approval" } }, ctx)).toBe("Pull request opened: https://h/pr/1. It hasn't merged yet: needs an approval");
    expect(landingText({ outcome: "verify_failed", detail: { timedOut: true, ms: 660_000 } }, ctx)).toContain("the check timed out after 11 minutes. It's gone back to Engineer to fix");
    expect(landingText({ outcome: "conflicts", detail: { files: ["a.ts"] } }, ctx)).toBe("Approved, but not merged: the work conflicts with main in a.ts. It's gone back to Engineer to sort out.");
    expect(landingText({ outcome: "uncommitted", detail: { files: ["b.ts"] } }, ctx)).toContain("isn't saved to the branch yet (b.ts)");
  });

  // BOS-1220: a failed check always names what failed; never "exit code undefined".
  it("names the failed step and test, and never prints an undefined exit code", () => {
    const ctx = { branch: "main", assignee: "Engineer" };
    const output = "PASS  merge check\nFAIL  related tests (exit 1)\n       FAIL  test/foo.test.ts > foo > does the thing\ncheck-quick: FAILED\n";
    const failed = landingText({ outcome: "verify_failed", detail: { exitCode: 1, output } }, ctx);
    expect(failed).toContain('exit code 1; step that failed: "related tests (exit 1)"');
    expect(failed).toContain("first failing test: test/foo.test.ts > foo > does the thing");
    // The migration-number bounce is also verify_failed and has no exit code or log.
    const migration = landingText({ outcome: "verify_failed", detail: { why: ["0123 is taken by main"] } }, ctx);
    expect(migration).not.toMatch(/undefined/);
    expect(migration).toContain("migration number is already taken (0123 is taken by main)");
    // A check stopped before it reported (null exit code) says so plainly.
    const stopped = landingText({ outcome: "verify_failed", detail: { exitCode: null, output: "" } }, ctx);
    expect(stopped).toContain("was stopped before it reported");
    expect(stopped).not.toMatch(/undefined|null/);
  });

  // BOS-1228: the bounce says where the whole log is and how to open it; no pointer when none was kept.
  it("names the kept full log in a failed-check bounce", () => {
    const ctx = { branch: "main", assignee: "Engineer" };
    const jobId = "11111111-2222-4333-8444-555555555555";
    const ticketId = "66666666-7777-4888-8999-000000000000";
    const withLog = landingText({ outcome: "verify_failed", detail: { exitCode: 1, output: "x", keptLog: { jobId, ticketId, chars: 300_000 } } }, ctx);
    expect(withLog).toContain(`tickets tool with action check_log, ticketId ${ticketId} and jobId ${jobId}`);
    expect(withLog).toMatch(/293 KB, kept 14 days/);
    expect(landingText({ outcome: "verify_failed", detail: { exitCode: 1, output: "x" } }, ctx)).not.toContain("check_log");
  });
});

describe("landing an approved ticket (R46, R47)", () => {
  const approve = (c: Awaited<ReturnType<typeof setup>>) => approveAndWait(c.req, c.ticket.id);
  const state = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;

  it("runs the project's check first, merges into the default branch, and the merge closes the ticket", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test", defaultBranch: "develop" });
    expect((await approve(c)).json()).toMatchObject({ verdict: "approved", outcome: "merged" });
    const kinds = c.sent.map((x) => x.type);
    expect(kinds.indexOf("workspace.verify")).toBeLessThan(kinds.indexOf("workspace.merge"));
    expect(c.sent.find((x) => x.type === "workspace.verify")).toMatchObject({ command: "pnpm test" });
    expect(c.sent.find((x) => x.type === "workspace.merge")).toMatchObject({ target: "develop", message: `Merge "Add rate limiting" (${c.ticket.id})` });
    expect(await state(c)).toMatchObject({ systemState: "done", mergeCommit: "c".repeat(40) });
  });

  it("sends a ticket back when a migration number is already taken, and never merges it (BOS-219)", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 }, migrations: { needed: true, number: 75, next: 76, why: ["0075_mine shares its number with 0075_theirs on another branch"], others: [] } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test", defaultBranch: "develop" });
    expect((await approve(c)).json()).toMatchObject({ outcome: "verify_failed" });
    expect(c.sent.some((x) => x.type === "workspace.merge")).toBe(false);
    expect(await state(c)).toMatchObject({ systemState: "in_progress", mergeCommit: null });
    const [w] = await c.db.select().from(wakes);
    expect(w).toMatchObject({ reason: "migration number taken", agentId: c.worker.id });
    expect(w!.note).toContain("0075_mine");
    expect(w!.note).toContain("0076");
    expect(c.sent.find((x) => x.type === "workspace.migrations")).toMatchObject({ type: "workspace.migrations", target: "develop" });
  });

  it("checking at merge time compares against the default branch only, so two clashing tickets don't keep sending each other back (BOS-219)", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test", defaultBranch: "develop" });
    // Another open ticket on the same project picked the same number. It must not be looked at here.
    const open = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Another migration", assigneeAgentId: c.worker.id, state: "in_progress" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${open.id}` }).where(eq(tickets.id, open.id));
    expect((await approve(c)).json()).toMatchObject({ outcome: "merged" });
    expect(c.sent.find((x) => x.type === "workspace.migrations")).toMatchObject({ type: "workspace.migrations", target: "develop", others: [] });
  });

  it("closes a ticket that changed nothing in the repository, without running the check or merging", async () => {
    const c = (ctx = await setup({ answers: { diff: { ...DIFF, commits: [], files: [], diff: "" }, verify: { ok: false, exitCode: 1, timedOut: true, output: "", ms: 660_000 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { noCode: true });
    expect((await approve(c)).json()).toMatchObject({ verdict: "approved", outcome: "done" });
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.verify");
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.merge");
    expect(await state(c)).toMatchObject({ systemState: "done", mergeCommit: null });
    expect(landingText({ outcome: "done", detail: { note: "Nothing in the repository changed, so there was nothing to check or merge." } }, { branch: "main", assignee: null })).toBe("Approved; the ticket is done. Nothing in the repository changed, so there was nothing to check or merge.");
  });

  it("sends a failed check back to the agent with its output, without merging", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: false, exitCode: 1, timedOut: false, output: "FAIL src/limit.test.ts\n  expected 1000 got 100", ms: 900 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    expect((await approve(c)).json()).toMatchObject({ outcome: "verify_failed" });
    expect(c.sent.some((x) => x.type === "workspace.merge")).toBe(false);
    expect(await state(c)).toMatchObject({ systemState: "in_progress", mergeCommit: null });
    const [w] = await c.db.select().from(wakes);
    expect(w).toMatchObject({ reason: "verify failed", agentId: c.worker.id });
    expect(w!.note).toContain("`pnpm test` exited with code 1");
    expect(w!.note).toContain("expected 1000 got 100");
  });

describe("server-owned check queue (BOS-316)", () => {
    const approve = (c: Awaited<ReturnType<typeof setup>>) => approveAndWait(c.req, c.ticket.id);
    const state = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;
    const prepared = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40) };
    const mergeAnswers = (c: { phase?: string }) => (c.phase === "prepare" ? prepared : { status: "merged", commit: prepared.commit });
    // Plays the dispatcher: ends the first queued/running merge job with the given state.
    const finishJob = async (c: Awaited<ReturnType<typeof setup>>, patch: Record<string, unknown>) => {
      for (let i = 0; i < 40; i++) {
        const [row] = await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
        if (row) { await c.db.update(checkJobs).set({ endedAt: new Date(), ...patch }).where(eq(checkJobs.id, row.id)); return row; }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("no job was queued");
    };
    const on = async (c: Awaited<ReturnType<typeof setup>>) => {
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      await c.db.insert(settings).values({ key: "check_queue_mode", value: "server" });
    };

    it("queues a merge job for the prepared tree, waits for it, then pushes that commit and marks main green", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const res = approve(c);
      const job = await finishJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
      expect(job).toMatchObject({ kind: "merge", scope: "full", commit: prepared.commit, tree: prepared.tree });
      expect(c.sent.some((x) => x.type === "workspace.verify")).toBe(false);
      expect(c.sent.filter((x) => x.type === "workspace.merge").map((x) => (x as { phase?: string }).phase)).toEqual(["prepare", "finish"]);
      const [p] = await c.db.select().from(projects).where(eq(projects.id, c.project.id));
      expect(p!.mainState).toBe("green");
      expect((await state(c)).systemState).toBe("done");
    });

    it("sends the ticket back with the log when the job fails, and pushes nothing", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const res = approve(c);
      await finishJob(c, { state: "failed", exitCode: 1, logTail: "expected 1 got 2" });
      expect((await res).json()).toMatchObject({ outcome: "verify_failed" });
      expect(c.sent.filter((x) => x.type === "workspace.merge").map((x) => (x as { phase?: string }).phase)).toEqual(["prepare"]);
      expect((await state(c)).systemState).toBe("in_progress");
    });

    it("raises the stuck card with the recorded reason when the job is stuck", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const res = approve(c);
      await finishJob(c, { state: "stuck", reason: "The runner went away." });
      expect((await res).json()).toMatchObject({ outcome: "check_stuck" });
      expect(c.sent.filter((x) => x.type === "workspace.merge").map((x) => (x as { phase?: string }).phase)).toEqual(["prepare"]);
      expect((await state(c)).systemState).toBe("review");
    });

    it("raises no card when the job was only dropped for a newer request (BOS-970)", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const res = approve(c);
      await finishJob(c, { state: "cancelled", reason: SUPERSEDED_TEXT });
      expect((await res).json()).toMatchObject({ outcome: "check_stuck" });
      expect(await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `merge-stuck:${c.ticket.id}`))).toHaveLength(0);
      expect((await state(c)).systemState).toBe("review");
    });

    // Ends the newest job that has not ended yet (finishJob takes the first row, which is the old one on a second attempt).
    const finishOpenJob = async (c: Awaited<ReturnType<typeof setup>>, patch: Record<string, unknown>) => {
      for (let i = 0; i < 40; i++) {
        const rows = await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
        const open = rows.filter((r) => !r.endedAt).pop();
        if (open) { await c.db.update(checkJobs).set({ endedAt: new Date(), ...patch }).where(eq(checkJobs.id, open.id)); return open; }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("no open job was queued");
    };
    const cards = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(decisions).where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'check_stuck'`));

    it("still raises the card when the job was cancelled for any other reason (BOS-970)", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const res = approve(c);
      await finishJob(c, { state: "cancelled", reason: "Stopped by the owner." });
      expect((await res).json()).toMatchObject({ outcome: "check_stuck" });
      expect(await cards(c)).toHaveLength(1);
    });

    it("raises one card when the job dropped for a newer request is itself dropped without a successor (BOS-970)", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const first = approve(c);
      await finishOpenJob(c, { state: "cancelled", reason: SUPERSEDED_TEXT });
      expect((await first).json()).toMatchObject({ outcome: "check_stuck" });
      expect(await cards(c)).toHaveLength(0);
      const second = approve(c);
      await finishOpenJob(c, { state: "stuck", reason: "The runner went away." });
      expect((await second).json()).toMatchObject({ outcome: "check_stuck" });
      expect(await cards(c)).toHaveLength(1);
    });

    it("closes an open retry card when the next merge check passes (BOS-970)", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      const first = approve(c);
      await finishOpenJob(c, { state: "stuck", reason: "The runner went away." });
      expect((await first).json()).toMatchObject({ outcome: "check_stuck" });
      expect(await cards(c)).toHaveLength(1);
      const second = approve(c);
      await finishOpenJob(c, { state: "passed", exitCode: 0 });
      expect((await second).json()).toMatchObject({ outcome: "merged" });
      expect(await cards(c)).toHaveLength(0);
    });

    it("cancels the ticket's leftover running merge job when its merge starts again, leaving exactly one live job (BOS-1289)", async () => {
      const c = (ctx = await setup({ answers: { merge: mergeAnswers } }));
      await on(c);
      // The old process's job: still running, for a tree main has since moved past.
      const [old] = await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: c.ticket.id, kind: "merge", scope: "full", commit: "e".repeat(40), tree: "8".repeat(40), command: "pnpm test", state: "running", startedAt: new Date() }).returning();
      const res = approve(c);
      for (let i = 0; i < 40 && (await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id))).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      const rows = await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      const live = rows.filter((r) => r.state === "queued" || r.state === "running");
      expect(live).toHaveLength(1);
      expect(live[0]!.tree).toBe(prepared.tree);
      expect(rows.find((r) => r.id === old!.id)).toMatchObject({ state: "cancelled" });
      await finishOpenJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
    });

    it("tries again with a fresh merge when main moved to a different tree", async () => {
      let finishes = 0;
      const c = (ctx = await setup({ answers: { merge: (m: { phase?: string }) => (m.phase === "prepare" ? prepared : ++finishes === 1 ? { status: "main_moved" } : { status: "merged", commit: prepared.commit }) } }));
      await on(c);
      const res = approve(c);
      await finishJob(c, { state: "passed", exitCode: 0 });
      expect((await res).json()).toMatchObject({ outcome: "merged" });
      expect(c.sent.filter((x) => x.type === "workspace.merge").map((x) => (x as { phase?: string }).phase)).toEqual(["prepare", "finish", "prepare", "finish"]);
    });
  });

  describe("checking the merged result (BOS-313)", () => {
    const sha = "d".repeat(40);
    const merged = { status: "merged", commit: sha, checked: { sha, tree: "e".repeat(40), ms: 5 } };

    it("with the setting on, sends the checks in the merge ask, runs no separate check and saves the checked commit", async () => {
      const c = (ctx = await setup({ answers: { merge: merged } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      expect((await c.req("PUT", "/api/settings/check-merged-result", { on: true })).json()).toEqual({ on: true });
      expect((await approve(c)).json()).toMatchObject({ outcome: "merged" });
      expect(c.sent.some((x) => x.type === "workspace.verify")).toBe(false);
      expect(c.sent.find((x) => x.type === "workspace.merge")).toMatchObject({ checks: ["pnpm test"] });
      expect(await state(c)).toMatchObject({ systemState: "done", mergeCommit: sha, checkedCommit: sha });
      const rows = await c.db.select().from(checkResults).where(eq(checkResults.ticketId, c.ticket.id));
      expect(rows).toMatchObject([{ sha, kind: "verify", passed: true }]);
    });

    it("with the setting off, keeps today's calls: a separate check and a merge without checks", async () => {
      const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      expect((await approve(c)).json()).toMatchObject({ outcome: "merged" });
      expect(c.sent.some((x) => x.type === "workspace.verify")).toBe(true);
      expect(c.sent.find((x) => x.type === "workspace.merge")).not.toHaveProperty("checks");
      expect((await state(c)).checkedCommit).toBeNull();
    });

    it("sends the ticket back when the merged result fails its check, and records the failure", async () => {
      const result = { ok: false, exitCode: 1, timedOut: false, output: "FAIL clash", ms: 50 };
      const c = (ctx = await setup({ answers: { merge: { status: "check_failed", command: "pnpm test", result } } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      await c.req("PUT", "/api/settings/check-merged-result", { on: true });
      expect((await approve(c)).json()).toMatchObject({ outcome: "verify_failed" });
      expect(await state(c)).toMatchObject({ systemState: "in_progress", mergeCommit: null, checkedCommit: null });
      const [w] = await c.db.select().from(wakes);
      expect(w!.note).toContain("FAIL clash");
      const rows = await c.db.select().from(checkResults).where(eq(checkResults.ticketId, c.ticket.id));
      expect(rows).toMatchObject([{ kind: "verify", passed: false }]);
    });
  });

  it("tells a killed check from a failed one", () => {
    const v = (o: Partial<{ timedOut: boolean; exitCode: number | null; output: string }>) => ({ timedOut: false, exitCode: 1, output: "", ...o });
    expect(checkNeverFinished(v({ timedOut: true }))).toBe("timed_out");
    expect(checkNeverFinished(v({ exitCode: 137 }))).toBe("killed");
    expect(checkNeverFinished(v({ exitCode: 143 }))).toBe("killed");
    expect(checkNeverFinished(v({ exitCode: null }))).toBe("killed");
    expect(checkNeverFinished(v({ output: "FATAL ERROR: JavaScript heap out of memory" }))).toBe("out_of_memory");
    expect(checkNeverFinished(v({ output: "Error: Worker exited unexpectedly" }))).toBe("killed");
    expect(checkNeverFinished(v({ output: "FAIL limit.test.ts\n expected 1000 got 100" }))).toBeNull();
    expect(landingText({ outcome: "check_stuck" }, { branch: "main", assignee: null })).toContain("it's in your Decisions");
  });

  it("starts the merge when every review is already in and a reviewer confirms, instead of refusing with no open review", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    const r = await c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "CEO", reviewerAgentId: c.ceo.id });
    expect(r).toMatchObject({ outcome: "merged" });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("done");
    // Someone with no slot is still refused.
    const d = await setup();
    await d.db.insert(reviewRequests).values({ ticketId: d.ticket.id, kind: "code", reviewerAgentId: d.ceo.id, round: 1, seq: 0, status: "approved" });
    await expect(d.review.submit(d.ticket.id, { verdict: "approved", reviewer: "Other", reviewerAgentId: randomUUID() })).rejects.toThrow(/no open review/);
  });

  it("does not restart the merge while an owner sign-off is still open", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } } }));
    await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    // A real sign-off card (BOS-1078: only a card that gates the merge holds it, not any card linked to the ticket).
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Sign off?", recommendedOption: "yes", context: { type: "risk_review", ticketId: c.ticket.id, reviewer: "CEO" } }).returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerDecisionId: d!.id });
    await expect(c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "CEO", reviewerAgentId: c.ceo.id })).rejects.toThrow(/waiting on the owner/);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("review");
  });

  describe("a check that only waited too long for the shared lock", () => {
    const gaveUp = { ok: false, exitCode: 75, timedOut: false, output: "check-all: gave up waiting for the heavy-phase lock /tmp/x.lock", ms: 600_000 };
    const landed = async (c: Awaited<ReturnType<typeof setup>>) => {
      await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
    };

    it("is told apart from a real failure", () => {
      expect(checkWaitedForLock(gaveUp)).toBe(true);
      expect(checkWaitedForLock({ exitCode: 1, output: gaveUp.output })).toBe(false);
      expect(checkWaitedForLock({ exitCode: 75, output: "FAIL limit.test.ts" })).toBe(false);
    });

    it("is retried by Boss Man, stays in review, says so, and merges once the lock frees up", async () => {
      setLockRetryBase(1);
      const c = (ctx = await setup({ answers: { verify: gaveUp } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "scripts/check-all.sh" });
      const first = approveAndWait(c.req, c.ticket.id);
      await vi.waitFor(() => expect(c.sent.filter((x) => x.type === "workspace.verify").length).toBeGreaterThanOrEqual(2));
      c.answers.verify = { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 };
      await first;
      await landed(c);
      const t = (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;
      expect(t.systemState).toBe("done");
      const log = (await c.db.select().from(activity)).filter((a) => a.ticketId === c.ticket.id && a.kind === "merge_check_lock_wait");
      expect(log.length).toBeGreaterThanOrEqual(1);
      expect(log[0]!.summary).toContain("Merge check waiting for lock, retrying");
    });

    it("asks the owner, not the agent, after every try ran out", async () => {
      setLockRetryBase(1);
      const c = (ctx = await setup({ answers: { verify: gaveUp } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "scripts/check-all.sh" });
      await approveAndWait(c.req, c.ticket.id);
      await landed(c);
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(LOCK_RETRY_ATTEMPTS);
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("review");
      expect(await c.db.select().from(wakes)).toHaveLength(0);
      expect((await c.db.select().from(decisions).where(eq(decisions.status, "open")))[0]!.question).toContain("shared lock");
    }, 30_000);

    // BOS-370: a queue that stood still is not retried; the card says so plainly.
    const noProgress = { ok: false, exitCode: 75, timedOut: false, output: "check-all: gave up waiting for the heavy-phase lock /tmp/x.lock: the queue made no progress for 60 min (place 3 of 9; the check holding the slot has not changed)", ms: 3_700_000 };

    it("tells a queue that stood still from a plain lock wait", () => {
      expect(checkQueueStuck(noProgress)).toBe(true);
      expect(checkWaitedForLock(noProgress)).toBe(false);
      expect(checkQueueStuck(gaveUp)).toBe(false);
    });

    it("asks the owner at once, without retrying, when the queue made no progress", async () => {
      setLockRetryBase(1);
      const c = (ctx = await setup({ answers: { verify: noProgress } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "scripts/check-all.sh" });
      await approveAndWait(c.req, c.ticket.id);
      await landed(c);
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(1);
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("review");
      expect((await c.db.select().from(decisions).where(eq(decisions.status, "open")))[0]!.question).toContain("made no progress for 60 minutes");
    }, 30_000);
  });

  describe("a check that was killed is retried by itself, then the CEO's call", () => {
    setInfraRetryBase(1);
    const killed = { ok: false, exitCode: 137, timedOut: false, output: "vitest\nKilled", ms: 5000 };
    const open = (c: Awaited<ReturnType<typeof setup>>) => c.db.select().from(decisions).where(eq(decisions.status, "open"));
    const answer = (c: Awaited<ReturnType<typeof setup>>, id: string, a: string) => c.req("POST", `/api/decisions/${id}/answer`, { answer: a });
    const landed = async (c: Awaited<ReturnType<typeof setup>>) => {
      await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing.state).toBe("finished"));
    };
    const stuck = async () => {
      const c = (ctx = await setup({ answers: { verify: killed } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "check_stuck" });
      return c;
    };

    it("is retried by Boss Man, with no card, when a later try passes", async () => {
      const c = (ctx = await setup({ answers: { verify: killed } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      let calls = 0;
      Object.defineProperty(c.answers, "verify", { get: () => (++calls <= 2 ? killed : { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 }) });
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(3);
      expect(await open(c)).toHaveLength(0);
    });

    it("also retries a timeout and a runner that doesn't answer, but never a real failure", async () => {
      const timedOut = { ok: false, exitCode: null, timedOut: true, output: "", ms: 60_000 };
      const c = (ctx = await setup({ answers: { verify: timedOut } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      let calls = 0;
      Object.defineProperty(c.answers, "verify", { get: () => (++calls === 1 ? timedOut : { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 }) });
      expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2);
      // A failing test is sent back at once: one run only.
      // (setup empties the database, so the first round's rows are gone; nothing below reads them.)
      const c2 = await setup({ answers: { verify: { ok: false, exitCode: 1, timedOut: false, output: "FAIL limit.test.ts", ms: 10 } } });
      ctx = c2;
      await c2.req("PATCH", `/api/projects/${c2.project.id}`, { verifyCommand: "pnpm test" });
      expect((await approveAndWait(c2.req, c2.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
      expect(c2.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(1);
    });

    it("keeps the ticket in review, asks the CEO once after the retries, and leaves the agent alone", async () => {
      const c = await stuck();
      const t = (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;
      expect(t.systemState).toBe("review");
      expect(await c.db.select().from(wakes)).toHaveLength(0);
      const [d, ...rest] = await open(c);
      expect(rest).toHaveLength(0);
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(1 + INFRA_RETRY_ATTEMPTS);
      expect(d).toMatchObject({ tier: "ceo", options: ["Run the check again", "Send it back to the agent", "Merge without the check"] });
      expect(d!.question).toContain("`pnpm test` couldn't finish (it was killed)");
      // The same stuck check again doesn't pile up a second question.
      await approveAndWait(c.req, c.ticket.id);
      expect(await open(c)).toHaveLength(1);
    });

    it("runs the check again and merges when it passes", async () => {
      const c = await stuck();
      c.answers.verify = { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 };
      expect((await answer(c, (await open(c))[0]!.id, "Run the check again")).statusCode).toBe(200);
      await landed(c);
      // Four tries in the first landing (the killed one is retried three times by itself), one in the second.
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2 + INFRA_RETRY_ATTEMPTS);
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]).toMatchObject({ systemState: "done", mergeCommit: "c".repeat(40) });
    });

    it("sends it back to the agent, or merges without the check, when the owner says so", async () => {
      const c = await stuck();
      await answer(c, (await open(c))[0]!.id, "Send it back to the agent");
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("in_progress");
      expect((await c.db.select().from(wakes))[0]!.note).toContain("couldn't finish");
      await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.ticket.id));
      await approveAndWait(c.req, c.ticket.id);
      const verifies = c.sent.filter((x) => x.type === "workspace.verify").length;
      await answer(c, (await open(c))[0]!.id, "Merge without the check");
      await landed(c);
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(verifies);
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("done");
    });
  });

  describe("merge check limit and sign-off cards (BOS-446)", () => {
    it("runs at most the set number of checks at once, the rest wait", async () => {
      const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
      await c.db.insert(settings).values({ key: MERGE_CHECK_LIMIT_KEY, value: 1 });
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      const second = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Second", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
      await c.db.update(tickets).set({ branch: `bossman/${second.id}` }).where(eq(tickets.id, second.id));
      const verifies = () => c.sent.filter((x) => x.type === "workspace.verify").length;
      expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
      await vi.waitFor(() => expect(verifies()).toBe(1));
      expect((await c.req("POST", `/api/tickets/${second.id}/review`, { verdict: "approved" })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 200));
      expect(verifies()).toBe(1);
      c.held.splice(0).forEach((release) => release());
      await vi.waitFor(() => expect(verifies()).toBe(2));
      c.held.splice(0).forEach((release) => release());
      for (const id of [c.ticket.id, second.id]) await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${id}/landing`)).json().landing.state).toBe("finished"));
    });

    it("a new sign-off round closes the older sign-off card, so only one stays open", async () => {
      const c = (ctx = await setup());
      const card = async () => {
        const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: c.ticket.id, reviewer: "R" } }).returning();
        await c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerDecisionId: d!.id });
        return d!;
      };
      const old1 = await card();
      const old2 = await card();
      expect(await supersedeSignoffs(c.db, c.ticket.id, { by: "system", note: "newer", at: new Date().toISOString() })).toBe(2);
      const rows = await c.db.select().from(decisions).where(eq(decisions.status, "open"));
      expect(rows).toHaveLength(0);
      expect((await c.db.select().from(decisions).where(eq(decisions.id, old1.id)))[0]!.status).toBe("withdrawn");
      expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, old2.id))).toHaveLength(0);
    });

    it("answering the sign-off closes the ticket's open retry card", async () => {
      const c = (ctx = await setup());
      const [signoff] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: c.ticket.id, reviewer: "R" } }).returning();
      await c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerDecisionId: signoff!.id });
      const [retry] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Run the check again?", options: ["Run the check again", "Send it back to the agent"], recommendedOption: "Run the check again", tier: "owner", dedupeKey: `merge-stuck:${c.ticket.id}`, context: { type: "check_stuck", ticketId: c.ticket.id, command: "", output: "x" } }).returning();
      expect((await c.req("POST", `/api/decisions/${signoff!.id}/answer`, { answer: "Send it back" })).statusCode).toBe(200);
      expect((await c.db.select().from(decisions).where(eq(decisions.id, retry!.id)))[0]!.status).toBe("withdrawn");
    });

    /** One open owner sign-off card on the ticket, as an agent's approval of high-risk work leaves it. */
    const signoffCard = async (c: Awaited<ReturnType<typeof setup>>) => {
      const [d] = await c.db
        .insert(decisions)
        .values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: c.ticket.id, reviewer: "R" } })
        .returning();
      await c.db.insert(ticketDependencies).values({ blockedTicketId: c.ticket.id, blockerDecisionId: d!.id });
      return d!;
    };
    const mergeCards = (c: Awaited<ReturnType<typeof setup>>) =>
      c.db.select().from(decisions).where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'check_stuck'`));

    it("Approve and merge on the ticket answers the open sign-off and starts the merge in one press (BOS-471, BOS-559)", async () => {
      const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      const signoff = await signoffCard(c);
      const res = c.req("POST", `/api/tickets/${c.ticket.id}/approve-merge`);
      const body = (await res).json() as { outcome: string; signoffAnswered: boolean; landing: { state: string; startedBy: string } | null };
      // The press returns at once, before the held check finishes (BOS-559): the sign-off is settled and the
      // merge runs in the background under the owner's name, handed back for the page to poll.
      expect(body).toMatchObject({ outcome: "landing", signoffAnswered: true, landing: { state: "running", startedBy: "the owner" } });
      // The sign-off is settled, so its hold on the ticket is gone while the merge runs...
      expect((await c.db.select().from(decisions).where(eq(decisions.id, signoff.id)))[0]!.status).toBe("answered");
      expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, signoff.id))).toHaveLength(0);
      // ...and exactly one landing is running (the press must not start a second one).
      expect(c.held).toHaveLength(1);
      c.held.splice(0).forEach((release) => release());
      await vi.waitFor(async () => expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("done"));
      expect(await mergeCards(c)).toHaveLength(0);
    });

    it("a press that only waits on the sign-off raises no merge-retry card (BOS-471)", async () => {
      const c = (ctx = await setup());
      const signoff = await signoffCard(c);
      // No runner is needed for this: the merge must not even claim a landing while the sign-off holds it.
      const direct = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
      expect(direct.statusCode).toBe(409);
      expect(await mergeCards(c)).toHaveLength(0);
      expect((await c.db.select().from(decisions).where(eq(decisions.id, signoff.id)))[0]!.status).toBe("open");
      expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toBeNull();
    });

    it("finishes a ticket with nothing to merge in the same press, rather than leaving it in review", async () => {
      const c = (ctx = await setup());
      await c.db.update(tickets).set({ noCode: true }).where(eq(tickets.id, c.ticket.id));
      const signoff = await signoffCard(c);
      expect((await c.req("POST", `/api/tickets/${c.ticket.id}/approve-merge`)).statusCode).toBe(200);
      expect((await c.db.select().from(decisions).where(eq(decisions.id, signoff.id)))[0]!.status).toBe("answered");
      expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!).toMatchObject({ systemState: "done", outcome: "completed" });
    });

    it("answers the sign-off card at once, before the runner's check finishes (BOS-559)", async () => {
      // The check is held open by the fake runner: the answer must come back anyway, not wait for it.
      const c = (ctx = await setup({ hold: true, answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
      await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
      const signoff = await signoffCard(c);
      const answered = await Promise.race([
        c.req("POST", `/api/decisions/${signoff.id}/answer`, { answer: "Approve and merge" }).then((r) => r.statusCode),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 2_000)),
      ]);
      // The card is closed and the merge is running in the background, still held by the fake runner.
      expect(answered).toBe(200);
      expect((await c.db.select().from(decisions).where(eq(decisions.id, signoff.id)))[0]!.status).toBe("answered");
      expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toMatchObject({ state: "running", startedBy: "the owner" });
      expect(c.held).toHaveLength(1);
      // Finish the merge so the run leaves no timer behind.
      c.held.splice(0).forEach((release) => release());
      await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toMatchObject({ state: "finished", outcome: "merged" }));
    });

    it("still reaches the ticket and the owner when the background landing fails (BOS-559)", async () => {
      // The runner never answers the carried-work check: the merge can't run, which is a failure to report.
      setInfraRetryBase(1);
      const c = (ctx = await setup({ answers: { carried: { carried: [] }, carriedFailures: 4 } }));
      const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Permission gate", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
      await c.db.update(tickets).set({ branch: `bossman/${other.id}` }).where(eq(tickets.id, other.id));
      const signoff = await signoffCard(c);
      const res = await c.req("POST", `/api/decisions/${signoff.id}/answer`, { answer: "Approve and merge" });
      expect(res.statusCode).toBe(200);
      // The failure reaches the ticket (it stays in review with the reason on it) and the owner gets one card.
      await vi.waitFor(async () => {
        const cards = (await c.db.select().from(decisions)).filter((d) => d.status === "open" && d.dedupeKey === `merge-stuck:${c.ticket.id}`);
        expect(cards).toHaveLength(1);
      });
      const t = (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;
      expect(t).toMatchObject({ systemState: "review", mergeCommit: null });
      expect(t.pullRequestNote).toContain("Not merged");
    });
  });

  it("asks the agent to resolve conflicts, or to commit first", async () => {
    const c = (ctx = await setup({ answers: { merge: { status: "conflicts", files: ["src/limit.ts"] } } }));
    expect((await approve(c)).json()).toMatchObject({ outcome: "conflicts" });
    expect((await c.db.select().from(wakes))[0]!.note).toMatch(/conflicts with main in: src\/limit\.ts\. Merge origin\/main into your branch/);
    await c.db.delete(wakes);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    c.answers.merge = { status: "uncommitted", files: ["draft.ts"] };
    expect((await approve(c)).json()).toMatchObject({ outcome: "uncommitted" });
    expect((await c.db.select().from(wakes))[0]!.note).toMatch(/aren't committed: draft\.ts\. Commit your work/);
  });

  it("tells the agent to change approach when the same check failure comes back a third time (R50)", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: false, exitCode: 1, timedOut: false, output: "FAIL src/limit.test.ts (12 ms)\n  expected 1000 got 100", ms: 12 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    for (let i = 0; i < 3; i++) {
      await approve(c);
      if (i < 2) await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    }
    const notes = (await c.db.select().from(wakes)).map((w) => w.note ?? "");
    expect(notes.filter((n) => n.includes("take a different approach"))).toHaveLength(1);
    expect(notes.at(-1)).toContain("This is the 3rd time the same failure has come back.");
  });
});


describe("a branch that carries another open ticket's work (BOS-130)", () => {
  /** An open ticket in the same project, with a branch of its own: what this ticket's branch might carry. */
  async function otherTicket(c: Awaited<ReturnType<typeof setup>>, title: string, risk?: "high" | "critical" | "low") {
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title, assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${t.id}`, ...(risk ? { risk } : {}) }).where(eq(tickets.id, t.id));
    return { id: t.id, branch: `bossman/${t.id}`, title };
  }
  const state = async (c: Awaited<ReturnType<typeof setup>>) => (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;

  it("refuses to merge, names the ticket that must merge first, and runs no check", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 10 } } }));
    const other = await otherTicket(c, "Permission gate");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    const r = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(r).toMatchObject({ verdict: "approved", outcome: "carried" });
    expect(r.message).toContain('"Permission gate"');
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.verify");
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.merge");
    expect(await state(c)).toMatchObject({ systemState: "review", mergeCommit: null });
    // The agent is told which ticket must go first; it hears again only when it is next approved.
    const w = (await c.db.select().from(wakes)).find((x) => x.reason === "carried work");
    expect(w!.note).toContain('carries unmerged work from "Permission gate"');
    expect(w!.note).toContain("must merge first");
    expect((await state(c)).pullRequestNote).toContain('"Permission gate"');
    // The ticket page and the owner hear why in plain words.
    expect(landingText({ outcome: "carried", detail: { carried: [{ title: "Permission gate" }] } }, { branch: "main", assignee: "Engineer" })).toBe(
      'Approved, but not merged: its branch also carries unapproved work from "Permission gate". That ticket must merge first; the ticket stays in review.',
    );
  });

  it("tells the owner when a carried ticket needs their sign-off, and still refuses", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Permission gate", "high");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    const r = (await approveAndWait(c.req, c.ticket.id)).json();
    // The carried ticket is unmerged, so there's nothing to approve-and-merge: the landing refuses,
    // and the owner hears that the high-risk ticket must merge first.
    expect(r).toMatchObject({ outcome: "carried" });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(d).toMatchObject({ tier: "owner", options: ["Got it"] });
    expect(d!.question).toContain('"Permission gate"');
    expect(d!.question).toContain("before \"Add rate limiting\" can land");
    expect(d!.question).toContain("high risk");
    // Nothing ran or merged, and the ticket stays in review, held by that decision.
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.verify");
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.merge");
    expect(await state(c)).toMatchObject({ systemState: "review" });
    expect(c.sent.find((x) => x.type === "workspace.carried")).toMatchObject({ target: "main", branches: [{ ticketId: other.id, branch: other.branch }] });
  });

  it("doesn't ask the owner again for a low-risk carried ticket: the agent is told and the ticket waits", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "A small fix", "low");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "carried" });
    expect(await c.db.select().from(decisions)).toHaveLength(0);
    expect(await state(c)).toMatchObject({ systemState: "review" });
  });

  it("lets the CEO start a fresh merge attempt on an approved ticket the gate refused, and refuses one that isn't approved (BOS-684)", async () => {
    const c = (ctx = await setup());
    const asCeo = { byAgentId: c.ceo.id, companyId: c.company.id };
    // Not approved yet: nothing to retry.
    await expect(c.review.retryMerge(c.ticket.id, asCeo)).rejects.toMatchObject({ status: 409 });
    const other = await otherTicket(c, "Permission gate");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    expect(await c.review.land(c.ticket.id, "Reviewer")).toMatchObject({ outcome: "carried" });
    expect((await state(c)).pullRequestNote).toContain("must merge first");
    // The carried work has merged since: the retry runs the gate again on the runner and lands it.
    c.answers.carried = { carried: [] };
    const before = c.sent.filter((x) => x.type === "workspace.carried").length;
    await c.review.retryMerge(c.ticket.id, asCeo);
    await vi.waitFor(async () => expect(await state(c)).toMatchObject({ systemState: "done" }));
    expect(c.sent.filter((x) => x.type === "workspace.carried").length).toBe(before + 1);
    // A finished ticket can't be retried.
    await expect(c.review.retryMerge(c.ticket.id, asCeo)).rejects.toMatchObject({ status: 409 });
  });

  it("starts the held merge again by itself once the ticket it waited for merges (BOS-733)", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Permission gate");
    const bystander = await otherTicket(c, "Unrelated work");
    for (const id of [c.ticket.id, other.id, bystander.id]) await c.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    expect(await c.review.land(c.ticket.id, "Reviewer")).toMatchObject({ outcome: "carried" });
    // A ticket held by something else is left alone.
    await c.db.update(tickets).set({ pullRequestNote: 'Waiting: its branch also carries unapproved work from "Something else" (medium risk), which must merge first.' }).where(eq(tickets.id, bystander.id));
    // The carried ticket merges: the held one is started again without anyone approving it again.
    c.answers.carried = { carried: [] };
    expect(await c.review.land(other.id, "Reviewer")).toMatchObject({ outcome: "merged" });
    await vi.waitFor(async () => expect(await state(c)).toMatchObject({ systemState: "done", mergeCommit: "c".repeat(40) }));
    expect((await c.db.select().from(activity).where(and(eq(activity.ticketId, c.ticket.id), eq(activity.kind, "merge_retried")))).map((a) => a.summary)).toEqual([
      '"Permission gate" merged, so the merge this ticket was waiting for was started again. Nothing to do.',
    ]);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, bystander.id)))[0]).toMatchObject({ systemState: "review" });
  });

  it("withdraws the owner's merge-that-first card and lands the held ticket once the high-risk ticket it named merges (BOS-733)", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Permission gate", "high");
    for (const id of [c.ticket.id, other.id]) await c.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    expect(await c.review.land(c.ticket.id, "Reviewer")).toMatchObject({ outcome: "carried" });
    const card = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).find((d) => (d.context as { type?: string }).type === "carried");
    expect(card).toBeDefined();
    // The owner signs the high-risk ticket off, and it merges.
    await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", status: "answered", answer: "Approve and merge", answeredAt: new Date(), context: { type: "risk_review", ticketId: other.id, reviewer: "the CEO" } });
    c.answers.carried = { carried: [] };
    expect(await c.review.land(other.id, "Reviewer")).toMatchObject({ outcome: "merged" });
    await vi.waitFor(async () => expect(await state(c)).toMatchObject({ systemState: "done" }));
    expect((await c.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]).toMatchObject({ status: "withdrawn" });
  });

  it("lands an approved ticket together with the one that holds all of it (fast-forward case, BOS-372)", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Inner work");
    await c.db.insert(reviewRequests).values({ ticketId: other.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch, contained: true }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(await state(c)).toMatchObject({ systemState: "done" });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, other.id)))[0]).toMatchObject({ systemState: "done" });
  });

  it("runs the deeper check when a high-risk approved ticket lands with a low-risk one (BOS-372)", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test"  });
    await c.db.update((await import("../src/db/schema.js")).projects).set({ deepVerifyCommand: "pnpm test:e2e" });
    const other = await otherTicket(c, "Inner work", "high");
    await c.db.insert(reviewRequests).values({ ticketId: other.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - 60_000) });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch, contained: true }] };
    // High risk is owed the owner's sign-off: never signed off, it can't ride along on this merge (BOS-503).
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "carried" });
    // Signed off, it lands with this one, and the deeper check its risk needs still runs.
    const t = (await c.db.select().from(tickets).where(eq(tickets.id, other.id)))[0]!;
    await c.db.insert(decisions).values({ companyId: t.companyId, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", status: "answered", answer: "Approve and merge", answeredAt: new Date(), context: { type: "risk_review", ticketId: other.id, reviewer: "the CEO" } });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch, contained: true }] };
    await c.db.update(tickets).set({ systemState: "review", pullRequestNote: null }).where(eq(tickets.id, c.ticket.id));
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(c.sent.filter((x) => x.type === "workspace.verify").map((x) => (x as { command: string }).command)).toEqual(["export BOSSMAN_FULL_CHECK_NEXT=1; pnpm test", "pnpm test:e2e"]);
  });

  it("never lands a carried ticket that isn't approved, even when this branch holds all of it (BOS-372)", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Unfinished work");
    await c.db.insert(reviewRequests).values({ ticketId: other.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "pending" });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch, contained: true }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "carried" });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, other.id)))[0]).toMatchObject({ systemState: "review" });
  });

  it("refuses an approved carried ticket this branch holds only part of (BOS-372)", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Inner work");
    await c.db.insert(reviewRequests).values({ ticketId: other.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch, contained: false }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "carried" });
  });

  it("merges when the other ticket is done, so its work is on the target already", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Permission gate");
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed" }).where(eq(tickets.id, other.id));
    c.answers.carried = { carried: [{ ticketId: other.id, branch: other.branch }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    // A done ticket is no longer a candidate at all, so the runner is never asked about it.
    expect(c.sent.find((x) => x.type === "workspace.carried")).toBeUndefined();
  });

  it("asks about every other open ticket's branch, never its own", async () => {
    const c = (ctx = await setup());
    const other = await otherTicket(c, "Permission gate");
    await approveAndWait(c.req, c.ticket.id);
    const asked = c.sent.find((x): x is Extract<RunnerCommand, { type: "workspace.carried" }> => x.type === "workspace.carried");
    expect(asked!.branches).toEqual([{ ticketId: other.id, branch: other.branch }]);
  });

  it("waits for a busy runner and asks the carried-work check again by itself, then merges (BOS-486)", async () => {
    setInfraRetryBase(1);
    const c = (ctx = await setup({ answers: { carried: { carried: [] }, carriedFailures: 2 } }));
    await otherTicket(c, "Permission gate");
    const r = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(r).toMatchObject({ verdict: "approved", outcome: "merged" });
    expect(c.sent.filter((x) => x.type === "workspace.carried")).toHaveLength(3);
    expect(c.sent.map((x) => x.type)).toContain("workspace.merge");
  });

  it("raises one Run-the-check-again card, and leaves the ticket in review, when the runner never answers the carried-work check (BOS-486)", async () => {
    setInfraRetryBase(1);
    const c = (ctx = await setup({ answers: { carried: { carried: [] }, carriedFailures: 4 } }));
    await otherTicket(c, "Permission gate");
    const r = (await approveAndWait(c.req, c.ticket.id)).json();
    expect(r).toMatchObject({ verdict: "approved", outcome: "check_stuck" });
    expect(c.sent.filter((x) => x.type === "workspace.carried")).toHaveLength(4);
    expect(c.sent.map((x) => x.type)).not.toContain("workspace.merge");
    expect(await state(c)).toMatchObject({ systemState: "review", mergeCommit: null });
    const cards = (await c.db.select().from(decisions)).filter((d) => d.status === "open" && d.dedupeKey === `merge-stuck:${c.ticket.id}`);
    expect(cards).toHaveLength(1);
    expect((await c.db.select().from(wakes)).find((x) => x.reason === "carried check failed")).toBeUndefined();
  });
});

describe("the owner's sign-off is tied to the commit it approved (DR-013)", () => {
  const OK = { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 };
  // The owner signs off a high-risk ticket at head bbbb…, and the merge then fails (a conflict), so it goes back.
  const signedOffThenFailed = async () => {
    const c = (ctx = await setup({ answers: { verify: OK, merge: { status: "conflicts", files: ["src/limit.ts"] } } }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { verifyCommand: "pnpm test" });
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { risk: "high" });
    expect(await c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "Senior Developer", reviewerAgentId: c.ceo.id })).toMatchObject({ outcome: "owner_review" });
    const [card] = await openCards(c);
    expect(card!.context).toMatchObject({ head: "b".repeat(40), risk: "high" });
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Approve and merge" })).statusCode).toBe(200);
    const [answered] = await c.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(answered!.context).toMatchObject({ signedOff: { head: "b".repeat(40), risk: "high", by: "owner" } });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("in_progress");
    c.answers.merge = { status: "merged", commit: "c".repeat(40) };
    return { c, card: card! };
  };
  const openCards = async (c: Awaited<ReturnType<typeof setup>>) =>
    (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "risk_review");
  // The ticket comes back to review and its reviewer approves again.
  const reApprove = async (c: Awaited<ReturnType<typeof setup>>) => {
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.ticket.id));
    return c.review.submit(c.ticket.id, { verdict: "approved", reviewer: "Senior Developer", reviewerAgentId: c.ceo.id });
  };

  it("(a) reuses the sign-off when the reviews pass again on the same commit: no new card, the merge runs", async () => {
    const { c } = await signedOffThenFailed();
    expect(await reApprove(c)).toMatchObject({ outcome: "merged" });
    expect(await openCards(c)).toHaveLength(0);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!.systemState).toBe("done");
    const [ev] = (await c.db.select().from(activity).where(eq(activity.ticketId, c.ticket.id))).filter((a) => a.kind === "signoff_reused");
    expect(ev!.summary).toMatch(/owner's sign-off from .* UTC was reused: Senior Developer approved the same commit bbbbbbbb/);
  });

  it("(b) asks again on a new commit, and the card names the commit the owner approved before", async () => {
    const { c } = await signedOffThenFailed();
    c.answers.diff = { ...DIFF, head: "d".repeat(40) };
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
    const [card] = await openCards(c);
    expect(card!.question).toMatch(/You approved an earlier version \(bbbbbbbb\) on .* UTC; the code has changed since\./);
    expect(card!.context).toMatchObject({ head: "d".repeat(40) });
  });

  it("(c) asks again after the owner sent it back, even on the same commit", async () => {
    const { c } = await signedOffThenFailed();
    // Re-approved once more and sent back on the new card.
    expect(await reApprove(c)).toMatchObject({ outcome: "merged" });
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.ticket.id));
    c.answers.diff = { ...DIFF, head: "d".repeat(40) };
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
    const [card] = await openCards(c);
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Send it back" })).statusCode).toBe(200);
    // The old sign-off's commit comes back unchanged: still a new card.
    c.answers.diff = DIFF;
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
    expect(await openCards(c)).toHaveLength(1);
  });

  it("(c) asks again after the owner sent it back from the review page, even on the same commit", async () => {
    const { c } = await signedOffThenFailed();
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.ticket.id));
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested", summary: "Not like this." })).statusCode).toBeLessThan(300);
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
    expect(await openCards(c)).toHaveLength(1);
  });

  it("(d) asks again when the risk was raised after the sign-off", async () => {
    const { c } = await signedOffThenFailed();
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { risk: "critical" });
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
    expect(await openCards(c)).toHaveLength(1);
  });

  it("never reuses a sign-off when the runner can't say which commit it is", async () => {
    const { c } = await signedOffThenFailed();
    c.answers.diff = { ...DIFF, head: "" };
    expect(await reApprove(c)).toMatchObject({ outcome: "owner_review" });
  });
});
