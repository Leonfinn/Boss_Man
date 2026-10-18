import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, tickets } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  return { ...built, db, close, req, company, ceo, project, sent, runnerRow: runnerRow! };
}

describe("git workspaces on the server (R38)", () => {
  it("refuses a repo address with a credential in it", async () => {
    const c = (ctx = await setup());
    expect((await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://bot:ghp_0123456789abcdefghijABCDEFGHIJ@github.com/a/b.git" })).statusCode).toBe(400);
    expect((await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "ftp://example.com/x" })).statusCode).toBe(400);
    const ok = await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "develop" });
    expect(ok.json()).toMatchObject({ repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "develop" });
  });

  it("launches a repo project's ticket in its worktree, records its branch, and frees it when done", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Checkout error states", assigneeAgentId: c.ceo.id })).json();
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    expect(start.workspace).toEqual({ projectId: c.project.id, ticketId: t.id, repoUrl: "https://github.com/Leonfinn/customer-app.git", baseRef: "main" });

    await c.runners.ingest(c.runnerRow, { seq: 1, at: new Date().toISOString(), event: { type: "run.workspace", runId: start.runId, ticketId: t.id, branch: `bossman/${t.id}`, baseCommit: "abc123", created: true, restoredPatch: false } });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]).toMatchObject({ branch: `bossman/${t.id}`, baseCommit: "abc123" });

    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    expect(c.sent.at(-1)).toEqual({ type: "workspace.release", projectId: c.project.id, ticketId: t.id });
  });

  it("leaves projects without a repo in a plain directory", async () => {
    const c = (ctx = await setup());
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Write the launch post", assigneeAgentId: c.ceo.id });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    expect(start.workspace).toBeUndefined();
    expect(start.cwd).toMatch(/^\/ws\//);
  });
});
