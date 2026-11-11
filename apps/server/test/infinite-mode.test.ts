// BOS-279: Synthetic's Infinite mode. Agents on an `infinite:` model never wait for the plan's quota, run in
// their own background slots instead of the normal ones, add nothing to usage, and get a longer quiet-run limit.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { costEvents, notifications, quotaSamples, runners, runs, wakes } from "../src/db/schema.js";
import type { Limits } from "../src/services/scheduler.js";
import type { SweepLimits } from "../src/services/sweeps.js";

const INF = "synthetic/infinite:small:vision";
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function setup(opts: { limits?: Partial<Limits>; sweep?: Partial<SweepLimits>; fetch?: typeof globalThis.fetch } = {}) {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, ...opts.limits }, sweepLimits: opts.sweep, workspaceRoot: "/ws", now: clock, fetch: opts.fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock().toISOString(), event });
  const ticket = async (title: string, assigneeAgentId: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId })).json() as { id: string };
  const plan = async (name = "Synthetic Big") => (await req("POST", "/api/funding-sources", { name, kind: "subscription", provider: "synthetic" })).json() as { id: string };
  const worker = async (name: string) => (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, ceo, project, commands, emit, ticket, plan, worker, advance, clock };
}

/** A full subscription window on the plan: routine work on it would be held (BOS-279 test). */
async function fillPlan(t: Awaited<ReturnType<typeof setup>>, id: string) {
  await t.db.insert(quotaSamples).values({ fundingSourceId: id, window: "plan_weekly", utilization: 1, resetsAt: new Date(Date.now() + 3_600_000) });
}

