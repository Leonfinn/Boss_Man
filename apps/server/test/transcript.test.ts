import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, costEvents, runners, runs } from "../src/db/schema.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const get = (url: string) => built.app.inject({ method: "GET", url, headers: { cookie } });
  const { company, ceo } = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json();
  const reg = (await built.app.inject({ method: "POST", url: `/api/companies/${company.id}/runner`, headers: { cookie } })).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runner!, { seq: ++seq, at: new Date().toISOString(), event });
  return { ...built, db, get, company, ceo, emit, cookie };
}

describe("run transcripts (R43)", () => {
  it("pages through one run's events, leaving out other runs and cost records", async () => {
    const c = await setup();
    const runId = randomUUID();
    const other = randomUUID();
    await c.emit({ type: "run.started", runId, agentId: c.ceo.id, acpSessionId: "s1", model: "opus" });
    await c.emit({ type: "run.started", runId: other, agentId: c.ceo.id, acpSessionId: "s2", model: null });
    for (let i = 0; i < 5; i++) await c.emit({ type: "run.update", runId, update: { kind: "tool_call", title: `step ${i}`, toolKind: "execute", status: "completed" } });
    await c.emit({ type: "run.cost", runId, fundingSourceId: randomUUID(), costMicrosDelta: 0, model: null });
    await c.emit({ type: "run.update", runId, update: { kind: "agent_message", text: "Done." } });
    await c.emit({ type: "run.ended", runId, stopReason: "end_turn", error: null });

    const first = (await c.get(`/api/runs/${runId}/transcript?limit=4`)).json();
    expect(first.run).toMatchObject({ id: runId, agent: "CEO", model: "opus", outcome: "end_turn" });
    expect(first.items.map((i: { type: string }) => i.type)).toEqual(["run.started", "run.update", "run.update", "run.update"]);
    expect(first.more).toBe(true);
    const rest = (await c.get(`/api/runs/${runId}/transcript?after=${first.next}`)).json();
    expect(rest.items.map((i: { event: { update?: { title?: string; text?: string } } }) => i.event.update?.title ?? i.event.update?.text ?? null)).toEqual(["step 3", "step 4", "Done.", null]);
    expect(rest.more).toBe(false);
    expect((await c.get(`/api/runs/${randomUUID()}/transcript`)).statusCode).toBe(404);
  });

  it("lists finished runs newest first with their cost", async () => {
    const c = await setup();
    const fs = (await c.app.inject({ method: "POST", url: "/api/funding-sources", headers: { cookie: c.cookie }, payload: { name: "API", kind: "api_payg", provider: "anthropic" } })).json();
    const older = randomUUID();
    const newer = randomUUID();
    await c.db.insert(runs).values([
      { id: older, companyId: c.company.id, agentId: c.ceo.id, endedAt: new Date(Date.now() - 60_000), outcome: "end_turn" },
      { id: newer, companyId: c.company.id, agentId: c.ceo.id, endedAt: new Date(), outcome: "error: boom" },
      { id: randomUUID(), companyId: c.company.id, agentId: c.ceo.id },
    ]);
    await c.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: c.company.id, runId: older, costMicros: 412_000 });
    const list = (await c.get("/api/runs/recent")).json();
    expect(list.map((r: { id: string; costMicros: number; agent: string }) => [r.id, r.costMicros, r.agent])).toEqual([
      [newer, 0, "CEO"],
      [older, 412_000, "CEO"],
    ]);
  });

  it("filters finished runs by agent and result, and pages older ones with before", async () => {
    const c = await setup();
    const [other] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Helper", role: "worker", agentKind: "claude" }).returning();
    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - n * 60_000);
    const ids = { ok: randomUUID(), bad: randomUUID(), int: randomUUID(), otherBad: randomUUID(), stopped: randomUUID() };
    await c.db.insert(runs).values([
      { id: ids.ok, companyId: c.company.id, agentId: c.ceo.id, endedAt: t(1), outcome: "end_turn" },
      { id: ids.bad, companyId: c.company.id, agentId: c.ceo.id, endedAt: t(2), outcome: "error: boom" },
      { id: ids.int, companyId: c.company.id, agentId: c.ceo.id, endedAt: t(3), outcome: "interrupted" },
      { id: ids.otherBad, companyId: c.company.id, agentId: other!.id, endedAt: t(4), outcome: "error: x" },
      { id: ids.stopped, companyId: c.company.id, agentId: c.ceo.id, endedAt: t(5), outcome: "cancelled" },
    ]);
    const idsOf = async (q: string) => ((await c.get(`/api/runs/recent?${q}`)).json() as Array<{ id: string }>).map((r) => r.id);
    expect(await idsOf("result=failed")).toEqual([ids.bad, ids.otherBad]);
    expect(await idsOf("result=interrupted")).toEqual([ids.int]);
    expect(await idsOf("result=finished")).toEqual([ids.ok]);
    expect(await idsOf(`agentId=${c.ceo.id}&result=failed`)).toEqual([ids.bad]);
    expect(await idsOf(`before=${encodeURIComponent(t(2).toISOString())}`)).toEqual([ids.int, ids.otherBad, ids.stopped]);
    expect((await c.get("/api/runs/recent?result=bogus")).statusCode).toBe(400);
  });
});
