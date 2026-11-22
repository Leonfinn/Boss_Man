import { describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import {
  checkGate,
  checkPriority,
  DEFAULT_BACKGROUND_LANE_AGE_MINUTES,
  DEFAULT_MERGE_CHECK_LIMIT,
  MAX_BACKGROUND_LANE_AGE_MINUTES,
  readLaneAgeMinutes,
} from "../src/services/check-gate.js";
import { eq } from "drizzle-orm";
import { settings } from "../src/db/schema.js";
import { DEPLOY_WAIT_KEY } from "../src/services/deploy-wait-hold.js";

const tick = () => new Promise((r) => setTimeout(r, 20));

async function gateWith() {
  const { db, close } = await openPglite();
  return { gate: checkGate(db), close, db };
}

describe("check gate", () => {
  it("parks new checks while a server update waits for a quiet machine (BOS-420); running ones finish", async () => {
    const { gate, close, db } = await gateWith();
    const order: string[] = [];
    const release: Record<string, () => void> = {};
    const job = (name: string) => gate.run(1, false, () => new Promise<void>((resolve) => { order.push(name); release[name] = resolve; }));
    const a = job("a");
    await tick();
    expect(order).toEqual(["a"]);
    await db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: { phase: "waiting", approvedAt: new Date().toISOString() } });
    const b = job("b");
    await tick();
    expect(order).toEqual(["a"]); // a free slot, but held
    expect(gate.state()).toEqual({ running: 1, waiting: 1 });
    release.a!();
    await a;
    await tick();
    expect(order).toEqual(["a"]);
    await db.delete(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
    await gate.pump(); // the wait's end pumps; otherwise the 30 s retry does
    await tick();
    expect(order).toEqual(["a", "b"]);
    release.b!();
    await b;
    await close();
  });

  it("a soft hold older than 3 hours parks nothing", async () => {
    const { gate, close, db } = await gateWith();
    await db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: { phase: "waiting", approvedAt: new Date(Date.now() - 4 * 3600_000).toISOString() } });
    await gate.run(1, false, async () => "ran");
    await close();
  });

  it("defaults to two at once and queues the rest in order", async () => {
    const { gate, close } = await gateWith();
    expect(await gate.limit()).toBe(DEFAULT_MERGE_CHECK_LIMIT);
    const order: string[] = [];
    const release: Record<string, () => void> = {};
    const job = (name: string, priority = 1, alone = false) =>
      gate.run(priority, alone, () => new Promise<void>((resolve) => { order.push(name); release[name] = resolve; }));
    const all = [job("a"), job("b"), job("c"), job("d")];
    await tick();
    expect(order).toEqual(["a", "b"]);
    release.a!();
    await tick();
    expect(order).toEqual(["a", "b", "c"]);
    release.b!();
    await tick();
    release.c!();
    release.d!();
    await Promise.all(all);
    await close();
  });

  it("lets urgent and arch-fix tickets jump the queue, and a final retry run alone", async () => {
    const { gate, close } = await gateWith();
    await gate.setLimit(1);
    const order: string[] = [];
    const release: Record<string, () => void> = {};
    const job = (name: string, priority: number, alone = false) =>
      gate.run(priority, alone, () => new Promise<void>((resolve) => { order.push(name); release[name] = resolve; }));
    const all = [job("first", 1)];
    await tick();
    all.push(job("normal", 1), job("urgent", checkPriority({ urgent: true })));
    await tick();
    release.first!();
    await tick();
    expect(order).toEqual(["first", "urgent"]);
    release.urgent!();
    await tick();
    release.normal!();
    await Promise.all(all);
    expect(checkPriority({ title: "Arch fix 7: one check" })).toBe(0);
    expect(checkPriority({ title: "Add a button" })).toBe(1);
    expect(checkPriority({ title: "Add a button", fixesMergeCheck: true })).toBe(0);
    expect(checkPriority({ title: "Add a button", fixesMergeCheck: false })).toBe(1);

    await gate.setLimit(2);
    order.length = 0;
    const more = [job("x", 1), job("alone", 1, true), job("y", 1)];
    await tick();
    expect(order).toEqual(["x"]);
    release.x!();
    await tick();
    expect(order).toEqual(["x", "alone"]);
    release.alone!();
    await tick();
    release.y!();
    await Promise.all(more);
    await close();
  });
});

describe("background lane age setting (BOS-1803)", () => {
  it("reads a whole number of minutes inside the allowed range", () => {
    expect(readLaneAgeMinutes(60)).toBe(60);
    expect(readLaneAgeMinutes("90")).toBe(90);
  });

  it("accepts both ends of the range", () => {
    expect(readLaneAgeMinutes(0)).toBe(0);
    expect(readLaneAgeMinutes(MAX_BACKGROUND_LANE_AGE_MINUTES)).toBe(MAX_BACKGROUND_LANE_AGE_MINUTES);
  });

  it("falls back to the default for a missing or blank value", () => {
    expect(readLaneAgeMinutes(null)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes(undefined)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes("")).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
  });

  it("falls back to the default for a negative, too-large, fractional or non-numeric value", () => {
    expect(readLaneAgeMinutes(-1)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes(MAX_BACKGROUND_LANE_AGE_MINUTES + 1)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes(1.5)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes("abc")).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
    expect(readLaneAgeMinutes(Number.NaN)).toBe(DEFAULT_BACKGROUND_LANE_AGE_MINUTES);
  });
});
