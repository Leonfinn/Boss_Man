import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { AGENT_TEMPLATES } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, tickets } from "../src/db/schema.js";

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
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  return { ...built, db, close, req, company, ceo, project, sent };
}

describe("the Agents tab (R62)", () => {
  it("stars an agent, and the star persists in the company's agent list", async () => {
    const c = (ctx = await setup());
    const sam = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Sam", template: "scrum-master" })).json() as { id: string };
    const starredIn = async () => ((await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as Array<{ id: string; starred: boolean }>).find((x) => x.id === sam.id)!.starred;
    expect(await starredIn()).toBe(false);
    expect((await c.req("PATCH", `/api/agents/${sam.id}`, { starred: true })).statusCode).toBe(200);
    expect(await starredIn()).toBe(true);
    const companies = (await c.req("GET", "/api/companies")).json() as Array<{ agents: Array<{ id: string; starred: boolean }> }>;
    expect(companies[0]!.agents.find((x) => x.id === sam.id)!.starred).toBe(true);
  });

  it("hires from a template, whose title and instructions reach the agent's prompt", async () => {
    const c = (ctx = await setup());
    const { templates } = (await c.req("GET", "/api/agent-templates")).json() as { templates: typeof AGENT_TEMPLATES };
    expect(templates.map((t) => t.title)).toEqual(["Engineer", "Researcher", "Designer", "QA", "Writer", "Scrum Master", "Assistant", "Senior Developer", "Security Reviewer", "Adversarial Reviewer", "Senior Infrastructure Engineer", "Product Manager", "Release Manager", "Data & Analytics", "Support"]);
    const hired = await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Sam", template: "scrum-master" });
    expect(hired.statusCode).toBe(201);
    const sam = hired.json() as { id: string; title: string; instructions: string; template: string };
    expect(sam).toMatchObject({ title: "Scrum Master", template: "scrum-master" });
    expect(sam.instructions).toContain("keep the owner and the CEO informed");
    expect((await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "X", template: "astronaut" })).statusCode).toBe(422);

    await c.req("POST", `/api/agents/${sam.id}/wake`, { note: "Say hello." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start" && x.agentId === sam.id)!;
    expect(start.prompt).toContain("You are Sam, the Scrum Master of App Co, working through Boss Man.");
    expect(start.prompt).toContain("Your instructions from the owner:");
    expect(start.prompt).toContain("You report; you do not do the work");
  });

  it("keeps a thinking level, refuses an unknown one, and sends it with the run", async () => {
    const c = (ctx = await setup());
    const eng = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Eng", thinking: "high" })).json() as { id: string; thinking: string | null };
    expect(eng.thinking).toBe("high");
    expect((await c.req("PATCH", `/api/agents/${eng.id}`, { thinking: "huge" })).statusCode).toBe(400);
    await c.req("POST", `/api/agents/${eng.id}/wake`, { note: "Go." });
    await c.scheduler.tick();
    const start = c.sent.find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start" && x.agentId === eng.id)!;
    expect(start.thinking).toBe("high");
    // Default sends nothing, so an older runner and the adapter's own default are unaffected.
    expect((await c.req("PATCH", `/api/agents/${eng.id}`, { thinking: null })).json()).toMatchObject({ thinking: null });
    const history = (await c.req("GET", `/api/agents/${eng.id}/history`)).json() as Array<{ c: { field: string } }>;
    expect(history.map((h) => h.c.field)).toContain("thinking");
  });

  it("lists each agent with what it's doing and its use this month", async () => {
    const c = (ctx = await setup());
    const eng = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", template: "engineer" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add checkout", assigneeAgentId: eng.id })).json() as { id: string };
    await c.scheduler.tick();
    const [run] = await c.db.select().from(runs).where(eq(runs.agentId, eng.id));
    await c.db.update(runs).set({ inputTokens: 1200, outputTokens: 300 }).where(eq(runs.id, run!.id));
    const list = (await c.req("GET", `/api/companies/${c.company.id}/agents`)).json() as Array<{ name: string; role: string; status: string; current: { ticketId: string } | null; openTickets: number; month: { runs: number; tokens: number; costMicros: number } }>;
    expect(list[0]!.role).toBe("ceo");
    const e = list.find((a) => a.name === "Engineer")!;
    expect(e).toMatchObject({ status: "working", current: { ticketId: t.id }, openTickets: 1, month: { runs: 1, tokens: 1500, costMicros: 0 } });
    expect(list.find((a) => a.name === "Wiki Maintainer")).toMatchObject({ status: "paused" });
  });

  it("keeps every change with its diff, and undoes one unless it has changed again", async () => {
    const c = (ctx = await setup());
    const eng = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", template: "engineer" })).json() as { id: string; instructions: string };
    await c.req("PATCH", `/api/agents/${eng.id}`, { instructions: "Only work on the API.", model: "claude-opus-5-5" });
    const history = (await c.req("GET", `/api/agents/${eng.id}/history`)).json() as Array<{ c: { id: string; field: string; before: unknown; after: unknown } }>;
    expect(history.map((h) => h.c.field).sort()).toEqual(["hired", "instructions", "model"]);
    const instr = history.find((h) => h.c.field === "instructions")!;
    expect(instr.c).toMatchObject({ before: eng.instructions, after: "Only work on the API." });

    expect((await c.req("POST", `/api/agent-changes/${instr.c.id}/undo`)).json()).toMatchObject({ instructions: eng.instructions, model: "claude-opus-5-5" });
    expect((await c.req("POST", `/api/agent-changes/${instr.c.id}/undo`)).statusCode).toBe(409);
    // The model changed again since that change, so undoing it is refused.
    const model = history.find((h) => h.c.field === "model")!;
    await c.req("PATCH", `/api/agents/${eng.id}`, { model: "claude-sonnet-5-5" });
    expect((await c.req("POST", `/api/agent-changes/${model.c.id}/undo`)).statusCode).toBe(409);
  });

  it("retires an agent: its open tickets and watches are freed, it can't get new work, and undo rehires it", async () => {
    const c = (ctx = await setup());
    const eng = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Add checkout", assigneeAgentId: eng.id, state: "backlog" })).json() as { id: string };
    await c.req("PUT", `/api/tickets/${t.id}/watcher`, { agentId: eng.id });
    expect((await c.req("POST", `/api/agents/${c.ceo.id}/retire`)).statusCode).toBe(409);

    const r = (await c.req("POST", `/api/agents/${eng.id}/retire`)).json() as { unassigned: number; agent: { retiredAt: string | null; paused: boolean } };
    expect(r).toMatchObject({ unassigned: 1, agent: { paused: true } });
    expect(r.agent.retiredAt).not.toBeNull();
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]).toMatchObject({ assigneeAgentId: null, watcherAgentId: null });
    expect((await c.req("GET", "/api/companies")).json()[0].agents.map((a: { name: string }) => a.name)).not.toContain("Engineer");
    expect((await c.req("PATCH", `/api/tickets/${t.id}`, { assigneeAgentId: eng.id })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/agents/${eng.id}`, { paused: false })).statusCode).toBe(409);

    const retired = ((await c.req("GET", `/api/agents/${eng.id}/history`)).json() as Array<{ c: { id: string; field: string } }>).find((h) => h.c.field === "retired")!;
    expect((await c.req("POST", `/api/agent-changes/${retired.c.id}/undo`)).json()).toMatchObject({ retiredAt: null });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]).toMatchObject({ assigneeAgentId: eng.id, watcherAgentId: eng.id });
  });
});
