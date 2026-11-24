import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { fundingQuotaHolds, quotaSamples } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeApp();
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await t.close();
});

const post = (url: string, payload: unknown) => t.app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const DAY = 86_400_000;

describe("the migration's backfill from readings on hand", () => {
  it("fills the fold straight away from 20 days of raw readings, one row per window and reset", async () => {
    const sub = (await post("/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json();
    const now = Date.now();
    const reset = new Date(Math.round((now - 5 * DAY) / 3_600_000) * 3_600_000);
    // Raw readings only, no summary rows: as on a database from before the migration.
    await t.db.insert(quotaSamples).values([
      { fundingSourceId: sub.id, window: "seven_day", utilization: 0.3, resetsAt: new Date(reset.getTime() + 1000), observedAt: new Date(now - 18 * DAY) },
      { fundingSourceId: sub.id, window: "seven_day", utilization: 0.8, resetsAt: new Date(reset.getTime() - 1000), observedAt: new Date(now - 6 * DAY) },
      { fundingSourceId: sub.id, window: "synthetic_weekly", utilization: 0.9, resetsAt: new Date(now - 2 * DAY), observedAt: new Date(now - 2 * DAY) },
    ]);
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
    const file = readdirSync(dir).find((f) => f.endsWith("_funding_history.sql"))!;
    const insert = readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint").find((s) => s.includes('INSERT INTO "funding_window_summaries"'))!;
    await t.db.execute(sql.raw(insert));
    const { weeks } = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    expect(weeks.flatMap((w: { plans: unknown[] }) => w.plans)).toEqual([{ window: "seven_day", resets: 1, peak: expect.closeTo(0.8, 2), limit: null }]);
  });
});

describe("funding status: the last 8 weeks", () => {
  it("keeps the peak per window and reset, the spend per week and the holds, and leaves out what is older than 8 weeks or not yet reset", async () => {
    const sub = (await post("/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json();
    const co = (await post("/api/companies", { name: "Co" })).json().company.id;
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY);
    const report = (window: string, utilization: number, resetsAt: Date) =>
      post("/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { [window]: { utilization, resetsAt: Math.floor(resetsAt.getTime() / 1000) } } } } });

    // Two reports in one window, the reset time a second apart: one window, the higher use kept.
    await report("five_hour", 0.4, ago(2));
    await report("five_hour", 0.92, new Date(ago(2).getTime() + 1000));
    await report("five_hour", 0.5, ago(3));
    // A reset still to come is not a reset yet; one 70 days back is out of the 8 weeks.
    await report("five_hour", 0.99, new Date(now + DAY));
    await report("five_hour", 0.99, ago(70));

    await post("/api/cost-events", { fundingSourceId: sub.id, companyId: co, costUsd: 4, occurredAt: ago(1).toISOString() });
    await post("/api/cost-events", { fundingSourceId: sub.id, companyId: co, costUsd: 3, occurredAt: ago(9).toISOString() });
    await t.db.insert(fundingQuotaHolds).values({ fundingSourceId: sub.id, window: "five_hour", startedAt: ago(1), endedAt: new Date(ago(1).getTime() + 90 * 60_000) });

    const { weeks } = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    expect(weeks).toHaveLength(8);
    expect(weeks[0].plans).toEqual([{ window: "five_hour", resets: 2, peak: expect.closeTo(0.92, 2), limit: null }]);
    expect(weeks[0].spendMicros).toBe(4_000_000);
    expect(weeks[0].holds).toHaveLength(1);
    expect(weeks[0].holds[0].ms).toBe(90 * 60_000);
    expect(weeks[1].spendMicros).toBe(3_000_000);
    expect(weeks.flatMap((w: { plans: unknown[] }) => w.plans)).toHaveLength(1);
  });
});
