import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, projects, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
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

  it("answering wakes the asker on the review ticket, and its assignee with the answer when that is someone else", async () => {
    const [dev] = await ctx.db.insert(agents).values({ companyId: ctx.co.company.id, name: "Dev", role: "worker", agentKind: "claude" }).returning();
    const own = await ctx.ticket({ systemState: "review" });
    const other = await ctx.ticket({ systemState: "review", assigneeAgentId: dev!.id });
    const c1 = await ctx.raise(own.id);
    const c2 = await ctx.raise(other.id);
    await ctx.decisions.answer(c1.id, "Stripe");
    await ctx.decisions.answer(c2.id, "Mollie");
    const woken = await ctx.db.select({ agentId: wakes.agentId, ticketId: wakes.ticketId, reason: wakes.reason, note: wakes.note }).from(wakes).where(eq(wakes.reason, "decision answered"));
    // The asker (the CEO) on the ticket it asked about, as it was before the card stopped blocking review tickets.
    expect(woken.filter((w) => w.agentId === ctx.co.ceo.id).map((w) => w.ticketId).sort()).toEqual([own.id, other.id].sort());
    // The other ticket's assignee hears the answer too.
    const devWake = woken.filter((w) => w.agentId === dev!.id);
    expect(devWake).toHaveLength(1);
    expect(devWake[0]!.ticketId).toBe(other.id);
    expect(devWake[0]!.note).toContain("Mollie");
    expect(await stateOf(own.id)).toBe("review");
    expect(await stateOf(other.id)).toBe("review");
  });

  it("a done ticket stays done", async () => {
    const t = await ctx.ticket({ systemState: "done" });
    const card = await ctx.raise(t.id);
    expect(await stateOf(t.id)).toBe("done");
    // The card is dead once its ticket is done (DR-061 Q4): the answer is refused and the ticket stays done.
    await expect(ctx.decisions.answer(card.id, "Stripe")).rejects.toThrow(/no longer valid/);
    expect(await stateOf(t.id)).toBe("done");
  });

  for (const from of ["backlog", "ready", "in_progress"] as const) {
    it(`a ticket in ${from} is blocked, the history names the card, and answering frees it to ready`, async () => {
      const t = await ctx.ticket({ systemState: from });
      const card = await ctx.raise(t.id);
      expect(await stateOf(t.id)).toBe("blocked");
      expect(await stateRows(t.id)).toEqual([`${from} -> blocked: Waiting on the owner's card ${card.id}`]);
      await ctx.decisions.answer(card.id, "Stripe");
      expect(await stateOf(t.id)).toBe("ready");
    });
  }

  it("a plain question or owner to-do on a ticket in review does not hold its merge (BOS-1078)", async () => {
    const t = await ctx.ticket({ systemState: "review" });
    const question = await ctx.raise(t.id);
    const todo = await ctx.decisions.raise({ companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, question: "Rotate the deploy key", options: ["Done", "Not yet"], recommended: "Done", blocksTicketId: t.id, triedFirst: "No host access", ownerMustDo: true, steps: ["Open Settings → Secrets and rotate the deploy key."] });
    // Both stay linked to the ticket (the board shows them in Your review)...
    expect(await ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, t.id))).toHaveLength(2);
    // Both are open in the owner's queue: not holding the merge is not the same as being closed.
    const open = await ctx.db.select({ id: decisions.id }).from(decisions).where(eq(decisions.status, "open"));
    expect(open.map((d) => d.id)).toEqual(expect.arrayContaining([question.id, todo.id]));
    // ...but neither holds the merge: the gate goes past them (this bare project has no board, so it fails later on).
    const r = await ctx.review.landOnce(t.id, "the owner").catch((e: unknown) => e);
    expect(r).not.toBeInstanceOf(ReviewHeldError);
    expect(String((r as Error)?.message ?? "")).not.toMatch(/card .* is still open/);
    // Once the ticket is finished (BOS-1193) the plain question closes by itself; the owner's to-do outlives the merge.
    const after = await ctx.db.select({ id: decisions.id }).from(decisions).where(eq(decisions.status, "open"));
    expect(after.map((d) => d.id)).toContain(todo.id);
  });

  it("a card raised with holdsMerge holds the merge while open, and the merge goes ahead once it is answered", async () => {
    const t = await ctx.ticket({ systemState: "review" });
    const card = await ctx.decisions.raise({ companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, holdsMerge: true, triedFirst: "Compared both providers" });
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
