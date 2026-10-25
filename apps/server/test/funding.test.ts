import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function company(name: string): Promise<string> {
  return (await post("/api/companies", { name })).json().company.id;
}

describe("API credit tracking from Boss Man's own runs (spike S3 fallback)", () => {
  it("reports the remaining monthly credit for the current cycle", async () => {
    const appCo = await company("App Co");
    // The cycle anchor is any past reset; the status uses the cycle containing today.
    const cycleStart = new Date(Date.now() - 3 * 86_400_000);
    const credit = (await post("/api/funding-sources", { name: "Claude API credit", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: cycleStart.toISOString() })).json();

    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: appCo, costUsd: 80, occurredAt: new Date(Date.now() - 86_400_000).toISOString() });
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: appCo, costUsd: 2.4 });
    // Before this cycle started: not counted.
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: appCo, costUsd: 50, occurredAt: new Date(cycleStart.getTime() - 3_600_000).toISOString() });

    const status = (await get(`/api/funding-sources/${credit.id}/status`)).json();
    expect(status.credit.spentMicros).toBe(82_400_000);
    expect(status.credit.remainingMicros).toBe(117_600_000);
    expect(status.coverage).toBe("boss_man_runs_only");
  });

  it("splits the last 7 days by company, biggest first", async () => {
    const appCo = await company("App Co");
    const holiday = await company("HolidayHours");
    const payg = (await post("/api/funding-sources", { name: "Ollama", kind: "api_payg", provider: "ollama" })).json();
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: appCo, costUsd: 0.5 });
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: holiday, costUsd: 1.8 });
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: holiday, costUsd: 9, occurredAt: new Date(Date.now() - 9 * 86_400_000).toISOString() });
    const status = (await get(`/api/funding-sources/${payg.id}/status`)).json();
    expect(status.byCompany).toEqual([
      { companyId: holiday, name: "HolidayHours", runs: 0, tokens: 0, costMicros: 1_800_000 },
      { companyId: appCo, name: "App Co", runs: 0, tokens: 0, costMicros: 500_000 },
    ]);
  });
});

describe("subscription quota from the Claude adapter", () => {
  it("stores the newest sample per window", async () => {
    const sub = (await post("/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json();
    const meta = (week: number) => ({
      "_claude/rateLimit": {
        status: week >= 1 ? "rejected" : "allowed",
        rateLimitType: "seven_day",
        overageInUse: week >= 1,
        unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792177800 }, seven_day: { utilization: week, resetsAt: 1792245600 } },
      },
    });
    await post("/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: meta(0.97) });
    await new Promise((r) => setTimeout(r, 5));
    await post("/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: meta(1) });

    const status = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    const week = status.quota.find((q: { window: string }) => q.window === "seven_day");
    expect(status.quota).toHaveLength(2);
    expect(week).toMatchObject({ utilization: 1, status: "rejected", overageInUse: true });
  });
});

describe("budgets", () => {
  it("warns, asks and pauses, and charges engagement work to the requester (R26)", async () => {
    const appCo = await company("App Co");
    const homelab = await company("Homelab Co");
    const credit = (await post("/api/funding-sources", { name: "Claude API credit", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: new Date(Date.now() - 86_400_000).toISOString() })).json();

    await post("/api/budget-policies", { scopeKind: "company", scopeId: appCo, fundingSourceId: credit.id, windowKind: "billing_cycle", limitUsd: 60, onLimit: "ask" });
    await post("/api/budget-policies", { scopeKind: "company", scopeId: homelab, windowKind: "lifetime", limitUsd: 5, onLimit: "pause" });

    // App Co's own work.
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: appCo, costUsd: 50 });
    // Homelab Co deploys for App Co under an engagement: charged back to App Co.
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: homelab, chargedCompanyId: appCo, costUsd: 5.2 });
    // Homelab Co's own work.
    await post("/api/cost-events", { fundingSourceId: credit.id, companyId: homelab, costUsd: 6 });

    const budgets = (await get("/api/budgets")).json() as Array<{ policy: { scopeId: string }; status: { usedMicros: number; state: string; action: string | null } }>;
    const app = budgets.find((b) => b.policy.scopeId === appCo)!;
    const lab = budgets.find((b) => b.policy.scopeId === homelab)!;
    expect(app.status).toMatchObject({ usedMicros: 55_200_000, state: "warning", action: null });
    expect(lab.status).toMatchObject({ usedMicros: 6_000_000, state: "exceeded", action: "pause" });
  });
});

