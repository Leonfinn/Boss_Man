// BOS-2766: the database reads of the owner's sign-off cards in signoff.ts (openSignoffCard, signoffHistory,
// priorSignoff), tested straight against the in-memory database with no app built.
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, projects, ticketReviews, tickets } from "../src/db/schema.js";
import { APPROVE_MERGE } from "../src/services/decisions.js";
import { openSignoffCard, priorSignoff, signoffHistory } from "../src/services/signoff.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db
    .insert(companies)
    .values({ name: `Co ${Math.random()}` })
    .returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "T", number: ++n, risk: "high", ...patch }).returning())[0]!;
  const card = async (ticketId: string, patch: Partial<typeof decisions.$inferInsert> = {}) =>
    (
      await db
        .insert(decisions)
        .values({
          companyId: co!.id,
          kind: "approval",
          question: "Merge it?",
          options: [APPROVE_MERGE, "Send it back"],
          recommendedOption: APPROVE_MERGE,
          tier: "owner",
          status: "open",
          context: { type: "risk_review", ticketId },
          ...patch,
        })
        .returning()
    )[0]!;
  /** An answered "Approve and merge" card that recorded a commit sign-off (DR-013). */
  const signedOffCard = async (ticketId: string, head: string, risk: string, atMs: number) => {
    const iso = at(atMs).toISOString();
    return card(ticketId, {
      status: "answered",
      answer: APPROVE_MERGE,
      createdAt: at(atMs),
      answeredAt: at(atMs),
      context: { type: "risk_review", ticketId, head, risk, signedOff: { head, risk, at: iso, by: "owner" } },
    });
  };
  const signedOff = (c: { context: unknown }) => (c.context as { signedOff: { head: string; risk: string; at: string; by: string } }).signedOff;
  return { db, close, company: co!.id, project: p!.id, ticket, card, signedOffCard, signedOff };
}

describe("openSignoffCard", () => {
  it("returns null when the ticket has no card", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    expect(await openSignoffCard(s.db, t.id)).toBeNull();
  });

  it("returns the id of the ticket's open risk_review card", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const c = await s.card(t.id);
    expect(await openSignoffCard(s.db, t.id)).toBe(c.id);
  });

  it("returns the newest when two cards are open", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.card(t.id, { createdAt: at(1) });
    const newer = await s.card(t.id, { createdAt: at(2) });
    expect(await openSignoffCard(s.db, t.id)).toBe(newer.id);
  });

  it("ignores answered cards, cards of other kinds and cards for other tickets", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const other = await s.ticket();
    await s.card(t.id, { status: "answered", answer: APPROVE_MERGE, createdAt: at(1), answeredAt: at(2) });
    await s.card(t.id, { kind: "question", context: { type: "something_else", ticketId: t.id }, createdAt: at(3) });
    const otherOpen = await s.card(other.id, { createdAt: at(4) });
    expect(await openSignoffCard(s.db, t.id)).toBeNull();
    expect(await openSignoffCard(s.db, other.id)).toBe(otherOpen.id);
  });
});

describe("signoffHistory", () => {
  it("returns null when the ticket has no cards", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    expect(await signoffHistory(s.db, t.id)).toBeNull();
  });

  it("lists each card newest first, saying open, answered or withdrawn with who and why", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    const open = await s.card(t.id, { createdAt: at(1) });
    const answered = await s.card(t.id, { status: "answered", answer: APPROVE_MERGE, createdAt: at(2), answeredAt: at(3) });
    const withdrawn = await s.card(t.id, {
      status: "withdrawn",
      createdAt: at(4),
      answeredAt: at(5),
      context: { type: "risk_review", ticketId: t.id, withdrawn: { by: "Dana", note: "duplicate card" } },
    });
    const lines = (await signoffHistory(s.db, t.id))!.split("\n").slice(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(withdrawn.id);
    expect(lines[0]).toContain(`withdrawn at `);
    expect(lines[0]).toContain("by Dana: duplicate card");
    expect(lines[1]).toContain(answered.id);
    expect(lines[1]).toContain(`answered "${APPROVE_MERGE}"`);
    expect(lines[2]).toContain(open.id);
    expect(lines[2]).toContain(": open");
  });

  it("keeps to the limit, newest first", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.card(t.id, { createdAt: at(1) });
    const middle = await s.card(t.id, { createdAt: at(2) });
    const newest = await s.card(t.id, { createdAt: at(3) });
    const lines = (await signoffHistory(s.db, t.id, 2))!.split("\n").slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(newest.id);
    expect(lines[1]).toContain(middle.id);
  });
});

describe("priorSignoff", () => {
  it("gives all three null when there is no answered card", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket();
    await s.card(t.id);
    expect(await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).toEqual({ reuse: null, earlier: null, current: null });
  });

  it("returns the newest sign-off as current and earlier, and reuses it only for the same head", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket({ risk: "high" });
    const signed = await s.signedOffCard(t.id, "head1", "high", 10);
    const signOff = s.signedOff(signed);
    expect(await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).toEqual({ reuse: signOff, earlier: signOff, current: signOff });
    const otherHead = await priorSignoff(s.db, { id: t.id, risk: "high" }, "head2");
    expect(otherHead).toEqual({ reuse: null, earlier: signOff, current: signOff });
  });

  it("leaves current null when a newer Send it back card was answered, and keeps earlier", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket({ risk: "high" });
    const signed = await s.signedOffCard(t.id, "head1", "high", 10);
    const signOff = s.signedOff(signed);
    await s.card(t.id, {
      status: "answered",
      answer: "Send it back",
      createdAt: at(20),
      answeredAt: at(20),
      context: { type: "risk_review", ticketId: t.id, head: "head1", risk: "high" },
    });
    expect(await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).toEqual({ reuse: null, earlier: signOff, current: null });
  });

  it("leaves current null when a changes_requested review came after the sign-off, and keeps earlier", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket({ risk: "high" });
    const signed = await s.signedOffCard(t.id, "head1", "high", 10);
    const signOff = s.signedOff(signed);
    // One before the sign-off does not clear it.
    await s.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Rae", verdict: "changes_requested", createdAt: at(5) });
    expect((await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).current).toEqual(signOff);
    await s.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Rae", verdict: "changes_requested", createdAt: at(20) });
    expect(await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).toEqual({ reuse: null, earlier: signOff, current: null });
  });

  it("leaves current null when the ticket's risk is now higher than the signed-off risk, and keeps earlier", async () => {
    const s = (ctx = await setup());
    const t = await s.ticket({ risk: "critical" });
    const signed = await s.signedOffCard(t.id, "head1", "high", 10);
    const signOff = s.signedOff(signed);
    expect(await priorSignoff(s.db, { id: t.id, risk: "critical" }, "head1")).toEqual({ reuse: null, earlier: signOff, current: null });
    // The same risk still stands.
    expect((await priorSignoff(s.db, { id: t.id, risk: "high" }, "head1")).current).toEqual(signOff);
  });
});
