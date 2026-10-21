import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decisions, reviewRequests, ticketDependencies } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeApp();
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await t.close();
});

const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function company(name: string) {
  return (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
}

const CUSTOM = [
  { name: "Ideas", systemState: "backlog" },
  { name: "Ready to build", systemState: "ready" },
  { name: "Building", systemState: "in_progress", wipLimit: 1 },
  { name: "Waiting", systemState: "blocked" },
  { name: "Needs review", systemState: "review" },
  { name: "Shipped", systemState: "done" },
];

describe("boards with custom columns (R17)", () => {
  it("creates default columns, and rejects boards that hide a state", async () => {
    const { company: c } = await company("App Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    const board = (await req("GET", `/api/projects/${p.id}/board`)).json();
    expect(board.columns.map((x: { systemState: string }) => x.systemState)).toEqual(["backlog", "ready", "in_progress", "blocked", "review", "done"]);

    const bad = await req("PUT", `/api/projects/${p.id}/columns`, CUSTOM.filter((x) => x.systemState !== "review"));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().message).toMatch(/review/);
  });

  it("moves tickets by column or state, keeps agents on fixed states, and enforces card limits", async () => {
    const { company: c, ceo } = await company("App Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app", columns: CUSTOM })).json();
    const building = (await req("GET", `/api/projects/${p.id}/board`)).json().columns.find((x: { name: string }) => x.name === "Building");

    const a = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Checkout errors", assigneeAgentId: ceo.id })).json();
    expect(a).toMatchObject({ systemState: "backlog" });
    const moved = (await req("PATCH", `/api/tickets/${a.id}`, { columnId: building.id })).json();
    expect(moved).toMatchObject({ systemState: "in_progress", columnId: building.id });

    const b = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Load test" })).json();
    const full = await req("PATCH", `/api/tickets/${b.id}`, { state: "in_progress" });
    expect(full.statusCode).toBe(409);
    expect((await req("PATCH", `/api/tickets/${b.id}`, { state: "in_progress", overLimit: true })).statusCode).toBe(200);

    const done = (await req("PATCH", `/api/tickets/${a.id}`, { state: "done" })).json();
    expect(done).toMatchObject({ systemState: "done", outcome: "completed" });
  });

  it("renaming columns keeps every ticket's state", async () => {
    const { company: c } = await company("App Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    await req("POST", `/api/projects/${p.id}/tickets`, { title: "Review me", state: "review" });
    await req("PUT", `/api/projects/${p.id}/columns`, CUSTOM);
    const board = (await req("GET", `/api/projects/${p.id}/board`)).json();
    const review = board.columns.find((x: { name: string }) => x.name === "Needs review");
    expect(review.tickets.map((x: { title: string }) => x.title)).toEqual(["Review me"]);
  });

  it("refuses an assignee from another company", async () => {
    const { company: c } = await company("App Co");
    const { ceo: otherCeo } = await company("Homelab Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    const res = await req("POST", `/api/projects/${p.id}/tickets`, { title: "x", assigneeAgentId: otherCeo.id });
    expect(res.statusCode).toBe(422);
  });
});

describe("tickets waiting on the owner", () => {
  it("flags a review ticket with an open owner sign-off, not one still with an agent reviewer", async () => {
    const { company: c, ceo } = await company("App Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    const signoff = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Needs you", state: "review", risk: "high" })).json();
    const agentReview = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Needs the CEO", state: "review" })).json();
    const [d] = await t.db
      .insert(decisions)
      .values({ companyId: c.id, kind: "approval", question: "Merge it?", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: signoff.id, reviewer: "Senior Developer" } })
      .returning();
    await t.db.insert(ticketDependencies).values({ blockedTicketId: signoff.id, blockerDecisionId: d!.id });
    await t.db.insert(reviewRequests).values({ ticketId: agentReview.id, kind: "code", reviewerAgentId: ceo.id, round: 1 });

    const cards = () => req("GET", `/api/projects/${p.id}/board`).then((r) => r.json().columns.flatMap((x: { tickets: Array<{ title: string; waitingOnOwner: boolean; waitingDecisionId: string | null }> }) => x.tickets));
    const by = (await cards()) as Array<{ title: string; waitingOnOwner: boolean; waitingDecisionId: string | null }>;
    expect(by.find((x) => x.title === "Needs you")).toMatchObject({ waitingOnOwner: true, waitingDecisionId: d!.id });
    expect(by.find((x) => x.title === "Needs the CEO")).toMatchObject({ waitingOnOwner: false, waitingDecisionId: null });

    await req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Send it back" });
    expect(((await cards()) as typeof by).find((x) => x.title === "Needs you")?.waitingOnOwner).toBe(false);
  });
});