describe("funding source provider and kind", () => {
  it("accepts API kinds for Bedrock, Foundry and gateways, and refuses a subscription on them", async () => {
    const ok = await post("/api/funding-sources", { name: "Bedrock", kind: "api_payg", provider: "bedrock" });
    expect(ok.statusCode).toBe(201);
    expect((await post("/api/funding-sources", { name: "Sub on Bedrock", kind: "subscription", provider: "bedrock" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post("/api/funding-sources", { name: "Max", kind: "subscription", provider: "openai" })).statusCode).toBe(201);
  });

  it("accepts OpenRouter credits and an Ollama Cloud plan, and refuses an OpenRouter subscription", async () => {
    expect((await post("/api/funding-sources", { name: "OpenRouter", kind: "api_payg", provider: "openrouter" })).statusCode).toBe(201);
    expect((await post("/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).statusCode).toBe(201);
    expect((await post("/api/funding-sources", { name: "Sub on OpenRouter", kind: "subscription", provider: "openrouter" })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("editing and deleting funding sources", () => {
  const send = (method: "PATCH" | "DELETE", url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
  const source = async (name = "Router", provider = "openai") => (await post("/api/funding-sources", { name, kind: "api_payg", provider })).json();
  const missing = "00000000-0000-4000-8000-000000000000";

  it("changes the provider, checks the kind/provider pair on the merged values, and rejects bad names", async () => {
    const s = await source();
    const ok = await send("PATCH", `/api/funding-sources/${s.id}`, { provider: "openrouter" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: s.id, name: "Router", kind: "api_payg", provider: "openrouter" });

    // Only the kind is sent, but the stored openrouter provider doesn't fit a subscription.
    expect((await send("PATCH", `/api/funding-sources/${s.id}`, { kind: "subscription" })).statusCode).toBe(400);
    expect((await get("/api/funding-sources")).json()[0]).toMatchObject({ kind: "api_payg", provider: "openrouter" });

    await source("Other");
    const dup = await send("PATCH", `/api/funding-sources/${s.id}`, { name: "Other" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toBe("There's already a funding source called Other.");
    expect((await send("PATCH", `/api/funding-sources/${missing}`, { name: "x" })).statusCode).toBe(404);
  });

  it("refuses to delete a source with spend, keeping its history", async () => {
    const s = await source();
    await post("/api/cost-events", { fundingSourceId: s.id, companyId: await company("Co"), costUsd: 3 });
    const res = await send("DELETE", `/api/funding-sources/${s.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Edit it instead/);
    expect((await get(`/api/funding-sources/${s.id}/status`)).json().totalSpentMicros).toBe(3_000_000);
  });

  it("deletes a source with no history and unlinks its agents", async () => {
    const s = await source();
    const co = await company("Co");
    const agent = (await post(`/api/companies/${co}/agents`, { name: "Engineer" })).json();
    await t.app.inject({ method: "PATCH", url: `/api/agents/${agent.id}`, headers: { cookie }, payload: { fundingSourceId: s.id } });
    const res = await send("DELETE", `/api/funding-sources/${s.id}`);
    expect(res.json()).toEqual({ agentsUnlinked: 1 });
    expect((await get("/api/funding-sources")).json()).toEqual([]);
    const agents = (await get(`/api/companies/${co}/agents`)).json();
    expect(JSON.stringify(agents)).toContain("Engineer");
    expect(JSON.stringify(agents)).not.toContain(s.id);
    expect((await send("DELETE", `/api/funding-sources/${s.id}`)).statusCode).toBe(404);
  });
});
