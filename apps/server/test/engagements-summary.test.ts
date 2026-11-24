import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, engagementMessages, engagements } from "../src/db/schema.js";

// BOS-2427: the owner's engagements list carries a stateSince per row and a summary on its first row.

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const mk = async (name: string) => (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
  const appCo = await mk("App Co");
  const homelab = await mk("Homelab Co");
  const request = async (title: string) =>
    (await req("POST", "/api/engagements", { requesterCompanyId: appCo.company.id, providerCompanyId: homelab.company.id, title, scope: "Do it", acceptanceCriteria: ["Works"] })).json() as { id: string };
  const act = (id: string, as: "requester" | "provider", body: Record<string, unknown>) => req("POST", `/api/engagements/${id}/actions`, { as, ...body });
  return { ...built, db, close, req, appCo, homelab, request, act };
}

type Row = { id: string; status: string; stateSince: string; summary?: Record<string, any> | null };
const DAY = 86_400_000;

describe("engagements list summary (BOS-2427)", () => {
  it("counts open by state and by side, sums 30-day spend by basis, takes the 90-day median", async () => {
    ctx = await setup();
    const waitProvider = await ctx.request("Waits on provider");
    const waitRequester = await ctx.request("Waits on requester");
    await ctx.act(waitRequester.id, "provider", { action: "counter", message: "Narrower", scope: "Less" });
    const done1 = await ctx.request("Done 1");
    const done2 = await ctx.request("Done 2");
    for (const [e, days] of [[done1, 2], [done2, 6]] as const) {
      await ctx.db.update(engagements).set({ status: "signed_off", createdAt: new Date(Date.now() - days * DAY) }).where(eq(engagements.id, e.id));
      await ctx.db.insert(engagementMessages).values({ engagementId: e.id, fromCompanyId: ctx.appCo.company.id, kind: "signed_off", body: "ok", createdAt: new Date() });
    }
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "API", kind: "api_credit", provider: "anthropic", monthlyGrantUsd: 200, cycleAnchor: "2026-10-01T00:00:00Z" })).json();
    await ctx.db.insert(costEvents).values([
      { fundingSourceId: fs.id, companyId: ctx.homelab.company.id, engagementId: waitProvider.id, chargedCompanyId: ctx.appCo.company.id, costMicros: 2_000_000, basis: "billed" },
      { fundingSourceId: fs.id, companyId: ctx.homelab.company.id, engagementId: waitProvider.id, chargedCompanyId: ctx.appCo.company.id, costMicros: 500_000, basis: "list_estimate" },
      { fundingSourceId: fs.id, companyId: ctx.homelab.company.id, engagementId: waitProvider.id, chargedCompanyId: ctx.appCo.company.id, costMicros: 9_000_000, basis: "billed", occurredAt: new Date(Date.now() - 40 * DAY) },
    ]);
    const rows = (await ctx.req("GET", "/api/engagements?status=requested")).json() as Row[];
    const s = rows[0]!.summary!;
    expect(s.openByState).toEqual({ requested: 1, countered: 1 });
    expect([s.waitingOnProvider, s.waitingOnRequester, s.waitingOnOther]).toEqual([1, 1, 0]);
    expect([s.spend30dPayAsYouGoUsd, s.spend30dPlanUseUsd]).toEqual([2, 0.5]);
    expect(s.finishedCount).toBe(2);
    expect(s.medianDaysToFinish).toBeCloseTo(4, 1);
    expect(rows.slice(1).every((r) => r.summary === undefined)).toBe(true);
  });

  it("dates a row from its newest step, ignores plain messages, and leaves the summary off an agent's company list", async () => {
    ctx = await setup();
    const e = await ctx.request("Stale one");
    const old = new Date(Date.now() - 5 * DAY);
    await ctx.db.update(engagementMessages).set({ createdAt: old }).where(eq(engagementMessages.engagementId, e.id));
    await ctx.act(e.id, "provider", { action: "message", message: "hello" });
    const rows = (await ctx.req("GET", "/api/engagements")).json() as Row[];
    expect(new Date(rows[0]!.stateSince).getTime()).toBe(old.getTime());
    const scoped = await ctx.engagements.list(ctx.homelab.company.id);
    expect(scoped[0]).not.toHaveProperty("summary", expect.anything());
  });

  it("gives no summary on an empty list", async () => {
    ctx = await setup();
    expect((await ctx.req("GET", "/api/engagements")).json()).toEqual([]);
  });
});
