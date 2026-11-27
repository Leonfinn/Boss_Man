// BOS-2773: the one-line "who is this review waiting on" text (reviewWaits) tested straight against the
// in-memory test database with no app built. Each case pins one branch of the function: an open run on
// this ticket or another, a chat run ignored, a queued/deferred review wake, and the rows left out.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, projects, reviewRequests, runs, tickets, wakes } from "../src/db/schema.js";
import { REVIEW_REASON, reviewWaits } from "../src/services/review-kinds.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db
    .insert(companies)
    .values({ name: `Co ${Math.random()}`, ticketPrefix: "BOS" })
    .returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const agent = async (name: string) =>
    (await db.insert(agents).values({ companyId: co!.id, name, role: "worker", agentKind: "claude" }).returning())[0]!;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, systemState: "review", ...patch }).returning())[0]!;
  const review = async (ticketId: string, reviewerAgentId: string | null, patch: Partial<typeof reviewRequests.$inferInsert> = {}) =>
    (await db.insert(reviewRequests).values({ ticketId, kind: "code", reviewerAgentId, round: 1, seq: 0, ...patch }).returning())[0]!;
  const run = async (agentId: string | null, ticketId: string | null, patch: Partial<typeof runs.$inferInsert> = {}) =>
    (await db.insert(runs).values({ companyId: co!.id, agentId, ticketId, ...patch }).returning())[0]!;
  const wake = async (agentId: string, note: string | null, patch: Partial<typeof wakes.$inferInsert> = {}) =>
    (await db.insert(wakes).values({ companyId: co!.id, agentId, reason: REVIEW_REASON, note, ...patch }).returning())[0]!;
  return { db, close, agent, ticket, review, run, wake };
}

const noteTail = `"T": look at the diff`;

describe("reviewWaits", () => {
  it("says the reviewer is reviewing it now when they have an open run on this ticket", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.run(r.id, t.id);
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Rae is reviewing it now"]]));
  });

  it("says the reviewer is busy on another ticket, naming it", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const other = await s.ticket({ number: 7 });
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.run(r.id, other.id);
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Rae is busy on BOS-7"]]));
  });

  it("ignores the reviewer's open chat run and leaves the ticket out when nothing else holds it", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.run(r.id, t.id, { purpose: "chat" });
    expect((await reviewWaits(s.db, [t.id])).has(t.id)).toBe(false);
  });

  it("says the reviewer is next but held up when their queued review wake carries a reason", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.wake(r.id, `- ${t.id} ${noteTail}`, { status: "queued", statusReason: "waiting for the owner" });
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Rae is next, but is held up: waiting for the owner"]]));
  });

  it("says about to start for a deferred wake, even one with a reason", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.wake(r.id, `- ${t.id} ${noteTail}`, { status: "deferred", statusReason: "later" });
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Rae is about to start"]]));
  });

  it("says about to start for a queued wake with no reason", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.wake(r.id, `- ${t.id} ${noteTail}`, { status: "queued" });
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Rae is about to start"]]));
  });

  it("leaves out a queued review wake whose note names another ticket", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const other = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(t.id, r.id);
    await s.wake(r.id, `- ${other.id} ${noteTail}`, { status: "queued", statusReason: "waiting for the owner" });
    expect((await reviewWaits(s.db, [t.id])).has(t.id)).toBe(false);
  });

  it("leaves out a review with no reviewer, a decided one, and one whose reviewer has nothing open", async () => {
    const s = (ctx = await setup());
    const noReviewer = await s.ticket();
    const decided = await s.ticket();
    const idle = await s.ticket();
    const r = await s.agent("Rae");
    await s.review(noReviewer.id, null);
    await s.review(decided.id, r.id, { status: "approved" });
    await s.review(idle.id, r.id);
    expect((await reviewWaits(s.db, [noReviewer.id, decided.id, idle.id])).size).toBe(0);
  });

  it("joins two reviewers with a semicolon and space", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const a = await s.agent("Ana");
    const b = await s.agent("Ben");
    await s.review(t.id, a.id, { kind: "code" });
    await s.review(t.id, b.id, { kind: "security" });
    await s.run(a.id, t.id);
    await s.run(b.id, t.id);
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Ana is reviewing it now; Ben is reviewing it now"]]));
  });

  it("shows the same line twice only once", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const a = await s.agent("Ana");
    await s.review(t.id, a.id, { kind: "code" });
    await s.review(t.id, a.id, { kind: "security" });
    await s.run(a.id, t.id);
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Ana is reviewing it now"]]));
  });

  it("counts only the newest round's active rows", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const old = await s.agent("Old");
    const fresh = await s.agent("Fresh");
    await s.review(t.id, old.id, { round: 1 });
    await s.review(t.id, fresh.id, { round: 2 });
    await s.run(old.id, t.id);
    expect((await reviewWaits(s.db, [t.id])).has(t.id)).toBe(false);
    await s.run(fresh.id, t.id);
    expect(await reviewWaits(s.db, [t.id])).toEqual(new Map([[t.id, "Fresh is reviewing it now"]]));
  });

  it("says nothing for a ticket with no reviews and for a ticket that does not exist", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    expect((await reviewWaits(s.db, [t.id, "00000000-0000-4000-8000-000000000000"])).size).toBe(0);
  });
});
