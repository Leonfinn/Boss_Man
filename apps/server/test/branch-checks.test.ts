// BOS-1418: the host's build result on a ticket's branch head, for the ticket page (route + review.branchChecks),
// and the tickets tool's "CI on branch head" line, which must stay word for word what it was.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, tickets } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const SHA = "a1b2c3d4".padEnd(40, "e");
type Kind = "github" | "gitea";
const BASE: Record<Kind, string> = { github: "https://api.example.com", gitea: "https://git.example.com/api/v1" };

/** A fake host: one branch head, and whatever the test queues for the checks call. */
function fakeHost(kind: Kind) {
  const state = { checks: { status: 200, body: {} as unknown }, branch: { status: 200 }, calls: 0 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const repo = `${BASE[kind]}/repos/leon/site`;
    if (url === `${repo}/branches/feature-x`) return state.branch.status === 200 ? json(200, { commit: kind === "github" ? { sha: SHA } : { id: SHA } }) : json(state.branch.status, { message: "nope" });
    if (url.startsWith(`${repo}/commits/${SHA}/`)) {
      state.calls++;
      return json(state.checks.status, state.checks.body);
    }
    return json(404, { message: `no fake for ${url}` });
  }) as typeof globalThis.fetch;
  return { fetch, state };
}

async function setup(kind: Kind, opts: { token?: boolean } = {}) {
  const host = fakeHost(kind);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch: host.fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await db.update(projects).set({ repoUrl: "https://example.com/leon/site.git", gitHost: kind, gitApiBase: BASE[kind] }).where(eq(projects.id, project.id));
  if (opts.token !== false) {
    const { secret } = (await req("POST", "/api/secrets", { name: "Git", kind: "generic", value: "example-token-value" })).json();
    await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  }
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work" })).json() as { id: string };
  await db.update(tickets).set({ systemState: "review", branch: "feature-x" }).where(eq(tickets.id, t.id));
  return { ...built, db, close, host, req, companyId: company.id, ticketId: t.id, project, cookie };
}

const ghRun = (name: string, status: string, conclusion: string | null, n: number) => ({ name, status, conclusion, html_url: `https://example.com/runs/${n}` });
const giteaStatus = (context: string, status: string, n: number) => ({ context, status, target_url: `https://example.com/ci/${n}` });

type Case = { label: string; github: unknown; gitea: unknown; ci: Record<string, unknown> | null; line: string };
const at = SHA.slice(0, 8);
const CASES: Case[] = [
  {
    label: "passed",
    github: { check_runs: [ghRun("build", "completed", "success", 1), ghRun("lint", "completed", "success", 2)] },
    gitea: { statuses: [giteaStatus("build", "success", 1), giteaStatus("lint", "success", 2)] },
    ci: { state: "passed", failing: [], total: 2 },
    line: `CI on branch head ${at}: passed (2 checks).`,
  },
  {
    label: "failed",
    github: { check_runs: [ghRun("build", "completed", "success", 1), ghRun("lint", "completed", "failure", 2)] },
    gitea: { statuses: [giteaStatus("build", "success", 1), giteaStatus("lint", "failure", 2)] },
    ci: { state: "failed", failing: ["lint"], total: 2 },
    line: `CI on branch head ${at}: FAILED (lint).`,
  },
  {
    label: "running",
    github: { check_runs: [ghRun("build", "in_progress", null, 1)] },
    gitea: { statuses: [giteaStatus("build", "pending", 1)] },
    ci: { state: "pending", failing: [], total: 1 },
    line: `CI on branch head ${at}: still running.`,
  },
  {
    label: "no result",
    github: { check_runs: [] },
    gitea: { statuses: [] },
    // The page shows nothing for a host that reported no checks (criterion 2); the tickets tool keeps its line.
    ci: null,
    line: `CI on branch head ${at}: no checks reported (yet).`,
  },
];

describe.each(["github", "gitea"] as const)("build result on %s", (kind) => {
  for (const c of CASES) {
    it(`${c.label}: the page gets the state, the tool keeps its exact line`, async () => {
      const x = (ctx = await setup(kind));
      x.host.state.checks.body = c[kind];
      const res = await x.req("GET", `/api/tickets/${x.ticketId}/ci`);
      expect(res.statusCode).toBe(200);
      if (c.ci === null) expect(res.json()).toEqual({ ci: null });
      else {
        expect(res.json().ci).toMatchObject({ ...c.ci, sha: SHA });
        expect(res.json().ci.url).toMatch(/^https:\/\/example\.com\//);
      }
      expect(await x.review.branchChecksLine(x.ticketId, x.companyId)).toBe(c.line);
    });
  }

  it("host error: the page gets null, the tool keeps its refusal line", async () => {
    const x = (ctx = await setup(kind));
    x.host.state.checks = { status: 403, body: { message: "Resource not accessible" } };
    const res = await x.req("GET", `/api/tickets/${x.ticketId}/ci`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ci: null });
    const line = await x.review.branchChecksLine(x.ticketId, x.companyId);
    expect(line).toContain(`CI on branch head: not available (Couldn't read the checks on ${at}: Resource not accessible`);
    expect(line).toContain("Checks: Read-only.");
  });

  it("a branch the host doesn't know gives null", async () => {
    const x = (ctx = await setup(kind));
    x.host.state.branch = { status: 404 };
    expect((await x.req("GET", `/api/tickets/${x.ticketId}/ci`)).json()).toEqual({ ci: null });
  });
});

describe("when there is nothing to show", () => {
  it("is null without a git token, without a branch, and once merged", async () => {
    const x = (ctx = await setup("github", { token: false }));
    expect((await x.req("GET", `/api/tickets/${x.ticketId}/ci`)).json()).toEqual({ ci: null });
    expect(await x.review.branchChecksLine(x.ticketId, x.companyId)).toBeNull();
  });
  it("is null with no branch, or a merge commit", async () => {
    const x = (ctx = await setup("gitea"));
    x.host.state.checks.body = { statuses: [giteaStatus("build", "success", 1)] };
    await x.db.update(tickets).set({ branch: null }).where(eq(tickets.id, x.ticketId));
    expect(await x.review.branchChecks(x.ticketId, x.companyId)).toBeNull();
    await x.db.update(tickets).set({ branch: "feature-x", mergeCommit: "f".repeat(40) }).where(eq(tickets.id, x.ticketId));
    expect(await x.review.branchChecks(x.ticketId, x.companyId)).toBeNull();
  });
  it("needs the owner's login", async () => {
    const x = (ctx = await setup("github"));
    const res = await x.app.inject({ method: "GET", url: `/api/tickets/${x.ticketId}/ci` });
    expect(res.statusCode).toBe(401);
  });
  it("answers repeat asks from a short cache", async () => {
    const x = (ctx = await setup("github"));
    x.host.state.checks.body = { check_runs: [ghRun("build", "completed", "success", 1)] };
    await x.req("GET", `/api/tickets/${x.ticketId}/ci`);
    await x.req("GET", `/api/tickets/${x.ticketId}/ci`);
    expect(x.host.state.calls).toBe(1);
  });
});
