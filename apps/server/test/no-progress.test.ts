// "No progress while work waits" (BOS-593, N4 of BOS-588, DR-031): a company with waiting work and no
// clean run for an hour, or one error hitting several agents, gets one card that names the likely cause.
// A platform-side cause also reaches the home company's CEO.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, failureSignatures, runs, wakes } from "../src/db/schema.js";
import { likelyCause, NO_PROGRESS_QUIET_MS } from "../src/services/no-progress.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const MIN = 60_000;

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  /** A company with a CEO, two workers and a connected runner. The first one made is the home company. */
  const company = async (name: string) => {
    const { company, ceo } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name: `${name} Rod` })).json() as { id: string };
    const b = (await req("POST", `/api/companies/${company.id}/agents`, { name: `${name} Jane` })).json() as { id: string };
    const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
    const release = built.runners.connect(reg.runnerId, () => true);
    return { id: company.id, ceo: ceo.id, a: a.id, b: b.id, offline: () => release() };
  };
  const home = await company("Boss Man Co");
  /** A wake that has waited `ago` ms, held for `why`. */
  const waiting = (c: { id: string; a: string }, ago: number, why: string | null = "at a concurrency limit") =>
    db.insert(wakes).values({ companyId: c.id, agentId: c.a, reason: "engagement", status: "queued", statusReason: why, createdAt: new Date(clock().getTime() - ago) });
  const ran = (c: { id: string; a: string }, endedAgo: number, outcome: string | null) =>
    db.insert(runs).values({ companyId: c.id, agentId: c.a, startedAt: new Date(clock().getTime() - endedAgo - 5 * MIN), lastEventAt: new Date(clock().getTime() - endedAgo), endedAt: new Date(clock().getTime() - endedAgo), outcome });
  const cards = (companyId?: string) =>
    db
      .select()
      .from(decisions)
      .where(sql`${decisions.context}->'ladder'->>'kind' = 'no_progress'${companyId ? sql` and ${decisions.companyId} = ${companyId}` : sql``}`);
  const sweep = () => built.sweeps.run();
  return { ...built, db, close, req, company, home, waiting, ran, cards, sweep, clock, advance: (ms: number) => (offset += ms) };
}

