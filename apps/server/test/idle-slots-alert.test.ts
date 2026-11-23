// BOS-2358: "nothing is running" alert. No non-chat work run for 15 minutes while a Ready or In-progress ticket of an
// unpaused agent waits raises one CEO card listing why each ticket isn't running; 30 minutes later, if still true, one
// owner notice; both close when a work run starts.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, projects, runs, settings, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { alertClearing, clearWhenOf } from "../src/services/alert-clearing.js";
import { busyAgentIds } from "../src/services/agent-wip.js";
import { kindCeiling } from "../src/services/alert-kinds.js";
import { idleSlotsGoneReason, idleSlotsKey, idleSlotsOwnerKey, idleSlotsSweep } from "../src/services/idle-slots-alert.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let projectId: string;
let ivyId: string;

const T0 = new Date("2026-11-19T12:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co" }).returning();
  companyId = c!.id;
  const [p] = await db.insert(projects).values({ companyId, name: "App" }).returning();
  projectId = p!.id;
  await db.insert(agents).values({ companyId, name: "Boss", role: "ceo", agentKind: "claude" });
  const [ivy] = await db.insert(agents).values({ companyId, name: "Ivy", role: "worker", agentKind: "claude" }).returning();
  ivyId = ivy!.id;
});
afterEach(async () => {
  await close();
});

const addTicket = (title: string, extra: Partial<typeof tickets.$inferInsert> = {}) =>
  db.insert(tickets).values({ companyId, projectId, title, systemState: "ready", assigneeAgentId: ivyId, ...extra }).returning();

function sweep(now: Date, raised: Array<Record<string, unknown>>, holdReason?: () => Promise<string | null>) {
  return idleSlotsSweep(db, { alert: async (i) => void raised.push(i), holdReason, now: () => now });
}

