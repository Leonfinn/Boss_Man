import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, notifications, quotaSamples, runners, runs } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const sub = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  return { ...built, db, close, req, company, sub };
}

// A reset a few hours off, as Claude reports it (epoch seconds).
const resetIn = (hours: number) => Math.floor(Date.now() / 1000 + hours * 3600);
const meta = (fiveHour: number, reset: number, week = 0.2, weekReset = resetIn(100)) => ({
  "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", overageInUse: false, unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: reset }, seven_day: { utilization: week, resetsAt: weekReset } } },
});

describe("limit estimate and daily use (R78)", () => {
  it("forecasts when a window runs out from its recent readings", async () => {
    const c = (ctx = await setup());
    const reset = resetIn(4);
    const weekReset = resetIn(100);
    // An hour ago: 30% of the 5-hour window, 20% of the week.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await c.db.insert(quotaSamples).values([
      { fundingSourceId: c.sub.id, window: "five_hour", utilization: 0.3, resetsAt: new Date(reset * 1000), observedAt: hourAgo },
      { fundingSourceId: c.sub.id, window: "seven_day", utilization: 0.2, resetsAt: new Date(weekReset * 1000), observedAt: hourAgo },
    ]);
    await c.req("POST", "/api/quota-samples", { fundingSourceId: c.sub.id, claudeMeta: meta(0.6, reset, 0.2, weekReset) });

    const status = (await c.req("GET", `/api/funding-sources/${c.sub.id}/status`)).json();
    const five = status.forecasts.five_hour;
    expect(five.perHour).toBeCloseTo(0.3, 1);
    expect(five.beforeReset).toBe(true);
    // 40% left at 30% an hour: about 80 minutes from now, well before the reset in 4 hours.
    const minutes = (new Date(five.runsOutAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(70);
    expect(minutes).toBeLessThan(90);
    expect(status.forecasts.seven_day).toMatchObject({ perHour: 0, runsOutAt: null, beforeReset: false });
  });

  it("adds up a week of runs and spend per day", async () => {
    const c = (ctx = await setup());
    const agent = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.sub.id })).json() as { id: string };
    const credit = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 100, cycleAnchor: new Date(Date.now() - 86_400_000).toISOString() })).json() as { id: string };
    const other = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Writer", fundingSourceId: credit.id })).json() as { id: string };
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    await c.db.insert(runs).values([
      { companyId: c.company.id, agentId: agent.id, startedAt: now, inputTokens: 1000, outputTokens: 200 },
      { companyId: c.company.id, agentId: agent.id, startedAt: yesterday, inputTokens: 500, outputTokens: 50 },
      // Another source's run: not counted here.
      { companyId: c.company.id, agentId: other.id, startedAt: now, inputTokens: 9999, outputTokens: 9999 },
      // Too old for the week.
      { companyId: c.company.id, agentId: agent.id, startedAt: new Date(now.getTime() - 9 * 86_400_000), inputTokens: 7, outputTokens: 7 },
    ]);
    const [paid] = await c.db.insert(runs).values({ companyId: c.company.id, agentId: other.id, startedAt: now, inputTokens: 10, outputTokens: 5 }).returning();
    await c.db.insert(costEvents).values({ fundingSourceId: credit.id, companyId: c.company.id, runId: paid!.id, costMicros: 1_500_000, occurredAt: now });

    const daily = (await c.req("GET", `/api/funding-sources/${c.sub.id}/status?tz=UTC`)).json().daily as Array<{ day: string; runs: number; inputTokens: number; outputTokens: number }>;
    expect(daily).toHaveLength(7);
    expect(daily.at(-1)!.day).toBe(now.toISOString().slice(0, 10));
    expect(daily.at(-1)).toMatchObject({ runs: 1, inputTokens: 1000, outputTokens: 200 });
    expect(daily.at(-2)).toMatchObject({ day: yesterday.toISOString().slice(0, 10), runs: 1, inputTokens: 500, outputTokens: 50 });
    expect(daily.slice(0, -2).every((d) => d.runs === 0)).toBe(true);

    // API credit counts its cost events, and the run they were charged to.
    const api = (await c.req("GET", `/api/funding-sources/${credit.id}/status?tz=UTC`)).json().daily as Array<{ runs: number; costMicros: number }>;
    expect(api.at(-1)).toMatchObject({ runs: 2, costMicros: 1_500_000 });
  });

  it("counts days in the owner's timezone, so late evening in BST isn't put on the next UTC day", async () => {
    const c = (ctx = await setup());
    const agent = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.sub.id })).json() as { id: string };
    // 00:30 on 16 Oct in London (BST, UTC+1) is 23:30 on 15 Oct UTC.
    const now = new Date("2026-10-16T12:00:00Z");
    await c.db.insert(runs).values({ companyId: c.company.id, agentId: agent.id, startedAt: new Date("2026-10-15T23:30:00Z"), inputTokens: 100, outputTokens: 10 });
    const london = await c.funding.daily(c.sub.id, now, "Europe/London");
    expect(london.map((d) => d.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(london.at(-1)).toMatchObject({ day: "2026-10-16", runs: 1, inputTokens: 100 });
    expect((await c.funding.daily(c.sub.id, now, "UTC")).at(-2)).toMatchObject({ day: "2026-10-15", runs: 1 });
    // The page asks with the browser's zone.
    const status = (await c.req("GET", `/api/funding-sources/${c.sub.id}/status?tz=Europe%2FLondon`)).json();
    expect(status.daily).toHaveLength(7);
    expect((await c.req("GET", `/api/funding-sources/${c.sub.id}/status?tz=Not%2FAZone`)).statusCode).toBe(200);
  });

  it("tells the owner once per window when the limit runs out before it resets", async () => {
    const c = (ctx = await setup());
    const reg = (await c.req("POST", `/api/companies/${c.company.id}/runner`)).json() as { runnerId: string };
    const [runnerRow] = await c.db.select().from(runners).where(eq(runners.id, reg.runnerId));
    let seq = 0;
    const emit = (event: RunnerEvent) => c.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
    const reset = resetIn(4);
    await c.db.insert(quotaSamples).values({ fundingSourceId: c.sub.id, window: "five_hour", utilization: 0.3, resetsAt: new Date(reset * 1000), observedAt: new Date(Date.now() - 3_600_000) });

    await emit({ type: "run.quota", fundingSourceId: c.sub.id, claudeMeta: meta(0.6, reset) });
    await vi.waitFor(async () => expect(await c.db.select().from(notifications)).toHaveLength(1));
    await emit({ type: "run.quota", fundingSourceId: c.sub.id, claudeMeta: meta(0.65, reset) });
    await new Promise((r) => setTimeout(r, 100));
    const sent = await c.db.select().from(notifications);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requested: "flag", link: "#/funding", title: expect.stringMatching(/^Claude Max: the limit "5-hour window" runs out about \w{3} \d{1,2} \S+ at \d\d:\d\d$/) });
    expect(sent[0]!.body).toContain("60%");
  });
});
