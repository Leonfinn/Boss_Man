// BOS-239: Synthetic's own quota reading is cached on the server, kept as a history, given to the CEO
// through server_status, and the owner is warned once per period. BOS-260: it reads the plan's weekly
// credits, not the request window the plan doesn't spend, and an unreadable field is unknown, never 0.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, fundingSources, notifications, providerQuotaReadings, providerQuotaWarnings, runs, runners } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { providerQuotaPeriod } from "../src/services/funding.js";

type Built = Awaited<ReturnType<ReturnType<typeof setup>["build"]>>;
let ctx: Built | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const QUOTA_URL = "https://api.synthetic.new/v2/quotas";
/** The real /v2/quotas shape (BOS-260): weekly credits used, plus the request window that stays at 0. */
const weekly = (usedPercent: number, nextRegenAt = "2026-11-10T14:00:00.000Z", requests = 0) => ({
  subscription: { limit: 500, requests, renewsAt: "2026-11-10T15:05:00.000Z" },
  search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-11-10T11:00:00.000Z" } },
  planWeeklyLimit: { nextRegenAt, percentRemaining: 100 - usedPercent, nextRegenPercent: 2 },
});
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

/** A clock the test moves, so the 5-minute cache and the 30-day prune can be checked without waiting. */
function setup() {
  const clock = { at: new Date("2026-11-10T10:00:00.000Z") };
  const now = () => new Date(clock.at);
  const calls: string[] = [];
  // What Synthetic answers next; tests change it to show usage rising or the call failing. The real
  // shape (BOS-260): the weekly credits are what the plan spends, and the request window sits at 0.
  // 48.3% left is 51.7% used, stored as 5,170 of 10,000.
  const answer = { status: 200, body: weekly(51.7) as unknown };
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url !== QUOTA_URL) return new Response("{}", { status: 404 });
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status });
  }) as typeof globalThis.fetch;
  const build = async () => {
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch, now, tickOnWake: false, workspaceRoot: "/ws" });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
    const { secret } = (await req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: "sk-syn-secret" })).json();
    const source = (await req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic", secretId: secret.id })).json() as { id: string };
    const port = (built.app.server.address() as { port: number }).port;
    const mcp = async () => {
      const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() });
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    return { ...built, db, close, req, company, ceo, source, secret, calls, answer, clock, mcp };
  };
  return { build, calls, answer, clock, now };
}

const quotaCalls = (calls: string[]) => calls.filter((c) => c === QUOTA_URL).length;
const status = async (c: Built, id = c.source.id) => (await c.req("GET", `/api/funding-sources/${id}/status`)).json();

