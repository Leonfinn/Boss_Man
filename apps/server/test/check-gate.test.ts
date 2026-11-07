import { describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { checkGate, checkPriority, DEFAULT_MERGE_CHECK_LIMIT } from "../src/services/check-gate.js";
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
