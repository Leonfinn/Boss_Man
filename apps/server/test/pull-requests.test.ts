import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, checkResults, notifications, projects, tickets, wakes } from "../src/db/schema.js";
import { approveAndWait } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const GITEA = "http://192.168.1.50:3003";
const HEAD = "d".repeat(40);

/** A fake Gitea 28 that records each call; merge answers are queued per test. */
function fakeGitea() {
  const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  const pr = { number: 7, html_url: `${GITEA}/leon/site/pulls/7`, state: "open", merged: false, merge_commit_sha: null as string | null };
  const mergeAnswers: Array<{ status: number; body?: unknown }> = [];
  const checks = { state: "pending", statuses: [] as Array<{ context: string; status: string }> };
  // Pull requests and their commits, by number (BOS-130); 7 is the one the fake opens.
  const pulls = new Map<number, typeof pr>([[7, pr]]);
  const commits = new Map<number, string[]>();
  // Branch heads at the host, by branch name (BOS-130).
  const heads = new Map<string, string>();
  // A status the host answers for a branch instead of its head, for errors other than "not found" (BOS-577).
  const branchErrors = new Map<string, number>();
  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === `${GITEA}/api/v1/version`) return json(200, { version: "28.0.0" });
    const base = `${GITEA}/api/v1/repos/leon/site/pulls`;
    if (method === "GET" && url.startsWith(`${base}/main/`)) return calls.some((c) => c.method === "POST" && c.url === base) ? json(200, pr) : json(404, { message: "not found" });
    if (method === "POST" && url === base) return json(201, pr);
    if (method === "POST" && url === `${base}/7/merge`) {
      const a = mergeAnswers.shift() ?? { status: 200 };
      if (a.status === 200) Object.assign(pr, { state: "closed", merged: true, merge_commit_sha: "e".repeat(40) });
      return json(a.status, a.body);
    }
    const one = /^\/(\d+)(\/commits)?(\?.*)?$/.exec(url.slice(base.length));
    if (method === "GET" && one) {
      const n = Number(one[1]);
      const pull = pulls.get(n);
      if (!pull) return json(404, { message: "no such pull request" });
      if (one[2]) return json(200, (commits.get(n) ?? []).map((sha) => ({ sha })));
      return json(200, pull);
    }
    if (method === "GET" && url === `${GITEA}/api/v1/repos/leon/site/commits/${HEAD}/status`) return json(200, checks);
    const branch = /^\/branches\/(.+)$/.exec(url.slice(`${GITEA}/api/v1/repos/leon/site`.length));
    if (method === "GET" && branch) {
      const failed = branchErrors.get(branch[1]!);
      if (failed) return json(failed, { message: "internal error" });
      const sha = heads.get(branch[1]!);
      return sha ? json(200, { name: branch[1], commit: { id: sha } }) : json(404, { message: "no such branch" });
    }
    return json(404, { message: `no fake for ${method} ${url}` });
  }) as typeof globalThis.fetch;
  return { fetch, calls, pr, mergeAnswers, checks, pulls, commits, heads, branchErrors };
}

// pin: the runner announces "merge-pin" like the real one: workspace.push answers branch_moved unless its pin is the branch tip
// held in pin.branch; workspace.covers answers pin.covers. The pins the pushes carried are kept in pin.pins.
type PinRunner = { branch: string; covers: boolean; pins: Array<string | undefined> };

