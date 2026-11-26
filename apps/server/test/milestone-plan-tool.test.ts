// BOS-2627: the CEO records the plan line for a milestone the owner put in their hands with the roadmap tool (set_plan),
// and the owner's roadmap reads it back under the milestone's reason. Only for a milestone that is At risk or Late and that
// the CEO manages, so a plan can't appear where nothing explains it. The roadmap list shows each milestone's status and plan.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueRunToken } from "../src/mcp.js";
import { decisions, ticketDependencies, tickets as ticketsTable } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const built: TestApp = await makeApp();
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const { cookie } = await signIn(built);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co", ceo: { name: "Chief", agentKind: "claude", model: "claude-opus-5-5" } })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  // A milestone that is Late on the read date: its date has passed with work left.
  const objective = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Ship it", priority: 1 })).json() as { id: string };
  const milestone = (await req("POST", `/api/objectives/${objective.id}/milestones`, { title: "Launch", targetDate: "2026-10-10" })).json() as { id: string };
  await req("POST", `/api/projects/${project.id}/tickets`, { title: "Done work", milestoneId: milestone.id, state: "done" });
  await req("POST", `/api/projects/${project.id}/tickets`, { title: "Left to build", milestoneId: milestone.id, state: "in_progress" });
  return { ...built, cookie, base, req, company, ceo, milestone, project };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

async function agent() {
  const token = await issueRunToken(ctx.db, { companyId: ctx.company.id, agentId: ctx.ceo.id, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

const readMilestone = async (today = "2026-10-16") => (await ctx.req("GET", `/api/roadmap?today=${today}`)).json()[0].objectives[0].milestones[0] as { status: string; ceoPlan: string | null; ceoManagesRisk: boolean };

describe("the CEO's plan for a milestone (BOS-2627)", () => {
  it("set_plan is refused on a milestone the CEO doesn't manage, so a plan only lands where a wake explains it", async () => {
    const c = await agent();
    const res = await c.callTool({ name: "roadmap", arguments: { action: "set_plan", milestoneId: ctx.milestone.id, plan: "Move the rest to next week.", reason: "Planning the milestone." } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/CEO manages at risk/);
    expect((await readMilestone()).ceoPlan).toBeNull();
    await c.close();
  });

  it("set_plan records the line, list shows it with the status, and null clears it", async () => {
    const c = await agent();
    await ctx.req("PATCH", `/api/milestones/${ctx.milestone.id}`, { ceoManagesRisk: true });
    expect((await readMilestone()).status).toBe("late");
    const res = await c.callTool({ name: "roadmap", arguments: { action: "set_plan", milestoneId: ctx.milestone.id, plan: "Move the rest to next week and ship the smaller part.", reason: "Planning the milestone." } });
    expect(textOf(res)).toMatch(/Recorded the plan/);
    expect(res.isError).not.toBe(true);
    expect((await readMilestone()).ceoPlan).toBe("Move the rest to next week and ship the smaller part.");
    // The list carries it, so the CEO can see what is already planned.
    const listed = JSON.parse(textOf(await c.callTool({ name: "roadmap", arguments: { action: "list" } }))) as Array<{ milestones: Array<{ id: string; status: string; ceoPlan: string | null }> }>;
    expect(listed[0]!.milestones[0]).toMatchObject({ id: ctx.milestone.id, status: "late", ceoPlan: "Move the rest to next week and ship the smaller part." });
    const cleared = await c.callTool({ name: "roadmap", arguments: { action: "set_plan", milestoneId: ctx.milestone.id, plan: null, reason: "No remedy needed." } });
    expect(cleared.isError).not.toBe(true);
    expect((await readMilestone()).ceoPlan).toBeNull();
    await c.close();
  });

  it("set_plan is accepted on a milestone At risk only because a ticket waits on the owner's card, as list shows it (BOS-2627)", async () => {
    const c = await agent();
    // Due well out with an estimate, so the only reason for At risk is the open card the ticket waits on.
    const o = (await ctx.req("POST", `/api/companies/${ctx.company.id}/objectives`, { title: "Owner waits", priority: 2 })).json() as { id: string };
    const m = (await ctx.req("POST", `/api/objectives/${o.id}/milestones`, { title: "Card bound", targetDate: "2026-12-30" })).json() as { id: string };
    const made = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Waiting on the owner", milestoneId: m.id, state: "ready" })).json() as { id: string };
    await ctx.db.update(ticketsTable).set({ size: 1 }).where(eq(ticketsTable.id, made.id));
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "question", question: "Do it this way?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: ctx.ceo.id }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: made.id, blockerDecisionId: d!.id });
    await ctx.req("PATCH", `/api/milestones/${m.id}`, { ceoManagesRisk: true });
    const listed = JSON.parse(textOf(await c.callTool({ name: "roadmap", arguments: { action: "list" } }))) as Array<{ milestones: Array<{ id: string; status: string }> }>;
    expect(listed.flatMap((x) => x.milestones).find((x) => x.id === m.id)?.status).toBe("at_risk");
    const res = await c.callTool({ name: "roadmap", arguments: { action: "set_plan", milestoneId: m.id, plan: "Ask the owner for a yes on the card.", reason: "Planning the milestone." } });
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toMatch(/Recorded the plan/);
    await c.close();
  });
});
