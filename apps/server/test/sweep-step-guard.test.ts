// BOS-2160: a background sweep step that throws is logged, named in failedSteps, and after three failing passes
// raises one owner card that closes after the step's next success; the other steps still run (BOS-611).
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite, type Db } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { sweepService } from "../src/services/sweeps.js";
import { sweepStepGuard, sweepStepKey, sweepStepOkReason } from "../src/services/sweep-step-guard.js";
import type { AlertInput } from "../src/services/alert-ladder.js";

let ctx: { db: Db; close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  ctx = { db, close };
  const [co] = await db.insert(companies).values({ name: "Acme", ticketPrefix: "ACM" } as never).returning({ id: companies.id });
  return { db, companyId: co!.id };
}

describe("sweepStepGuard", () => {
  it("logs a redacted failure, returns the fallback and lets the other steps run", async () => {
    const { db } = await setup();
    const logs: string[] = [];
    const g = await sweepStepGuard(db, { log: (m) => logs.push(m) });
    const out = await g.step("merge stall alarm", async () => { throw new Error("boom DB_PASSWORD=made-up-value-12345"); }, "fallback");
    expect(out).toBe("fallback");
    expect(await g.step("other", async () => "fine", "x")).toBe("fine");
    expect(g.failed()).toEqual(["merge stall alarm"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('sweep step "merge stall alarm" failed: boom');
    expect(logs[0]).not.toContain("made-up-value-12345");
  });

  it("raises one owner alert at the third failing pass, not before and not again, and the closer sees the recovery", async () => {
    const { db, companyId } = await setup();
    const raised: AlertInput[] = [];
    const opts = { alert: async (i: AlertInput) => (raised.push(i), { id: "a" }), homeCompany: async () => companyId };
    const pass = async (fails: boolean) => {
      const g = await sweepStepGuard(db, opts);
      await g.step("run time limit", async () => { if (fails) throw new Error("x"); }, undefined);
      await g.finish();
    };
    await pass(true);
    await pass(true);
    expect(raised).toHaveLength(0);
    await pass(true);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ companyId, kind: "sweep_step_failing", from: "owner", dedupeKey: "sweep-step:run time limit", clearWhen: [{ kind: "sweepStepOk", step: "run time limit" }] });
    expect(await sweepStepOkReason(db, "run time limit")).toBeNull();
    await pass(true);
    expect(raised).toHaveLength(1);
    await pass(false);
    expect(await sweepStepOkReason(db, "run time limit")).toContain("without an error");
  });

  it("a failure in between successes never reaches three", async () => {
    const { db, companyId } = await setup();
    const raised: AlertInput[] = [];
    const opts = { alert: async (i: AlertInput) => (raised.push(i), { id: "a" }), homeCompany: async () => companyId };
    for (const fails of [true, true, false, true, true, false]) {
      const g = await sweepStepGuard(db, opts);
      await g.step("s", async () => { if (fails) throw new Error("x"); }, undefined);
      await g.finish();
    }
    expect(raised).toHaveLength(0);
  });
});

describe("the sweep pass", () => {
  it("names a failing step in failedSteps, logs it, and still runs the rest", async () => {
    const { db } = await setup();
    const logs: string[] = [];
    const sweeps = sweepService(db, {
      wake: async () => ({}), isConnected: () => true, endRun: async () => ({}), endUnconfirmedCancels: async () => ({}), alert: async () => null,
      log: (m) => logs.push(m),
      mergeStall: async () => { throw new Error("stall read failed"); },
      priorityWatch: async () => undefined,
    });
    const pass = await sweeps.run(async () => ({ raised: 0 }));
    expect(pass.failedSteps).toEqual(["merge stall alarm"]);
    expect(logs.some((l) => l.includes("merge stall alarm"))).toBe(true);
    expect(pass).toHaveProperty("goalChecks");
    expect((await db.select().from(companies).where(eq(companies.name, "Acme"))).length).toBe(1);
  });
});

describe("sweepStepKey", () => {
  it("pins the key format and keeps one key per step name", () => {
    expect(sweepStepKey("run time limit")).toBe("sweep-step:run time limit");
    expect(sweepStepKey("run time limit")).toBe(sweepStepKey("run time limit"));
    expect(sweepStepKey("run time limit")).not.toBe(sweepStepKey("merge stall alarm"));
  });

  it("is the dedupe key of the alert raised for the failing step", async () => {
    const { db, companyId } = await setup();
    const raised: AlertInput[] = [];
    const opts = { alert: async (i: AlertInput) => (raised.push(i), { id: "a" }), homeCompany: async () => companyId };
    for (let pass = 0; pass < 3; pass++) {
      const g = await sweepStepGuard(db, opts);
      await g.step("run time limit", async () => { throw new Error("x"); }, undefined);
      await g.finish();
    }
    expect(raised).toHaveLength(1);
    expect(raised[0]!.dedupeKey).toBe(sweepStepKey("run time limit"));
  });
});
