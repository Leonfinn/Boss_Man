// BOS-2786: a runner update queued behind a server update's trial gets Boss Man's own wrap-up, so the host is quiet when
// the trial ends without the owner pressing "Ask agents to wrap up". It is the owner's wrap-up (same hold, tie and ends),
// started by Boss Man: new work and checks are held from the press, running agents are asked to finish
// AUTO_WRAPUP_TELL_LEAD_MIN before the trial ends, and it lifts by itself when the update is in, fails, is cancelled or
// the trial is switched back.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, projects, runners, runs, settings, tickets, wakes } from "../src/db/schema.js";
import { AUTO_WRAP_EVERY_MS, getHold, WRAP_UP_ASKED, WRAP_UP_AUTO, WRAPUP_HOLD_REASON } from "../src/services/maintenance.js";
import { AUTO_WRAPUP_QUEUED_GRACE_MIN, AUTO_WRAPUP_TELL_LEAD_MIN } from "../src/services/update-waits.js";

const MIN = 60_000;
const KEY = "k".repeat(43);
const ID = "11111111-2222-4333-8444-555555555555";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-autowrap-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "key"), `${KEY}\n`);
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  // No launcher: the swap finishes on the pass after the drain takes over (nothing to recreate).
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock, deployerDir: dir, drainReconnectMs: 1000 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const commands: Array<Extract<RunnerCommand, { type: "run.start" }>> = [];
  const messages: Array<Extract<RunnerCommand, { type: "run.message" }>> = [];
  const { company: co, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const reg = (await req("POST", `/api/companies/${co.id}/runner`)).json() as { runnerId: string };
  const [row] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  built.runners.connect(reg.runnerId, (cmd) => {
    if (cmd.type === "run.start") commands.push(cmd);
    if (cmd.type === "run.message") messages.push(cmd);
    return true;
  }, ["check-jobs", "merge-base"]);
  let seq = 0;
  const endRun = (runId: string) => built.runners.ingest(row!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
  const ticket = async (number: number, o: Partial<typeof tickets.$inferInsert> = {}) => {
    const [p] = await db.insert(projects).values({ companyId: co.id, name: `P${number}` }).returning();
    const [t] = await db.insert(tickets).values({ companyId: co.id, projectId: p!.id, title: `T${number}`, number, systemState: "ready", assigneeAgentId: ceo.id, ...o }).returning();
    return t!.id;
  };
  const advance = (ms: number) => (offset += ms);
  const maint = () => req("GET", "/api/maintenance").then((r) => r.json());
  const put = (key: string, value: unknown) => db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  /** The server update went live and is on its trial until `trialEnd` (the deploy wait's window phase). */
  const onTrial = (trialEnd: Date) =>
    put("deploy_wait", { decisionId: ID, commit: "b".repeat(40), fromCommit: "a".repeat(40), approvedAt: new Date(clock().getTime() - 5 * MIN).toISOString(), phase: "window", windowUntil: trialEnd.toISOString(), deadline: trialEnd.toISOString(), minutes: 30, origin: "approve" });
  /** The owner's Build and update runners press, queued behind the trial (BOS-1086). */
  const queueRunner = (trialEnd: Date) => put("self_deploy_runner_due", { commit: "b".repeat(40), fromCommit: "a".repeat(40), after: trialEnd.toISOString(), offer: true, pressed: clock().toISOString() });
  const report = (s: { id: string; target: string; result: string }) =>
    writeFile(path.join(dir, "outbox", "status.json"), JSON.stringify({ ...s, message: "", from_commit: "a".repeat(40), to_commit: "b".repeat(40), started: clock().toISOString(), ended: s.result === "running" ? "" : clock().toISOString() }));
  const drainFile = (reason?: string) => writeFile(path.join(dir, "inbox", "drain.json"), JSON.stringify({ by: "update-runner.sh", ...(reason ? { reason } : {}) }));
  /** A drain pass after the auto-wrap read interval, so the chain is read on it. */
  const pass = async () => {
    advance(AUTO_WRAP_EVERY_MS);
    await built.maintenance.step();
  };
  return { ...built, db, close, dir, req, co, ceo, commands, messages, endRun, ticket, advance, maint, put, onTrial, queueRunner, report, drainFile, pass, now: clock };
}

describe("Boss Man's own wrap-up for a runner update queued behind a trial (BOS-2786)", () => {
  it("queued during the trial: holds new work at once, asks running agents to finish at the lead time, and the swap takes it over at the trial's end", async () => {
    const c = (ctx = await setup());
    // An agent is working when the server update goes on trial.
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "woken by owner" });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    const h = await getHold(c.db);
    expect(h).toMatchObject({ kind: "wrapup", forUpdate: "runner", auto: { startsAt: trialEnd.toISOString(), tellAt: new Date(trialEnd.getTime() - AUTO_WRAPUP_TELL_LEAD_MIN * MIN).toISOString() } });
    // Not told yet: the lead time is still ahead. New work is held from now.
    expect(c.messages).toHaveLength(0);
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "nudge", note: "routine" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0 });
    expect((await c.db.select().from(wakes).where(eq(wakes.status, "queued"))).map((w) => w.statusReason)).toContain(WRAPUP_HOLD_REASON);
    // The screen says Boss Man is doing it, and when it asks agents to finish.
    const m = (await c.maint()) as { kind: string; wrapTie: { by?: string; tellAt?: string; runner?: { stage: string } } };
    expect(m).toMatchObject({ kind: "wrapup", wrapTie: { by: "boss-man", tellAt: h!.auto!.tellAt, runner: { stage: "queued" } } });
    // At the lead time the running agent is told, once.
    c.advance(4 * MIN);
    await c.maintenance.step();
    expect(c.messages.map((x) => x.text)).toEqual([expect.stringContaining(WRAP_UP_AUTO)]);
    await c.maintenance.step();
    expect(c.messages).toHaveLength(1);
    await c.endRun(c.commands[0]!.runId);
    // The trial ends; the runner request goes to the host, builds, and the drain takes the wrap-up over and swaps.
    c.advance(11 * MIN);
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await c.db.delete(settings).where(eq(settings.key, "self_deploy_runner_due"));
    await c.report({ id: "runner-1", target: "runner", result: "running" });
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", tie: { runner: { stage: "building" } } });
    await c.drainFile();
    await c.maintenance.step();
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(((await c.maint()) as { last?: { body: string } }).last?.body).toContain("The wrap-up Boss Man started");
  });

  it("queued with less than the lead time left: agents are asked at once", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "woken by owner" });
    await c.scheduler.tick();
    const trialEnd = new Date(c.now().getTime() + 3 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    expect(c.messages.map((x) => x.text)).toEqual([expect.stringContaining(WRAP_UP_AUTO)]);
  });

  it("the trial is switched back: the queued update is cancelled and the wrap-up lifts by itself, and work restarts", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", auto: expect.any(Object) });
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "nudge", note: "routine" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0 });
    // The host switched the server back in its trial: the deploy wait ends and the queued press is cancelled.
    await c.report({ id: ID, target: "server", result: "rolled_back" });
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await c.db.delete(settings).where(eq(settings.key, "self_deploy_runner_due"));
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.maint()).last).toMatchObject({ title: "Wrap-up lifted: the server update was switched back" });
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1); // the held wake started
  });

  it("the queued update is cancelled by the owner: lifts after the grace minute", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    await c.db.delete(settings).where(eq(settings.key, "self_deploy_runner_due"));
    await c.maintenance.step();
    c.advance(2 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.maint()).last).toMatchObject({ title: "Wrap-up lifted: the runner update was cancelled" });
  });

  it("drain cap: the runner update is still only queued well after the trial's end, so the wrap-up gives up and work restarts", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 5 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    expect(await getHold(c.db)).not.toBeNull();
    // The trial ends but something else holds the press back: it stays queued.
    // (pass() already moved the clock 30 s; this lands about a minute short of the grace's end.)
    c.advance(5 * MIN + AUTO_WRAPUP_QUEUED_GRACE_MIN * MIN - 90_000);
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull();
    c.advance(2 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.maint()).last).toMatchObject({ title: expect.stringContaining(`within ${AUTO_WRAPUP_QUEUED_GRACE_MIN} minutes of the trial's end`) });
  });

  it("an urgent and a fixes-live wake still start during it; a routine one is held", async () => {
    const c = (ctx = await setup());
    const urgent = await c.ticket(1, { urgent: true });
    const plain = await c.ticket(2);
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "assigned", ticketId: urgent });
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "nudge", ticketId: plain, note: "routine" });
    await c.scheduler.tick();
    expect((await c.db.select().from(runs)).map((r) => [r.ticketId, r.passedUpdateHold])).toEqual([[urgent, true]]);
    // The urgent run is never told to wrap up.
    c.advance(10 * MIN);
    await c.maintenance.step();
    expect(c.messages).toHaveLength(0);
  });

  it("the owner presses Ask agents to wrap up too: same hold, agents told now with the owner's words, and Boss Man does not tell them again", async () => {
    const c = (ctx = await setup());
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "woken by owner" });
    await c.scheduler.tick();
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    const before = await getHold(c.db);
    expect((await c.req("POST", "/api/maintenance/wrapup", {})).statusCode).toBeLessThan(300);
    const after = await getHold(c.db);
    expect(after).toMatchObject({ kind: "wrapup", since: before!.since, ownerPressedAt: expect.any(String), auto: { startsAt: trialEnd.toISOString() } });
    expect(c.messages.map((x) => x.text)).toEqual([expect.stringContaining(WRAP_UP_ASKED)]);
    c.advance(10 * MIN);
    await c.maintenance.step();
    expect(c.messages).toHaveLength(1);
    // The screen now words it as the owner's ask.
    expect(((await c.maint()) as { wrapTie: { by?: string } }).wrapTie.by).toBeUndefined();
  });

  it("the owner cancels it: work restarts and Boss Man does not start it again for the same press", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.queueRunner(trialEnd);
    await c.pass();
    expect((await c.req("POST", "/api/maintenance/cancel", {})).statusCode).toBeLessThan(300);
    expect(await getHold(c.db)).toBeNull();
    await c.pass();
    await c.pass();
    expect(await getHold(c.db)).toBeNull();
  });

  // BOS-2808: before, only a hold Boss Man started recorded the "don't start again" marker, so cancelling the owner's own
  // wrap-up was undone by Boss Man's wrap-up on the next read of the chain (about 30 s later).
  it("the owner cancels their own wrap-up while a runner update is queued behind the trial: Boss Man does not start one", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.req("POST", "/api/maintenance/wrapup", {});
    await c.queueRunner(trialEnd);
    await c.pass();
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", forUpdate: "runner" });
    expect((await getHold(c.db))!.auto).toBeUndefined();
    expect((await c.req("POST", "/api/maintenance/cancel", {})).statusCode).toBeLessThan(300);
    expect(await getHold(c.db)).toBeNull();
    await c.pass();
    await c.pass();
    c.advance(5 * MIN);
    await c.pass();
    expect(await getHold(c.db)).toBeNull();
    // The cancel note says so, as for Boss Man's own wrap-up.
    expect((await c.maint()).last.body).toContain("Boss Man won't wrap up again for this runner update");
  });

  it("the owner cancels their own wrap-up with nothing queued: a runner update queued later still gets Boss Man's wrap-up", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.req("POST", "/api/maintenance/wrapup", {});
    await c.req("POST", "/api/maintenance/cancel", {});
    expect((await c.maint()).last.body).not.toContain("Boss Man won't wrap up again");
    await c.queueRunner(trialEnd);
    await c.pass();
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", auto: expect.any(Object) });
  });

  it("the owner pressed first: Boss Man adds no second hold and keeps the owner's words", async () => {
    const c = (ctx = await setup());
    const trialEnd = new Date(c.now().getTime() + 14 * MIN);
    await c.onTrial(trialEnd);
    await c.req("POST", "/api/maintenance/wrapup", {});
    const first = await getHold(c.db);
    await c.queueRunner(trialEnd);
    await c.pass();
    const h = await getHold(c.db);
    expect(h).toMatchObject({ kind: "wrapup", since: first!.since, forUpdate: "runner" });
    expect(h!.auto).toBeUndefined();
  });

  // Before BOS-2786 the dispatcher read the hold through runnerCardHold, which leaves a wrap-up out: the owner's "no new
  // checks either" was never enforced, and merge checks kept starting during a wrap-up.
  it("a wrap-up (the owner's or Boss Man's) hands no new check to the runner; it starts once the wrap-up ends", async () => {
    const c = (ctx = await setup());
    await c.put("check_queue_mode", "server");
    const t = await c.ticket(7);
    const [p] = await c.db.select({ id: tickets.projectId }).from(tickets).where(eq(tickets.id, t));
    await c.req("POST", "/api/maintenance/wrapup", {});
    await c.db.insert(checkJobs).values({ companyId: c.co.id, projectId: p!.id, ticketId: t, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "queued" });
    await c.checks.pump();
    expect((await c.db.select().from(checkJobs)).map((j) => j.state)).toEqual(["queued"]);
    // The same queue with no wrap-up: the runner takes it (so the hold, not the setup, kept it back above).
    await c.req("POST", "/api/maintenance/cancel", {});
    await c.checks.pump();
    expect((await c.db.select().from(checkJobs)).map((j) => j.state)).toEqual(["running"]);
  });

  it("nothing queued, or a queue with no trial in front: Boss Man starts nothing", async () => {
    const c = (ctx = await setup());
    await c.onTrial(new Date(c.now().getTime() + 14 * MIN));
    await c.pass();
    expect(await getHold(c.db)).toBeNull();
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await c.queueRunner(new Date(c.now().getTime() - MIN));
    await c.pass();
    expect(await getHold(c.db)).toBeNull();
  });
});
