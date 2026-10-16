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

async function setup(opts: { online?: boolean } = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws" });
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
      return true;
    });
  }
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${ticket.id}` }).where(eq(tickets.id, ticket.id));
  await db.delete(wakes);
  return { ...built, db, close, req, company, ceo, worker, project, ticket, sent };
}

describe("review (R39)", () => {
  it("fetches the diff from the runner holding the worktree", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/diff`)).json()).toEqual(DIFF);
    expect(c.sent.at(-1)).toMatchObject({ type: "workspace.diff", projectId: c.project.id, ticketId: c.ticket.id });
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
    expect((await c.db.select().from(tickets).where(eq(tickets.id, c.ticket.id)))[0]).toMatchObject({ systemState: "done", outcome: "completed" });
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
