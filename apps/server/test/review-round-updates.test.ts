// BOS-2772: the database-backed review-round helpers in review-kinds.ts that update rows
// (passedReviewTickets, skipPending, reviveSkipped, setReviewOrder). Tested against the in-memory
// database with rows inserted straight into the tables, as test/check-hold.test.ts and
// test/review-rounds.test.ts do (no buildApp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, projects, reviewRequests, tickets } from "../src/db/schema.js";
import { passedReviewTickets, reviveSkipped, setReviewOrder, skipPending } from "../src/services/review-kinds.js";

let ctx: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  ctx = await setup();
});

afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [reviewer] = await db.insert(agents).values({ companyId: co!.id, name: "Reviewer", role: "worker", agentKind: "claude" } as never).returning();
  const [ceo] = await db.insert(agents).values({ companyId: co!.id, name: "CEO", role: "worker", agentKind: "claude" } as never).returning();
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, systemState: "review", ...patch } as never).returning())[0]!;
  const review = async (ticketId: string, round: number, kind: string, patch: Partial<typeof reviewRequests.$inferInsert> = {}) =>
    (await db.insert(reviewRequests).values({ ticketId, kind, reviewerAgentId: reviewer!.id, round, ...patch } as never).returning())[0]!;
  const statuses = async (ticketId: string) =>
    Object.fromEntries((await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId))).map((r) => [r.kind, r.status]));
  const seqs = async (ticketId: string) =>
    Object.fromEntries((await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId))).map((r) => [r.kind, r.seq]));
  return { db, close, company: co!.id, ceo: ceo!.id, ticket, review, statuses, seqs };
}

describe("passedReviewTickets", () => {
  it("gives an empty set for an empty list", async () => {
    const { db } = ctx;
    expect(await passedReviewTickets(db, [])).toEqual(new Set());
  });

  it("leaves out a ticket with no reviews", async () => {
    const { db, ticket, review } = ctx;
    const passed = await ticket();
    const none = await ticket();
    await review(passed.id, 1, "code", { status: "approved" });
    expect([...(await passedReviewTickets(db, [passed.id, none.id]))]).toEqual([passed.id]);
  });

  it("counts only the newest round: an old approval with a pending new round is not passed", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "approved" });
    await review(t.id, 2, "code", { status: "pending" });
    expect(await passedReviewTickets(db, [t.id])).toEqual(new Set());
  });

  it("counts only the newest round: old changes requested followed by an all-approved round is passed", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "changes_requested" });
    await review(t.id, 2, "code", { status: "approved" });
    await review(t.id, 2, "security", { status: "approved" });
    expect(await passedReviewTickets(db, [t.id])).toEqual(new Set([t.id]));
  });

  it("counts an overruled review as settled", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "approved" });
    await review(t.id, 1, "security", { status: "overruled" });
    expect(await passedReviewTickets(db, [t.id])).toEqual(new Set([t.id]));
  });

  it("does not count the newest round with changes requested", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "approved" });
    await review(t.id, 1, "security", { status: "changes_requested" });
    expect(await passedReviewTickets(db, [t.id])).toEqual(new Set());
  });

  it("answers each ticket on its own in one call", async () => {
    const { db, ticket, review } = ctx;
    const passed = await ticket();
    const waiting = await ticket();
    const failed = await ticket();
    await review(passed.id, 1, "code", { status: "approved" });
    await review(waiting.id, 1, "code", { status: "pending" });
    await review(failed.id, 1, "code", { status: "changes_requested" });
    expect(await passedReviewTickets(db, [passed.id, waiting.id, failed.id])).toEqual(new Set([passed.id]));
  });
});

describe("skipPending", () => {
  it("sets only the pending rows to skipped and leaves decided rows alone", async () => {
    const { db, ticket, review, statuses } = ctx;
    const t = await ticket();
    const pending = await review(t.id, 1, "code", { status: "pending" });
    await review(t.id, 1, "security", { status: "approved" });
    await review(t.id, 1, "infra", { status: "changes_requested" });
    const skipped = await review(t.id, 1, "adversarial", { status: "skipped" });
    await skipPending(db, await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id)));
    expect(await statuses(t.id)).toEqual({ code: "skipped", security: "approved", infra: "changes_requested", adversarial: "skipped" });
    expect(pending.id).toBeTruthy();
    expect(skipped.id).toBeTruthy();
  });

  it("does not touch rows it was not given", async () => {
    const { db, ticket, review, statuses } = ctx;
    const t = await ticket();
    const given = await review(t.id, 1, "code", { status: "pending" });
    const other = await review(t.id, 1, "security", { status: "pending" });
    await skipPending(db, [given]);
    expect(await statuses(t.id)).toEqual({ code: "skipped", security: "pending" });
    expect(other.status).toBe("pending");
  });
});

