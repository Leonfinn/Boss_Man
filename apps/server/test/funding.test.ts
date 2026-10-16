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