async function setup(opts: { token?: boolean; pin?: PinRunner } = {}) {
  const gitea = fakeGitea();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: gitea.fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  if (opts.token !== false) {
    const { secret } = (await req("POST", "/api/secrets", { name: "Gitea", kind: "generic", value: "gitea-token-value" })).json();
    await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  }
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    // Landing first asks what changed; these tickets changed code.
    if (c.type === "workspace.diff") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "", truncated: false } }));
    if (c.type === "workspace.push") {
      const pin = opts.pin;
      pin?.pins.push(c.pin);
      const data = pin && c.pin && c.pin !== pin.branch ? { status: "branch_moved", head: pin.branch, pinned: c.pin } : { status: "pushed", branch: `bossman/${c.ticketId}`, commit: HEAD };
      queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data }));
    }
    if (c.type === "workspace.covers") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { covers: opts.pin?.covers ?? false, reason: "", newCommits: opts.pin?.covers ? 0 : 1, handMerges: 0 } }));
    if (c.type === "workspace.merge") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { status: "merged", commit: "c".repeat(40) } }));
    if (c.type === "workspace.migrations") queueMicrotask(() => built.runners.resolveReply({ requestId: c.requestId, ok: true, data: { needed: false, reason: "No other branch uses this ticket's migration numbers." } }));
    return true;
  }, opts.pin ? ["signoff-covers", "merge-pin"] : undefined);
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", body: "Limit the API to 100 requests a minute.", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.delete(wakes);
  const approve = () => approveAndWait(req, ticket.id);
  const state = async () => (await db.select().from(tickets).where(eq(tickets.id, ticket.id)))[0]!;
  return { ...built, db, close, req, company, worker, project, ticket, sent, gitea, approve, state };
}

describe("pull requests on Gitea (R59)", () => {
  it("allows a LAN Gitea over plain http and finds its API", async () => {
    const c = (ctx = await setup());
    expect((await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "http://example.com/leon/site.git" })).statusCode).toBe(400);
    const ok = await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git` });
    expect(ok.json()).toMatchObject({ repoUrl: `${GITEA}/leon/site.git`, gitHost: "gitea", gitApiBase: `${GITEA}/api/v1`, landing: "merge" });
  });

  it("pushes the branch, opens a pull request and merges the reviewed commit", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    expect((await c.approve()).json()).toMatchObject({ verdict: "approved", outcome: "merged" });

    expect(c.sent.map((x) => x.type)).toContain("workspace.push");
    expect(c.sent.some((x) => x.type === "workspace.merge")).toBe(false);
    const create = c.gitea.calls.find((x) => x.method === "POST" && x.url.endsWith("/repos/leon/site/pulls"))!;
    expect(create.auth).toBe("token gitea-token-value");
    expect(create.body).toMatchObject({ head: `bossman/${c.ticket.id}`, base: "main", title: "Add rate limiting", body: expect.stringContaining("Limit the API to 100 requests a minute.") });
    const merge = c.gitea.calls.find((x) => x.url.endsWith("/pulls/7/merge"))!;
    expect(merge.body).toMatchObject({ do: "merge", head_commit_id: HEAD });
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: "e".repeat(40), pullRequestNumber: 7, pullRequestUrl: `${GITEA}/leon/site/pulls/7`, pullRequestHead: HEAD });
  });

  it("waits in review while the host won't merge, tells the owner once, and finishes when it's merged there", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    c.gitea.mergeAnswers.push({ status: 405, body: { message: "Does not have enough approvals" } }, { status: 405, body: { message: "Does not have enough approvals" } });
    expect((await c.approve()).json()).toMatchObject({ outcome: "pull_request" });
    expect(await c.state()).toMatchObject({ systemState: "review", pullRequestNote: "Does not have enough approvals", mergeCommit: null });

    expect(await c.review.syncPullRequests()).toEqual({ checked: 1, merged: 0 });
    const told = await c.db.select().from(notifications);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: "Pull request waiting: Add rate limiting", link: `#/tickets/${c.ticket.id}` });

    // Someone merges it on Gitea.
    Object.assign(c.gitea.pr, { state: "closed", merged: true, merge_commit_sha: "f".repeat(40) });
    expect(await c.review.syncPullRequests()).toEqual({ checked: 1, merged: 1 });
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: "f".repeat(40), pullRequestNote: null });
    expect(await c.review.syncPullRequests()).toEqual({ checked: 0, merged: 0 });
  });

  it("stops before pushing without a git token, or without a known host", async () => {
    const c = (ctx = await setup({ token: false }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    const res = await c.approve();
    expect(res.json().message).toContain("GIT_TOKEN");
    await c.db.update(projects).set({ gitHost: null, gitApiBase: null }).where(eq(projects.id, c.project.id));
    expect((await c.approve()).json().message).toContain("git host");
    expect(c.sent.some((x) => x.type === "workspace.push" || x.type === "workspace.merge")).toBe(false);
    expect(await c.state()).toMatchObject({ systemState: "review" });
  });
});

