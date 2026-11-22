// BOS-1866: the cost sanity check compares a run's recorded cost with its tokens at list price when it ends.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, costEvents, fundingSources, runs } from "../src/db/schema.js";
import { backInBandReason, BACK_IN_BAND_RUNS, checkEndedRun, costCheckKey, raiseCostAlert, summarizeCostChecks } from "../src/services/cost-check.js";
import { clearWhenOf } from "../src/services/alert-clearing.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let sourceId: string;

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co" }).returning();
  companyId = c!.id;
  const [s] = await db.insert(fundingSources).values({ name: "Src", kind: "api_payg", provider: "anthropic" }).returning();
  sourceId = s!.id;
});
afterEach(async () => {
  await close();
});

/** A run of claude-sonnet-5-5 ($2 in, $10 out per million) with 1M in and 100k out: list price $3.00. */
async function endedRun(costMicros: number, model = "claude-sonnet-5-5", endedAt = new Date()) {
  const [r] = await db.insert(runs).values({ companyId, model, startedAt: endedAt, endedAt, inputTokens: 1_000_000, outputTokens: 100_000, cachedReadTokens: 0, cachedWriteTokens: 0 }).returning();
  if (costMicros > 0) await db.insert(costEvents).values({ runId: r!.id, fundingSourceId: sourceId, companyId, costMicros });
  return r!.id;
}
const stored = async (id: string) => (await db.select({ c: runs.costCheck }).from(runs).where(eq(runs.id, id)))[0]!.c;

describe("checkEndedRun", () => {
  it("marks a run whose cost matches its tokens as ok and raises nothing", async () => {
    const id = await endedRun(3_000_000);
    expect(await checkEndedRun(db, id)).toBeNull();
    expect(await stored(id)).toBe("ok");
  });

  it("flags a cost about 8x the list price (the BOS-1857 shape) and returns the CEO alert", async () => {
    const id = await endedRun(24_000_000);
    const alert = await checkEndedRun(db, id);
    expect(await stored(id)).toBe("out_of_band");
    expect(alert).toMatchObject({ companyId });
    expect(alert!.question).toContain("$24.00 recorded");
  });

  it("flags a cost far below the list price", async () => {
    const id = await endedRun(300_000);
    expect(await checkEndedRun(db, id)).not.toBeNull();
    expect(await stored(id)).toBe("out_of_band");
  });

  it("skips and names a model with no list price, and a run with no recorded cost, without flagging", async () => {
    const unknown = await endedRun(24_000_000, "qwen3:8b");
    const free = await endedRun(0);
    expect(await checkEndedRun(db, unknown)).toBeNull();
    expect(await checkEndedRun(db, free)).toBeNull();
    expect(await stored(unknown)).toBe("skipped:no_list_price");
    expect(await stored(free)).toBe("skipped:no_recorded_cost");
    const sum = await summarizeCostChecks(db, eq(runs.companyId, companyId));
    expect(sum.outOfBand).toBe(0);
    expect(sum.skipped).toEqual(expect.arrayContaining([{ model: "qwen3:8b", reason: "no list price known for the model", runs: 1 }]));
  });

  it("counts out-of-band runs for the panel", async () => {
    await checkEndedRun(db, await endedRun(3_000_000));
    await checkEndedRun(db, await endedRun(30_000_000));
    expect(await summarizeCostChecks(db, eq(runs.companyId, companyId))).toMatchObject({ outOfBand: 1, checked: 2 });
  });
});

describe("the CEO alert", () => {
  it("is raised for the CEO tier with one key per company and a self-clearing condition", async () => {
    const raised: Array<Record<string, unknown>> = [];
    await raiseCostAlert(async (i) => void raised.push(i), { companyId, question: "q" });
    expect(raised[0]).toMatchObject({ kind: "cost_out_of_band", from: "ceo", dedupeKey: `cost-out-of-band:${companyId}`, clearWhen: [{ kind: "costBackInBand", companyId }] });
    expect(clearWhenOf({ clearWhen: raised[0]!.clearWhen })).toEqual([{ kind: "costBackInBand", companyId }]);
  });

  it("closes only once the latest checked runs are all in band and the newest ended after the card", async () => {
    const t0 = new Date("2026-11-19T10:00:00Z");
    const cardAt = new Date(t0.getTime() + 60_000);
    const bad = await endedRun(30_000_000, "claude-sonnet-5-5", t0);
    await checkEndedRun(db, bad);
    expect(await backInBandReason(db, companyId, cardAt)).toBeNull();
    for (let i = 0; i < BACK_IN_BAND_RUNS; i++) {
      const id = await endedRun(3_000_000, "claude-sonnet-5-5", new Date(cardAt.getTime() + (i + 1) * 60_000));
      await checkEndedRun(db, id);
      // Until the fifth, the bad run is still among the latest five.
      if (i < BACK_IN_BAND_RUNS - 1) expect(await backInBandReason(db, companyId, cardAt)).toBeNull();
    }
    expect(await backInBandReason(db, companyId, cardAt)).toMatch(/in line/);
  });
});

describe("costCheckKey: one alert key per company", () => {
  it("names the company in the key", () => {
    expect(costCheckKey("8a5f1c2e-0000-4000-8000-000000000001")).toBe("cost-out-of-band:8a5f1c2e-0000-4000-8000-000000000001");
  });

  it("keeps the id exactly as given, so two companies never share a key", () => {
    expect(costCheckKey("example-co")).toBe("cost-out-of-band:example-co");
    expect(costCheckKey("")).toBe("cost-out-of-band:");
    expect(costCheckKey("example-co")).not.toBe(costCheckKey("example-co-2"));
  });
});
