import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, runs, wakes } from "../src/db/schema.js";
import { limitRequeue, limitWindowKey, LIMIT_HELD_PREFIX } from "../src/services/limit-requeue.js";

// BOS-1438: a run the account refuses for a usage limit goes back in the queue as held work, once per
// limit window, held to the account's real reset (not to BOS-463's made-up one-hour reading).

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.release();
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const START = new Date("2026-11-14T15:00:00Z");
const HOUR = 3_600_000;

async function setup() {
  const { db, close } = await openPglite();
  const clock = { t: new Date(START) };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => new Date(clock.t) });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  const release = built.runners.connect(reg.runnerId, (c) => {
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  let seq = 0;
  const endRun = (runId: string, error: string | null) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock.t.toISOString(), event: { type: "run.ended", runId, stopReason: error ? null : "end_turn", error } });
  const source = (await req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
  await req("PATCH", `/api/agents/${ceo.id}`, { fundingSourceId: source.id });
  // The account's own reading before the refusal: its week resets in two days.
  const realReset = new Date(START.getTime() + 48 * HOUR);
  await built.funding.recordQuota(source.id, [{ provider: "anthropic", window: "seven_day", utilization: 0.5, resetsAt: realReset, status: null, overageInUse: false }], START);
  const tick = async () => {
    await built.scheduler.slow();
    return built.scheduler.tick();
  };
  const requeue = limitRequeue(db, { now: () => new Date(clock.t) });
  return { ...built, db, close, req, company, ceo, source, commands, endRun, tick, clock, release, realReset, requeue };
}

