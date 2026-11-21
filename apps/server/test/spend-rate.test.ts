// BOS-2173: a day's spend over 3 times the usual daily rate (and over $5) raises one owner alert a day.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { agents, companies, costEvents, fundingSources, projects, runs, tickets } from "../src/db/schema.js";
import { kindCeiling } from "../src/services/alert-kinds.js";
import { spendRateSweep } from "../src/services/spend-rate.js";

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let sourceId: string;
let agentId: string;
let runId: string;

const NOW = new Date("2026-11-21T15:00:00Z");
const daysAgo = (n: number) => new Date(Date.UTC(2026, 10, 21 - n, 10, 0, 0));

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const [c] = await db.insert(companies).values({ name: "Co", ticketPrefix: "CO" }).returning();
  companyId = c!.id;
  const [p] = await db.insert(projects).values({ companyId, name: "App" }).returning();
  const [s] = await db.insert(fundingSources).values({ name: "Src", kind: "api_payg", provider: "anthropic" }).returning();
  sourceId = s!.id;
  const [a] = await db.insert(agents).values({ companyId, name: "Ivy", role: "worker", agentKind: "claude" }).returning();
  agentId = a!.id;
  const [t] = await db.insert(tickets).values({ companyId, projectId: p!.id, title: "Loopy work", systemState: "in_progress" }).returning();
  const [r] = await db.insert(runs).values({ companyId, agentId, ticketId: t!.id }).returning();
  runId = r!.id;
});
afterEach(async () => {
  await close();
});

const spend = (dollars: number, at: Date) => db.insert(costEvents).values({ fundingSourceId: sourceId, companyId, agentId, runId, costMicros: dollars * 1_000_000, occurredAt: at });
const history = async (perDay: number, days: number) => {
  for (let d = 1; d <= days; d++) await spend(perDay, daysAgo(d));
};
function sweep(now: Date, raised: Array<Record<string, unknown>>) {
  return spendRateSweep(db, { alert: async (i) => void raised.push(i), now: () => now });
}

describe("spend rate alert", () => {
  it("raises one owner alert naming the top agent and ticket, and not a second one that day", async () => {
    await history(10, 7);
    await spend(50, daysAgo(0));
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(NOW, raised).run()).raised).toBe(1);
    expect(raised[0]).toMatchObject({ companyId, kind: "spend_rate", from: "owner" });
    const q = String(raised[0]!.question);
    expect(q).toContain("$50.00");
    expect(q).toContain("about 5 times the usual $10.00 a day");
    expect(q).toContain("Ivy");
    expect(q).toContain('CO-');
    expect(q).toContain("Loopy work");
    expect((await sweep(new Date("2026-11-21T16:00:00Z"), raised).run()).raised).toBe(0);
    // The next day it may alert again.
    await spend(80, new Date("2026-11-22T09:00:00Z"));
    expect((await sweep(new Date("2026-11-22T15:00:00Z"), raised).run()).raised).toBe(1);
  });

  it("stays quiet at 3 times or less, or under the $5 floor", async () => {
    await history(10, 7);
    await spend(30, daysAgo(0)); // exactly 3x
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(NOW, raised).run()).raised).toBe(0);
  });

  it("stays quiet under the floor even when many times the usual", async () => {
    await history(0.5, 7);
    await spend(4, daysAgo(0));
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(NOW, raised).run()).raised).toBe(0);
  });

  it("raises nothing with fewer than 3 days of history", async () => {
    await history(1, 2);
    await spend(100, daysAgo(0));
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(NOW, raised).run()).raised).toBe(0);
  });

  it("uses the days there are when history is 3 to 6 days", async () => {
    await history(10, 3);
    await spend(50, daysAgo(0));
    const raised: Array<Record<string, unknown>> = [];
    expect((await sweep(NOW, raised).run()).raised).toBe(1);
    expect(String(raised[0]!.question)).toContain("usual $10.00 a day");
  });

  it("a failed raise is tried again, and the alert may reach the owner", async () => {
    await history(10, 7);
    await spend(50, daysAgo(0));
    let fail = true;
    const raised: Array<Record<string, unknown>> = [];
    const s = spendRateSweep(db, { alert: async (i) => { if (fail) throw new Error("down"); raised.push(i); }, now: () => NOW });
    await expect(s.run()).rejects.toThrow("down");
    fail = false;
    expect((await s.run()).raised).toBe(1);
    expect(kindCeiling("spend_rate", "owner")).toBeDefined();
  });
});
