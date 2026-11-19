// BOS-1881: free run slots that outnumber the startable Ready tickets for 30 minutes raise one CEO alert, once,
// and the alert's closer reports when the condition has ended.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, projects, settings, tickets } from "../src/db/schema.js";
import { clearWhenOf } from "../src/services/alert-clearing.js";
import { idleSlotsGoneReason, idleSlotsSweep } from "../src/services/idle-slots-alert.js";

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
