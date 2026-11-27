// BOS-2751: the small database-backed review-round helpers in review-kinds.ts (latestRows, roundStartedAt,
// recordReviewWait, reviewWaitedSince). Tested against the in-memory database with rows inserted straight into
// the tables, as test/check-hold.test.ts and test/agent-wip-reads.test.ts do (no buildApp).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects, reviewRequests, tickets } from "../src/db/schema.js";
import { latestRows, recordReviewWait, reviewWaitedSince, roundStartedAt } from "../src/services/review-kinds.js";

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
  let n = 0;
  const ticket = async () => (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, systemState: "review" } as never).returning())[0]!;
  const review = async (ticketId: string, round: number, kind: string, patch: Partial<typeof reviewRequests.$inferInsert> = {}) =>
    (await db.insert(reviewRequests).values({ ticketId, kind, reviewerAgentId: reviewer!.id, round, ...patch } as never).returning())[0]!;
  return { db, close, company: co!.id, ticket, review };
}

describe("latestRows", () => {
  it("gives nothing for a ticket with no reviews", async () => {
    const { db, ticket } = ctx;
    const t = await ticket();
    expect(await latestRows(db, t.id)).toEqual([]);
  });

  it("gives only the newest round's rows, ordered by seq then kind", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { seq: 0 });
    await review(t.id, 2, "security", { seq: 1 });
    await review(t.id, 2, "code", { seq: 1 });
    await review(t.id, 2, "infra", { seq: 0 });
    await review(t.id, 2, "adversarial", { seq: 0 });
    const rows = await latestRows(db, t.id);
    expect(rows.map((r) => `${r.round}:${r.seq}:${r.kind}`)).toEqual(["2:0:adversarial", "2:0:infra", "2:1:code", "2:1:security"]);
  });

  it("does not count another ticket's newer round", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    const other = await ticket();
    await review(t.id, 1, "code");
    await review(other.id, 3, "code");
    const rows = await latestRows(db, t.id);
    expect(rows.map((r) => r.round)).toEqual([1]);
  });
});

describe("roundStartedAt", () => {
  it("is null for a ticket with no reviews", async () => {
    const { db, ticket } = ctx;
    const t = await ticket();
    expect(await roundStartedAt(db, t.id)).toBeNull();
  });

  it("gives the earliest row of the newest round", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    await review(t.id, 1, "code", { createdAt: new Date("2026-01-01T10:00:00Z") });
    await review(t.id, 1, "security", { createdAt: new Date("2026-01-01T11:00:00Z") });
    await review(t.id, 2, "code", { createdAt: new Date("2026-01-01T12:05:00Z") });
    await review(t.id, 2, "security", { createdAt: new Date("2026-01-01T12:00:00Z") });
    expect((await roundStartedAt(db, t.id))?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("does not count another ticket's newest round", async () => {
    const { db, ticket, review } = ctx;
    const t = await ticket();
    const other = await ticket();
    await review(t.id, 1, "code", { createdAt: new Date("2026-01-01T10:00:00Z") });
    await review(other.id, 2, "code", { createdAt: new Date("2026-01-01T12:00:00Z") });
    expect((await roundStartedAt(db, t.id))?.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });
});

describe("recordReviewWait and reviewWaitedSince", () => {
  it("gives null for a review that was never left another hour", async () => {
    const { db } = ctx;
    expect(await reviewWaitedSince(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("gives the latest time the same review was left", async () => {
    const { db, company, ticket, review } = ctx;
    const t = await ticket();
    const r = await review(t.id, 1, "code");
    await recordReviewWait(db, { companyId: company, ticketId: t.id, reviewId: r.id, at: new Date("2026-01-01T09:00:00Z") });
    await recordReviewWait(db, { companyId: company, ticketId: t.id, reviewId: r.id, at: new Date("2026-01-01T10:00:00Z") });
    expect((await reviewWaitedSince(db, r.id))?.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("does not count a record for another review", async () => {
    const { db, company, ticket, review } = ctx;
    const t = await ticket();
    const r = await review(t.id, 1, "code");
    const other = await review(t.id, 1, "security");
    await recordReviewWait(db, { companyId: company, ticketId: t.id, reviewId: other.id, at: new Date("2026-01-01T09:00:00Z") });
    expect(await reviewWaitedSince(db, r.id)).toBeNull();
  });
});