describe("Synthetic quota caching (BOS-239)", () => {
  it("serves the cached reading for 5 minutes, asks again after, and never puts the key in the answer", async () => {
    const c = (ctx = await setup().build());
    const first = await c.req("GET", `/api/funding-sources/${c.source.id}/status`);
    expect(first.statusCode).toBe(200);
    expect(quotaCalls(c.calls)).toBe(1);
    // 51.7% of the week's credits used, from the real planWeeklyLimit; the request window's "0 of 500" is ignored.
    expect(first.json().providerQuota).toMatchObject({ used: 5170, limit: 10_000, measure: "weekly", renewsAt: null, ageSeconds: 0 });
    // An older reading, marked with its age.
    c.clock.at = new Date(c.clock.at.getTime() + 2 * 60_000);
    const cached = await status(c);
    expect(quotaCalls(c.calls)).toBe(1);
    expect(cached.providerQuota.ageSeconds).toBe(120);
    // Past the window: read again, and the history keeps both readings.
    c.clock.at = new Date(c.clock.at.getTime() + 4 * 60_000);
    c.answer.body = weekly(60);
    const fresh = await status(c);
    expect(quotaCalls(c.calls)).toBe(2);
    expect(fresh.providerQuota).toMatchObject({ used: 6000, ageSeconds: 0 });
    expect(fresh.providerQuota.history.map((h: { used: number }) => h.used)).toEqual([6000, 5170]);
    expect(first.body).not.toContain("sk-syn-secret");
    expect(JSON.stringify(fresh)).not.toContain("sk-syn-secret");
  });

  it("shows an account with only the request window as that, labelled, never as weekly credits", async () => {
    const c = (ctx = await setup().build());
    c.answer.body = { subscription: { limit: 500, requests: 0, renewsAt: "2026-11-10T15:05:00.000Z" } };
    const view = (await status(c)).providerQuota;
    expect(view).toMatchObject({ used: 0, limit: 500, measure: "requests", renewsAt: "2026-11-10T15:05:00.000Z" });
  });

  it("is unknown, never 0, when Synthetic sends no reading it recognises", async () => {
    const c = (ctx = await setup().build());
    // A weekly block without a usable percentage and no request window.
    c.answer.body = { planWeeklyLimit: { percentRemaining: "48.3" } };
    expect((await status(c)).providerQuota).toMatchObject({ used: null, limit: null, ageSeconds: null, history: [] });
  });

  it("counts a repeated percentage once, so the trend isn't padded by refreshes between ticks", async () => {
    const c = (ctx = await setup().build());
    await status(c);
    // Past the 5-minute cache, but no credits came back yet: the same 51.7% used.
    c.clock.at = new Date(c.clock.at.getTime() + 6 * 60_000);
    const same = await status(c);
    expect(same.providerQuota.history).toHaveLength(1);
    // The next 2% tick is a real new point.
    c.clock.at = new Date(c.clock.at.getTime() + 6 * 60_000);
    c.answer.body = weekly(49.7);
    const tick = await status(c);
    expect(tick.providerQuota.history.map((h: { used: number }) => h.used)).toEqual([4970, 5170]);
  });

  it("keeps the last good reading with its age when the call fails, and is unknown when there never was one", async () => {
    const c = (ctx = await setup().build());
    // Before any reading, a failure is unknown, not an error.
    c.answer.status = 500;
    const none = await c.req("GET", `/api/funding-sources/${c.source.id}/status`);
    expect(none.statusCode).toBe(200);
    expect(none.json().providerQuota).toMatchObject({ used: null, limit: null, ageSeconds: null, history: [] });
    // A good reading, then a failure: the old reading stays, aged.
    c.answer.status = 200;
    await status(c);
    c.answer.status = 500;
    c.clock.at = new Date(c.clock.at.getTime() + 10 * 60_000);
    const kept = await status(c);
    expect(kept.providerQuota).toMatchObject({ used: 5170, limit: 10_000, ageSeconds: 600 });
  });

  it("doesn't re-ask Synthetic on every load during an outage: a failed call backs off for a minute", async () => {
    const c = (ctx = await setup().build());
    await status(c);
    const afterGood = quotaCalls(c.calls);
    // Synthetic goes down; past the 5-minute cache each load would otherwise retry the 10s call.
    c.answer.status = 500;
    c.clock.at = new Date(c.clock.at.getTime() + 6 * 60_000);
    await status(c);
    const afterFirstFailure = quotaCalls(c.calls);
    expect(afterFirstFailure).toBe(afterGood + 1);
    // The next loads inside the backoff reuse the stored reading without calling Synthetic.
    c.clock.at = new Date(c.clock.at.getTime() + 20_000);
    await status(c);
    await status(c);
    expect(quotaCalls(c.calls)).toBe(afterFirstFailure);
    // Once the backoff passes, it tries again.
    c.clock.at = new Date(c.clock.at.getTime() + 60_000);
    await status(c);
    expect(quotaCalls(c.calls)).toBe(afterFirstFailure + 1);
  });

  it("reads again when a run on a Synthetic agent ends, and prunes readings older than 30 days", async () => {
    const c = (ctx = await setup().build());
    await status(c);
    const reg = (await c.req("POST", `/api/companies/${c.company.id}/runner`)).json();
    const [runnerRow] = await c.db.select().from(runners).where(eq(runners.id, reg.runnerId));
    c.runners.connect(reg.runnerId, () => true);
    const runId = randomUUID();
    const [ceo] = await c.db.select().from(agents).where(eq(agents.id, c.ceo.id));
    await c.db.update(agents).set({ fundingSourceId: c.source.id }).where(eq(agents.id, c.ceo.id));
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: ceo!.id, purpose: "ticket", origin: "scheduler" });
    c.answer.body = weekly(65);
    // Past the 5-minute cache window, as the plan is only checked again that often.
    c.clock.at = new Date(c.clock.at.getTime() + 6 * 60_000);
    await c.runners.ingest(runnerRow!, { seq: 1, at: c.clock.at.toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
    await new Promise((r) => setTimeout(r, 50));
    expect(quotaCalls(c.calls)).toBe(2);
    // The newest reading is the run's, and both are inside this period.
    const after = await status(c);
    expect(after.providerQuota).toMatchObject({ used: 6500, ageSeconds: 0 });
    expect(after.providerQuota.history).toHaveLength(2);
    // Old history falls away after 30 days.
    c.clock.at = new Date(c.clock.at.getTime() + 31 * 86_400_000);
    c.answer.body = weekly(10);
    const later = await status(c);
    expect(later.providerQuota.history).toHaveLength(1);
    const left = await c.db.select().from(providerQuotaReadings).where(eq(providerQuotaReadings.fundingSourceId, c.source.id));
    expect(left).toHaveLength(1);
  });
});