describe("nothing is running alert", () => {
  it("waits 15 minutes, raises one CEO card listing why each ticket waits, then the owner notice 30 minutes later", async () => {
    await addTicket("Plan me", { planFirst: true });
    const [dep] = await addTicket("Parked", { systemState: "in_progress" });
    await db.insert(wakes).values({ companyId, agentId: ivyId, ticketId: dep!.id, reason: "refresh", status: "deferred", statusReason: "quiet hours", notBefore: at(240) });
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(at(0), raised).run()).raised).toBe(0); // clock starts
    expect((await sweep(at(14), raised).run()).raised).toBe(0);
    expect((await sweep(at(15), raised, async () => "an update hold since 11:00 UTC").run()).raised).toBe(1);
    expect(raised[0]).toMatchObject({ kind: "idle_slots", from: "ceo", dedupeKey: idleSlotsKey(companyId), clearWhen: [{ kind: "idleSlotsGone", companyId }] });
    const q = String(raised[0]!.question);
    expect(q).toContain("update hold");
    expect(q).toContain("Plan me");
    expect(q).toContain("its plan is not approved");
    expect(q).toContain("Parked");
    expect(q).toContain("deferred until 16:00 UTC (quiet hours)");
    expect(clearWhenOf({ clearWhen: raised[0]!.clearWhen })).toHaveLength(1);
    // The raise stands in for the ladder's card: an open card with the key stops repeats.
    await db.insert(decisions).values({ companyId, kind: "question", question: "q", options: ["Got it"], recommendedOption: "Got it", status: "open", dedupeKey: idleSlotsKey(companyId) });
    expect((await sweep(at(44), raised).run()).raised).toBe(0);
    expect((await sweep(at(45), raised).run()).raised).toBe(1);
    expect(raised[1]).toMatchObject({ kind: "idle_slots_owner", from: "owner", dedupeKey: idleSlotsOwnerKey(companyId) });
    await db.insert(decisions).values({ companyId, kind: "question", question: "q", options: ["Got it"], recommendedOption: "Got it", status: "open", dedupeKey: idleSlotsOwnerKey(companyId) });
    expect((await sweep(at(60), raised).run()).raised).toBe(0);
    expect(raised).toHaveLength(2);
  });

  it("says nothing without open work, or while a work run is live, and restarts the quarter hour when the condition breaks", async () => {
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(at(0), raised).run()).raised).toBe(0);
    expect((await sweep(at(30), raised).run()).raised).toBe(0); // no ticket: nothing waits
    const [t] = await addTicket("Next");
    await sweep(at(31), raised).run(); // clock starts
    const [run] = await db.insert(runs).values({ companyId, agentId: ivyId, ticketId: t!.id }).returning();
    await sweep(at(40), raised).run(); // a live work run: clock cleared
    expect(await db.select().from(settings)).toHaveLength(0);
    await db.update(runs).set({ endedAt: at(41), outcome: "error: SSE read timed out" }).where(eq(runs.id, run!.id));
    await sweep(at(42), raised).run();
    expect((await sweep(at(56), raised).run()).raised).toBe(0);
    expect((await sweep(at(57), raised).run()).raised).toBe(1);
    expect(String(raised[0]!.question)).toContain("last run errored at 12:41 UTC");
  });

  it("does not count an owner chat run as work", async () => {
    await addTicket("Next");
    await db.insert(runs).values({ companyId, agentId: ivyId, purpose: "chat" });
    expect(await idleSlotsGoneReason(db, companyId, at(0))).toBeNull();
  });

  it("names a blocked ticket and a booked check", async () => {
    const [a] = await addTicket("Blocker", { systemState: "in_progress" });
    await addTicket("Checked", { systemState: "in_progress", monitorAt: at(90) });
    const [b] = await addTicket("Waiting");
    await db.insert(ticketDependencies).values({ blockedTicketId: b!.id, blockerTicketId: a!.id, until: "merged" });
    const raised: Array<Record<string, unknown>> = [];
    await sweep(at(0), raised).run();
    await sweep(at(15), raised).run();
    const q = String(raised[0]!.question);
    expect(q).toContain("blocked on an unfinished ticket");
    expect(q).toContain("check booked for 13:30 UTC");
  });

  it("busyAgentIds ignores a deferred wake that is not due, and counts a due one and a queued one", async () => {
    await db.insert(wakes).values({ companyId, agentId: ivyId, reason: "refresh", status: "deferred", notBefore: at(120) });
    expect([...(await busyAgentIds(db, at(0)))]).not.toContain(ivyId);
    expect([...(await busyAgentIds(db, at(121)))]).toContain(ivyId);
    await db.insert(wakes).values({ companyId, agentId: ivyId, reason: "x", status: "queued" });
    expect([...(await busyAgentIds(db, at(0)))]).toContain(ivyId);
  });
});

describe("nothing is running alert through the real ladder and closer", () => {
  it("raises a CEO-tier card that stays out of the owner's queue, and closes it once a work run starts", async () => {
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
    try {
      const [t] = await addTicket("Next");
      const raise = (i: Record<string, unknown>) => built.alerts.raise(i as unknown as Parameters<typeof built.alerts.raise>[0]);
      await idleSlotsSweep(db, { alert: raise, now: () => at(0) }).run();
      expect((await idleSlotsSweep(db, { alert: raise, now: () => at(15) }).run()).raised).toBe(1);
      const cards = await db.select().from(decisions).where(eq(decisions.dedupeKey, idleSlotsKey(companyId)));
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ tier: "ceo", status: "open" });
      expect(kindCeiling("idle_slots", "ceo")).toBe("ceo");
      expect(await db.select().from(decisions).where(and(eq(decisions.tier, "owner"), eq(decisions.status, "open")))).toHaveLength(0);
      const closer = alertClearing(db, { isConnected: () => false, hasRoom: async () => true, now: () => at(16) });
      expect(await closer.check()).toBe(0);
      await db.insert(runs).values({ companyId, agentId: ivyId, ticketId: t!.id });
      expect(await closer.check()).toBe(1);
      expect((await db.select().from(decisions).where(eq(decisions.id, cards[0]!.id)))[0]!.status).not.toBe("open");
    } finally {
      await built.app.close();
    }
  });
});
