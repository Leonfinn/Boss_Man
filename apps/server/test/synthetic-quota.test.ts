import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { quotaSamples } from "../src/db/schema.js";
import { SYNTHETIC_HOLD_SAMPLE_MS } from "../src/services/funding.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  // What Synthetic answers; tests change these to move the plan's usage or take Synthetic down.
  const synthetic = { percentRemaining: 87.7, nextRegenAt: "2026-11-30T00:05:00.000Z", down: false };
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url, authorization });
    if (url !== "https://api.synthetic.new/v2/quotas") return new Response("{}", { status: 404 });
    if (authorization === "Bearer sk-syn-good" && !synthetic.down) {
      // The real shape (BOS-260): weekly credits are the measure, and the request window is often 0.
      return new Response(JSON.stringify({ subscription: { limit: 500, requests: 0, renewsAt: "2026-11-30T00:00:00.000Z" }, planWeeklyLimit: { nextRegenAt: synthetic.nextRegenAt, percentRemaining: synthetic.percentRemaining, nextRegenPercent: 2 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch, now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, req, calls, synthetic, clock, advance: (ms: number) => (offset += ms) };
}

async function source(t: Awaited<ReturnType<typeof setup>>, value: string) {
  const { secret } = (await t.req("POST", "/api/secrets", { name: `Synthetic ${value}`, kind: "generic", value })).json();
  return (await t.req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic", secretId: secret.id })).json() as { id: string };
}

describe("Synthetic quota", () => {
  it("reads the week's credits with the key, and never puts the key in the answer", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-syn-good");
    const res = await c.req("GET", `/api/funding-sources/${s.id}/status`);
    expect(res.statusCode).toBe(200);
    // 12.3% of the week's credits used, stored as 1,230 of 10,000; the request window's 0 is ignored.
    expect(res.json().providerQuota).toMatchObject({ used: 1230, limit: 10_000, measure: "weekly", ageSeconds: expect.any(Number), warned: [] });
    expect(c.calls.find((x) => x.url === "https://api.synthetic.new/v2/quotas")!.authorization).toBe("Bearer sk-syn-good");
    expect(res.body).not.toContain("sk-syn-good");
  });

  it("uses the key granted to the company when the funding source has none attached", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json();
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: "sk-syn-good" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "SYNTHETIC_API_KEY" });
    const s = (await c.req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic" })).json();
    expect((await c.req("GET", `/api/funding-sources/${s.id}/status`)).json().providerQuota).toMatchObject({ used: 1230, limit: 10_000, measure: "weekly" });
  });

  it("shows an unknown quota on a failed call instead of failing the request", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-bad");
    const res = await c.req("GET", `/api/funding-sources/${s.id}/status`);
    expect(res.statusCode).toBe(200);
    expect(res.json().providerQuota).toMatchObject({ used: null, limit: null, renewsAt: null, ageSeconds: null, history: [] });
  });

  // BOS-852: the scheduler's hold reads only quota_samples, so each good reading is copied there.
  it("feeds each good reading into the quota hold's samples, one row per change, and lets a stale one lapse", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-syn-good");
    // The next regeneration is a minute away: the sample still holds for 15 minutes so the next refresh replaces it in time.
    c.synthetic.nextRegenAt = new Date(c.clock().getTime() + 60_000).toISOString();
    await c.refreshSyntheticQuota();
    let rows = await c.db.select().from(quotaSamples).where(eq(quotaSamples.fundingSourceId, s.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ window: "synthetic_weekly", overageInUse: false });
    expect(rows[0]!.utilization).toBeCloseTo(0.123, 5);
    expect(rows[0]!.resetsAt!.getTime()).toBe(rows[0]!.observedAt.getTime() + SYNTHETIC_HOLD_SAMPLE_MS);
    expect((await c.req("GET", `/api/funding-sources/${s.id}/status`)).json().windowsSeen).toEqual(["synthetic_weekly"]);

    // The same reading 5 minutes later moves the row forward instead of adding one.
    const firstSeen = rows[0]!.observedAt.getTime();
    c.advance(5 * 60_000);
    await c.refreshSyntheticQuota();
    rows = await c.db.select().from(quotaSamples).where(eq(quotaSamples.fundingSourceId, s.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedAt.getTime()).toBeGreaterThanOrEqual(firstSeen + 5 * 60_000);
    expect(rows[0]!.resetsAt!.getTime()).toBe(rows[0]!.observedAt.getTime() + SYNTHETIC_HOLD_SAMPLE_MS);

    // A change adds a row; a renewal further out than 15 minutes is kept as the reset.
    c.synthetic.percentRemaining = 4;
    c.synthetic.nextRegenAt = new Date(c.clock().getTime() + 3_600_000).toISOString();
    c.advance(5 * 60_000);
    await c.refreshSyntheticQuota();
    rows = await c.db.select().from(quotaSamples).where(eq(quotaSamples.fundingSourceId, s.id)).orderBy(desc(quotaSamples.observedAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.utilization).toBeCloseTo(0.96, 5);
    expect(rows[0]!.resetsAt!.toISOString()).toBe(c.synthetic.nextRegenAt);

    // Synthetic going down stores nothing new, so the hold can't stick on the old number past its reset.
    c.synthetic.down = true;
    c.advance(5 * 60_000);
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(quotaSamples).where(eq(quotaSamples.fundingSourceId, s.id))).toHaveLength(2);
  });

  it("still lets the owner delete a Synthetic source that has only Synthetic's own readings", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-syn-good");
    await c.refreshSyntheticQuota();
    expect(await c.db.select().from(quotaSamples).where(eq(quotaSamples.fundingSourceId, s.id))).toHaveLength(1);
    expect(await c.funding.remove(s.id)).toEqual({ agentsUnlinked: 0 });
  });

  it("doesn't call Synthetic for other providers", async () => {
    const c = (ctx = await setup());
    const s = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json();
    expect((await c.req("GET", `/api/funding-sources/${s.id}/status`)).json().providerQuota).toBeNull();
    expect(c.calls.some((x) => x.url === "https://api.synthetic.new/v2/quotas")).toBe(false);
  });
});
