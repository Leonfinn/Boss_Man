import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agents, costEvents, features, fundingSources, runs, tickets } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// BOS-2194: GET /api/companies/:id/spend-report.
let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeApp();
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await t.close();
});

const get = (url: string, headers: Record<string, string> = { cookie }) => t.app.inject({ method: "GET", url, headers });
const post = (url: string, payload: object) => t.app.inject({ method: "POST", url, headers: { cookie }, payload });

async function seed() {
  const co = (await post("/api/companies", { name: "Co" })).json().company.id as string;
  const other = (await post("/api/companies", { name: "Other" })).json().company.id as string;
  const project = (await post(`/api/companies/${co}/projects`, { name: "Site" })).json();
  const [ann, bob] = await t.db.insert(agents).values([{ companyId: co, name: "Ann", role: "worker", agentKind: "claude" }, { companyId: co, name: "Bob", role: "worker", agentKind: "claude" }]).returning();
  const [search, spend] = await t.db.insert(features).values([{ companyId: co, title: "Search" }, { companyId: co, title: "Spend" }]).returning();
  const tk = async (featureId: string | null) => (await t.db.insert(tickets).values({ companyId: co, projectId: project.id, featureId, title: "T" }).returning())[0]!.id;
  const run = async (companyId: string, ticketId: string | null) => (await t.db.insert(runs).values({ companyId, ticketId }).returning())[0]!.id;
  const [api] = await t.db.insert(fundingSources).values({ name: "API", kind: "api_credit", provider: "anthropic" }).returning();
  const cost = (companyId: string, runId: string | null, agentId: string | null, micros: number, daysAgo: number) =>
    t.db.insert(costEvents).values({ companyId, runId, agentId, fundingSourceId: api!.id, costMicros: micros, occurredAt: new Date(Date.now() - daysAgo * 86_400_000) });
  return { co, other, ann: ann!, bob: bob!, search: search!, spend: spend!, tk, run, cost };
}

describe("spend report route", () => {
  it("answers a signed-out request with 401", async () => {
    const s = await seed();
    expect((await get(`/api/companies/${s.co}/spend-report`, {})).statusCode).toBe(401);
  });

  it("refuses an unknown company and a period that isn't 7, 30 or 90", async () => {
    const s = await seed();
    expect((await get("/api/companies/00000000-0000-4000-8000-000000000000/spend-report")).statusCode).toBe(404);
    expect((await get(`/api/companies/${s.co}/spend-report?days=5`)).statusCode).toBe(400);
  });

  it("over 40 days of seeded spend, the 30-day answer has 30 days and the sums match", async () => {
    const s = await seed();
    const rSearch = await s.run(s.co, await s.tk(s.search.id));
    const rSpend = await s.run(s.co, await s.tk(s.spend.id));
    // One $1 event per day for 40 days (Ann on Search), plus $0.50 a day for Bob on Spend for the last 10 days.
    // Noon is never near a day edge in UTC, so the cut doesn't depend on the minute the test runs at.
    for (let i = 0; i < 40; i++) {
      const at = i + 0.5;
      await s.cost(s.co, rSearch, s.ann.id, 1_000_000, at);
      if (i < 10) await s.cost(s.co, rSpend, s.bob.id, 500_000, at);
    }
    const r = (await get(`/api/companies/${s.co}/spend-report?days=30&tz=UTC`)).json();
    expect(r.days).toHaveLength(30);
    const sum = (key: "agent" | "feature") => {
      const out: Record<string, number> = {};
      for (const row of r.rows) out[row[key]] = (out[row[key]] ?? 0) + row.micros;
      return out;
    };
    // 30 local days, each with one Ann event (the event 0.5 days ago is today or yesterday in UTC, never both).
    const dayCount = new Set(r.rows.map((x: { date: string }) => x.date)).size;
    expect(dayCount).toBeGreaterThanOrEqual(29);
    expect(dayCount).toBeLessThanOrEqual(30);
    expect(sum("agent")).toEqual({ Ann: dayCount * 1_000_000, Bob: 5_000_000 });
    expect(sum("feature")).toEqual({ Search: dayCount * 1_000_000, Spend: 5_000_000 });
    expect(r.totalMicros).toBe(dayCount * 1_000_000 + 5_000_000);
    // The 90-day answer holds all 40 days.
    const long = (await get(`/api/companies/${s.co}/spend-report?days=90&tz=UTC`)).json();
    expect(long.days).toHaveLength(90);
    expect(long.totalMicros).toBe(40 * 1_000_000 + 5_000_000);
  });

  it("shows spend with no ticket as No feature, and never another company's spend", async () => {
    const s = await seed();
    await s.cost(s.co, null, null, 250_000, 1);
    await s.cost(s.other, await s.run(s.other, null), null, 9_000_000, 1);
    const r = (await get(`/api/companies/${s.co}/spend-report?days=7`)).json();
    expect(r.rows).toEqual([expect.objectContaining({ feature: "No feature", micros: 250_000 })]);
    expect(r.totalMicros).toBe(250_000);
  });
});
