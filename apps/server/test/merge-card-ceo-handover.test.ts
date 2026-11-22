// BOS-1873: a merge or check card raised on the CEO's rung reaches the owner if the CEO leaves it, after the usual
// 60-minute handover, marked as tried by the CEO first. Driven through the real alert-ladder sweep on a fake clock.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, tickets } from "../src/db/schema.js";
import { raiseMergeStuck } from "../src/services/decisions.js";
import { signedInOwner } from "./helpers/owner-session.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const [ticket] = await db.insert(tickets).values({ companyId, projectId: project.id, title: "Add rate limiting", systemState: "review" }).returning();
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const row = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
  return { ...built, db, close, companyId, ceo: ceo!, ticket: ticket!, advance, row };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("a CEO-first merge card left by the CEO (BOS-1873)", () => {
  it("stays off the owner's queue for its first hour, then reaches the owner marked as tried by the CEO first", async () => {
    const [card] = await raiseMergeStuck(ctx.db, ctx.ticket, "the merge gate fault: the runner didn't answer");
    expect(card).toMatchObject({ ceoFirst: true });
    const queued = async () => (await ctx.decisions.queue({ companyId: ctx.companyId })).map((d) => d.id);
    expect(await queued()).not.toContain(card!.id);

    ctx.advance(59);
    await ctx.alerts.sweep();
    expect((await ctx.row(card!.id)).tier).toBe("ceo");
    expect(await queued()).not.toContain(card!.id);

    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const after = await ctx.row(card!.id);
    expect(after.tier).toBe("owner");
    expect(after.status).toBe("open");
    expect((after.context as { ladder?: { rung: string } }).ladder?.rung).toBe("owner");
    // A system card's handover note (alert-ladder.ts): the hops it took, the CEO's with this card's reason.
    expect((after.context as { triedFirst?: string }).triedFirst).toMatch(/^Boss Man tried the team first: the CEO \(the CEO retries merge and check faults first/);
    expect(await queued()).toContain(card!.id);
  });

  it("a merge card already open without a ladder is left on the owner's queue by the sweep, and a new raise replaces it with one card, not two", async () => {
    const [old] = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.companyId, kind: "question", question: "The merge check timed out", options: ["Run the check again", "Send it back to the agent"], recommendedOption: "Run the check again", tier: "ceo", dedupeKey: `merge-stuck:${ctx.ticket.id}`, context: { type: "check_stuck", ticketId: ctx.ticket.id, command: "pnpm test", output: "timed out" } })
      .returning();
    ctx.advance(600);
    await ctx.alerts.sweep();
    const same = await ctx.row(old!.id);
    expect(same.status).toBe("open");
    expect(same.context).not.toHaveProperty("ladder");
    expect((await ctx.decisions.queue({ companyId: ctx.companyId })).map((d) => d.id)).toContain(old!.id);
    const open = await ctx.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(open.filter((d) => (d.context as { ticketId?: string }).ticketId === ctx.ticket.id)).toHaveLength(1);
  });
});