describe("Synthetic quota warnings (BOS-239)", () => {
  // Each reading past the 5-minute cache needs its own clock step, as it would in real life.
  const at = (c: { clock: { at: Date } }, minutes: number) => (c.clock.at = new Date(c.clock.at.getTime() + minutes * 60_000));
  const run = (c: Built, minutes = 6) => (at(c, minutes), c.refreshSyntheticQuota());

  it("warns on the weekly credits at 60%, 80% and 92% used, naming the agents paid from it, and not twice", async () => {
    const c = (ctx = await setup().build());
    // A worker paid from Synthetic, so the warning names it.
    await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.source.id });
    // 51.7% used: below the first warning.
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(notifications)).toHaveLength(0);
    expect(quotaCalls(c.calls)).toBe(1);
    // Passing 60%: one flag, once.
    c.answer.body = weekly(61.4);
    await run(c);
    await run(c);
    const flags = await c.db.select().from(notifications);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ companyId: null, agentId: null, level: "flag", link: "#/funding" });
    expect(flags[0]!.title).toContain("61%");
    expect(flags[0]!.body).toContain("39% left");
    expect(flags[0]!.body).toContain("Credits come back 2% at a time");
    expect(flags[0]!.body).toContain("Engineer (App Co)");
    // 80% used: a second warning, not a repeat of the first.
    c.answer.body = weekly(81);
    await run(c);
    expect((await c.db.select().from(notifications))[1]!.title).toContain("81%");
    // 92% used: the third.
    c.answer.body = weekly(93.2);
    await run(c);
    const all = await c.db.select().from(notifications);
    expect(all).toHaveLength(3);
    expect(all[2]!.body).toContain("7% left");
    // The next week (about 50 regeneration ticks later) warns again.
    c.answer.body = weekly(65, "2026-11-17T14:00:00.000Z");
    await run(c);
    expect(await c.db.select().from(notifications)).toHaveLength(4);
    // One week key shared by the three in the first week, and a different one for the week after.
    const week1 = providerQuotaPeriod("2026-11-10T14:00:00.000Z", true);
    const week2 = providerQuotaPeriod("2026-11-17T14:00:00.000Z", true);
    expect(week1).not.toBe(week2);
    expect((await c.db.select().from(providerQuotaWarnings)).map((w) => [w.period, w.threshold])).toEqual([
      [week1, 60],
      [week1, 80],
      [week1, 92],
      [week2, 60],
    ]);
  });

  it("still warns on the old request window for an account that sends only that", async () => {
    const c = (ctx = await setup().build());
    c.answer.body = { subscription: { limit: 1000, requests: 810, renewsAt: "2026-11-30T00:00:00.000Z" } };
    await c.refreshSyntheticQuota();
    const flags = await c.db.select().from(notifications);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.title).toContain("request allowance");
    expect(flags[0]!.body).toContain("810 of 1,000");
  });

  it("doesn't warn twice in a period when Synthetic's renewal time drifts by a few minutes", async () => {
    const c = (ctx = await setup().build());
    c.answer.body = { subscription: { limit: 1000, requests: 810, renewsAt: "2026-11-30T00:02:00.000Z" } };
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(notifications)).toHaveLength(1);
    // The same renewal, reported three minutes later: still one period, so no second flag.
    c.answer.body = { subscription: { limit: 1000, requests: 820, renewsAt: "2026-11-30T00:05:00.000Z" } };
    await run(c);
    expect(await c.db.select().from(notifications)).toHaveLength(1);
    // Both readings fall in the same hour, so they share a period.
    expect(providerQuotaPeriod("2026-11-30T00:05:00.000Z")).toBe(providerQuotaPeriod("2026-11-30T00:02:00.000Z"));
  });

  it("doesn't warn again in the same week when the next regeneration time moves on", async () => {
    const c = (ctx = await setup().build());
    // Jumping straight past both points sends both warnings once each.
    c.answer.body = weekly(81, "2026-11-10T14:00:00.000Z");
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(notifications)).toHaveLength(2);
    // Past 80% again, a few regeneration ticks on (each 202 minutes): still the same week, no second flag.
    c.answer.body = weekly(82, "2026-11-10T17:22:00.000Z");
    await run(c);
    expect(await c.db.select().from(notifications)).toHaveLength(2);
  });

  it("sends nothing when Synthetic can't be reached", async () => {
    const c = (ctx = await setup().build());
    c.answer.status = 401;
    await run(c);
    expect(await c.db.select().from(notifications)).toHaveLength(0);
  });
});

