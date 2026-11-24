import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, costEvents, features, fundingSources, projects, runs, tickets } from "../src/db/schema.js";
import { spendReport, validZone } from "../src/services/spend-report.js";

let ctx: Awaited<ReturnType<typeof openPglite>> | undefined;
beforeEach(async () => {
  ctx = await openPglite();
});
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});
const db = () => ctx!.db;

const NOW = new Date("2026-11-21T12:00:00Z");

async function setup() {
  const [company] = await db().insert(companies).values({ name: "Spend Co" }).returning();
  const [elsewhere] = await db().insert(companies).values({ name: "Other Co" }).returning();
  const [project] = await db().insert(projects).values({ companyId: company!.id, name: "Site" }).returning();
  const [feature] = await db().insert(features).values({ companyId: company!.id, title: "Search box" }).returning();
  const [ticket] = await db().insert(tickets).values({ companyId: company!.id, projectId: project!.id, featureId: feature!.id, title: "Work" }).returning();
  const [agent] = await db().insert(agents).values({ companyId: company!.id, name: "Bungle", role: "worker", agentKind: "claude" }).returning();
  const [api] = await db().insert(fundingSources).values({ name: "API", kind: "api_credit", provider: "anthropic" }).returning();
  const [sub] = await db().insert(fundingSources).values({ name: "Sub", kind: "subscription", provider: "synthetic" }).returning();
  const [run] = await db().insert(runs).values({ companyId: company!.id, ticketId: ticket!.id }).returning();
  const cost = (fundingSourceId: string, costMicros: number, occurredAt: string, extra: { runId?: string | null; agentId?: string | null; companyId?: string } = {}) =>
    db().insert(costEvents).values({ runId: run!.id, agentId: agent!.id, companyId: company!.id, fundingSourceId, costMicros, occurredAt: new Date(occurredAt), ...extra });
  return { company: company!, project: project!, elsewhere: elsewhere!, api: api!, sub: sub!, cost };
}

