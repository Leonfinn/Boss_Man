// BOS-239: Synthetic's own quota reading is cached on the server, kept as a history, given to the CEO
// through server_status, and the owner is warned once per period at 80% and again at 100%.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, fundingSources, notifications, providerQuotaReadings, providerQuotaWarnings, runs, runners } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

type Built = Awaited<ReturnType<ReturnType<typeof setup>["build"]>>;
let ctx: Built | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const QUOTA_URL = "https://api.synthetic.new/v2/quotas";
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

/** A clock the test moves, so the 5-minute cache and the 30-day prune can be checked without waiting. */
function setup() {
  const clock = { at: new Date("2026-11-10T10:00:00.000Z") };
  const now = () => new Date(clock.at);
  const calls: string[] = [];
  // What Synthetic answers next; tests change it to show usage rising or the call failing.
  const answer = { status: 200, body: { subscription: { limit: 1000, requests: 123, renewsAt: "2026-11-30T00:00:00.000Z" } } as unknown };
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
    expect(first.json().providerQuota).toMatchObject({ used: 123, limit: 1000, renewsAt: "2026-11-30T00:00:00.000Z", ageSeconds: 0 });
    // An older reading, marked with its age.
    c.clock.at = new Date(c.clock.at.getTime() + 2 * 60_000);
    const cached = await status(c);
    expect(quotaCalls(c.calls)).toBe(1);
    expect(cached.providerQuota.ageSeconds).toBe(120);
    // Past the window: read again, and the history keeps both readings.
    c.clock.at = new Date(c.clock.at.getTime() + 4 * 60_000);
    c.answer.body = { subscription: { limit: 1000, requests: 200, renewsAt: "2026-11-30T00:00:00.000Z" } };
    const fresh = await status(c);
    expect(quotaCalls(c.calls)).toBe(2);
    expect(fresh.providerQuota).toMatchObject({ used: 200, ageSeconds: 0 });
    expect(fresh.providerQuota.history.map((h: { used: number }) => h.used)).toEqual([200, 123]);
    expect(first.body).not.toContain("sk-syn-secret");
    expect(JSON.stringify(fresh)).not.toContain("sk-syn-secret");
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
    expect(kept.providerQuota).toMatchObject({ used: 123, limit: 1000, ageSeconds: 600 });
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
    c.answer.body = { subscription: { limit: 1000, requests: 150, renewsAt: "2026-11-30T00:00:00.000Z" } };
    // Past the 5-minute cache window, as the plan is only checked again that often.
    c.clock.at = new Date(c.clock.at.getTime() + 6 * 60_000);
    await c.runners.ingest(runnerRow!, { seq: 1, at: c.clock.at.toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
    await new Promise((r) => setTimeout(r, 50));
    expect(quotaCalls(c.calls)).toBe(2);
    // The newest reading is the run's, and both are inside this period.
    const after = await status(c);
    expect(after.providerQuota).toMatchObject({ used: 150, ageSeconds: 0 });
    expect(after.providerQuota.history).toHaveLength(2);
    // Old history falls away after 30 days.
    c.clock.at = new Date(c.clock.at.getTime() + 31 * 86_400_000);
    c.answer.body = { subscription: { limit: 1000, requests: 10, renewsAt: "2026-12-31T00:00:00.000Z" } };
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

  it("warns once at 80% and again at 100%, naming the renewal and the agents paid from it, and not twice", async () => {
    const c = (ctx = await setup().build());
    // A worker paid from Synthetic, so the warning names it.
    await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Engineer", fundingSourceId: c.source.id });
    c.answer.body = { subscription: { limit: 1000, requests: 500, renewsAt: "2026-11-30T00:00:00.000Z" } };
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(notifications)).toHaveLength(0);
    expect(quotaCalls(c.calls)).toBe(1);
    // Passing 80%: one flag, once.
    c.answer.body = { subscription: { limit: 1000, requests: 810, renewsAt: "2026-11-30T00:00:00.000Z" } };
    await run(c);
    await run(c);
    const flags = await c.db.select().from(notifications);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ companyId: null, agentId: null, level: "flag", link: "#/funding" });
    expect(flags[0]!.title).toContain("80%");
    expect(flags[0]!.body).toContain("810 of 1,000");
    expect(flags[0]!.body).toContain("Engineer (App Co)");
    expect(flags[0]!.body).toMatch(/renews Mon 30 Nov/);
    // 100%: a second warning, not a repeat of the first.
    c.answer.body = { subscription: { limit: 1000, requests: 1000, renewsAt: "2026-11-30T00:00:00.000Z" } };
    await run(c);
    await run(c);
    const all = await c.db.select().from(notifications);
    expect(all).toHaveLength(2);
    expect(all[1]!.title).toContain("used up");
    // The next period warns again.
    c.answer.body = { subscription: { limit: 1000, requests: 850, renewsAt: "2026-12-30T00:00:00.000Z" } };
    await run(c);
    expect(await c.db.select().from(notifications)).toHaveLength(3);
    expect((await c.db.select().from(providerQuotaWarnings)).map((w) => [w.period, w.threshold])).toEqual([
      ["2026-11-30T00:00:00.000Z", 80],
      ["2026-11-30T00:00:00.000Z", 100],
      ["2026-12-30T00:00:00.000Z", 80],
    ]);
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
    expect(view.syntheticUsage[0]).toMatchObject({ name: "Synthetic", reading: { used: 123, limit: 1000, renewsAt: "2026-11-30T00:00:00.000Z", ageSeconds: 0 } });
    expect(view.syntheticUsage[0].reading.history).toHaveLength(1);
    expect(view.syntheticUsage[0].agents.map((a: { name: string }) => a.name)).toContain("Engineer");
    expect(JSON.stringify(view)).not.toContain("sk-syn-secret");
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
    const usage = await c.funding.syntheticUsage();
    expect(usage.map((u) => u.name)).toEqual(["Synthetic"]);
  });
});
