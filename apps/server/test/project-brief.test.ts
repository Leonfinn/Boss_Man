import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, runners, wakes } from "../src/db/schema.js";
import { briefCommitLine, briefFolder, briefSlug, briefTitle, parseCommitLine } from "../src/services/project-brief.js";

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
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string; name: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => (c.type === "run.start" && commands.push(c), true));
  const writeBrief = (body: string) => built.wiki.write(company.id, { slug: briefSlug(project.id), folder: briefFolder(project.name), title: briefTitle(project.name), body, agentId: ceo.id, runId: null });
  return { ...built, db, close, req, company, ceo, project, worker, commands, writeBrief };
}

const BODY = `${briefCommitLine("abc1234", "main")}\n\n## Objectives\nShip.\n\n## Code map\nsrc/\n`;

describe("commit line", () => {
  it("reads the sha and branch back", () => {
    expect(parseCommitLine(briefCommitLine("0123abc", "release/1.2"))).toEqual({ commit: "0123abc", branch: "release/1.2" });
    expect(parseCommitLine(`${briefCommitLine("0123abc", "main")}\n\n## Objectives`)).toEqual({ commit: "0123abc", branch: "main" });
    expect(parseCommitLine("## Objectives\nDescribes commit abc1234 on main.")).toBeNull();
    expect(parseCommitLine("Describes commit xyz on main.")).toBeNull();
  });
});

describe("project brief", () => {
  it("creates one ticket for the CEO, and returns it again while it is open", async () => {
    const c = (ctx = await setup());
    const url = `/api/projects/${c.project.id}/brief`;
    const first = await c.req("POST", url);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ title: "Write the project brief", assigneeAgentId: c.ceo.id, projectId: c.project.id });
    expect(first.json().body).toContain(`slug: brief-${c.project.id}`);
    expect(first.json().body).toContain("## Code map");
    expect(first.json().body).toContain("git rev-parse HEAD");
    const second = await c.req("POST", url);
    expect(second.json().id).toBe(first.json().id);
    expect((await c.req("GET", url)).json()).toMatchObject({ slug: briefSlug(c.project.id), exists: false, commit: null, ticketId: first.json().id });

    // Once it is done, the brief is no longer being written; with a page it becomes a refresh.
    await c.req("PATCH", `/api/tickets/${first.json().id}`, { state: "done" });
    await c.writeBrief(BODY);
    const got = (await c.req("GET", url)).json();
    expect(got).toMatchObject({ exists: true, commit: "abc1234", branch: "main", ticketId: null });
    expect((await c.req("POST", url)).json()).toMatchObject({ title: "Refresh the project brief" });
  });

  it("keeps its slug when the project is renamed, and refuses without a CEO", async () => {
    const c = (ctx = await setup());
    const { page } = await c.writeBrief(BODY);
    expect(page.slug).toBe(briefSlug(c.project.id));
    await c.req("PATCH", `/api/projects/${c.project.id}`, { name: "Renamed" });
    expect((await c.req("GET", `/api/projects/${c.project.id}/brief`)).json()).toMatchObject({ exists: true });

    await c.db.update(agents).set({ retiredAt: new Date() }).where(eq(agents.id, c.ceo.id));
    const res = await c.req("POST", `/api/projects/${c.project.id}/brief`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no CEO");
  });

  it("points a ticket's wake at the brief only when the page exists", async () => {
    const c = (ctx = await setup());
    const wake = async (title: string) => {
      c.commands.length = 0;
      await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title, assigneeAgentId: c.worker.id });
      await c.scheduler.tick();
      return c.commands.find((x) => x.agentId === c.worker.id)!.prompt;
    };
    expect(await wake("First")).not.toContain("project has a brief");
    await c.writeBrief(BODY);
    c.runners.ingest((await c.db.select().from(runners))[0]!, { seq: 1, at: new Date().toISOString(), event: { type: "run.ended", runId: c.commands[0]!.runId, stopReason: "end_turn", error: null } });
    const prompt = await wake("Second");
    expect(prompt).toContain(`wiki read slug="${briefSlug(c.project.id)}" section="Code map"`);
    expect(prompt).toContain("sections: Objectives, Code map");
    expect(prompt).toContain("commit abc1234 on main");
    expect(prompt).toContain("It is a map, not the source of truth");
    expect(prompt).not.toContain("Ship.");
  });

  it("tells the wiki maintainer to update the brief for a finished ticket of that project", async () => {
    const c = (ctx = await setup());
    await c.writeBrief(BODY);
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Move the server" })).json() as { id: string };
    await c.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    const [keeper] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.duty, "wiki")));
    await c.req("PATCH", `/api/agents/${keeper!.id}`, { paused: false, model: "claude-sonnet-5-5" });
    expect(await c.db.select().from(wakes).where(eq(wakes.agentId, keeper!.id))).not.toHaveLength(0);
    await c.scheduler.tick();
    const prompt = c.commands.find((c) => c.agentId === keeper!.id)!.prompt;
    expect(prompt).toContain(`"Move the server" (completed): nothing attached; project brief: ${briefSlug(c.project.id)}`);
    expect(prompt).toContain("update the affected sections of that brief");
  });
});