/** Polls until `check` returns true, with a deadline (no fixed sleep: GitHub's runners are several times slower). */
async function waitUntil(what: string, check: () => Promise<boolean>, deadlineMs = 30_000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Starts the agent's wake and ends its run with the given error, then waits for the positive signal that the
 * run-ended handling is done: `settled` (default: the run's outcome is stored; pass a stronger one when the
 * handler is expected to leave a held wake or a card).
 */
async function refuse(c: NonNullable<typeof ctx>, error: string, settled?: () => Promise<boolean>) {
  await c.scheduler.wake({ agentId: c.ceo.id, reason: "review", note: "Review BOS-1" });
  await c.tick();
  const run = c.commands.at(-1)!;
  await c.endRun(run.runId, error);
  await waitUntil("the run's outcome", async () => {
    const [r] = await c.db.select({ outcome: runs.outcome }).from(runs).where(eq(runs.id, run.runId));
    return !!r?.outcome;
  });
  if (settled) await waitUntil("the run-ended handling", settled);
  return run;
}

const heldWakes = (c: NonNullable<typeof ctx>) => c.db.select().from(wakes).where(and(eq(wakes.agentId, c.ceo.id), like(wakes.statusReason, `${LIMIT_HELD_PREFIX}%`)));

describe("a run refused for an account limit (BOS-1438)", () => {
  it("1. requeues its wake once, held, with the account's real reset time", async () => {
    const c = (ctx = await setup());
    const run = await refuse(c, "Claude Max: You've hit your weekly limit", async () => (await heldWakes(c)).length === 1);
    expect(run.runId).toBeTruthy();
    const held = await heldWakes(c);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: "deferred", reason: "review", note: "Review BOS-1", agentId: c.ceo.id });
    expect(held[0]!.notBefore?.toISOString()).toBe(c.realReset.toISOString());
  });

  it("2. does not start just because the one-hour made-up reading expires; starts after the real reset with a fresh reading", async () => {
    const c = (ctx = await setup());
    await refuse(c, "Claude Max: You've hit your weekly limit", async () => (await heldWakes(c)).length === 1);
    const started = c.commands.length;

    c.clock.t = new Date(START.getTime() + 2 * HOUR); // the made-up hour is over, the real reset is not
    await c.tick();
    expect(c.commands).toHaveLength(started);
    expect(await heldWakes(c)).toHaveLength(1);

    c.clock.t = new Date(c.realReset.getTime() + 60_000);
    await c.funding.recordQuota(c.source.id, [{ provider: "anthropic", window: "seven_day", utilization: 0.02, resetsAt: new Date(c.realReset.getTime() + 7 * 24 * HOUR), status: null, overageInUse: false }], c.clock.t);
    await c.tick();
    expect(c.commands).toHaveLength(started + 1);
  });

  it("3. a second refusal in the same window raises the account card and does not requeue again", async () => {
    const c = (ctx = await setup());
    const first = await refuse(c, "Claude Max: You've hit your weekly limit", async () => (await heldWakes(c)).length === 1);
    // The account shows room again (a real reading), which frees the held wake early.
    c.clock.t = new Date(START.getTime() + 2 * HOUR);
    await c.funding.recordQuota(c.source.id, [{ provider: "anthropic", window: "seven_day", utilization: 0.1, resetsAt: c.realReset, status: null, overageInUse: false }], c.clock.t);
    expect(await c.requeue.releaseReady()).toBe(1);
    await c.tick();
    const second = c.commands.at(-1)!;
    expect(second.runId).not.toBe(first.runId);
    await c.endRun(second.runId, "Claude Max: You've hit your weekly limit");
    const hasCard = async () => (await c.db.select().from(decisions).where(eq(decisions.companyId, c.company.id))).some((d) => JSON.stringify(d.context).includes("account_limit"));
    await waitUntil("the account_limit card", hasCard);
    expect(await heldWakes(c)).toHaveLength(0); // the first one was released; no new one was made
  });

  it("4. the held wake carries the label (waiting for the account until the reset) and clears when it starts", async () => {
    const c = (ctx = await setup());
    await refuse(c, "Claude Max: You've hit your weekly limit", async () => (await heldWakes(c)).length === 1);
    const [held] = await heldWakes(c);
    expect(held!.statusReason).toBe(`${LIMIT_HELD_PREFIX} waiting for Claude Max until 2026-11-16 15:00 UTC`);
    c.clock.t = new Date(c.realReset.getTime() + 60_000);
    await c.funding.recordQuota(c.source.id, [{ provider: "anthropic", window: "seven_day", utilization: 0.02, resetsAt: new Date(c.realReset.getTime() + 7 * 24 * HOUR), status: null, overageInUse: false }], c.clock.t);
    await c.tick();
    const [after] = await c.db.select().from(wakes).where(eq(wakes.id, held!.id));
    expect(after).toMatchObject({ status: "launched", statusReason: null });
  });

  it("5. does not requeue a login or key error", async () => {
    const c = (ctx = await setup());
    for (const error of ["Invalid API key", "You are logged out, please sign in again", "Your credit balance is too low"]) {
      const run = await refuse(c, `Claude Max: ${error}`);
      expect(await heldWakes(c), error).toHaveLength(0);
      // Asked directly, it says why: not a limit.
      expect(await c.requeue.afterRun(run.runId), error).toEqual({ outcome: "not_a_limit" });
    }
    expect(await heldWakes(c)).toHaveLength(0);
  });
});

describe("limitWindowKey", () => {
  it("maps the provider's limit wording to the quota readings' window names", () => {
    // accountOutage hands it the wording as "the <limit>".
    expect(limitWindowKey("the weekly limit")).toBe("seven_day");
    expect(limitWindowKey("the 5-hour limit")).toBe("five_hour");
    expect(limitWindowKey("the five-hour limit")).toBe("five_hour");
    expect(limitWindowKey("the rate limit")).toBe("rate_limit");
    expect(limitWindowKey("the usage limit")).toBe("usage_limit");
    expect(limitWindowKey("the quota")).toBe("quota");
  });

  it("keeps empty or unknown wording usable as a key", () => {
    expect(limitWindowKey("")).toBe("");
    expect(limitWindowKey("the ")).toBe("");
    expect(limitWindowKey("hourly")).toBe("hourly");
    expect(limitWindowKey("per   request")).toBe("per_request");
  });
});
