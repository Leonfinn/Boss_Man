import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, projects, ticketDependencies, tickets } from "../src/db/schema.js";
import { ReviewHeldError } from "../src/services/review.js";

// BOS-919 (DR-047 point 3): an owner card only knocks work that hasn't been handed in into blocked. A ticket in
// review or done keeps its state (still linked to the card), its merge waits while the card is open, and
// answering the card leaves it where it is, so no new review round starts.
let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
  const [p] = await db.insert(projects).values({ companyId: co.company.id, name: "Customer app" }).returning();
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: p!.id, title: "T", assigneeAgentId: co.ceo.id, ...patch }).returning())[0]!;
  const raise = (ticketId: string) =>
    built.decisions.raise({ companyId: co.company.id, agentId: co.ceo.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: ticketId, triedFirst: "Compared both providers" });
  return { ...built, db, close, co, ticket, raise };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const stateOf = async (id: string) => (await ctx.db.select({ s: tickets.systemState }).from(tickets).where(eq(tickets.id, id)))[0]!.s;
const stateRows = async (id: string) => (await ctx.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "state")))).map((r) => r.summary);

describe("an owner card on handed-in work (BOS-919)", () => {
  it("a ticket in review keeps its state, stays linked to the card, and answering leaves it in review", async () => {
    const t = await ctx.ticket({ systemState: "review" });
    const card = await ctx.raise(t.id);
    expect(await stateOf(t.id)).toBe("review");
    expect(await stateRows(t.id)).toEqual([]);
    // Still linked, so the board shows it in Your review.
    expect(await ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card.id))).toHaveLength(1);
    await ctx.decisions.answer(card.id, "Stripe");
    await ctx.scheduler.releaseIfUnblocked(t.id);
    expect(await stateOf(t.id)).toBe("review");
    expect(await stateRows(t.id)).toEqual([]);
  });

  it("a done ticket stays done", async () => {
    const t = await ctx.ticket({ systemState: "done" });
    const card = await ctx.raise(t.id);
    expect(await stateOf(t.id)).toBe("done");
    await ctx.decisions.answer(card.id, "Stripe");
    expect(await stateOf(t.id)).toBe("done");
  });

  for (const from of ["backlog", "ready", "in_progress"] as const) {
    it(`a ticket in ${from} is blocked, the history names the card, and answering frees it to ready`, async () => {
      const t = await ctx.ticket({ systemState: from });
      const card = await ctx.raise(t.id);
      expect(await stateOf(t.id)).toBe("blocked");
      expect(await stateRows(t.id)).toEqual([`${from} -> blocked: held by the card ${card.id}`]);
      await ctx.decisions.answer(card.id, "Stripe");
      expect(await stateOf(t.id)).toBe("ready");
    });
  }

  it("the merge waits while the card is open, and goes ahead once it is answered", async () => {
    const t = await ctx.ticket({ systemState: "review" });
    const card = await ctx.raise(t.id);
    await expect(ctx.review.landOnce(t.id, "the owner")).rejects.toBeInstanceOf(ReviewHeldError);
    // A wait, not a failure: land() raises no merge-stuck card for it.
    await expect(ctx.review.land(t.id, "the owner")).rejects.toThrow(/card .* is still open/);
    expect(await ctx.db.select().from(decisions).where(and(eq(decisions.status, "open"), eq(decisions.dedupeKey, `merge-stuck:${t.id}`)))).toEqual([]);
    expect(await stateOf(t.id)).toBe("review");
    await ctx.decisions.answer(card.id, "Stripe");
    // Past the card's gate now (this bare test project has no board, so the finishing move itself fails later on).
    const after = await ctx.review.landOnce(t.id, "the owner").catch((e: unknown) => e);
    expect(after).not.toBeInstanceOf(ReviewHeldError);
  });
});
