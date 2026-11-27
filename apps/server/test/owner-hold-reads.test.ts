// BOS-2770: the failed-update hold's open and read paths (owner-holds.ts openHold, heldFor, pickupOf), against
// the in-memory database with rows inserted by hand (as check-hold.test.ts does), no buildApp.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, companies, ownerHolds, projects, runs, settings, tickets } from "../src/db/schema.js";
import { HOLD_DEFAULT_MINUTES, HOLD_MINUTES_KEY, heldFor, openHold, pickupOf } from "../src/services/owner-holds.js";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const [co] = await db.insert(companies).values({ name: `Co ${randomUUID()}`, ticketPrefix: "BOS" }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: co!.id, name: "Dana", role: "worker", agentKind: "claude" }).returning();
  const [other] = await db.insert(agents).values({ companyId: co!.id, name: "Ines", role: "worker", agentKind: "claude" }).returning();
  let n = 0;
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: "Diagnose the failed update", number: ++n, assigneeAgentId: agent!.id, ...patch }).returning())[0]!;
  return { db, close, company: co!.id, agent: agent!.id, other: other!.id, ticket };
}

const hold = (over: Partial<Parameters<typeof openHold>[1]> = {}) =>
  openHold(ctx.db, { subject: "server_deploy", commit: "a".repeat(40), result: "failed", reason: "x", ...over });

const read = async (id: string) => (await ctx.db.select().from(ownerHolds).where(eq(ownerHolds.id, id)))[0]!;

const release = (id: string, outcome: "retry_safe" | "do_not_retry" | "unknown") =>
  ctx.db.update(ownerHolds).set({ releasedAt: new Date("2026-11-27T10:00:00Z"), releasedBy: "Dana", outcome }).where(eq(ownerHolds.id, id));

describe("openHold: when the hold ends", () => {
  it("releases 120 minutes after it opened by default", async () => {
    const now = new Date("2026-11-27T09:00:00Z");
    const h = await hold({ now });
    expect(h.createdAt).toEqual(now);
    expect(h.releaseBy).toEqual(new Date("2026-11-27T11:00:00Z"));
    expect(h.releaseBy.getTime() - h.createdAt.getTime()).toBe(HOLD_DEFAULT_MINUTES * 60_000);
  });

  it("uses the owner_hold_minutes setting when one is set", async () => {
    await ctx.db.insert(settings).values({ key: HOLD_MINUTES_KEY, value: 30 });
    const h = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    expect(h.releaseBy).toEqual(new Date("2026-11-27T09:30:00Z"));
  });
});

describe("openHold: the reason it stores", () => {
  it("cuts a reason over 500 characters to its first 500, and keeps a short one whole", async () => {
    const long = "x".repeat(600);
    const cut = await hold({ reason: long });
    expect(cut.reason).toHaveLength(500);
    expect(cut.reason).toBe(long.slice(0, 500));
    const short = await hold({ subject: "runner_update", reason: "the build timed out" });
    expect(short.reason).toBe("the build timed out");
  });
});

describe("openHold: one current hold per subject", () => {
  it("ends the previous hold and carries its diagnosis ticket while that ticket is open", async () => {
    const t = await ctx.ticket(); // backlog, so not done
    const first = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    await ctx.db.update(ownerHolds).set({ ticketId: t.id }).where(eq(ownerHolds.id, first.id));

    const second = await hold({ now: new Date("2026-11-27T10:00:00Z"), commit: "b".repeat(40) });

    expect((await read(first.id)).endedAt).toEqual(new Date("2026-11-27T10:00:00Z"));
    expect(second.ticketId).toBe(t.id);
    expect((await read(second.id)).endedAt).toBeNull();
  });

  it("drops the diagnosis ticket once that ticket is done", async () => {
    const t = await ctx.ticket({ systemState: "done" });
    const first = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    await ctx.db.update(ownerHolds).set({ ticketId: t.id }).where(eq(ownerHolds.id, first.id));

    const second = await hold({ now: new Date("2026-11-27T10:00:00Z"), commit: "b".repeat(40) });

    expect(second.ticketId).toBeNull();
  });

  it("leaves a hold of the other subject alone", async () => {
    const server = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    const runner = await hold({ subject: "runner_update", commit: "b".repeat(40), now: new Date("2026-11-27T09:10:00Z") });

    await hold({ now: new Date("2026-11-27T10:00:00Z"), commit: "c".repeat(40) });

    expect((await read(server.id)).endedAt).toEqual(new Date("2026-11-27T10:00:00Z"));
    expect((await read(runner.id)).endedAt).toBeNull();
  });
});