describe("reviveSkipped", () => {
  it("sets only the skipped rows back to pending and leaves decided rows alone", async () => {
    const { db, ticket, review, statuses } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "skipped" });
    await review(t.id, 1, "security", { status: "pending" });
    await review(t.id, 1, "infra", { status: "approved" });
    await review(t.id, 1, "adversarial", { status: "changes_requested" });
    await reviveSkipped(db, await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id)));
    expect(await statuses(t.id)).toEqual({ code: "pending", security: "pending", infra: "approved", adversarial: "changes_requested" });
  });

  it("does not touch rows it was not given", async () => {
    const { db, ticket, review, statuses } = ctx;
    const t = await ticket();
    const given = await review(t.id, 1, "code", { status: "skipped" });
    await review(t.id, 1, "security", { status: "skipped" });
    await reviveSkipped(db, [given]);
    expect(await statuses(t.id)).toEqual({ code: "pending", security: "skipped" });
  });
});

describe("setReviewOrder", () => {
  it("stores the order on the ticket, numbers pending rows of the newest round, and records it once", async () => {
    const { db, ceo, ticket, review, seqs } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "pending" });
    await review(t.id, 1, "security", { status: "pending" });
    await review(t.id, 1, "infra", { status: "pending" });
    await setReviewOrder(db, t, ["security", "code"], ceo);
    const [stored] = await db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(stored!.reviewOrder).toEqual(["security", "code"]);
    expect(await seqs(t.id)).toEqual({ code: 2, security: 1, infra: 0 });
    const acts = await db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "review_sequence")));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.summary).toBe("Reviews run in this order: security, then code");
    expect(acts[0]!.agentId).toBe(ceo);
  });

  it("returns only the rows that became active because of the change", async () => {
    const { db, ceo, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "pending", seq: 1 });
    await review(t.id, 1, "security", { status: "pending", seq: 2 });
    const active = await setReviewOrder(db, t, ["security", "code"], ceo);
    expect(active.map((r) => r.kind)).toEqual(["security"]);
  });

  it("leaves decided rows' places alone while numbering the pending ones", async () => {
    const { db, ceo, ticket, review, seqs } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "approved", seq: 0 });
    await review(t.id, 1, "security", { status: "pending", seq: 0 });
    await review(t.id, 1, "infra", { status: "changes_requested", seq: 0 });
    await setReviewOrder(db, t, ["code", "security", "infra"], ceo);
    expect(await seqs(t.id)).toEqual({ code: 0, security: 2, infra: 0 });
  });

  it("only numbers the newest round", async () => {
    const { db, ceo, ticket, review, seqs } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { status: "pending", seq: 0 });
    await review(t.id, 2, "code", { status: "pending", seq: 0 });
    await review(t.id, 2, "security", { status: "pending", seq: 0 });
    await setReviewOrder(db, t, ["code", "security"], ceo);
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, t.id));
    const old = rows.find((r) => r.round === 1)!;
    expect(old.seq).toBe(0);
    expect(Object.fromEntries(rows.filter((r) => r.round === 2).map((r) => [r.kind, r.seq]))).toEqual({ code: 1, security: 2 });
  });

  it("clears an order: stores null, numbers every pending row 0, and records all at once", async () => {
    const { db, ceo, ticket, review, seqs } = ctx;
    const t = await ticket({ reviewOrder: ["code", "security"] });
    await review(t.id, 1, "code", { status: "pending", seq: 1 });
    await review(t.id, 1, "security", { status: "pending", seq: 2 });
    const active = await setReviewOrder(db, t, [], ceo);
    const [stored] = await db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(stored!.reviewOrder).toBeNull();
    expect(await seqs(t.id)).toEqual({ code: 0, security: 0 });
    const acts = await db.select().from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "review_sequence")));
    expect(acts).toHaveLength(1);
    expect(acts[0]!.summary).toBe("Reviews run all at once");
    expect(active.map((r) => r.kind)).toEqual(["security"]);
  });
});
