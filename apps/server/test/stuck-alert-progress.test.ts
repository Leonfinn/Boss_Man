// BOS-612: the "looks stuck" card counts real progress (a commit, a state change, a review verdict), not run
// starts; it recommends Reassign after repeated empty runs; a CEO plan with a deadline holds it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, reviewRequests, runs, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { wakes } from "../src/db/schema.js";

const HOUR = 3_600_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const head: { value: string | null; calls: number } = { value: "base", calls: 0 };
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: clock, branchHead: async () => { head.calls++; return head.value; } });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  /** An in-progress ticket on a branch, idle for an hour, whose assignee has run on it `runCount` times without a trace. */
  const stuck = async (title: string, runCount: number, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "in_progress", branch: "bossman/t", baseCommit: "base", lastActivityAt: new Date(Date.now() - HOUR), ...set }).where(eq(tickets.id, t.id));
    for (let i = 0; i < runCount; i++) await db.insert(runs).values({ companyId: company.id, agentId: worker.id, ticketId: t.id, startedAt: new Date(Date.now() + 1000 + i), endedAt: new Date(Date.now() + 2000 + i), outcome: "end_turn" });
    return t.id;
  };
  const settle = () => db.update(wakes).set({ status: "launched" });
  const cards = () => db.select().from(decisions).where(like(decisions.dedupeKey, "missed:%"));
  const advance = (ms: number) => (offset += ms);
  /** Two nudges, then the sweep that writes the card (the cadence missed-work.test.ts uses). */
  const toCard = async () => {
    advance(HOUR); // the runs ended just now: wait out the half hour a ticket must be quiet
    await built.sweeps.run();
    await settle();
    advance(5 * HOUR);
    await built.sweeps.run();
    await settle();
    advance(5 * HOUR);
    return built.sweeps.run();
  };
  return { ...built, db, close, req, company, ceo, worker, project, mcp, stuck, settle, cards, advance, toCard, head };
}

describe("stuck-ticket card counts real progress (BOS-612)", () => {
  it("recommends Reassign and names the run count after repeated runs with no progress", async () => {
    ctx = await setup();
    const id = await ctx.stuck("Empty runs", 4);
    expect(await ctx.toCard()).toMatchObject({ missedWork: { gaveUp: 1 } });
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ recommendedOption: "Reassign", options: ["Reassign", "Got it"] });
    expect(card!.question).toContain("run on it 4 times with no new commit, state change or review");
    expect(card!.dedupeKey).toContain(id);
  });

  it("does not ask the runner for the branch head again once the card exists (answered or not)", async () => {
    ctx = await setup();
    await ctx.stuck("Empty runs", 4);
    await ctx.toCard();
    expect(await ctx.cards()).toHaveLength(1);
    const before = ctx.head.calls;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      ctx.advance(60_000);
      await ctx.sweeps.run();
    }
    expect(ctx.head.calls).toBe(before);
  });

  it("keeps the old Got it card under the run limit", async () => {
    ctx = await setup();
    await ctx.stuck("Two empty runs", 2);
    await ctx.toCard();
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ recommendedOption: "Got it", options: ["Got it"] });
  });

  it("a new commit resets the count", async () => {
    ctx = await setup();
    const id = await ctx.stuck("Committed", 4, { progressHead: "base" });
    ctx.head.value = "second-commit";
    await ctx.toCard();
    const [card] = await ctx.cards();
    expect(card).toMatchObject({ recommendedOption: "Got it" });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]).toMatchObject({ progressHead: "second-commit" });
  });

  it("a review verdict resets the count, and a branch head it can't read does not escalate on a guess", async () => {
    ctx = await setup();
    const id = await ctx.stuck("Reviewed", 4);
    await ctx.db.insert(reviewRequests).values({ ticketId: id, kind: "code", reviewerAgentId: ctx.worker.id, round: 1, status: "changes_requested", decidedAt: new Date(Date.now() + 60_000) });
    await ctx.toCard();
    expect((await ctx.cards())[0]).toMatchObject({ recommendedOption: "Got it" });
  });

  it("an unreadable branch head is not treated as no commit", async () => {
    ctx = await setup();
    // Same ticket and runs as the first test, but the runner can't say what the head is.
    ctx.head.value = null;
    await ctx.stuck("Head unreadable", 4);
    await ctx.toCard();
    expect((await ctx.cards())[0]).toMatchObject({ recommendedOption: "Got it" });
  });
});

describe("a CEO plan holds the stuck card (BOS-612)", () => {
  it("is quiet until the deadline plus grace, then raises one card saying it passed", async () => {
    ctx = await setup();
    const id = await ctx.stuck("Planned", 4, { ceoPlan: "Bungle splits the work in two", ceoPlanDeadline: new Date(Date.now() + 13 * HOUR) });
    await ctx.toCard(); // 11 hours in: the plan still stands
    expect(await ctx.cards()).toEqual([]);

    ctx.advance(2 * HOUR + 10 * 60_000); // 13:10, past the deadline but inside the 30 minute grace
    await ctx.sweeps.run();
    expect(await ctx.cards()).toEqual([]);

    ctx.advance(30 * 60_000);    await ctx.settle(); // the idle-slot wake the 13:10 pass queued would otherwise keep the agent "busy"
    expect(await ctx.sweeps.run()).toMatchObject({ missedWork: { gaveUp: 1 } });
    const [card] = await ctx.cards();
    expect(card!.question).toContain("had a deadline of");
    expect(card!.question).toContain("Bungle splits the work in two");
    expect(card!.dedupeKey).toContain(`missed:${id}:plan:`);

    // Once per plan.
    await ctx.db.update(decisions).set({ status: "answered", dedupeKey: null }).where(eq(decisions.id, card!.id));
    ctx.advance(10 * HOUR);
    await ctx.sweeps.run();
    expect(await ctx.cards()).toEqual([]);
  });

  it("only the CEO sets a plan, it needs a future deadline, and null clears it", async () => {
    ctx = await setup();
    const id = await ctx.stuck("Plan me", 0);
    const ceo = await ctx.mcp(ctx.ceo.id);
    const worker = await ctx.mcp(ctx.worker.id);
    const when = new Date(Date.now() + 6 * HOUR).toISOString();
    expect(await worker.callTool({ name: "update_ticket", arguments: { ticketId: id, ceoPlan: "x", ceoPlanDeadline: when, reason: "r" } })).toMatchObject({ isError: true });
    expect(await ceo.callTool({ name: "update_ticket", arguments: { ticketId: id, ceoPlan: "no date", reason: "r" } })).toMatchObject({ isError: true });
    expect(await ceo.callTool({ name: "update_ticket", arguments: { ticketId: id, ceoPlan: "past", ceoPlanDeadline: new Date(Date.now() - HOUR).toISOString(), reason: "r" } })).toMatchObject({ isError: true });
    const ok = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: id, ceoPlan: "Split it in two", ceoPlanDeadline: when, reason: "Plan agreed" } });
    expect(ok).not.toHaveProperty("isError", true);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]).toMatchObject({ ceoPlan: "Split it in two", ceoPlanAlertedAt: null });
    await ceo.callTool({ name: "update_ticket", arguments: { ticketId: id, ceoPlan: null, reason: "Dropped" } });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]).toMatchObject({ ceoPlan: null, ceoPlanDeadline: null });
    await ceo.close();
    await worker.close();
  });
});
