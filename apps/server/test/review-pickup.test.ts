import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, reviewRequests, runners, runs, tickets, wakes } from "../src/db/schema.js";
import { listReviews, REVIEW_REASON } from "../src/services/review-kinds.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const MIN = 60_000;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, () => true);
  const senior = async (name: string) => (await db.insert(agents).values({ companyId: company.id, name, role: "worker", agentKind: "claude", template: "senior-dev" }).returning())[0]!;
  const author = (await db.insert(agents).values({ companyId: company.id, name: "Author", role: "worker", agentKind: "claude" }).returning())[0]!;
  const ticket = async (title: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ systemState: "review", assigneeAgentId: author.id }).where(eq(tickets.id, t.id));
    return t.id;
  };
  const busy = (agentId: string, ticketId: string | null = null) => db.insert(runs).values({ companyId: company.id, agentId, ticketId, startedAt: new Date() });
  /** A review wake for this reviewer that has been waiting `ago` ms. */
  const reviewWake = async (agentId: string, ticketId: string, ago: number) => {
    await db.insert(reviewRequests).values({ ticketId, kind: "code", reviewerAgentId: agentId, round: 1 });
    return (await db.insert(wakes).values({ companyId: company.id, agentId, reason: REVIEW_REASON, priority: 3, note: `- ${ticketId} "T": note\n  Your code review, round 1.`, createdAt: new Date(Date.now() - ago) }).returning())[0]!;
  };
  const reviewer = async (ticketId: string) => (await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId)))[0]!.reviewerAgentId;
  return { ...built, db, close, req, company, ceo, project, author, senior, ticket, busy, reviewWake, reviewer };
}

describe("review pick-up", () => {
  it("waits only a few seconds, not two minutes, before a review request can start", async () => {
    ctx = await setup();
    const a = await ctx.senior("Ada");
    const w = await ctx.scheduler.notify(a.id, { reason: REVIEW_REASON, priority: 3, note: `- ${"0".repeat(8)}-0000-0000-0000-000000000000 "T": n` });
    expect(w.status).toBe("deferred");
    expect(w.notBefore!.getTime() - Date.now()).toBeLessThanOrEqual(10_000 + 1000);
  });

  it("starts a queued review before ordinary work that has waited longer", async () => {
    ctx = await setup();
    const a = await ctx.senior("Ada");
    const t = await ctx.ticket("Ordinary");
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: a.id, ticketId: t, reason: "assigned", priority: 2, createdAt: new Date(Date.now() - 30 * MIN) });
    const review = await ctx.reviewWake(a.id, await ctx.ticket("To review"), MIN);
    await ctx.scheduler.tickOnce();
    const [r] = await ctx.db.select().from(wakes).where(eq(wakes.id, review.id));
    expect(r!.status).toBe("launched");
  });

  it("hands a review to another senior developer once the reviewer has been busy past the threshold", async () => {
    ctx = await setup();
    const ada = await ctx.senior("Ada");
    const sam = await ctx.senior("Sam");
    const t = await ctx.ticket("Add checkout");
    const w = await ctx.reviewWake(ada.id, t, 11 * MIN);
    await ctx.busy(ada.id);
    await ctx.scheduler.tickOnce();

    expect(await ctx.reviewer(t)).toBe(sam.id);
    const [old] = await ctx.db.select().from(wakes).where(eq(wakes.id, w.id));
    expect(old).toMatchObject({ status: "dropped", statusReason: "handed to another reviewer" });
    const [mine] = await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, sam.id), eq(wakes.reason, REVIEW_REASON)));
    expect(mine!.note).toContain(`- ${t} `);
    const [log] = await ctx.db.select().from(activity).where(and(eq(activity.ticketId, t), eq(activity.kind, "review_handover")));
    expect(log!.summary).toBe("Ada was busy for 11 minutes, so Sam takes the code review");
  });

  it("keeps the review with its reviewer before the threshold", async () => {
    ctx = await setup();
    const ada = await ctx.senior("Ada");
    await ctx.senior("Sam");
    const t = await ctx.ticket("Add checkout");
    await ctx.reviewWake(ada.id, t, 5 * MIN);
    await ctx.busy(ada.id);
    await ctx.scheduler.tickOnce();
    expect(await ctx.reviewer(t)).toBe(ada.id);
  });

  it("keeps the review when nobody else is free, paused, or the author", async () => {
    ctx = await setup();
    const ada = await ctx.senior("Ada");
    const sam = await ctx.senior("Sam");
    const t = await ctx.ticket("Add checkout");
    await ctx.reviewWake(ada.id, t, 11 * MIN);
    await ctx.busy(ada.id);
    await ctx.busy(sam.id);
    await ctx.scheduler.tickOnce();
    expect(await ctx.reviewer(t)).toBe(ada.id);

    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, sam.id));
    await ctx.db.delete(runs).where(eq(runs.agentId, sam.id));
    await ctx.scheduler.tickOnce();
    expect(await ctx.reviewer(t)).toBe(ada.id);

    await ctx.db.update(agents).set({ paused: false, template: null }).where(eq(agents.id, sam.id));
    await ctx.scheduler.tickOnce();
    expect(await ctx.reviewer(t)).toBe(ada.id);
  });

  it("only moves the tickets that have someone to move to, and shows who a review waits on", async () => {
    ctx = await setup();
    const ada = await ctx.senior("Ada");
    await ctx.senior("Sam");
    const t1 = await ctx.ticket("First");
    const t2 = await ctx.ticket("Second");
    const [{ number }] = (await ctx.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, t2))) as [{ number: number | null }];
    await ctx.busy(ada.id, t2);
    // The review of t2 stays with Ada if she has it open already; the card says so.
    await ctx.db.insert(reviewRequests).values({ ticketId: t1, kind: "code", reviewerAgentId: ada.id, round: 1 });
    const rows = await listReviews(ctx.db, t1);
    expect(rows[0]!.waitingOn).toMatch(/^Ada is busy on .*-?\d*/);
    expect(rows[0]!.waitingOn).toContain(String(number));
  });
});