describe("Synthetic usage for the CEO (BOS-239)", () => {
  it("is in server_status: current used/limit/renewal, the reading's age, history and the agents on it", async () => {
    const c = (ctx = await setup().build());
    await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.source.id });
    const client = await c.mcp();
    const view = JSON.parse(textOf(await client.callTool({ name: "server_status", arguments: {} })));
    expect(view.syntheticUsage).toHaveLength(1);
    expect(view.syntheticUsage[0]).toMatchObject({ name: "Synthetic", reading: { used: 5170, limit: 10_000, measure: "weekly", renewsAt: null, ageSeconds: 0 } });
    expect(view.syntheticUsage[0].reading.history).toHaveLength(1);
    expect(view.syntheticUsage[0].agents.map((a: { name: string }) => a.name)).toContain("Engineer");
    expect(JSON.stringify(view)).not.toContain("sk-syn-secret");
    await client.close();
  });

  it("names only the calling company's agents, and counts the other company's without naming them", async () => {
    const c = (ctx = await setup().build());
    await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.source.id });
    // A second company on the same Synthetic plan, with an agent of its own.
    const b = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string }; ceo: { id: string } };
    await c.req("POST", `/api/companies/${b.company.id}/agents`, { name: "Secret Agent", fundingSourceId: c.source.id });

    const aView = await c.funding.syntheticUsage(c.company.id);
    expect(aView[0]!.agents.map((a) => a.name)).toEqual(["Engineer"]);
    expect(aView[0]!.otherCompaniesAgents).toBe(1);

    const otherView = await c.funding.syntheticUsage(b.company.id);
    expect(otherView[0]!.agents.map((a) => a.name)).toEqual(["Secret Agent"]);
    expect(otherView[0]!.otherCompaniesAgents).toBe(1);
    // The CEO of App Co never sees the other company's agent name in its own server_status.
    const client = await c.mcp();
    const view = JSON.parse(textOf(await client.callTool({ name: "server_status", arguments: {} })));
    expect(JSON.stringify(view)).not.toContain("Secret Agent");
    expect(JSON.stringify(view)).not.toContain("Other Co");
    await client.close();
  });
});

describe("other providers (BOS-239)", () => {
  it("have no Synthetic reading, and the Funding status is unchanged for them", async () => {
    const c = (ctx = await setup().build());
    const ollama = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json() as { id: string };
    expect((await status(c, ollama.id)).providerQuota).toBeNull();
    await c.refreshSyntheticQuota();
    expect(quotaCalls(c.calls)).toBe(1);
    const usage = await c.funding.syntheticUsage(c.company.id);
    expect(usage.map((u) => u.name)).toEqual(["Synthetic"]);
  });
});
