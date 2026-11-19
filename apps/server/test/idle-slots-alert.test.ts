// BOS-1881: free run slots that outnumber the startable Ready tickets for 30 minutes raise one CEO alert, once,
// and the alert's closer reports when the condition has ended.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, projects, settings, tickets } from "../src/db/schema.js";
import { alertClearing, clearWhenOf } from "../src/services/alert-clearing.js";
import { kindCeiling } from "../src/services/alert-kinds.js";
import { idleSlotsGoneReason, idleSlotsKey, idleSlotsSweep } from "../src/services/idle-slots-alert.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let projectId: string;

const T0 = new Date("2026-11-19T12:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co" }).returning();
  companyId = c!.id;
  const [p] = await db.insert(projects).values({ companyId, name: "App" }).returning();
  projectId = p!.id;
  await db.insert(agents).values({ companyId, name: "Boss", role: "ceo", agentKind: "claude" });
  await db.insert(agents).values({ companyId, name: "Ivy", role: "worker", agentKind: "claude" });
});
afterEach(async () => {
  await close();
});

function sweep(free: number, now: Date, raised: Array<Record<string, unknown>>) {
  return idleSlotsSweep(db, { freeSlots: async () => free, alert: async (i) => void raised.push(i), now: () => now });
}

describe("idle slots alert", () => {
  it("waits 30 minutes, raises one CEO alert naming the idle agents, then stays quiet while it is open", async () => {
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(3, at(0), raised).run()).raised).toBe(0); // clock starts
    expect((await sweep(3, at(29), raised).run()).raised).toBe(0);
    expect((await sweep(3, at(30), raised).run()).raised).toBe(1);
    expect(raised[0]).toMatchObject({ kind: "idle_slots", from: "ceo", dedupeKey: `idle-slots:${companyId}`, clearWhen: [{ kind: "idleSlotsGone", companyId }] });
    expect(String(raised[0]!.question)).toContain("Ivy");
    expect(clearWhenOf({ clearWhen: raised[0]!.clearWhen })).toHaveLength(1);
    // The raise stands in for the ladder's card: an open card with the key stops repeats.
    await db.insert(decisions).values({ companyId, kind: "question", question: "q", options: ["Got it"], recommendedOption: "Got it", status: "open", dedupeKey: `idle-slots:${companyId}` });
    expect((await sweep(3, at(45), raised).run()).raised).toBe(0);
    expect(raised).toHaveLength(1);
  });

  it("restarts the half hour when the condition breaks", async () => {
    const raised: Array<Record<string, unknown>> = [];
    await sweep(3, at(0), raised).run();
    await sweep(0, at(20), raised).run(); // slots full: clock cleared
    expect(await db.select().from(settings)).toHaveLength(0);
    await sweep(3, at(25), raised).run();
    expect((await sweep(3, at(40), raised).run()).raised).toBe(0);
    expect((await sweep(3, at(55), raised).run()).raised).toBe(1);
  });

  it("does not count a Ready ticket that can start against the slots, and the closer says when the condition is over", async () => {
    const [ivy] = await db.select().from(agents).where(eq(agents.name, "Ivy"));
    await db.insert(tickets).values({ companyId, projectId, title: "Next", systemState: "ready", assigneeAgentId: ivy!.id });
    // One free slot, one startable ticket: nothing to say.
    expect(await idleSlotsGoneReason(db, companyId, async () => 1)).toContain("no longer outnumber");
    // Two free slots, one startable ticket: still holds.
    expect(await idleSlotsGoneReason(db, companyId, async () => 2)).toBeNull();
  });
});

// Review round 1: the real alert ladder and the real closer, not stand-ins.
describe("idle slots alert through the real ladder and closer", () => {
  it("raises a CEO-tier card that stays out of the owner's queue, and the closer closes it once startable work fills the slots", async () => {
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
    try {
      const sweepReal = idleSlotsSweep(db, { freeSlots: async () => 3, alert: (i) => built.alerts.raise(i as unknown as Parameters<typeof built.alerts.raise>[0]), now: () => at(0) });
      await sweepReal.run();
      const later = idleSlotsSweep(db, { freeSlots: async () => 3, alert: (i) => built.alerts.raise(i as unknown as Parameters<typeof built.alerts.raise>[0]), now: () => at(30) });
      expect((await later.run()).raised).toBe(1);
      const cards = await db.select().from(decisions).where(eq(decisions.dedupeKey, idleSlotsKey(companyId)));
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ tier: "ceo", status: "open" });
      expect((cards[0]!.context as { ladder: { topRung: string } }).ladder.topRung).toBe("ceo");
      expect(kindCeiling("idle_slots", "ceo")).toBe("ceo");
      expect(kindCeiling("idle_slots", undefined)).toBe("ceo");
      // Nothing for the owner: no open card of this kind sits on the owner's tier.
      expect(await db.select().from(decisions).where(and(eq(decisions.tier, "owner"), eq(decisions.status, "open")))).toHaveLength(0);
      // Still holding: the closer leaves it open. Two free slots filled by startable work: it closes by itself.
      let free = 3;
      const closer = alertClearing(db, { isConnected: () => false, hasRoom: async () => true, freeSlots: async () => free });
      expect(await closer.check()).toBe(0);
      const [ivy] = await db.select().from(agents).where(eq(agents.name, "Ivy"));
      for (const title of ["A", "B", "C"]) await db.insert(tickets).values({ companyId, projectId, title, systemState: "ready", assigneeAgentId: ivy!.id });
      free = 1; // Ivy can start one at a time; free slots no longer outnumber startable tickets
      expect(await closer.check()).toBe(1);
      expect((await db.select().from(decisions).where(eq(decisions.id, cards[0]!.id)))[0]!.status).not.toBe("open");
    } finally {
      await built.app.close();
    }
  });
});