describe("heldFor: which update the hold stops", () => {
  it("gives null when no hold is current", async () => {
    expect(await heldFor(ctx.db, "server_deploy")).toBeNull();
  });

  it("gives an unreleased hold whatever the tip, and nothing for the other subject", async () => {
    const h = await hold();
    expect((await heldFor(ctx.db, "server_deploy"))?.id).toBe(h.id);
    expect((await heldFor(ctx.db, "server_deploy", "f".repeat(40)))?.id).toBe(h.id);
    expect(await heldFor(ctx.db, "runner_update")).toBeNull();
  });

  it("gives null once it is released as retry_safe or unknown", async () => {
    const retry = await hold();
    await release(retry.id, "retry_safe");
    expect(await heldFor(ctx.db, "server_deploy")).toBeNull();
    expect(await heldFor(ctx.db, "server_deploy", retry.commit)).toBeNull();

    const timedOut = await hold({ now: new Date("2026-11-27T11:00:00Z") });
    await release(timedOut.id, "unknown");
    expect(await heldFor(ctx.db, "server_deploy")).toBeNull();
  });

  it("keeps only the failed commit held after do_not_retry, without regard to case", async () => {
    const h = await hold({ commit: "AbCdEf".padEnd(40, "0") });
    await release(h.id, "do_not_retry");

    expect((await heldFor(ctx.db, "server_deploy"))?.id).toBe(h.id);
    expect((await heldFor(ctx.db, "server_deploy", h.commit.toLowerCase()))?.id).toBe(h.id);
    expect((await heldFor(ctx.db, "server_deploy", h.commit.toUpperCase()))?.id).toBe(h.id);
    expect(await heldFor(ctx.db, "server_deploy", "9".repeat(40))).toBeNull();
  });

  it("ignores a hold that has already ended", async () => {
    const h = await hold({ subject: "runner_update" });
    await ctx.db.update(ownerHolds).set({ endedAt: new Date("2026-11-27T10:00:00Z") }).where(eq(ownerHolds.id, h.id));
    expect(await heldFor(ctx.db, "runner_update")).toBeNull();
  });
});

describe("pickupOf: who is diagnosing the hold", () => {
  it("gives nulls and keeps the wake time when the hold has no ticket", async () => {
    const h = await hold();
    const wokenAt = new Date("2026-11-27T09:05:00Z");
    await ctx.db.update(ownerHolds).set({ wokenAt }).where(eq(ownerHolds.id, h.id));

    expect(await pickupOf(ctx.db, await read(h.id))).toEqual({ ticketId: null, ref: null, agent: null, startedAt: null, wokenAt });
  });

  it("gives the ticket's ref and assignee, and their first run on it since the hold began", async () => {
    const h = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    const t = await ctx.ticket({ number: 42 });
    await ctx.db.update(ownerHolds).set({ ticketId: t.id }).where(eq(ownerHolds.id, h.id));
    const at = (mins: number) => new Date(Date.UTC(2026, 10, 27, 9, mins));
    await ctx.db.insert(runs).values([
      // Before the hold began, by another agent, and a chat about the ticket: none is the diagnosis.
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "work", startedAt: at(-5) },
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.other, purpose: "work", startedAt: at(1) },
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "chat", startedAt: at(2) },
      // The assignee's first real run since the hold: the one that counts.
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "work", startedAt: at(7) },
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "reply", startedAt: at(9) },
    ]);

    expect(await pickupOf(ctx.db, await read(h.id))).toMatchObject({ ticketId: t.id, ref: "BOS-42", agent: "Dana", startedAt: at(7) });
  });

  it("leaves startedAt null until the assignee has run on the ticket since the hold began", async () => {
    const h = await hold({ now: new Date("2026-11-27T09:00:00Z") });
    const t = await ctx.ticket();
    await ctx.db.update(ownerHolds).set({ ticketId: t.id }).where(eq(ownerHolds.id, h.id));
    await ctx.db.insert(runs).values([
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "chat", startedAt: new Date("2026-11-27T09:05:00Z") },
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.other, purpose: "work", startedAt: new Date("2026-11-27T09:06:00Z") },
      { companyId: ctx.company, ticketId: t.id, agentId: ctx.agent, purpose: "work", startedAt: new Date("2026-11-27T08:50:00Z") },
    ]);

    expect(await pickupOf(ctx.db, await read(h.id))).toMatchObject({ ticketId: t.id, ref: "BOS-1", agent: "Dana", startedAt: null });
  });
});