describe("the pull-request push is pinned to the reviewed head (BOS-1413 follow-up)", () => {
  const REVIEWED = "b".repeat(40);
  const LATE = "c".repeat(40);

  it("pushes with the reviewed head as its pin", async () => {
    const pin: PinRunner = { branch: REVIEWED, covers: false, pins: [] };
    const c = (ctx = await setup({ pin }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    expect((await c.approve()).json()).toMatchObject({ outcome: "merged" });
    expect(pin.pins).toEqual([REVIEWED]);
  });

  it("a commit made after the approval is not pushed: no pull request, ticket sent back", async () => {
    const pin: PinRunner = { branch: LATE, covers: false, pins: [] };
    const c = (ctx = await setup({ pin }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    expect((await c.approve()).json()).toMatchObject({ outcome: "branch_changed" });
    expect(c.gitea.calls.some((x) => x.method === "POST")).toBe(false);
    expect(await c.state()).toMatchObject({ systemState: "in_progress", pullRequestNumber: null });
  });

  it("a head that only has main merged in is pushed: the pin moves to it", async () => {
    const pin: PinRunner = { branch: LATE, covers: true, pins: [] };
    const c = (ctx = await setup({ pin }));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    expect((await c.approve()).json()).toMatchObject({ outcome: "merged" });
    expect(pin.pins).toEqual([REVIEWED, LATE]);
    expect(await c.state()).toMatchObject({ systemState: "done", pullRequestNumber: 7 });
  });
});

describe("check results wake the right agent (R86)", () => {
  it("tells the assignee once per commit when checks fail, and the CEO when they pass", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    const note = { status: 405, body: { message: "Required status check is not passing" } };
    c.gitea.mergeAnswers.push(note, note, note, note, note, note);
    await c.approve();
    await c.db.delete(wakes);

    // Pending says nothing.
    await c.review.syncPullRequests();
    expect(await c.db.select().from(wakes)).toHaveLength(0);

    Object.assign(c.gitea.checks, { state: "failure", statuses: [{ context: "ci/build", status: "failure" }, { context: "ci/lint", status: "success" }] });
    await c.review.syncPullRequests();
    const failed = await c.db.select().from(wakes);
    expect(failed).toEqual([expect.objectContaining({ agentId: c.worker.id, ticketId: c.ticket.id, reason: "ci failed", priority: 3, note: expect.stringContaining("ci/build") })]);
    expect(failed[0]!.note).not.toContain("ci/lint");
    expect(await c.state()).toMatchObject({ systemState: "in_progress", pullRequestCi: `${HEAD}:failed` });
    expect(await c.db.select().from(checkResults)).toEqual([expect.objectContaining({ ticketId: c.ticket.id, sha: HEAD, kind: "ci", passed: false, detail: "ci/build" })]);

    // Back in review on the same commit: the same result isn't told again.
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, c.ticket.id));
    await c.review.syncPullRequests();
    expect(await c.db.select().from(wakes)).toHaveLength(1);

    Object.assign(c.gitea.checks, { state: "success", statuses: [{ context: "ci/build", status: "success" }] });
    await c.review.syncPullRequests();
    await c.review.syncPullRequests();
    const [ceo] = await c.db.select().from(agents).where(eq(agents.role, "ceo"));
    const passed = (await c.db.select().from(wakes)).filter((w) => w.reason === "ci passed");
    expect(passed).toEqual([expect.objectContaining({ agentId: ceo!.id, ticketId: c.ticket.id, note: expect.stringContaining("Required status check is not passing") })]);
    expect((await c.db.select().from(checkResults).orderBy(checkResults.at)).map((r) => r.passed)).toEqual([false, true]);
  });
});

describe("a pull request whose branch carries another open ticket's work (BOS-130)", () => {
  it("doesn't merge it at the host, and says which ticket must go first", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    // A high-risk ticket with its own open pull request: its reviewed head is one of this branch's commits.
    const carried = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Permission gate", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
    const theirHead = "f".repeat(40);
    await c.db.update(tickets).set({ branch: `bossman/${carried.id}`, risk: "high", pullRequestNumber: 8, pullRequestHead: theirHead }).where(eq(tickets.id, carried.id));
    c.gitea.pulls.set(8, { number: 8, html_url: `${GITEA}/leon/site/pulls/8`, state: "open", merged: false, merge_commit_sha: null });
    // This ticket's open pull request: its commits include the carried ticket's reviewed head.
    c.gitea.pulls.set(7, { number: 7, html_url: `${GITEA}/leon/site/pulls/7`, state: "open", merged: false, merge_commit_sha: null });
    c.gitea.commits.set(7, ["a".repeat(40), theirHead]);
    await c.db.update(tickets).set({ pullRequestNumber: 7, pullRequestUrl: `${GITEA}/leon/site/pulls/7`, pullRequestHead: "b".repeat(40) }).where(eq(tickets.id, c.ticket.id));

    const res = await c.req("POST", `/api/tickets/${c.ticket.id}/pull-request/merge`);
    expect(res.statusCode).toBe(200);
    expect(c.gitea.calls.some((x) => x.url.endsWith("/pulls/7/merge"))).toBe(false);
    const t = await c.state();
    expect(t).toMatchObject({ systemState: "review", mergeCommit: null });
    expect(t.pullRequestNote).toContain('"Permission gate"');
    expect(t.pullRequestNote).toContain("must merge first");
  });

  it("still merges the pull request when nothing is carried", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    expect((await c.approve()).json()).toMatchObject({ outcome: "merged" });
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: "e".repeat(40) });
  });

  it("still merges when another open ticket's branch was never pushed to the host (BOS-577)", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    // An in-progress ticket with a branch of its own that the host has never seen: it carries nothing.
    const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Permission gate", assigneeAgentId: c.worker.id, state: "in_progress" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${other.id}` }).where(eq(tickets.id, other.id));
    await c.db.update(tickets).set({ pullRequestNumber: 7, pullRequestUrl: `${GITEA}/leon/site/pulls/7`, pullRequestHead: "b".repeat(40) }).where(eq(tickets.id, c.ticket.id));

    const res = await c.req("POST", `/api/tickets/${c.ticket.id}/pull-request/merge`);
    expect(res.statusCode).toBe(200);
    expect(c.gitea.calls.some((x) => x.url.endsWith("/pulls/7/merge"))).toBe(true);
    expect(await c.state()).toMatchObject({ systemState: "done", mergeCommit: "e".repeat(40) });
  });

  it("doesn't merge when the host can't say what another ticket's branch is carrying (BOS-577)", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: `${GITEA}/leon/site.git`, landing: "pull_request" });
    // An open ticket whose branch the host fails to answer for (not a plain "not found"): the gate can't check it.
    const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Permission gate", assigneeAgentId: c.worker.id, state: "review" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${other.id}` }).where(eq(tickets.id, other.id));
    c.gitea.branchErrors.set(`bossman/${other.id}`, 500);
    await c.db.update(tickets).set({ pullRequestNumber: 7, pullRequestUrl: `${GITEA}/leon/site/pulls/7`, pullRequestHead: "b".repeat(40) }).where(eq(tickets.id, c.ticket.id));

    const res = await c.req("POST", `/api/tickets/${c.ticket.id}/pull-request/merge`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("so it wasn't merged");
    expect(c.gitea.calls.some((x) => x.url.endsWith("/pulls/7/merge"))).toBe(false);
    expect(await c.state()).toMatchObject({ systemState: "review", mergeCommit: null });
  });
});
