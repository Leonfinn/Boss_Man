import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { windowHasReset } from "@boss-man/shared";
import { engagements, quotaSamples } from "../src/db/schema.js";
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

  it("says who used a source in the last 7 days, with shares, and nothing for an unused one", async () => {
    const appCo = await company("App Co");
    const payg = (await post("/api/funding-sources", { name: "Ollama", kind: "api_payg", provider: "ollama" })).json();
    const idle = (await post("/api/funding-sources", { name: "Idle", kind: "api_payg", provider: "ollama" })).json();
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: appCo, costUsd: 3, inputTokens: 600, outputTokens: 200 });
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: appCo, costUsd: 1, inputTokens: 100, outputTokens: 100 });
    await post("/api/cost-events", { fundingSourceId: payg.id, companyId: appCo, costUsd: 50, inputTokens: 5000, occurredAt: new Date(Date.now() - 9 * 86_400_000).toISOString() });
    const who = (await get(`/api/funding-sources/${payg.id}/status`)).json().whoUsedIt;
    expect(who.totalMicros).toBe(4_000_000);
    expect(who.totalTokens).toBe(1000);
    expect(who.agents).toHaveLength(1);
    expect(who.agents[0]).toMatchObject({ tokens: 1000, costMicros: 4_000_000, share: 1 });
    expect(who.projects[0]).toMatchObject({ name: "No project", company: "App Co", share: 1 });
    const none = (await get(`/api/funding-sources/${idle.id}/status`)).json().whoUsedIt;
    expect(none).toMatchObject({ totalTokens: 0, totalMicros: 0, agents: [], projects: [] });
  });

  it("lists the top 5 of 7 agents, sums the rest as everyone else, drops older events and counts engagement work under the charged company and project", async () => {
    const appCo = await company("App Co");
    const provider = await company("Provider Co");
    const project = (await post(`/api/companies/${appCo}/projects`, { name: "Customer app" })).json().id as string;
    const providerProject = (await post(`/api/companies/${provider}/projects`, { name: "Provider work" })).json().id as string;
    const src = (await post("/api/funding-sources", { name: "Plan", kind: "subscription", provider: "anthropic" })).json();
    const agentIds: string[] = [];
    for (let i = 1; i <= 7; i++) agentIds.push((await post(`/api/companies/${provider}/agents`, { name: `Agent ${i}` })).json().id);
    const [eng] = await t.db.insert(engagements).values({ requesterCompanyId: appCo, requesterProjectId: project, providerCompanyId: provider, title: "Help", scope: "Help" }).returning();
    // Agent i uses i * 100 tokens, no money: a plan-only source. Agent 7's work is an engagement charged to App Co.
    for (let i = 1; i <= 7; i++) {
      await post("/api/cost-events", {
        fundingSourceId: src.id,
        companyId: provider,
        projectId: providerProject,
        agentId: agentIds[i - 1],
        costUsd: 0,
        inputTokens: i * 100,
        ...(i === 7 ? { engagementId: eng!.id, chargedCompanyId: appCo, chargedProjectId: project } : {}),
      });
    }
    await post("/api/cost-events", { fundingSourceId: src.id, companyId: provider, agentId: agentIds[0], costUsd: 0, inputTokens: 9999, occurredAt: new Date(Date.now() - 9 * 86_400_000).toISOString() });
    const who = (await get(`/api/funding-sources/${src.id}/status`)).json().whoUsedIt;
    expect(who.totalTokens).toBe(2800);
    expect(who.totalMicros).toBe(0);
    expect(who.agents.map((a: { name: string }) => a.name)).toEqual(["Agent 7", "Agent 6", "Agent 5", "Agent 4", "Agent 3"]);
    expect(who.agentsOthers).toMatchObject({ count: 2, tokens: 300 });
    const shares = who.agents.reduce((n: number, a: { share: number }) => n + a.share, 0) + who.agentsOthers.share;
    expect(shares).toBeCloseTo(1, 6);
    const charged = who.projects.find((p: { name: string }) => p.name === "Customer app");
    expect(charged).toMatchObject({ company: "App Co", tokens: 700, engagement: true });
    const own = who.projects.find((p: { name: string }) => p.name === "Provider work");
    expect(own).toMatchObject({ company: "Provider Co", tokens: 2100, engagement: false });
  });

  it("uses one basis (spend) for order and share when agents' token and money splits differ, so shares add to 1", async () => {
    const co = await company("App Co");
    const src = (await post("/api/funding-sources", { name: "Key", kind: "api_payg", provider: "anthropic" })).json();
    const a = (await post(`/api/companies/${co}/agents`, { name: "Agent A" })).json().id as string;
    const b = (await post(`/api/companies/${co}/agents`, { name: "Agent B" })).json().id as string;
    // A: 90% of tokens, 10% of spend. B: 10% of tokens, 90% of spend.
    await post("/api/cost-events", { fundingSourceId: src.id, companyId: co, agentId: a, costUsd: 1, inputTokens: 900 });
    await post("/api/cost-events", { fundingSourceId: src.id, companyId: co, agentId: b, costUsd: 9, inputTokens: 100 });
    const who = (await get(`/api/funding-sources/${src.id}/status`)).json().whoUsedIt;
    expect(who.agents.map((r: { name: string }) => r.name)).toEqual(["Agent B", "Agent A"]);
    expect(who.agents[0].share).toBeCloseTo(0.9, 6);
    expect(who.agents[1].share).toBeCloseTo(0.1, 6);
    expect(who.agents.reduce((n: number, r: { share: number }) => n + r.share, 0)).toBeCloseTo(1, 6);
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

  // BOS-1409: the card needs the reading's own time to tell whether it was taken before its reset. The
  // status keeps reporting the stored figure; the shared rule (windowHasReset) reads it as empty.
  it("reports each window's reading time, so a reading from a window that has reset reads as empty", async () => {
    const sub = (await post("/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json();
    // A week whose reset has already passed, with the last reading taken before it: the owner's case
    // after a weekly reset (BOS-1409). The stored figure stays; the shared rule reads it as empty.
    const resets = Math.floor(Date.now() / 1000) - 3600;
    await post("/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day_overage_included: { utilization: 0.33, resetsAt: resets } } } } });
    await t.db.update(quotaSamples).set({ observedAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(quotaSamples.fundingSourceId, sub.id));
    const status = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    const fable = status.quota.find((q: { window: string }) => q.window === "seven_day_overage_included");
    expect(fable.utilization).toBeCloseTo(0.33);
    expect(windowHasReset(new Date(fable.resetsAt), new Date())).toBe(true);
  });

  // BOS-2670: a weekly-limit stop writes one reading of its own; Fable stays on the card and in the hold list.
  it("keeps Fable when Boss Man's own weekly-limit reading follows a real report", async () => {
    const report = { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: 1792245600 }, seven_day_overage_included: { utilization: 0.4, resetsAt: 1792245600 } } } };
    const a = (await post("/api/funding-sources", { name: "Account C", kind: "subscription", provider: "anthropic" })).json();
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report });
    await t.db.update(quotaSamples).set({ observedAt: new Date(Date.now() - 3_600_000) }).where(eq(quotaSamples.fundingSourceId, a.id));
    const at = new Date();
    await t.db.insert(quotaSamples).values({ fundingSourceId: a.id, window: "seven_day", utilization: 1, resetsAt: new Date(at.getTime() + 3_600_000), status: "rejected", overageInUse: false, observedAt: at });
    const s = (await get(`/api/funding-sources/${a.id}/status`)).json();
    expect(s.quota.map((q: { window: string }) => q.window).sort()).toEqual(["seven_day", "seven_day_overage_included"]);
    expect(s.windowsSeen).toEqual(["seven_day", "seven_day_overage_included"]);
    expect(s.quota.find((q: { window: string }) => q.window === "seven_day").utilization).toBe(1);
  });

  // BOS-1916: a limit shows (and can trigger the hold) only while the account's latest report includes it.
  it("lists only the limits the latest report includes, and keeps the owner's switch for one that went away", async () => {
    const report = (windows: Record<string, number>) => ({ "_claude/rateLimit": { unifiedWindows: Object.fromEntries(Object.entries(windows).map(([k, u]) => [k, { utilization: u, resetsAt: 1792245600 }])) } });
    const a = (await post("/api/funding-sources", { name: "Account A", kind: "subscription", provider: "anthropic" })).json();
    const b = (await post("/api/funding-sources", { name: "Account B", kind: "subscription", provider: "anthropic" })).json();
    // A used to report a 5-hour window at 99%, then its latest report left it out; B never reported Fable.
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ five_hour: 0.99, seven_day: 0.2 }) });
    await post("/api/quota-samples", { fundingSourceId: b.id, claudeMeta: report({ five_hour: 0.3, seven_day: 0.2 }) });
    await t.db.update(quotaSamples).set({ observedAt: new Date(Date.now() - 3_600_000) }).where(eq(quotaSamples.fundingSourceId, a.id));
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ seven_day: 0.3, seven_day_overage_included: 0.1 }) });
    await t.app.inject({ method: "PATCH", url: `/api/funding-sources/${a.id}`, headers: { cookie }, payload: { quotaDisabledWindows: ["five_hour"] } });
    const sa = (await get(`/api/funding-sources/${a.id}/status`)).json();
    const sb = (await get(`/api/funding-sources/${b.id}/status`)).json();
    expect(sa.windowsSeen).toEqual(["seven_day", "seven_day_overage_included"]);
    expect(sa.quota.map((q: { window: string }) => q.window).sort()).toEqual(["seven_day", "seven_day_overage_included"]);
    expect(sb.windowsSeen).toEqual(["five_hour", "seven_day"]);
    expect(sb.quota.map((q: { window: string }) => q.window).sort()).toEqual(["five_hour", "seven_day"]);
    // The owner's choice for the 5-hour window is kept while A does not report it.
    expect(sa.source.quotaDisabledWindows).toEqual(["five_hour"]);
    // It comes back by itself when A reports it again.
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ five_hour: 0.1, seven_day: 0.3, seven_day_overage_included: 0.1 }) });
    const again = (await get(`/api/funding-sources/${a.id}/status`)).json();
    expect(again.windowsSeen).toEqual(["five_hour", "seven_day", "seven_day_overage_included"]);
    expect(again.source.quotaDisabledWindows).toEqual(["five_hour"]);
  });

  // BOS-2676: a report that carries only some windows must not hide a limit an earlier real report had, until that limit's own reset.
  it("keeps a limit the latest report left out until its own reset, and drops it after", async () => {
    const future = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const report = (windows: Record<string, number>) => ({ "_claude/rateLimit": { unifiedWindows: Object.fromEntries(Object.entries(windows).map(([k, u]) => [k, { utilization: u, resetsAt: future }])) } });
    const a = (await post("/api/funding-sources", { name: "Account A", kind: "subscription", provider: "anthropic" })).json();
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ seven_day: 0.5, seven_day_overage_included: 0.4 }) });
    await t.db.update(quotaSamples).set({ observedAt: new Date(Date.now() - 3_600_000) }).where(eq(quotaSamples.fundingSourceId, a.id));
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ seven_day: 0.9 }) });
    const kept = (await get(`/api/funding-sources/${a.id}/status`)).json();
    expect(kept.windowsSeen).toEqual(["seven_day", "seven_day_overage_included"]);
    const fable = kept.quota.find((q: { window: string }) => q.window === "seven_day_overage_included");
    expect(fable.utilization).toBeCloseTo(0.4);
    // Once the limit's own reset has passed and no report brought it back, it leaves.
    await t.db.update(quotaSamples).set({ resetsAt: new Date(Date.now() - 1000) }).where(and(eq(quotaSamples.fundingSourceId, a.id), eq(quotaSamples.window, "seven_day_overage_included")));
    const dropped = (await get(`/api/funding-sources/${a.id}/status`)).json();
    expect(dropped.windowsSeen).toEqual(["seven_day"]);
  });

  // BOS-2676: a read-only readout of the newest stored reports per Claude account, for server_status.
  it("reads out each Claude account's newest reports and flags a row Boss Man wrote itself", async () => {
    const future = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const report = (windows: Record<string, number>) => ({ "_claude/rateLimit": { unifiedWindows: Object.fromEntries(Object.entries(windows).map(([k, u]) => [k, { utilization: u, resetsAt: future }])) } });
    const a = (await post("/api/funding-sources", { name: "Account A", kind: "subscription", provider: "anthropic" })).json();
    await post("/api/funding-sources", { name: "Other", kind: "subscription", provider: "codex" });
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ seven_day: 0.5, seven_day_overage_included: 0.4 }) });
    await t.db.update(quotaSamples).set({ observedAt: new Date(Date.now() - 3_600_000) }).where(eq(quotaSamples.fundingSourceId, a.id));
    await post("/api/quota-samples", { fundingSourceId: a.id, claudeMeta: report({ seven_day: 0.9 }) });
    const written = new Date();
    await t.db.insert(quotaSamples).values({ fundingSourceId: a.id, window: "seven_day", utilization: 1, status: "rejected", resetsAt: new Date(written.getTime() + 3_600_000), observedAt: written });
    const out = await t.funding.claudeQuotaReports();
    expect(out.map((s) => s.name)).toEqual(["Account A"]);
    const reports = out[0]!.reports;
    expect(reports).toHaveLength(3);
    expect(reports[0]!.windows).toEqual([expect.objectContaining({ window: "seven_day", bossManWritten: true })]);
    expect(reports[1]!.windows.map((w) => [w.window, w.bossManWritten])).toEqual([["seven_day", false]]);
    expect(reports[2]!.windows.map((w) => w.window)).toEqual(["seven_day", "seven_day_overage_included"]);
  });

  it("keeps the hold threshold, extra-usage choice and window switches per source", async () => {
    const sub = (await post("/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json();
    await post("/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: 1792245600 }, five_hour: { utilization: 0.2, resetsAt: 1792177800 } } } } });
    const before = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    expect(before.source).toMatchObject({ quotaHoldAt: 0.95, quotaOverage: "pause", quotaDisabledWindows: [] });
    expect(before.windowsSeen).toEqual(["five_hour", "seven_day"]);

    const patch = (payload: unknown) => t.app.inject({ method: "PATCH", url: `/api/funding-sources/${sub.id}`, headers: { cookie }, payload: payload as object });
    await patch({ quotaHoldAt: 0.85, quotaOverage: "all", quotaDisabledWindows: ["five_hour"] });
    const after = (await get(`/api/funding-sources/${sub.id}/status`)).json();
    expect(after.source).toMatchObject({ quotaHoldAt: 0.85, quotaOverage: "all", quotaDisabledWindows: ["five_hour"] });
    // Out of range is refused.
    expect((await patch({ quotaHoldAt: 1.2 })).statusCode).toBeGreaterThanOrEqual(400);
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

  it("accepts the Synthetic standard plan as a subscription", async () => {
    expect((await post("/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic" })).statusCode).toBe(201);
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