describe("spendReport", () => {
  it("groups real spend by local day, agent, feature and project, and leaves out subscriptions and other companies", async () => {
    const s = await setup();
    await s.cost(s.api.id, 1_500_000, "2026-11-20T10:00:00Z");
    await s.cost(s.api.id, 500_000, "2026-11-20T11:00:00Z");
    await s.cost(s.sub.id, 9_000_000, "2026-11-20T11:00:00Z");
    await s.cost(s.api.id, 7_000_000, "2026-11-20T11:00:00Z", { companyId: s.elsewhere.id });
    const r = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(r.days).toHaveLength(7);
    expect(r.days.at(-1)).toBe("2026-11-21");
    expect(r.rows).toEqual([{ date: "2026-11-20", agentId: expect.any(String), agent: "Bungle", featureId: expect.any(String), feature: "Search box", projectId: expect.any(String), project: "Site", tickets: 1, micros: 2_000_000 }]);
    expect(r.totalMicros).toBe(2_000_000);
  });

  it("shows spend with no ticket as No feature, and keeps it in the total", async () => {
    const s = await setup();
    await s.cost(s.api.id, 250_000, "2026-11-21T08:00:00Z", { runId: null, agentId: null });
    const r = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(r.rows).toEqual([expect.objectContaining({ agent: "No agent", feature: "No feature", project: "No project", tickets: 0, micros: 250_000 })]);
  });

  it("uses the owner's time zone for the day, and drops events before the first day", async () => {
    const s = await setup();
    // 23:30 UTC on the 20th is already the 21st in Auckland (UTC+13 in November).
    await s.cost(s.api.id, 100_000, "2026-11-20T23:30:00Z");
    await s.cost(s.api.id, 100_000, "2026-10-01T00:00:00Z");
    const utc = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(utc.rows.map((r) => r.date)).toEqual(["2026-11-20"]);
    const nz = await spendReport(db(), s.company.id, { days: 7, timeZone: "Pacific/Auckland", now: NOW });
    expect(nz.rows.map((r) => r.date)).toEqual(["2026-11-21"]);
    expect(nz.days.at(-1)).toBe("2026-11-22");
    expect(nz.totalMicros).toBe(100_000);
  });

  it("lists the costliest tickets with ref, state, feature, spend and run count, and the no-ticket spend as one row (BOS-2370)", async () => {
    const s = await setup();
    const [second] = await db().insert(tickets).values({ companyId: s.company.id, projectId: s.project.id, title: "Cheap one" }).returning();
    const [run2] = await db().insert(runs).values({ companyId: s.company.id, ticketId: second!.id }).returning();
    await s.cost(s.api.id, 1_000_000, "2026-11-20T10:00:00Z");
    await s.cost(s.api.id, 2_000_000, "2026-11-20T11:00:00Z");
    await s.cost(s.api.id, 500_000, "2026-11-20T11:00:00Z", { runId: run2!.id });
    await s.cost(s.api.id, 1_200_000, "2026-11-20T12:00:00Z", { runId: null });
    await s.cost(s.api.id, 1_200_000, "2026-11-20T13:00:00Z", { runId: null });
    await s.cost(s.sub.id, 9_000_000, "2026-11-20T11:00:00Z");
    await s.cost(s.api.id, 9_000_000, "2026-09-01T11:00:00Z");
    const r = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(r.topTickets.map((t) => [t.title, t.micros, t.runs])).toEqual([
      ["Work", 3_000_000, 1],
      ["Not on a ticket", 2_400_000, 0],
      ["Cheap one", 500_000, 1],
    ]);
    expect(r.topTickets[0]).toMatchObject({ feature: "Search box", state: "backlog", ref: expect.stringMatching(/-\d+$/) });
    expect(r.topTickets[1]).toMatchObject({ ticketId: null, ref: null });
  });

  it("splits by model: spend, runs, tokens, plan use apart from pay-as-you-go, and a null model as Unknown model (BOS-2401)", async () => {
    const s = await setup();
    const [run2] = await db().insert(runs).values({ companyId: s.company.id }).returning();
    const ev = (fundingSourceId: string, costMicros: number, extra: Record<string, unknown>) =>
      db().insert(costEvents).values({ runId: run2!.id, companyId: s.company.id, fundingSourceId, costMicros, occurredAt: new Date("2026-11-20T10:00:00Z"), ...extra });
    await ev(s.api.id, 1_000_000, { model: "opus", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
    await ev(s.api.id, 500_000, { model: "opus", inputTokens: 1 });
    await ev(s.sub.id, 3_000_000, { model: "opus", outputTokens: 5 });
    await s.cost(s.sub.id, 250_000, "2026-11-21T10:00:00Z");
    await s.cost(s.api.id, 9_000_000, "2026-09-01T10:00:00Z");
    const r = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(r.models).toEqual([
      { date: "", model: "opus", micros: 4_500_000, planMicros: 3_000_000, payMicros: 1_500_000, runs: 1, inputTokens: 11, outputTokens: 25, cacheReadTokens: 30, cacheWriteTokens: 40 },
      expect.objectContaining({ model: "Unknown model", micros: 250_000, planMicros: 250_000, payMicros: 0, runs: 1 }),
    ]);
    expect(r.modelDays.map((m) => [m.date, m.model])).toEqual([["2026-11-20", "opus"], ["2026-11-21", "Unknown model"]]);
    // The other splits still leave plan use out.
    expect(r.totalMicros).toBe(1_500_000);
  });

  it("caps the costliest tickets at 10", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) {
      const [t] = await db().insert(tickets).values({ companyId: s.company.id, projectId: s.project.id, title: `T${i}` }).returning();
      const [rn] = await db().insert(runs).values({ companyId: s.company.id, ticketId: t!.id }).returning();
      await s.cost(s.api.id, 100_000 + i, "2026-11-20T10:00:00Z", { runId: rn!.id });
    }
    const r = await spendReport(db(), s.company.id, { days: 7, timeZone: "UTC", now: NOW });
    expect(r.topTickets).toHaveLength(10);
    expect(r.topTickets[0]!.title).toBe("T11");
  });
});

describe("validZone", () => {
  it("falls back to UTC for a missing or unknown zone", () => {
    expect(validZone(undefined)).toBe("UTC");
    expect(validZone("Not/AZone")).toBe("UTC");
    expect(validZone("Europe/London")).toBe("Europe/London");
  });
});
