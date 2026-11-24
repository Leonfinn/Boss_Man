// BOS-846: a run ends itself after a time limit the owner sets (per company, off by default).
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, runners, runs } from "../src/db/schema.js";
import { runLimitReason } from "../src/services/run-time-limit.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runnerRow] = await db.select().from(runners);
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true), []);
  // The runner's own run.ended, through the same ingest the real socket uses.
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock().toISOString(), event });
  const startRun = async (agoMin: number) => {
    const id = randomUUID();
    await db.insert(runs).values({ id, companyId: company.id, agentId: worker.id, startedAt: new Date(clock().getTime() - agoMin * MIN), acpSessionId: "s", lastEventAt: clock() });
    return id;
  };
  const row = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;
  // Only this feature's cards: a ticketless old run also draws the Scrum Master's own card.
  const limitCards = async () => (await db.select().from(decisions)).filter((d) => d.dedupeKey?.startsWith("run-time-limit:"));
  const limit = (maxRunMinutes: number | null) => req("PATCH", `/api/companies/${company.id}`, { maxRunMinutes });
  return { ...built, db, close, company, worker, sent, emit, startRun, row, limit, limitCards, req, advance: (ms: number) => void (offset += ms) };
}

describe("run time limit", () => {
  it("is off by default: a very old run is left alone", async () => {
    ctx = await setup();
    expect((await ctx.db.select().from(companies).where(eq(companies.id, ctx.company.id)))[0]!.maxRunMinutes).toBeNull();
    const id = await ctx.startRun(24 * 60);
    await ctx.sweeps.run();
    expect(ctx.sent.filter((c) => c.type === "run.cancel")).toEqual([]);
    expect((await ctx.row(id)).cancelRequestedAt).toBeNull();
    expect(await ctx.limitCards()).toEqual([]);
  });

  it("stops a run past the limit through the normal cancel, once, and leaves a younger run alone", async () => {
    ctx = await setup();
    expect((await ctx.limit(60)).statusCode).toBe(200);
    const old = await ctx.startRun(61);
    const young = await ctx.startRun(10);
    await ctx.sweeps.run();
    await ctx.sweeps.run();
    const cancels = ctx.sent.filter((c) => c.type === "run.cancel");
    expect(cancels).toEqual([{ type: "run.cancel", runId: old }]);
    expect((await ctx.row(old)).cancelRequestedAt).not.toBeNull();
    expect((await ctx.row(young)).cancelRequestedAt).toBeNull();
    // The runner confirms the stop: the run reads "Stopped: run time limit (60 min)".
    await ctx.runners.endRun(old, "cancelled", new Date());
    expect((await ctx.row(old)).outcome).toBe("stopped: run time limit (60 min)");
  });

  it("keeps the real outcome when the run finishes by itself before the runner confirms the stop", async () => {
    ctx = await setup();
    await ctx.limit(60);
    const id = await ctx.startRun(61);
    // The limit asks for a stop, which records the why and tells the runner.
    await ctx.sweeps.run();
    expect(ctx.sent.filter((c) => c.type === "run.cancel")).toEqual([{ type: "run.cancel", runId: id }]);
    // In the gap before it confirms the stop, the run finishes its own turn (end_turn): the outcome
    // the runner reports is the real one, not "stopped: run time limit".
    await ctx.emit({ type: "run.ended", runId: id, stopReason: "end_turn", error: null });
    expect((await ctx.row(id)).outcome).toBe("end_turn");
  });

  it("a run the runner confirms as cancelled still reads 'stopped: run time limit'", async () => {
    ctx = await setup();
    await ctx.limit(60);
    const id = await ctx.startRun(61);
    await ctx.sweeps.run();
    await ctx.emit({ type: "run.ended", runId: id, stopReason: "cancelled", error: null });
    expect((await ctx.row(id)).outcome).toBe("stopped: run time limit (60 min)");
  });

  it("leaves a run that already ended with its recorded outcome", async () => {
    ctx = await setup();
    await ctx.limit(60);
    const id = await ctx.startRun(61);
    // It ended on its own before the sweep ran; the sweep must not re-end it or change its outcome.
    await ctx.emit({ type: "run.ended", runId: id, stopReason: "end_turn", error: null });
    expect((await ctx.row(id)).outcome).toBe("end_turn");
    // The server's own end refuses an already-ended run, so the recorded outcome stands.
    expect(await ctx.runners.endRun(id, "cancelled", new Date())).toBe(false);
    expect((await ctx.row(id)).outcome).toBe("end_turn");
  });

  it("raises one owner card per stopped run, and Raise the limit lifts the limit by half", async () => {
    ctx = await setup();
    await ctx.limit(60);
    const id = await ctx.startRun(75);
    await ctx.sweeps.run();
    await ctx.sweeps.run();
    const cards = await ctx.limitCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.options).toEqual(["Raise the limit", "Leave it"]);
    expect(cards[0]!.tier).toBe("owner");
    expect(cards[0]!.question).toContain("Engineer");
    expect(cards[0]!.dedupeKey).toBe(`run-time-limit:${id}`);
    const answered = await ctx.req("POST", `/api/decisions/${cards[0]!.id}/answer`, { answer: "Raise the limit" });
    expect(answered.statusCode).toBe(200);
    expect((await ctx.db.select().from(companies).where(eq(companies.id, ctx.company.id)))[0]!.maxRunMinutes).toBe(90);
  });

  it("Raise the limit never goes above the 10080-minute cap the Settings field accepts", async () => {
    ctx = await setup();
    await ctx.limit(9000);
    await ctx.startRun(9100);
    await ctx.sweeps.run();
    const cards = await ctx.limitCards();
    expect(cards).toHaveLength(1);
    const answered = await ctx.req("POST", `/api/decisions/${cards[0]!.id}/answer`, { answer: "Raise the limit" });
    expect(answered.statusCode).toBe(200);
    expect((await ctx.db.select().from(companies).where(eq(companies.id, ctx.company.id)))[0]!.maxRunMinutes).toBe(10080);
  });

  it("Leave it changes nothing, and clearing the limit with null switches it off", async () => {
    ctx = await setup();
    await ctx.limit(30);
    await ctx.startRun(45);
    await ctx.sweeps.run();
    const [card] = await ctx.limitCards();
    expect((await ctx.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Leave it" })).statusCode).toBe(200);
    expect((await ctx.db.select().from(companies).where(eq(companies.id, ctx.company.id)))[0]!.maxRunMinutes).toBe(30);
    expect((await ctx.limit(null)).statusCode).toBe(200);
    expect((await ctx.limit(0)).statusCode).toBe(400);
  });

  it("only the signed-in owner can change the limit: a call with no owner session is refused", async () => {
    ctx = await setup();
    const res = await ctx.app.inject({ method: "PATCH", url: `/api/companies/${ctx.company.id}`, payload: { maxRunMinutes: 5 } });
    expect(res.statusCode).toBe(401);
    expect((await ctx.db.select().from(companies).where(eq(companies.id, ctx.company.id)))[0]!.maxRunMinutes).toBeNull();
  });
});

// BOS-2352: the reason text the stop carries (and the outcome is built from), on its own.
describe("runLimitReason (BOS-2352)", () => {
  it("names the limit in minutes in the form the run's outcome reads", () => {
    expect(runLimitReason(60)).toBe("run time limit (60 min)");
    expect(runLimitReason(1)).toBe("run time limit (1 min)");
    expect(runLimitReason(90.5)).toBe("run time limit (90.5 min)");
  });
});
