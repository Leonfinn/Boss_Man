// BOS-2907: review.imagesJobLines (what `tickets read` shows under the CI line) reads the ticket's own bossman-ci runs
// through the project's GitHub host and token, and names the branch commit from GitHub CI before review's rows.
import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkResults, projects, tickets } from "../src/db/schema.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const API = "https://api.example.com";
const LOG = ['INSTALL_HELPER_MOVE=1 INSTALL_RELEASE_JSON="$RUNNER_TEMP/release.json" scripts/test-shell.sh scripts/install-images.test.sh', "ok   the second install answers /api/health beside the first", "ok   the first install still answers"].join("\n");

async function setup(kind: "github" | "gitea") {
  let ticketId = "";
  const asked: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    // The token goes in the header, never in the URL or the lines.
    expect(url).not.toContain("example-token-value");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer example-token-value");
    const repo = `${API}/repos/leon/site`;
    if (url === `${repo}/actions/runs?branch=${encodeURIComponent(`bossman-ci/${ticketId}`)}&per_page=10`)
      return json(200, { workflow_runs: [{ id: 5, run_attempt: 1, name: "CI", event: "push", status: "completed", conclusion: "success", head_sha: "8c7712b2".padEnd(40, "0"), head_commit: { message: "GitHub CI before review (workflows from main)" }, path: ".github/workflows/ci.yml", html_url: "https://example.com/runs/5", created_at: "2026-11-28T04:18:32Z" }] });
    if (url === `${repo}/actions/runs/5/jobs?per_page=100`)
      return json(200, { jobs: [{ id: 7, name: "images (amd64)", status: "completed", conclusion: "success", html_url: "https://example.com/job/7", steps: [{ number: 28, name: "Install from the images this branch just built", status: "completed", conclusion: "success" }] }] });
    if (url === `${repo}/actions/jobs/7/logs`) return new Response(LOG, { status: 200 });
    return json(404, { message: `no fake for ${url}` });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", fetch });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await db.update(projects).set({ repoUrl: "https://example.com/leon/site.git", gitHost: kind, gitApiBase: API }).where(eq(projects.id, project.id));
  const { secret } = (await req("POST", "/api/secrets", { name: "Git", kind: "generic", value: "example-token-value" })).json();
  await req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "GIT_TOKEN" });
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work" })).json() as { id: string };
  ticketId = t.id;
  await db.update(tickets).set({ systemState: "in_progress", branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  await db.insert(checkResults).values({ companyId: company.id, ticketId: t.id, sha: "39b99e03".padEnd(40, "1"), kind: "ci_preflight_started", passed: false, detail: "agent", at: new Date("2026-11-28T04:18:00Z") });
  return { ...built, db, ticketId, companyId: company.id, asked };
}

it("shows the images job of the ticket's newest CI run, with the branch commit it tested and the install lines", async () => {
  const x = await setup("github");
  const lines = await x.review.imagesJobLines(x.ticketId, x.companyId);
  expect(lines?.[0]).toContain("your branch commit 39b99e03 merged with main");
  expect(lines?.[1]).toBe('- images (amd64): passed; install step: passed; install-images.test.sh: 2 ok, 0 FAIL; last lines: "ok the second install answers /api/health beside the first" | "ok the first install still answers". https://example.com/job/7');
});

it("shows nothing once the ticket is done, and nothing off GitHub", async () => {
  const x = await setup("github");
  await x.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, x.ticketId));
  expect(await x.review.imagesJobLines(x.ticketId, x.companyId)).toBeNull();
  await ctx?.close();
  const y = await setup("gitea");
  expect(await y.review.imagesJobLines(y.ticketId, y.companyId)).toBeNull();
  expect(y.asked.filter((u) => u.includes("/actions/"))).toEqual([]);
});
