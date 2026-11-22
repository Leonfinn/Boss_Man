import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costEvents, runs } from "../src/db/schema.js";
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

const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("project page: star and spend", () => {
  it("stars a project and lists it on the company payload", async () => {
    const co = (await req("POST", "/api/companies", { name: "Co" })).json().company.id;
    const p = (await req("POST", `/api/companies/${co}/projects`, { name: "Site" })).json();
    expect(p.starred).toBe(false);
    expect((await req("PATCH", `/api/projects/${p.id}`, { starred: true })).json().starred).toBe(true);
    const c = (await req("GET", "/api/companies")).json().find((x: { id: string }) => x.id === co);
    expect(c.projects).toEqual([{ id: p.id, companyId: co, name: "Site", starred: true }]);
  });

  it("sums a project's money spend, this month and all time, and ranks tickets", async () => {
    const co = (await req("POST", "/api/companies", { name: "Co" })).json();
    const p = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Site" })).json();
    const other = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Other" })).json();
    await req("PATCH", `/api/projects/${p.id}`, { ticketCostCapUsd: 5, monthlyCapUsd: 20 });
    const big = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Big" })).json();
    const small = (await req("POST", `/api/projects/${p.id}/tickets`, { title: "Small" })).json();
    const elsewhere = (await req("POST", `/api/projects/${other.id}/tickets`, { title: "Else" })).json();
    const api = (await req("POST", "/api/funding-sources", { name: "API", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 100, cycleAnchor: new Date().toISOString() })).json();
    const sub = (await req("POST", "/api/funding-sources", { name: "Sub", kind: "subscription", provider: "anthropic" })).json();
    const run = async (ticketId: string) => (await t.db.insert(runs).values({ companyId: co.company.id, ticketId }).returning())[0]!.id;
    const cost = (runId: string, fundingSourceId: string, costMicros: number, occurredAt = new Date()) => t.db.insert(costEvents).values({ runId, fundingSourceId, companyId: co.company.id, costMicros, occurredAt });
    const longAgo = new Date(Date.now() - 100 * 86_400_000);
    const rBig = await run(big.id);
    await cost(rBig, api.id, 3_000_000);
    await cost(rBig, api.id, 1_000_000, longAgo);
    await cost(await run(small.id), api.id, 500_000);
    await cost(rBig, sub.id, 9_000_000); // subscription is not money
    await cost(await run(elsewhere.id), api.id, 7_000_000); // another project

    const s = (await req("GET", `/api/projects/${p.id}/spend`)).json();
    expect(s.monthMicros).toBe(3_500_000);
    expect(s.totalMicros).toBe(4_500_000);
    expect(s.ticketCostCapMicros).toBe(5_000_000);
    expect(s.monthlyCapMicros).toBe(20_000_000);
    expect(s.topTickets).toEqual([
      { id: big.id, title: "Big", micros: 4_000_000, planMicros: 9_000_000 },
      { id: small.id, title: "Small", micros: 500_000, planMicros: 0 },
    ]);
    // Plan use: runs started on a subscription source, and the estimate of its cost events. A provider whose tool reported no price shows runs with no estimate.
    const synth = (await req("POST", "/api/funding-sources", { name: "Synth", kind: "subscription", provider: "synthetic" })).json();
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: big.id, fundingSourceId: sub.id });
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: big.id, fundingSourceId: synth.id });
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: small.id, fundingSourceId: synth.id, startedAt: longAgo });
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: elsewhere.id, fundingSourceId: synth.id });
    expect((await req("GET", `/api/projects/${p.id}/spend`)).json().plan).toEqual([
      { provider: "synthetic", monthRuns: 1, totalRuns: 2, monthMicros: 0, totalMicros: 0 },
      { provider: "anthropic", monthRuns: 1, totalRuns: 1, monthMicros: 9_000_000, totalMicros: 9_000_000 },
    ]);
    expect((await req("GET", `/api/projects/${crypto.randomUUID()}/spend`)).statusCode).toBe(404);

    // Tokens count every run on the project's tasks, subscription ones included; other projects' runs don't.
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: big.id, inputTokens: 1000, outputTokens: 200, cachedReadTokens: 7000, cachedWriteTokens: 300 });
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: small.id, inputTokens: 50, outputTokens: 5, cachedReadTokens: 20, cachedWriteTokens: 2, startedAt: longAgo });
    await t.db.insert(runs).values({ companyId: co.company.id, ticketId: elsewhere.id, inputTokens: 9999, outputTokens: 9999, cachedReadTokens: 9999, cachedWriteTokens: 9999 });
    const withTokens = (await req("GET", `/api/projects/${p.id}/spend`)).json();
    expect(withTokens.tokens).toEqual({
      month: { input: 1000, output: 200, cacheRead: 7000, cacheWrite: 300 },
      total: { input: 1050, output: 205, cacheRead: 7020, cacheWrite: 302 },
    });
  });

  // The project routes live in routes/projects.ts (BOS-909) but must stay inside the owner scope.
  it("refuses the project and setup routes without the owner's session", async () => {
    const co = (await req("POST", "/api/companies", { name: "Co" })).json().company.id;
    const p = (await req("POST", `/api/companies/${co}/projects`, { name: "Site" })).json();
    const anon = (method: "GET" | "POST" | "PATCH", url: string) => t.app.inject({ method, url, ...(method === "GET" ? {} : { payload: {} }) });
    expect((await anon("PATCH", `/api/projects/${p.id}`)).statusCode).toBe(401);
    expect((await anon("GET", `/api/projects/${p.id}/spend`)).statusCode).toBe(401);
    expect((await anon("GET", `/api/companies/${co}/projects`)).statusCode).toBe(401);
    expect((await anon("GET", "/api/setup-progress")).statusCode).toBe(401);
    expect((await anon("GET", `/api/projects/${p.id}/brief`)).statusCode).toBe(401);
  });
});
