// BOS-2767: the create, read and close of a review hold in review-holds.ts (createHold, openHold, closeHold),
// tested straight against the in-memory database with no app built.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, projects, reviewHolds, reviewHoldWaits, reviewRequests, tickets } from "../src/db/schema.js";
import { closeHold, createHold, openHold } from "../src/services/review-holds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const RELEASE = new Date("2026-12-01T09:30:00Z");
const DECIDED = new Date("2026-11-20T10:00:00Z");

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [reviewer] = await db.insert(agents).values({ companyId: co!.id, name: "Reviewer", role: "worker", agentKind: "claude" }).returning();
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, ...patch }).returning())[0]!;
  const decision = async (patch: Partial<typeof decisions.$inferInsert> = {}) =>
    (await db.insert(decisions).values({ companyId: co!.id, kind: "question", question: "Which way?", recommendedOption: "This way", ...patch }).returning())[0]!;
  const request = async (ticketId: string, patch: Partial<typeof reviewRequests.$inferInsert> = {}) =>
    (await db.insert(reviewRequests).values({ ticketId, kind: "code", round: 1, status: "approved", decidedAt: DECIDED, ...patch }).returning())[0]!;
  const holdRow = async (ticketId: string, patch: Partial<typeof reviewHolds.$inferInsert> = {}) =>
    (await db.insert(reviewHolds).values({ ticketId, reason: "held", ...patch }).returning())[0]!;
  return { db, close, company: co!.id, project: p!.id, reviewer: reviewer!.id, ticket, decision, request, holdRow };
}

describe("createHold", () => {
  it("stores an open hold with the reason, reviewer and release date given", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.request(t.id);
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: r.id, reviewerAgentId: s.reviewer, reason: "waiting for the deploy", releaseAt: RELEASE, waits: [] });
    expect(hold).toMatchObject({ ticketId: t.id, reviewRequestId: r.id, reviewerAgentId: s.reviewer, reason: "waiting for the deploy", status: "open" });
    expect(hold.releaseAt!.toISOString()).toBe(RELEASE.toISOString());
    const [row] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, t.id));
    expect(row).toMatchObject({ id: hold.id, status: "open", reason: "waiting for the deploy", reviewerAgentId: s.reviewer });
    expect(row!.releaseAt!.toISOString()).toBe(RELEASE.toISOString());
  });

  it("stores one wait row per wait: a ticket wait sets the ticket, a decision wait sets the decision", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const blocker = await s.ticket();
    const d = await s.decision();
    const hold = await createHold(s.db, {
      ticketId: t.id,
      reviewRequestId: null,
      reviewerAgentId: null,
      reason: "waits on two things",
      releaseAt: null,
      waits: [{ ticketId: blocker.id }, { decisionId: d.id }],
    });
    const rows = await s.db.select().from(reviewHoldWaits).where(eq(reviewHoldWaits.holdId, hold.id));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ holdId: hold.id, blockerTicketId: blocker.id, blockerDecisionId: null }),
        expect.objectContaining({ holdId: hold.id, blockerTicketId: null, blockerDecisionId: d.id }),
      ]),
    );
  });

  it("stores no wait row when it waits on nothing", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: null, reviewerAgentId: null, reason: "x", releaseAt: null, waits: [] });
    expect(await s.db.select().from(reviewHoldWaits).where(eq(reviewHoldWaits.holdId, hold.id))).toEqual([]);
  });
});

describe("openHold", () => {
  it("gives the ticket's open hold", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: null, reviewerAgentId: s.reviewer, reason: "held", releaseAt: null, waits: [] });
    expect(await openHold(s.db, t.id)).toMatchObject({ id: hold.id, ticketId: t.id, status: "open", reviewerAgentId: s.reviewer });
  });

  it("is null when the ticket has no hold", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    expect(await openHold(s.db, t.id)).toBeNull();
  });

  it("is null when the only hold was released or cancelled", async () => {
    const s = (ctx = await setup());
    const released = await s.ticket();
    await s.holdRow(released.id, { status: "released" });
    expect(await openHold(s.db, released.id)).toBeNull();
    const cancelled = await s.ticket();
    await s.holdRow(cancelled.id, { status: "cancelled" });
    expect(await openHold(s.db, cancelled.id)).toBeNull();
  });

  it("ignores another ticket's hold", async () => {
    const s = (ctx = await setup());
    const a = await s.ticket();
    const b = await s.ticket();
    const bHold = await s.holdRow(b.id, { status: "open" });
    expect(await openHold(s.db, a.id)).toBeNull();
    const aHold = await s.holdRow(a.id, { status: "open" });
    expect((await openHold(s.db, a.id))!.id).toBe(aHold.id);
    expect((await openHold(s.db, b.id))!.id).toBe(bHold.id);
  });
});

describe("closeHold", () => {
  it("released sets the status, who and when, and leaves an approved review request approved", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.request(t.id);
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: r.id, reviewerAgentId: s.reviewer, reason: "held", releaseAt: null, waits: [] });
    expect(await closeHold(s.db, hold, "released", "Alice")).toBe(true);
    const [row] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.id, hold.id));
    expect(row).toMatchObject({ status: "released", closedBy: "Alice" });
    expect(row!.closedAt).toBeInstanceOf(Date);
    const [rr] = await s.db.select().from(reviewRequests).where(eq(reviewRequests.id, r.id));
    expect(rr).toMatchObject({ status: "approved" });
    expect(rr!.decidedAt!.toISOString()).toBe(DECIDED.toISOString());
  });

  it("cancelled sets the status and puts the approved review request back to pending with decidedAt cleared", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.request(t.id);
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: r.id, reviewerAgentId: s.reviewer, reason: "held", releaseAt: null, waits: [] });
    expect(await closeHold(s.db, hold, "cancelled", "Bob")).toBe(true);
    const [row] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.id, hold.id));
    expect(row).toMatchObject({ status: "cancelled", closedBy: "Bob" });
    expect(row!.closedAt).toBeInstanceOf(Date);
    const [rr] = await s.db.select().from(reviewRequests).where(eq(reviewRequests.id, r.id));
    expect(rr).toMatchObject({ status: "pending" });
    expect(rr!.decidedAt).toBeNull();
  });

  it("a hold with no review request changes no review row", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.request(t.id);
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: null, reviewerAgentId: s.reviewer, reason: "held", releaseAt: null, waits: [] });
    expect(await closeHold(s.db, hold, "cancelled", "Bob")).toBe(true);
    const [rr] = await s.db.select().from(reviewRequests).where(eq(reviewRequests.id, r.id));
    expect(rr).toMatchObject({ status: "approved" });
    expect(rr!.decidedAt!.toISOString()).toBe(DECIDED.toISOString());
  });

  it("closing a hold that is already closed gives false and changes nothing", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.request(t.id);
    const hold = await createHold(s.db, { ticketId: t.id, reviewRequestId: r.id, reviewerAgentId: s.reviewer, reason: "held", releaseAt: null, waits: [] });
    expect(await closeHold(s.db, hold, "released", "Alice")).toBe(true);
    const [before] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.id, hold.id));
    expect(await closeHold(s.db, hold, "cancelled", "Bob")).toBe(false);
    const [after] = await s.db.select().from(reviewHolds).where(eq(reviewHolds.id, hold.id));
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: "released", closedBy: "Alice" });
    const [rr] = await s.db.select().from(reviewRequests).where(eq(reviewRequests.id, r.id));
    expect(rr).toMatchObject({ status: "approved" });
    expect(rr!.decidedAt!.toISOString()).toBe(DECIDED.toISOString());
  });
});
