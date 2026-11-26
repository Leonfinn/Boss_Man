import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";

// BOS-2291: who is woken when the owner answers a card, by card kind.
let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (title: string, patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title, systemState: "in_progress", assigneeAgentId: dev.id, stateNote: "Working on it.", stateNoteAt: new Date(), ...patch }).returning())[0]!;
  return { ...built, db, close, req, co, dev, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const card = async (t: { id: string }, context: Record<string, unknown>, raisedByAgentId: string | null, blocks = false) => {
  const [d] = await ctx.db
    .insert(decisions)
    .values({ companyId: ctx.co.company.id, kind: "question", question: "Is the wording right?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId, context: { ticketId: t.id, ...context } })
    .returning();
  if (blocks) await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
  return d!;
};
const devWakes = async () => (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.dev.id);

describe("a card answer and the ticket's assignee (BOS-2291)", () => {
  it("does not wake the assignee for a card the CEO raised that blocks nothing of theirs", async () => {
    const t = await ctx.ticket("Reword the page");
    const d = await card(t, { type: "question" }, ctx.co.ceo.id);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    expect(await devWakes()).toEqual([]);
    // The raiser is woken with the answer.
    expect((await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.co.ceo.id))).some((w) => w.reason === "decision answered")).toBe(true);
  });

  it("does not wake the assignee for a card Boss Man raised itself (an alert) that blocks nothing", async () => {
    const t = await ctx.ticket("Reword the page");
    const d = await card(t, { type: "check_stuck" }, null);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    expect(await devWakes()).toEqual([]);
  });

  it("still wakes the assignee when the card blocks their ticket, with 'Not your card' at the top", async () => {
    const t = await ctx.ticket("Reword the page", { systemState: "blocked" });
    const d = await card(t, { type: "question" }, ctx.co.ceo.id, true);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    const ws = (await devWakes()).filter((w) => w.reason === "unblocked");
    expect(ws).toHaveLength(1);
    expect(ws[0]!.note!.startsWith("Not your card:")).toBe(true);
    expect(ws[0]!.note).toContain("the answer was: Yes");
  });

  it("still wakes the assignee for a sign-off card on their ticket", async () => {
    const t = await ctx.ticket("Reword the page", { systemState: "review" });
    const d = await card(t, { type: "risk_review", head: "abc123" }, null);
    const res = await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "No" });
    expect(res.statusCode).toBe(200);
    expect((await devWakes()).length).toBeGreaterThan(0);
  });

  it("says plainly the card is not theirs when a held review ticket is woken", async () => {
    const t = await ctx.ticket("Reword the page", { systemState: "review" });
    const d = await card(t, { type: "question" }, ctx.co.ceo.id, true);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    const ws = (await devWakes()).filter((w) => w.reason === "decision answered");
    for (const w of ws) expect(w.note).toContain("Not your card");
  });
});

// BOS-2655: a reissued card keeps its first raiser, who may no longer own the ticket.
describe("a card answer after the ticket changed hands (BOS-2655)", () => {
  const second = async () => (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Brian" })).json() as { id: string };
  const wakesOf = async (id: string) => (await ctx.db.select().from(wakes).where(eq(wakes.agentId, id)));

  it("wakes the current assignee, not the raiser who handed the ticket over, and tells the CEO", async () => {
    const brian = await second();
    // Brian owns the ticket and works it, then it is reassigned to Dev.
    const t = await ctx.ticket("Look into the failing release", { systemState: "blocked", assigneeAgentId: brian.id });
    await ctx.db.insert(runs).values({ companyId: ctx.co.company.id, agentId: brian.id, ticketId: t.id, startedAt: new Date() });
    const d = await card(t, { type: "question" }, brian.id, true);
    await ctx.db.update(tickets).set({ assigneeAgentId: ctx.dev.id }).where(eq(tickets.id, t.id));
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    expect(await wakesOf(brian.id)).toEqual([]);
    expect((await devWakes()).some((w) => w.ticketId === t.id)).toBe(true);
    const ceoWake = (await wakesOf(ctx.co.ceo.id)).find((w) => w.note?.includes("no longer owns"));
    expect(ceoWake).toBeTruthy();
  });

  it("still wakes a raiser who never owned the ticket (a peer asking about it)", async () => {
    const brian = await second();
    const t = await ctx.ticket("Look into the failing release", { systemState: "blocked" });
    const d = await card(t, { type: "question" }, brian.id, true);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    expect((await wakesOf(brian.id)).some((w) => w.reason === "decision answered" && w.note?.includes("your question"))).toBe(true);
    expect((await wakesOf(ctx.co.ceo.id)).some((w) => w.note?.includes("no longer owns"))).toBe(false);
  });

  it("still wakes the raiser while they are the assignee", async () => {
    const t = await ctx.ticket("Look into the failing release", { systemState: "blocked" });
    const d = await card(t, { type: "question" }, ctx.dev.id, true);
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" });
    expect((await devWakes()).some((w) => w.reason === "decision answered" && w.note?.includes("your question"))).toBe(true);
  });
});