describe("Synthetic Infinite mode (BOS-279)", () => {
  it("never pauses an infinite-model agent while the plan's window is full, but holds a normal one on the same plan", async () => {
    ctx = await setup({ limits: { agent: 5 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    const normal = await ctx.worker("Normal");
    await ctx.req("PATCH", `/api/agents/${normal.id}`, { fundingSourceId: p.id, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    await fillPlan(ctx, p.id);

    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    await ctx.req("POST", `/api/agents/${normal.id}/wake`, { priority: 2 });
    await ctx.req("POST", "/api/scheduler/tick");
    const rows = await ctx.db.select().from(wakes);
    expect(rows.find((w) => w.agentId === ctx.ceo.id)!.status).toBe("launched");
    const held = rows.find((w) => w.agentId === normal.id)!;
    expect(held.status).toBe("deferred");
    expect(held.notBefore).not.toBeNull();
  });

  // BOS-852: before this, Synthetic's reading never reached the hold, so only a hand-made sample (above) could hold a plan.
  it("holds a normal agent when Synthetic itself reports the week's credits past the hold level, and never an infinite one", async () => {
    const synthetic = { percentRemaining: 4 };
    const fetch = (async (input: string | URL | Request) => {
      if (String(input) !== "https://api.synthetic.new/v2/quotas") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ planWeeklyLimit: { nextRegenAt: new Date(Date.now() + 3_600_000).toISOString(), percentRemaining: synthetic.percentRemaining, nextRegenPercent: 2 } }), { status: 200 });
    }) as typeof globalThis.fetch;
    ctx = await setup({ limits: { agent: 5 }, fetch });
    const { secret } = (await ctx.req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: "sk-syn-test" })).json() as { secret: { id: string } };
    await ctx.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: ctx.company.id, envName: "SYNTHETIC_API_KEY" });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    const normal = await ctx.worker("Normal");
    await ctx.req("PATCH", `/api/agents/${normal.id}`, { fundingSourceId: p.id, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    await ctx.refreshSyntheticQuota(); // 96% used, past the default 95% hold

    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    await ctx.req("POST", `/api/agents/${normal.id}/wake`, { priority: 2 });
    await ctx.req("POST", "/api/scheduler/tick");
    let rows = await ctx.db.select().from(wakes);
    expect(rows.find((w) => w.agentId === ctx.ceo.id)!.status).toBe("launched");
    expect(rows.find((w) => w.agentId === normal.id)!).toMatchObject({ status: "deferred", statusReason: expect.stringContaining("synthetic_weekly") });
    // The plan also pays for a normal agent, so the owner is told routine work paused (it used to be skipped).
    await ctx.scheduler.slow();
    expect((await ctx.db.select().from(notifications)).filter((n) => /Routine work paused/.test(n.title))).toHaveLength(1);
    // An infinite CEO can still run, so the alert ladder doesn't think it is stopped by the plan.
    expect(await ctx.scheduler.ceoCanRun(ctx.company.id)).toBe(true);

    // Credits come back below the hold level: the next reading lets the normal agent go.
    synthetic.percentRemaining = 10;
    ctx.advance(5 * 60_000);
    await ctx.refreshSyntheticQuota();
    await ctx.req("POST", "/api/scheduler/tick");
    rows = await ctx.db.select().from(wakes);
    expect(rows.find((w) => w.agentId === normal.id)!.status).toBe("launched");
  });

  // BOS-934: an account with paid top-up credit can carry on past the weekly allowance, if the owner chooses.
  it("holds a Synthetic plan at 100% by default, and lets routine work run on top-up credit once the owner chooses it", async () => {
    const fetch = (async (input: string | URL | Request) => {
      if (String(input) !== "https://api.synthetic.new/v2/quotas") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ planWeeklyLimit: { nextRegenAt: new Date(Date.now() + 3_600_000).toISOString(), percentRemaining: 0, nextRegenPercent: 2 } }), { status: 200 });
    }) as typeof globalThis.fetch;
    ctx = await setup({ limits: { agent: 5 }, fetch });
    const { secret } = (await ctx.req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: "sk-syn-test" })).json() as { secret: { id: string } };
    await ctx.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: ctx.company.id, envName: "SYNTHETIC_API_KEY" });
    const p = await ctx.plan();
    const normal = await ctx.worker("Normal");
    await ctx.req("PATCH", `/api/agents/${normal.id}`, { fundingSourceId: p.id, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    await ctx.refreshSyntheticQuota(); // the weekly allowance is used up

    // The default ("hold") is today's behaviour: routine work waits, and the note says how to use top-up credit.
    await ctx.req("POST", `/api/agents/${normal.id}/wake`, { priority: 2 });
    await ctx.req("POST", "/api/scheduler/tick");
    expect((await ctx.db.select().from(wakes)).find((w) => w.agentId === normal.id)!.status).toBe("deferred");
    await ctx.scheduler.slow();
    const paused = (await ctx.db.select().from(notifications)).find((n) => /Routine work paused/.test(n.title));
    expect(paused!.body).toContain('set "I have top-up credit" to "Keep all work running"');

    // The owner says the account has top-up credit: the same wake now runs.
    expect((await ctx.req("PATCH", `/api/funding-sources/${p.id}`, { quotaOverage: "all" })).statusCode).toBeLessThan(300);
    // A wake held by the quota is looked at again on every tick, so the change takes effect at once.
    await ctx.req("POST", "/api/scheduler/tick");
    expect((await ctx.db.select().from(wakes)).find((w) => w.agentId === normal.id)!.status).toBe("launched");
  });

  it("gives infinite-mode runs their own background slots instead of the normal ones", async () => {
    ctx = await setup({ limits: { instance: 8, company: 8, agent: 5, background: 1 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    await ctx.ticket("One", ctx.ceo.id);
    await ctx.ticket("Two", ctx.ceo.id);
    await ctx.ticket("Three", ctx.ceo.id);
    // Only one background slot, so only one of the three starts; the rest wait.
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1, waiting: 2 });
    const live = (await ctx.db.select().from(runs)).filter((r) => !r.endedAt);
    expect(live).toHaveLength(1);
    expect(live[0]!.model).toBe(INF);
  });

  it("does not let an infinite run take a normal slot: normal agents still launch with background slots full", async () => {
    ctx = await setup({ limits: { instance: 8, company: 8, agent: 5, background: 1 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    const normal = await ctx.worker("Normal");
    await ctx.ticket("Free one", ctx.ceo.id);
    await ctx.ticket("Free two", ctx.ceo.id);
    await ctx.ticket("Paid one", normal.id);
    await ctx.ticket("Paid two", normal.id);
    // One infinite run (its own background slot) plus both normal runs, all in one pass.
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 3 });
    const live = (await ctx.db.select().from(runs)).filter((r) => !r.endedAt);
    expect(live.filter((r) => r.model === INF)).toHaveLength(1);
    expect(live.filter((r) => r.model !== INF)).toHaveLength(2);
  });

  it("keeps the company's normal slots when the company limit is lower than the overall one (BOS-279 review)", async () => {
    // The company limit is the tight one here (2), below the overall 8, and both background slots are full. An infinite
    // run must not take either of the company's two normal slots, so normal work still launches both.
    ctx = await setup({ limits: { instance: 8, company: 2, agent: 5, background: 2 } });
    const p = await ctx.plan();
    // Two infinite agents, so the background slots actually fill.
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    const free2 = await ctx.worker("Free two");
    await ctx.req("PATCH", `/api/agents/${free2.id}`, { model: INF, fundingSourceId: p.id });
    const normal = await ctx.worker("Normal");
    await ctx.ticket("Free one", ctx.ceo.id);
    await ctx.ticket("Free two", free2.id);
    // Two infinite runs fill the background slots. The company's normal capacity is untouched: both its normal slots
    // (and the one kept for cards overall) are still free, which is what the idle-slot sweep and server_status read.
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 2 });
    expect(await ctx.scheduler.freeSlots(ctx.company.id)).toBe(2);
    // Normal work then takes both of the company's normal slots, which the infinite runs didn't use.
    await ctx.ticket("Paid one", normal.id);
    await ctx.ticket("Paid two", normal.id);
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 2 });
    const live = (await ctx.db.select().from(runs)).filter((r) => !r.endedAt);
    expect(live.filter((r) => r.model === INF)).toHaveLength(2);
    expect(live.filter((r) => r.model !== INF)).toHaveLength(2);
  });

  it("honours the owner's background limit from Settings", async () => {
    ctx = await setup({ limits: { instance: 8, company: 8, agent: 5, background: 1 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    await ctx.ticket("One", ctx.ceo.id);
    await ctx.ticket("Two", ctx.ceo.id);
    await ctx.ticket("Three", ctx.ceo.id);
    const saved = (await ctx.req("PUT", "/api/run-limits", { instance: 8, company: 8, background: 3 })).json() as { background: number; defaults: { background: number } };
    expect(saved).toMatchObject({ background: 3, defaults: { background: 2 } });
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 3 });
  });

  it("adds nothing to usage: an infinite run's cost event isn't recorded", async () => {
    ctx = await setup();
    const p = await ctx.plan();
    // An infinite agent and a normal one, both paid from the same plan.
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    const normal = await ctx.worker("Normal");
    await ctx.req("PATCH", `/api/agents/${normal.id}`, { fundingSourceId: p.id, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { reason: "woken by owner" });
    await ctx.req("POST", `/api/agents/${normal.id}/wake`, { reason: "woken by owner" });
    await ctx.req("POST", "/api/scheduler/tick");
    const freeRun = ctx.commands.find((c) => c.agentId === ctx.ceo.id)!;
    const paidRun = ctx.commands.find((c) => c.agentId === normal.id)!;
    // The infinite run's cost event is dropped...
    await ctx.emit({ type: "run.cost", runId: freeRun.runId, fundingSourceId: p.id, costMicrosDelta: 12_345, model: INF });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.db.select().from(costEvents).where(eq(costEvents.runId, freeRun.runId))).toEqual([]);
    // ...while the normal run's is still recorded, so the guard is specific to infinite mode.
    await ctx.emit({ type: "run.cost", runId: paidRun.runId, fundingSourceId: p.id, costMicrosDelta: 12_345, model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.db.select().from(costEvents).where(eq(costEvents.runId, paidRun.runId))).toHaveLength(1);
  });

  it("waits far longer before flagging an infinite run as stalled, but still flags a normal one on time", async () => {
    ctx = await setup({ limits: { agent: 5 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { reason: "woken by owner" });
    await ctx.req("POST", "/api/scheduler/tick");
    const run = ctx.commands.at(-1)!;
    await ctx.emit({ type: "run.started", runId: run.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: INF });
    const sweep = async () => (await ctx.req("POST", "/api/sweep")).json() as { stalledRuns: { raised: number } };
    // 20 minutes quiet: well past the normal 5-minute limit, still inside infinite mode's 30.
    ctx.advance(20 * 60_000);
    expect((await sweep()).stalledRuns.raised).toBe(0);
    // Past 30 minutes it is flagged.
    ctx.advance(12 * 60_000);
    expect((await sweep()).stalledRuns.raised).toBe(1);
  });

  it("keeps the longer check-queue limit for an infinite run waiting 45 minutes in the shared check slot (BOS-279 review)", async () => {
    ctx = await setup({ limits: { agent: 5 } });
    const p = await ctx.plan();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { model: INF, fundingSourceId: p.id });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { reason: "woken by owner" });
    await ctx.req("POST", "/api/scheduler/tick");
    const run = ctx.commands.at(-1)!;
    await ctx.emit({ type: "run.started", runId: run.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: INF });
    // The agent is inside scripts/check-quick.sh, waiting for a shared check slot: the 2-hour limit applies, not
    // the 30-minute infinite stall limit, so a 45-minute wait is not a stall.
    await ctx.emit({ type: "run.update", runId: run.runId, update: { kind: "tool_call", title: "Run quick check", rawInput: { command: "cd /work && scripts/check-quick.sh" }, status: "in_progress" } } as unknown as RunnerEvent);
    const sweep = async () => {
      await ctx.db.update(runners).set({ lastSeenAt: ctx.clock() });
      return (await ctx.req("POST", "/api/sweep")).json() as { stalledRuns: { raised: number } };
    };
    ctx.advance(45 * 60_000);
    expect((await sweep()).stalledRuns.raised).toBe(0);
    // Past two hours it is still flagged.
    ctx.advance(76 * 60_000);
    expect((await sweep()).stalledRuns.raised).toBe(1);
  });

  it("offers infinite mode for OpenCode on a Synthetic plan, in the Agents picker and in model_options", async () => {
    ctx = await setup();
    await ctx.plan();
    // The Agents page reads /models; the CEO's model_options tool reads the same catalog.
    const lists = (await ctx.req("GET", `/api/companies/${ctx.company.id}/models`)).json() as { runner: Record<string, Array<{ value: string }>>; infinite: Array<{ model: { value: string; name: string } }> };
    expect(lists.infinite).toHaveLength(1);
    expect(lists.infinite[0]!.model).toMatchObject({ value: INF });
    expect(lists.infinite[0]!.model.name).toContain("free");
    expect(lists.infinite[0]!.model.name).toContain("slow");
  });
});
