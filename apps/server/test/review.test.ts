import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, tickets, wakes } from "../src/db/schema.js";

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

type Answers = { verify?: unknown; merge?: unknown };

async function setup(opts: { online?: boolean; answers?: Answers } = {}) {
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
      if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: DIFF }));
      if (c.type === "workspace.verify") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.verify }));
      if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: answers.merge }));
      return true;
    });
  }
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${ticket.id}` }).where(eq(tickets.id, ticket.id));
  await db.delete(wakes);
  return { ...built, db, close, req, company, ceo, worker, project, ticket, sent, answers };
}

describe("review (R39)", () => {
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
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).json()).toMatchObject({ verdict: "approved" });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]).toMatchObject({ systemState: "done", outcome: "completed", mergeCommit: "c".repeat(40) });
    expect(c.sent.at(-1)).toMatchObject({ type: "workspace.release", ticketId: c.ticket.id });
    expect((await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" })).statusCode).toBe(409);
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

describe("landing an approved ticket (R46, R47)", () => {
  const approve = (c: Awaited<ReturnType<typeof setup>>) => c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved" });
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

