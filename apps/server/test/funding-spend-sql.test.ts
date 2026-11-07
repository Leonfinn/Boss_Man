import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { signIn, type TestApp } from "./helpers.js";

/**
 * BOS-671: the funding status page (and the run.quota handler, which reads the same status) must
 * total cost events in SQL, not fetch every row and add it up in JS. At 50k rows the old
 * `select occurred_at, cost_micros from cost_events where funding_source_id = $1` took ~330 ms and
 * blocked the event loop.
 *
 * These tests open the app with `logQuery` and read the statements: the row-fetch is gone, and a
 * `sum(...)` over the source runs instead. On the old code the row-fetch appears, so this fails there.
 */
let t: TestApp;
let cookie: string;
let queries: string[];

beforeEach(async () => {
  queries = [];
  const { db, close } = await openPglite(undefined, { logQuery: (sql) => queries.push(sql) });
  const master = { version: 1, key: randomBytes(32) };
  const built = await buildApp({ db, master, secureCookies: false });
  t = { ...built, db, master, close: async () => (await built.app.close(), await close()) };
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await t.close();
});

const post = (url: string, payload: unknown) => t.app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
const get = (url: string) => t.app.inject({ method: "GET", url, headers: { cookie } });

/** Did any statement fetch the per-row spend columns out of cost_events into JS? */
const fetchedCostRows = () =>
  queries.some((q) => /select\s+"cost_events"\."occurred_at",\s*"cost_events"\."cost_micros"\s+from\s+"cost_events"/i.test(q) && /"funding_source_id"\s*=\s*\$1/i.test(q));
/** Did any statement sum cost_micros in the database? */
const summedCostMicros = () => queries.some((q) => /sum\("cost_events"\."cost_micros"\)/i.test(q));

describe("funding status totals spend in SQL (BOS-671)", () => {
  it("does not read every cost event into JS to add up this cycle's credit", async () => {
    const co = (await post("/api/companies", { name: "Co" })).json().company.id;
    const credit = (await post("/api/funding-sources", { name: "Claude API credit", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: new Date(Date.now() - 3 * 86_400_000).toISOString() })).json();
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: co, costUsd: 80 });
    queries.length = 0;

    const status = (await get(`/api/funding-sources/${credit.id}/status`)).json();
    expect(status.credit.spentMicros).toBe(80_000_000);
    expect(summedCostMicros()).toBe(true);
    expect(fetchedCostRows()).toBe(false);
  });

  it("does not read every cost event into JS to add up a budget's window", async () => {
    const co = (await post("/api/companies", { name: "Co" })).json().company.id;
    const credit = (await post("/api/funding-sources", { name: "C", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: new Date(Date.now() - 3 * 86_400_000).toISOString() })).json();
    await post("/api/budget-policies", { scopeKind: "company", scopeId: co, fundingSourceId: credit.id, windowKind: "billing_cycle", limitUsd: 60, onLimit: "ask" });
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: co, costUsd: 50 });
    queries.length = 0;

    const budgets = (await get("/api/budgets")).json() as Array<{ status: { usedMicros: number } }>;
    expect(budgets[0]!.status.usedMicros).toBe(50_000_000);
    expect(summedCostMicros()).toBe(true);
    expect(fetchedCostRows()).toBe(false);
  });
});
