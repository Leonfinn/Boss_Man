import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decisions, ticketDependencies, tickets } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const ticket = async (title: string, fields: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...fields })).json() as { id: string };
  return { req, company, project, ticket, db: t.db };
}

describe("roadmap", () => {
  it("groups milestones by objective and company with their progress and status", async () => {
    const c = await setup();
    const obj = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch the beta", priority: 1 })).json();
    await c.req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Beta users", target: 50, current: 20 });
    const alpha = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Alpha", targetDate: "2026-10-10" })).json();
    const beta = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Beta", targetDate: "2026-10-25" })).json();
    const later = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Later" })).json();
    await c.ticket("Sign-in", { milestoneId: alpha.id, state: "done" });
    await c.ticket("Payments", { milestoneId: alpha.id, state: "in_progress" });
    await c.ticket("Onboarding", { milestoneId: beta.id, state: "done" });
    await c.ticket("Invites", { milestoneId: beta.id, state: "blocked" });
    await c.ticket("Dropped idea", { milestoneId: beta.id, state: "done", outcome: "cancelled" });

    const [co] = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json();
    expect(co.name).toBe("App Co");
    const [o] = co.objectives;
    expect(o.keyResults[0]).toMatchObject({ title: "Beta users", progress: 0.4 });
    expect(o.milestones.map((m: { title: string; status: string; total: number; done: number }) => [m.title, m.status, m.done, m.total])).toEqual([
      ["Alpha", "late", 1, 2],
      ["Beta", "at_risk", 1, 2],
      ["Later", "no_work", 0, 0],
    ]);

    // Now / Next / Later: from work and dates, unless pinned.
    expect(o.milestones.map((m: { title: string; horizon: string; pinned: string | null }) => [m.title, m.horizon, m.pinned])).toEqual([
      ["Alpha", "now", null],
      ["Beta", "now", null],
      ["Later", "later", null],
    ]);
    expect((await c.req("PATCH", `/api/milestones/${later.id}`, { horizon: "next" })).json().horizon).toBe("next");
    const soon = (await c.req("POST", `/api/objectives/${obj.id}/milestones`, { title: "Polish", horizon: "next" })).json();
    expect(soon.horizon).toBe("next");
    const pinned = (await c.req("GET", "/api/roadmap?today=2026-10-16")).json()[0].objectives[0].milestones;
    expect(pinned.filter((m: { horizon: string }) => m.horizon === "next").map((m: { title: string }) => m.title).sort()).toEqual(["Later", "Polish"]);
    expect((await c.req("PATCH", `/api/milestones/${later.id}`, { horizon: "soon" })).statusCode).toBe(400);
    await c.req("DELETE", `/api/milestones/${soon.id}`);

    expect((await c.req("PATCH", `/api/milestones/${beta.id}`, { targetDate: "2026-12-01" })).json().targetDate).toBe("2026-12-01");
    expect((await c.req("GET", `/api/milestones/${alpha.id}/tickets`)).json().map((x: { title: string }) => x.title)).toEqual(["Sign-in", "Payments"]);

    // Deleting a milestone keeps its tickets.
    expect((await c.req("DELETE", `/api/milestones/${later.id}`)).statusCode).toBe(204);
    expect((await c.req("DELETE", `/api/milestones/${alpha.id}`)).statusCode).toBe(204);
    expect((await c.db.select().from(tickets)).length).toBe(5);

    // Closed objectives leave the roadmap unless asked for.
    await c.req("PATCH", `/api/objectives/${obj.id}`, { status: "done" });
    expect((await c.req("GET", "/api/roadmap")).json()[0].objectives).toEqual([]);
    expect((await c.req("GET", "/api/roadmap?closed=1")).json()[0].objectives).toHaveLength(1);
    expect((await c.req("PATCH", `/api/objectives/${obj.id}`, { status: "paused" })).statusCode).toBe(400);
  });
});

describe("plan", () => {
  it("draws what tickets wait on, finds blocked chains, and releases a ticket when its last blocker goes", async () => {
    const c = await setup();
    const design = await c.ticket("Design the API", { state: "in_progress" });
    const api = await c.ticket("Build the API", { state: "blocked" });
    const ui = await c.ticket("Build the UI", { state: "blocked" });
    await c.ticket("Unrelated", { state: "ready" });
    const dep1 = (await c.req("POST", `/api/tickets/${api.id}/dependencies`, { ticketId: design.id })).json();
    await c.req("POST", `/api/tickets/${ui.id}/dependencies`, { ticketId: api.id });
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "Which payment provider?", options: ["Stripe", "Adyen"], recommendedOption: "Stripe", context: { type: "question" } }).returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: ui.id, blockerDecisionId: d!.id });

    const plan = (await c.req("GET", `/api/companies/${c.company.id}/plan`)).json();
    const node = (id: string) => plan.nodes.find((n: { id: string }) => n.id === id);
    expect(plan.nodes).toHaveLength(4);
    expect(node(design.id)).toMatchObject({ kind: "ticket", layer: 0, blocked: false, holdingUp: 2, link: `#/tickets/${design.id}`, project: "Customer app" });
    expect(node(ui.id)).toMatchObject({ layer: 2, blocked: true, holdingUp: 0 });
    expect(node(ui.id).causes.sort()).toEqual([d!.id, design.id].sort());
    expect(node(d!.id)).toMatchObject({ kind: "decision", open: true, title: "Which payment provider?" });

    const links = (await c.req("GET", `/api/tickets/${api.id}/links`)).json();
    expect(links.waitsOn).toEqual([expect.objectContaining({ kind: "ticket", id: design.id, open: true, dependencyId: dep1.id })]);
    expect(links.blocks).toEqual([expect.objectContaining({ id: ui.id, title: "Build the UI" })]);

    // A decision blocker goes by answering the decision.
    const decisionDep = (await c.req("GET", `/api/tickets/${ui.id}/links`)).json().waitsOn.find((w: { kind: string }) => w.kind === "decision");
    expect((await c.req("DELETE", `/api/dependencies/${decisionDep.dependencyId}`)).statusCode).toBe(422);

    expect((await c.req("DELETE", `/api/dependencies/${dep1.id}`)).statusCode).toBe(204);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, api.id)))[0]!.systemState).toBe("ready");
    expect((await c.req("GET", `/api/companies/${c.company.id}/open-tickets`)).json()).toHaveLength(4);
  });
});
