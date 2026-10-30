import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, reviewRequests, checkResults, decisions, runs, tickets, ticketDependencies, wakes } from "../src/db/schema.js";
import { checkNeverFinished, checkWaitedForLock, LOCK_RETRY_ATTEMPTS, setLockRetryBase, landingText } from "../src/services/review.js";
import { approveAndWait } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const DIFF: WorkspaceDiff = {
  baseCommit: "a".repeat(40),
  head: "b".repeat(40),
  commits: [{ sha: "b".repeat(40), subject: "Add rate limiting" }],
  files: [{ path: "src/limit.ts", added: 2, removed: 0 }],
  diff: ["diff --git a/src/limit.ts b/src/limit.ts", "--- /dev/null", "+++ b/src/limit.ts", "@@ -0,0 +1,2 @@", "+export const LIMIT = 1000;", "+export const WINDOW = 60;"].join("\n"),
  truncated: false,
};

type Answers = { verify?: unknown; merge?: unknown; diff?: unknown };

async function setup(opts: { online?: boolean; answers?: Answers; hold?: boolean } = {}) {
  const held: Array<() => void> = [];
  const answers: Answers = { merge: { status: "merged", commit: "c".repeat(40) }, ...opts.answers };
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
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
      if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.merge }));
      return true;
    });
  }
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${ticket.id}` }).where(eq(tickets.id, ticket.id));
  await db.delete(wakes);
  return { ...built, db, close, req, company, ceo, worker, project, ticket, sent, answers, held };
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
    await vi.waitFor(async () => expect((await c.req("GET", `/api/tickets/${c.ticket.id}/landing`)).json().landing).toBeNull());
  });

  it("says each outcome in plain words", () => {
    const ctx = { branch: "main", assignee: "Engineer" };
    expect(landingText({ outcome: "merged" }, ctx)).toBe("Merged into main.");
    expect(landingText({ outcome: "pull_request", detail: { url: "https://h/pr/1", note: "needs an approval" } }, ctx)).toBe("Pull request opened: https://h/pr/1. It hasn't merged yet: needs an approval");
    expect(landingText({ outcome: "verify_failed", detail: { timedOut: true, ms: 660_000 } }, ctx)).toContain("the check timed out after 11 minutes. It's gone back to Engineer to fix");
    expect(landingText({ outcome: "conflicts", detail: { files: ["a.ts"] } }, ctx)).toBe("Approved, but not merged: the work conflicts with main in a.ts. It's gone back to Engineer to sort out.");
    expect(landingText({ outcome: "uncommitted", detail: { files: ["b.ts"] } }, ctx)).toContain("isn't saved to the branch yet (b.ts)");
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
    await d.app.close(); await d.close();
  });

  it("does not restart the merge while an owner sign-off is still open", async () => {
    const c = (ctx = await setup({ answers: { verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } } }));
    await c.db.insert(reviewRequests).values({ ticketId: c.ticket.id, kind: "code", reviewerAgentId: c.ceo.id, round: 1, seq: 0, status: "approved" });
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Sign off?", recommendedOption: "yes" }).returning();
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
  });

  describe("a check that was killed is the owner's call", () => {
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

    it("keeps the ticket in review, asks the owner once, and leaves the agent alone", async () => {
      const c = await stuck();
      const t = (await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]!;
      expect(t.systemState).toBe("review");
      expect(await c.db.select().from(wakes)).toHaveLength(0);
      const [d, ...rest] = await open(c);
      expect(rest).toHaveLength(0);
      expect(d).toMatchObject({ tier: "owner", options: ["Run the check again", "Send it back to the agent", "Merge without the check"] });
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
      expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(2);
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