describe("no progress while work waits (BOS-593)", () => {
  it("a company with work waiting an hour and no clean run gets one card naming the cause; a second sweep adds none", async () => {
    ctx = await setup();
    await ctx.waiting(ctx.home, 61 * MIN, "subscription weekly window nearly used up");
    await ctx.sweep();
    await ctx.sweep();
    const list = await ctx.cards();
    expect(list).toHaveLength(1);
    expect(list[0]!.companyId).toBe(ctx.home.id);
    expect(list[0]!.status).toBe("open");
    expect(list[0]!.question).toMatch(/Boss Man Co is making no progress/);
    expect(list[0]!.question).toMatch(/Likely cause: 1 of its wakes are held because the owner's account is near its usage limit/);
    // The owner's account is not Boss Man's side: no platform note.
    expect(list[0]!.question).not.toMatch(/Boss Man's side/);
  });

  it("raises nothing while runs are ending cleanly, even with work waiting, and nothing for work under an hour old", async () => {
    ctx = await setup();
    await ctx.waiting(ctx.home, 3 * 60 * MIN);
    await ctx.ran(ctx.home, 10 * MIN, "end_turn");
    await ctx.sweep();
    expect(await ctx.cards()).toHaveLength(0);

    const other = await ctx.company("Quiet Co");
    await ctx.waiting(other, 50 * MIN);
    await ctx.sweep();
    expect(await ctx.cards()).toHaveLength(0);
    // A failed or cut-off run is not progress.
    const third = await ctx.company("Failing Co");
    await ctx.waiting(third, 61 * MIN, null);
    await ctx.ran(third, 5 * MIN, "error: something broke");
    await ctx.ran(third, 6 * MIN, "lost: runner offline");
    await ctx.sweep();
    expect(await ctx.cards(third.id)).toHaveLength(1);
  });

  it("the CEO's run that only read the card is not progress: the card stays open", async () => {
    ctx = await setup();
    await ctx.waiting(ctx.home, 61 * MIN, null);
    await ctx.sweep();
    const [card] = await ctx.cards();
    expect(card!.status).toBe("open");
    await ctx.db.insert(runs).values({ companyId: ctx.home.id, agentId: ctx.home.ceo, origin: "decision", startedAt: new Date(ctx.clock().getTime() - MIN), endedAt: ctx.clock(), outcome: "end_turn" });
    ctx.advance(1000);
    await ctx.sweep();
    expect((await ctx.cards())[0]!.status).toBe("open");
  });

  it("closes by itself once a run there finishes cleanly", async () => {
    ctx = await setup();
    await ctx.waiting(ctx.home, 61 * MIN, null);
    await ctx.sweep();
    expect((await ctx.cards())[0]!.status).toBe("open");
    ctx.advance(2 * MIN);
    await ctx.ran(ctx.home, 0, "end_turn");
    await ctx.sweep();
    const [card] = await ctx.cards();
    expect(card!.status).toBe("withdrawn");
    expect((card!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/finished cleanly/);
  });

  it("a platform-side cause also reaches the home company's CEO: HolidayHours held at the all-companies limit", async () => {
    ctx = await setup();
    const hh = await ctx.company("HolidayHours");
    // Nothing of its own running, its wakes held "at a concurrency limit": the all-companies limit (DR-031).
    await ctx.waiting(hh, 18 * 60 * MIN);
    // Boss Man Co is busy and fine.
    await ctx.ran(ctx.home, 5 * MIN, "end_turn");
    await ctx.sweep();
    const theirs = await ctx.cards(hh.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.question).toMatch(/waited up to 18 hours/);
    expect(theirs[0]!.question).toMatch(/other companies' runs are filling the all-companies run limit/);
    expect(theirs[0]!.question).toMatch(/Boss Man's own CEO has been told too/);
    const copy = await ctx.cards(ctx.home.id);
    expect(copy).toHaveLength(1);
    expect(copy[0]!.question).toMatch(/Another company, HolidayHours, is making no progress because of the all-companies run limit/);
    // Waiting on the home company's CEO, not its Scrum Master.
    expect((copy[0]!.context as { ladder: { rung: string } }).ladder.rung).toBe("ceo");
    // Both close on HolidayHours' next clean run.
    ctx.advance(MIN);
    await ctx.ran(hh, 0, "end_turn");
    await ctx.sweep();
    expect((await ctx.cards()).map((c) => c.status)).toEqual(["withdrawn", "withdrawn"]);
  });

  it("an offline runner is named, and is platform-side", async () => {
    ctx = await setup();
    const hh = await ctx.company("HolidayHours");
    hh.offline();
    await ctx.waiting(hh, 2 * 60 * MIN, "runner offline");
    await ctx.sweep();
    expect((await ctx.cards(hh.id))[0]!.question).toMatch(/its runner is offline/);
    expect(await ctx.cards(ctx.home.id)).toHaveLength(1);
  });

  it("3 failures with the same error across 2 agents within an hour raise the card, even with nothing waiting", async () => {
    ctx = await setup();
    const hh = await ctx.company("HolidayHours");
    const err = "fatal: unable to access 'http://192.168.1.20/git/app.git/': Failed to connect to 192.168.1.20 port 80: Connection refused";
    const at = (ago: number) => new Date(ctx!.clock().getTime() - ago);
    await ctx.db.insert(failureSignatures).values([
      { companyId: hh.id, agentId: hh.a, signature: "sig-net", sample: err, createdAt: at(40 * MIN) },
      { companyId: hh.id, agentId: hh.a, signature: "sig-net", sample: err, createdAt: at(20 * MIN) },
      { companyId: hh.id, agentId: hh.b, signature: "sig-net", sample: err, createdAt: at(5 * MIN) },
    ]);
    await ctx.sweep();
    const [card] = await ctx.cards(hh.id);
    expect(card!.question).toMatch(/the same failure came back 3 times in the last hour, for 2 different agents/);
    expect(card!.question).toMatch(/the network guard may be refusing a host it needs/);
    expect(card!.question).toContain("Connection refused");
    // The network guard is Boss Man's: the home CEO hears too.
    expect(await ctx.cards(ctx.home.id)).toHaveLength(1);
  });

  it("the same error from one agent, or spread over more than an hour, is the loop guard's, not this card", async () => {
    ctx = await setup();
    const at = (ago: number) => new Date(ctx!.clock().getTime() - ago);
    const h = ctx.home;
    await ctx.db.insert(failureSignatures).values([
      { companyId: h.id, agentId: h.a, signature: "one-agent", sample: "boom", createdAt: at(10 * MIN) },
      { companyId: h.id, agentId: h.a, signature: "one-agent", sample: "boom", createdAt: at(20 * MIN) },
      { companyId: h.id, agentId: h.a, signature: "one-agent", sample: "boom", createdAt: at(30 * MIN) },
      { companyId: h.id, agentId: h.a, signature: "slow", sample: "bang", createdAt: at(90 * MIN) },
      { companyId: h.id, agentId: h.b, signature: "slow", sample: "bang", createdAt: at(30 * MIN) },
      { companyId: h.id, agentId: h.a, signature: "slow", sample: "bang", createdAt: at(10 * MIN) },
    ]);
    await ctx.sweep();
    expect(await ctx.cards()).toHaveLength(0);
  });

  it("after a person answers the card, waits before raising another for the same company", async () => {
    ctx = await setup();
    await ctx.waiting(ctx.home, 61 * MIN, null);
    await ctx.sweep();
    const [card] = await ctx.cards();
    await ctx.db.update(decisions).set({ status: "answered", answer: "Got it", answeredAt: ctx.clock() }).where(eq(decisions.id, card!.id));
    ctx.advance(60 * MIN);
    await ctx.sweep();
    expect((await ctx.cards()).filter((c) => c.status === "open")).toHaveLength(0);
    ctx.advance(NO_PROGRESS_QUIET_MS);
    await ctx.sweep();
    expect((await ctx.cards()).filter((c) => c.status === "open")).toHaveLength(1);
  });
});

describe("likelyCause (BOS-593)", () => {
  const base = { runnerConnected: true, liveRuns: 0, liveInCheckLine: 0, holds: [] as Array<string | null>, badEnds: [] as string[] };
  it("names each cause, and marks the platform-side ones", () => {
    expect(likelyCause({ ...base, runnerConnected: null }).platform).toBe("runner");
    expect(likelyCause({ ...base, runnerConnected: false }).platform).toBe("runner");
    expect(likelyCause({ ...base, badEnds: ["lost: runner restarted", "lost: runner offline"] }).platform).toBe("runner");
    expect(likelyCause({ ...base, badEnds: ["error: Could not resolve host: git.local"] }).platform).toBe("network guard");
    expect(likelyCause({ ...base, liveRuns: 2, liveInCheckLine: 2 }).platform).toBe("check line");
    expect(likelyCause({ ...base, holds: ["at a concurrency limit"] }).platform).toBe("run limit");
    // Its own runs fill its own limit: the company's, not the platform's.
    const own = likelyCause({ ...base, liveRuns: 3, liveInCheckLine: 1, holds: ["at a concurrency limit"] });
    expect(own.platform).toBe(false);
    expect(own.text).toMatch(/its own run limit is full/);
    expect(likelyCause({ ...base, holds: ["budget limit reached"] }).text).toMatch(/budget or cost cap/);
    expect(likelyCause({ ...base, badEnds: ["error: tests failed", "error: tests failed", "error: other"] }).text).toMatch(/keep failing \(3 in the last hour\): "error: tests failed"/);
    expect(likelyCause({ ...base, badEnds: ["error: Claude Max: weekly limit reached"] }).text).toMatch(/Claude Max: the weekly limit/);
    expect(likelyCause(base).text).toMatch(/can't tell why/);
  });
});
