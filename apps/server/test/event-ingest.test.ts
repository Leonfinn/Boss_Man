import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, costEvents, fundingSources, quotaSamples, runnerEvents, runners, runs, runTokens } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  // A run the scheduler created, so run.ended has something to close.
  const runId = crypto.randomUUID();
  await built.runners.ingest(runnerRow!, { seq: 1, at: new Date().toISOString(), event: { type: "run.started", runId, agentId: ceo.id, acpSessionId: "s", model: null } });
  return { ...built, db, close, req, company, ceo, project, runnerRow: runnerRow!, runId };
}

describe("runner event ingest is one transaction (BOS-584)", () => {
  it("rolls the stored event back when an apply throws, and the resend closes the run", async () => {
    const c = (ctx = await setup());
    // markEnded's weekly-limit branch only runs when the run is paid from a source.
    const [fs] = await c.db.insert(fundingSources).values({ name: "Claude", kind: "subscription", provider: "anthropic" }).returning();
    await c.db.update(runs).set({ fundingSourceId: fs!.id }).where(eq(runs.id, c.runId));
    // Make the quota reading markEnded records fail once.
    const real = c.funding.recordQuota.bind(c.funding);
    const failOnce = vi.spyOn(c.funding, "recordQuota").mockImplementationOnce(async () => {
      throw new Error("database hiccup");
    });

    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.ended" as const, runId: c.runId, stopReason: null, error: "You've hit your weekly limit · resets later" } };
    await expect(c.runners.ingest(c.runnerRow, entry)).rejects.toThrow("database hiccup");
    expect(failOnce).toHaveBeenCalledTimes(1);

    // The failed apply left no stored event and did not close the run.
    const stored = await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)));
    expect(stored).toHaveLength(0);
    const [before] = await c.db.select().from(runs).where(eq(runs.id, c.runId));
    expect(before!.endedAt).toBeNull();

    // The runner resends the same seq; it is a new event now, so it is applied and the run closes.
    vi.spyOn(c.funding, "recordQuota").mockImplementation(async (...args) => real(...args));
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    const [after] = await c.db.select().from(runs).where(eq(runs.id, c.runId));
    expect(after!.endedAt).not.toBeNull();
    expect(after!.outcome).toMatch(/weekly limit/);
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(1);
  });

  it("applies a normal event once, stores it once, and ignores a resend", async () => {
    const c = (ctx = await setup());
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.ended" as const, runId: c.runId, stopReason: "end_turn", error: null } };
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    const [run] = await c.db.select().from(runs).where(eq(runs.id, c.runId));
    expect(run!.endedAt).not.toBeNull();
    expect(run!.outcome).toBe("end_turn");

    // A resend of the same seq is a duplicate: not applied again, not stored twice.
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(false);
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(1);
  });

  // BOS-623: markEnded deleted the token on the outer handle, which on PGlite's one connection waits
  // for the ingest transaction for ever. The short timeout makes that a quick failure, not a hang.
  it("removes the ended run's token inside the ingest transaction, without hanging", { timeout: 10_000 }, async () => {
    const c = (ctx = await setup());
    await c.db.insert(runTokens).values({ tokenHash: "bos-623-token", runId: c.runId, companyId: c.company.id, agentId: c.ceo.id, expiresAt: new Date(Date.now() + 3_600_000) });
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.ended" as const, runId: c.runId, stopReason: "end_turn", error: null } };
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    expect(await c.db.select().from(runTokens).where(eq(runTokens.runId, c.runId))).toHaveLength(0);
  });

  it("rolls a cost event's storage and its cost row back together when the apply throws", async () => {
    const c = (ctx = await setup());
    const [fs] = await c.db.insert(fundingSources).values({ name: "Claude", kind: "subscription", provider: "anthropic" }).returning();
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.cost" as const, runId: c.runId, fundingSourceId: fs!.id, model: "opus", costMicrosDelta: 5_000 } as never };
    vi.spyOn(c.funding, "recordCost").mockImplementationOnce(async () => {
      throw new Error("cost insert failed");
    });
    await expect(c.runners.ingest(c.runnerRow, entry)).rejects.toThrow("cost insert failed");
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(0);
    expect(await c.db.select().from(costEvents)).toHaveLength(0);

    // The resend is applied: both rows land, exactly once.
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    expect(await c.db.select().from(costEvents)).toHaveLength(1);
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(1);
  });

  it("records a quota reading and the event in one go", async () => {    const c = (ctx = await setup());
    const [fs] = await c.db.insert(fundingSources).values({ name: "Claude", kind: "subscription", provider: "anthropic" }).returning();
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.quota" as const, fundingSourceId: fs!.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 40, resetsAt: "2026-11-07T14:00:00Z" } } } } } as never };
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    expect(await c.db.select().from(quotaSamples)).toHaveLength(1);
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(1);
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(false);
    expect(await c.db.select().from(quotaSamples)).toHaveLength(1);
  });

  it("keeps and marks an event that can never apply, and the next event still lands (BOS-584)", async () => {
    const c = (ctx = await setup());
    // A cost reported for an account the owner deleted meanwhile: the FK fails on every resend.
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.cost" as const, runId: c.runId, fundingSourceId: crypto.randomUUID(), model: "opus", costMicrosDelta: 5_000 } as never };
    // It is recorded and acked (true), not retried for ever.
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    expect(await c.db.select().from(runnerEvents).where(and(eq(runnerEvents.runnerId, c.runnerRow.id), eq(runnerEvents.seq, 2)))).toHaveLength(1);
    expect(await c.db.select().from(costEvents)).toHaveLength(0);
    const [failed] = await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "runner_event_failed")));
    expect(failed?.summary).toMatch(/seq 2 \(run.cost\)|Runner event 2/);

    // A later event for the same runner is not stuck behind it: the run still ends.
    const ended = { seq: 3, at: new Date().toISOString(), event: { type: "run.ended" as const, runId: c.runId, stopReason: "end_turn", error: null } };
    expect(await c.runners.ingest(c.runnerRow, ended)).toBe(true);
    const [run] = await c.db.select().from(runs).where(eq(runs.id, c.runId));
    expect(run!.endedAt).not.toBeNull();
  });

  it("still retries a connection-style failure on the resend (not marked as failed)", async () => {
    const c = (ctx = await setup());
    const [fs] = await c.db.insert(fundingSources).values({ name: "Claude", kind: "subscription", provider: "anthropic" }).returning();
    const entry = { seq: 2, at: new Date().toISOString(), event: { type: "run.cost" as const, runId: c.runId, fundingSourceId: fs!.id, model: "opus", costMicrosDelta: 5_000 } as never };
    // A dropped connection is not a data error: the event is not stored, so the resend applies it.
    vi.spyOn(c.funding, "recordCost").mockImplementationOnce(async () => {
      throw Object.assign(new Error("connection reset"), { code: "08006" });
    });
    await expect(c.runners.ingest(c.runnerRow, entry)).rejects.toThrow("connection reset");
    expect(await c.db.select().from(runnerEvents).where(eq(runnerEvents.runnerId, c.runnerRow.id))).toHaveLength(1); // only run.started
    expect(await c.runners.ingest(c.runnerRow, entry)).toBe(true);
    expect(await c.db.select().from(costEvents)).toHaveLength(1);
  });
});