describe("objectives, milestones and due dates (R16)", () => {
  it("inherits due dates from milestones and flags unlinked work", async () => {
    const { company: c } = await company("App Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    const o = (await req("POST", `/api/companies/${c.id}/objectives`, { title: "Public beta", priority: 1 })).json();
    const kr = (await req("POST", `/api/objectives/${o.id}/key-results`, { title: "Beta users", target: 20, current: 5 })).json();
    const m = (await req("POST", `/api/objectives/${o.id}/milestones`, { title: "Beta launch", targetDate: "2026-10-31" })).json();

    await req("POST", `/api/projects/${p.id}/tickets`, { title: "Linked", milestoneId: m.id, keyResultId: kr.id });
    await req("POST", `/api/projects/${p.id}/tickets`, { title: "Own date", milestoneId: m.id, dueDate: "2026-10-24" });
    await req("POST", `/api/projects/${p.id}/tickets`, { title: "Drifting" });

    const cards = (await req("GET", `/api/projects/${p.id}/board`)).json().columns.flatMap((x: { tickets: unknown[] }) => x.tickets) as Array<{ title: string; dueDate: string | null; unlinked: boolean }>;
    const by = Object.fromEntries(cards.map((x) => [x.title, x]));
    expect(by["Linked"]).toMatchObject({ dueDate: "2026-10-31", unlinked: false });
    expect(by["Own date"]).toMatchObject({ dueDate: "2026-10-24", unlinked: false });
    expect(by["Drifting"]).toMatchObject({ dueDate: null, unlinked: true });

    const tree = (await req("GET", `/api/companies/${c.id}/objectives`)).json();
    expect(tree[0].keyResults[0].progress).toBe(0.25);
    expect(tree[0].milestones[0].title).toBe("Beta launch");
  });

  it("refuses links to another company's objectives", async () => {
    const { company: a } = await company("App Co");
    const { company: b } = await company("Homelab Co");
    const p = (await req("POST", `/api/companies/${a.id}/projects`, { name: "Customer app" })).json();
    const o = (await req("POST", `/api/companies/${b.id}/objectives`, { title: "Uptime" })).json();
    const m = (await req("POST", `/api/objectives/${o.id}/milestones`, { title: "Backups" })).json();
    expect((await req("POST", `/api/projects/${p.id}/tickets`, { title: "x", milestoneId: m.id })).statusCode).toBe(422);
  });
});

describe("dependencies (R25)", () => {
  it("allows same-company tickets and requested engagements, and refuses cycles", async () => {
    const { company: c } = await company("App Co");
    const { company: other } = await company("Homelab Co");
    const p = (await req("POST", `/api/companies/${c.id}/projects`, { name: "Customer app" })).json();
    const op = (await req("POST", `/api/companies/${other.id}/projects`, { name: "Ops" })).json();
    const t1 = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Ship" })).json();
    const t2 = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Domain" })).json();
    const foreign = (await req("POST", `/api/projects/${op.id}/tickets`, { title: "Patch" })).json();

    expect((await req("POST", `/api/tickets/${t1.id}/dependencies`, { ticketId: t2.id })).statusCode).toBe(201);
    expect((await req("POST", `/api/tickets/${t2.id}/dependencies`, { ticketId: t1.id })).json().message).toMatch(/wait on each other/);
    expect((await req("POST", `/api/tickets/${t1.id}/dependencies`, { ticketId: foreign.id })).json().message).toMatch(/Use an engagement/);
    expect((await req("POST", `/api/tickets/${t1.id}/dependencies`, { ticketId: t1.id })).statusCode).toBe(422);

    const board = (await req("GET", `/api/projects/${p.id}/board`)).json();
    const ship = board.columns.flatMap((x: { tickets: Array<{ title: string }> }) => x.tickets).find((x: { title: string }) => x.title === "Ship");
    expect(ship.blockedBy).toEqual([{ ticketId: t2.id, engagementId: null, decisionId: null }]);
  });
});
