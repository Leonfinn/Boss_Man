import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers, companies, decisions, notifications, projects, runners, runs, settings, tickets, wakes } from "../src/db/schema.js";
import { BUILD_HOLD_MAX_MINUTES, DRAIN_GO_AHEAD_MINUTES, drainForecast, drainGoAheadAt, getHold, HOLD_CAP_MINUTES, HOLD_REASON, holdBlocksStarts, holdCapAt, holdEndsAt, SWAP_WHEN_DONE_CAP_MINUTES, WRAP_UP, WRAP_UP_ASKED, WRAP_UP_DURING_UPDATE, WRAP_UP_SETTINGS } from "../src/services/maintenance.js";
import { CEO_REPLY_REASON, MISSED_REASON, UPDATE_ALERT_REASON } from "../src/services/scheduler.js";
import { activeWaits, WAIT_RULES } from "../src/services/update-waits.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

const MIN = 60_000;
/** Steps the drain past every retry of a failing swap (3 tries, 30 s then 60 s apart). */
async function retryOut(c: { maintenance: { step: () => Promise<unknown> }; advance: (ms: number) => unknown }) {
  for (let i = 0; i < 4; i++) {
    await c.maintenance.step();
    c.advance(2 * MIN);
  }
}
const KEY = "k".repeat(43);

/** A stand-in launcher with one runner per slug; `recreate` puts a runner on the new image. */
function fakeLauncher() {
  const runnersBySlug = new Map<string, { current: boolean }>();
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/runners") return json(200, [...runnersBySlug].map(([slug, r]) => ({ slug, state: "running", status: "Up", image: "boss-man-runner:current", ...(old ? {} : { current: r.current }) })));
    if (method === "PUT") return json(200, { slug: url.pathname.split("/")[2], id: "x" }); // a new company's runner starts by itself
    const back = /^\/runners\/([^/]+)\/previous$/.exec(url.pathname);
    if (method === "POST" && back) {
      if (noPrevious) return json(409, { error: "There is no previous runner image (boss-man-runner:previous) to go back to." });
      rolledBack.push(back[1]!);
      return json(200, { slug: back[1], image: "boss-man-runner:previous" });
    }
    const m = /^\/runners\/([^/]+)\/recreate$/.exec(url.pathname);
    if (method === "POST" && m) {
      const left = failTimes.get(m[1]!);
      if (left) {
        failTimes.set(m[1]!, left - 1);
        return json(502, { error: "Creating the runner failed: the container exited at once" });
      }
      if (guardBroken.has(m[1]!)) return json(502, { error: `The network guard for ${m[1]} stopped (exit code 1); see docker logs.` });
      if (broken.has(m[1]!)) return json(502, { error: "Creating the runner failed: no such image" });
      runnersBySlug.get(m[1]!)!.current = true;
      return json(200, { slug: m[1] });
    }
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  let old = false;
  const broken = new Set<string>();
  const guardBroken = new Set<string>();
  const failTimes = new Map<string, number>();
  const rolledBack: string[] = [];
  let noPrevious = false;
  // BOS-2058: a launcher that has stopped answering (connection refused).
  let isDown = false;
  const down = ((input: string | URL | Request, init?: RequestInit) => (isDown ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init))) as typeof globalThis.fetch;
  return { fetch: down, calls, runnersBySlug, broken, guardBroken, failTimes, rolledBack, setNoPrevious: (v: boolean) => (noPrevious = v), setOldLauncher: (v: boolean) => (old = v), setDown: (v: boolean) => (isDown = v) };
}

async function setup(opts: { launcher?: boolean; reconnectMs?: number; settleMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-drain-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "key"), `${KEY}\n`);
  const fake = fakeLauncher();
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({
    db,
    master: { version: 1, key: randomBytes(32) },
    secureCookies: false,
    tickOnWake: false,
    limits: { quickBatchMs: 0 },
    workspaceRoot: "/ws",
    now: clock,
    fetch: fake.fetch,
    deployerDir: dir,
    launcher: opts.launcher === false ? undefined : { url: "http://launcher:3105", keyFile: path.join(dir, "key") },
    drainReconnectMs: opts.reconnectMs,
    drainSettleMs: opts.settleMs,
  });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  const commands: Array<Extract<RunnerCommand, { type: "run.start" }> & { company: string }> = [];
  const messages: Array<Extract<RunnerCommand, { type: "run.message" }>> = [];
  const decides: Array<Extract<RunnerCommand, { type: "permission.decide" }>> = [];
  const cancels: string[] = [];
  let seq = 0;
  /** A company with its runner (connected unless said otherwise) and a launcher slug. */
  const company = async (name: string, slug: string, connect = true) => {
    const callsBefore = fake.calls.length;
    const { company: c, ceo } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
    // POST /api/companies starts the company's runner in the background (`void launch.start`), which later writes the restart
    // reason "owner restart". Wait for its last call (the allow-list PUT, after the token PUT) so that write can't land after
    // a later reason such as "setting change" (BOS-1986 flake).
    if (opts.launcher !== false) {
      const started = () => {
        const mine = fake.calls.slice(callsBefore);
        const token = mine.findIndex((x) => /^PUT \/runners\/[^/]+$/.test(x));
        return token >= 0 && mine.slice(token + 1).some((x) => /^PUT \/runners\/[^/]+\/allow$/.test(x));
      };
      const deadline = Date.now() + 30_000;
      while (!started()) {
        if (Date.now() > deadline) throw new Error("the new company's background runner start never finished");
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const reg = (await req("POST", `/api/companies/${c.id}/runner`)).json() as { runnerId: string };
    const [row] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
    if (connect)
      built.runners.connect(reg.runnerId, (cmd) => {
        if (cmd.type === "run.start") commands.push({ ...cmd, company: name });
        if (cmd.type === "run.message") messages.push(cmd);
        if (cmd.type === "run.cancel") cancels.push(cmd.runId);
        if (cmd.type === "permission.decide") decides.push(cmd);
        return true;
      });
    await db.insert(settings).values({ key: `runner-slug:${c.id}`, value: slug }).onConflictDoUpdate({ target: settings.key, set: { value: slug } });
    fake.runnersBySlug.set(slug, { current: false });
    const endRun = (runId: string) => built.runners.ingest(row!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
    const event = (e: Parameters<typeof built.runners.ingest>[1]["event"]) => built.runners.ingest(row!, { seq: ++seq, at: new Date().toISOString(), event: e });
    const out = { id: c.id, ceo: ceo.id, name, endRun, event };
    byName.set(name, out);
    return out;
  };
  const byName = new Map<string, { endRun: (runId: string) => Promise<unknown> }>();
  const ended = new Set<string>();
  /** The company's newest run that is still going ends. */
  const finish = async (c: { name: string }) => {
    const cmd = commands.filter((x) => x.company === c.name && !ended.has(x.runId)).at(-1)!;
    ended.add(cmd.runId);
    await byName.get(c.name)!.endRun(cmd.runId);
  };
  const wake = (c: { ceo: string }) => built.scheduler.wake({ agentId: c.ceo, reason: "woken by owner" });
  const advance = (ms: number) => (offset += ms);
  const maint = () => req("GET", "/api/maintenance").then((r) => r.json());
  const open = async () => (await db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "maintenance");
  const titles = async () => (await db.select().from(notifications)).map((n) => `${n.level}: ${n.title}`);
  return { ...built, db, close, dir, fake, now: clock, finish, req, company, wake, commands, messages, decides, cancels, advance, maint, open, titles };
}

describe("runner update drain (docs/09-self-deploy.md, phase 2)", () => {
  it("holds new runs in every company, lets running ones finish, and counts them for the banner", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    expect(c.commands.map((x) => x.company)).toEqual(["App Co"]);
    expect(await c.maint()).toEqual({ on: false, last: null });

    expect((await c.req("POST", "/api/maintenance/start", {})).statusCode).toBe(200);
    // Both companies want a run; neither gets one. The wake says why it waits, and stays queued.
    await c.wake(a);
    await c.wake(b);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, waiting: 2 });
    expect(c.commands).toHaveLength(1);
    const held = await c.db.select().from(wakes).where(eq(wakes.status, "queued"));
    expect(held.map((w) => w.statusReason)).toEqual([HOLD_REASON, HOLD_REASON]);
    // The run that was going is untouched and the banner counts it: 1 run in 1 company.
    expect(await c.maint()).toMatchObject({ on: true, runs: 1, companies: 1 });

    // Any other wake still waits: the hold itself starts nothing new.
    await c.wake(b);
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);

    // Company A is busy, so its runner stays; B is idle, so it is swapped at once.
    await c.maintenance.step();
    expect([...c.fake.runnersBySlug]).toEqual([["app-co", { current: false }], ["home-lab", { current: true }]]);
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate"]);
    expect(await c.maint()).toMatchObject({ on: true, runs: 1 });

    // A's run ends, A is swapped, every runner is on the new image: the hold lifts and the queue runs.
    await c.finish(a);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await c.maint()).toMatchObject({ on: false, last: { ok: true, title: "Runners updated" } });
    expect(await c.titles()).toContain("note: Runners updated");
    expect(c.commands.map((x) => x.company).sort()).toEqual(["App Co", "App Co", "Home Lab"]);
  });

  it("counts only work runs, so the chat page's banner matches what really holds the swap", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/start", {});
    // A chat run is live beside the one work run.
    await c.req("POST", `/api/companies/${a.id}/chat`, { text: "What's still running?" });
    await c.scheduler.tick();
    const chat = c.commands.find((x) => x.type === "run.start" && x.boardToolsOnly);
    expect(chat).toBeDefined();
    // The banner counts the work run only, and says chat stays open.
    expect(await c.maint()).toMatchObject({ on: true, runs: 1, companies: 1, chatOpen: true });
  });

  it("waits for a running check job like a run, never swaps mid-check, and holds new checks meanwhile (BOS-1471)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.db.insert(settings).values({ key: "check_queue_mode", value: "server" }).onConflictDoNothing();
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    const [job] = await c.db
      .insert(checkJobs)
      .values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() })
      .returning();
    await c.req("POST", "/api/maintenance/start", {});
    await c.maintenance.step();
    // No agent run is going, but a check is: the runner stays as it is.
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    expect(c.fake.calls.some((x) => x.endsWith("/recreate"))).toBe(false);
    // A check queued now is not handed out while the drain is pending.
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "pre_review", scope: "quick", commit: "c2", tree: "t2", state: "queued" });
    await c.checks.pump();
    expect((await c.db.select().from(checkJobs).where(eq(checkJobs.state, "running"))).map((j) => j.id)).toEqual([job!.id]);
    // The check ends: the swap goes ahead.
    await c.db.update(checkJobs).set({ state: "passed", endedAt: new Date() }).where(eq(checkJobs.id, job!.id));
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("at the deadline the owner's ask names the checks still running (BOS-1471)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
    await c.req("POST", "/api/maintenance/start", {});
    c.advance(31 * MIN);
    // The check keeps printing (BOS-1982: a row silent for 20 minutes is not waited on).
    await c.db.update(checkJobs).set({ lastOutputAt: c.now() }).where(eq(checkJobs.state, "running"));
    await c.maintenance.step();
    const asks = await c.open();
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toMatch(/1 check is still going/);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
  });

  it("a check on a separate check worker doesn't hold the swap (BOS-1600)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    const [w] = await c.db.insert(checkWorkers).values({ name: "worker-1", tokenHash: "x" } as never).returning();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", workerId: w!.id, startedAt: new Date(), lastOutputAt: new Date() });
    await c.req("POST", "/api/maintenance/start", {});
    expect(await c.maint()).toMatchObject({ on: true, runs: 0, checks: 0 });
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("the status names the runner check it waits on, and update-now ends the wait (BOS-1600)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
    await c.req("POST", "/api/maintenance/start", {});
    const st = (await c.maint()) as { checks: number; checksList: { kind: string }[] };
    expect(st.checks).toBe(1);
    expect(st.checksList[0]!.kind).toBe("merge");
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    expect((await c.maintenance.updateNow()).ok).toBe(true);
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("the status counts match what the swap waits on: agents only, checks only, both, nothing (BOS-1600 A, B)", async () => {
    // For each kind of wait, the banner's numbers must agree with the swap's own decision: it swaps exactly when the
    // status says nothing is left (runs 0 and checks 0), and the text says "swapping the runners now" only then.
    for (const [agents, check] of [[true, false], [false, true], [true, true], [false, false]] as const) {
      if (ctx) {
        await ctx.app.close();
        await ctx.close();
        await rm(ctx.dir, { recursive: true, force: true });
      }
      const c = (ctx = await setup());
      const a = await c.company("App Co", "app-co");
      const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
      const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
      if (agents) await c.db.insert(runs).values({ id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: null, model: "m", startedAt: new Date() });
      if (check) await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
      await c.req("POST", "/api/maintenance/start", {});
      const st = (await c.maint()) as { runs: number; checks: number };
      expect(st.runs > 0).toBe(agents);
      expect(st.checks > 0).toBe(check);
      await c.maintenance.step();
      const swapped = c.fake.runnersBySlug.get("app-co")!.current === true;
      expect(swapped).toBe(st.runs === 0 && st.checks === 0);
    }
  });

  it("a live chat run doesn't stop a busy company's runner swapping", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    // The owner's chat is answering when the update starts to drain.
    await c.req("POST", `/api/companies/${a.id}/chat`, { text: "Are you there?" });
    await c.scheduler.tick();
    expect(c.commands.filter((x) => x.type === "run.start" && x.boardToolsOnly)).toHaveLength(1);
    await c.req("POST", "/api/maintenance/start", {});
    // The chat run is live but it isn't work: the banner counts nothing. Chat stays open: no runner is being recreated yet (BOS-2404).
    expect(await c.maint()).toMatchObject({ on: true, runs: 0, chatOpen: true });
    // With no work run to wait for, the runner swaps even though the chat run is still live.
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await getHold(c.db)).toBeNull();
  });

  it("the swap waits for a chat run that started during the drain, then goes ahead (BOS-1877)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.req("POST", "/api/maintenance/start", {});
    const hold = (await getHold(c.db))!;
    // A chat run let through during the drain starts after the hold began.
    const [chat] = await c.db.insert(runs).values({ id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: "chat", model: "m", startedAt: new Date(new Date(hold.since).getTime() + 1000) }).returning();
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    await c.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, chat!.id));
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("the status gives the phase, the expected finish from the check's usual time, and says when it is overdue (BOS-1877)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    const base = Date.now();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c0", tree: "t0", state: "passed", startedAt: new Date(base - 100 * MIN), endedAt: new Date(base - 60 * MIN), lastOutputAt: new Date(base - 60 * MIN) });
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
    await c.req("POST", "/api/maintenance/start", {});
    const st = (await c.maint()) as { phase: string; expectedFinishAt: string | null; overdue: boolean; chatOpen: boolean };
    expect(st).toMatchObject({ phase: "waiting", overdue: false, chatOpen: true });
    expect(st.expectedFinishAt).not.toBeNull();
    c.advance(45 * MIN);
    expect(await c.maint()).toMatchObject({ phase: "waiting", overdue: true, expectedFinishAt: null });
  });

  it("drainForecast: nothing left is swapping; a run has no estimate; the deadline passing is overdue (BOS-1877)", () => {
    const now = new Date("2026-11-19T13:30:00Z");
    const deadline = "2026-11-19T14:00:00Z";
    expect(drainForecast({ runs: 0, checks: [], deadline, now })).toEqual({ phase: "swapping", expectedFinishAt: null, overdue: false });
    expect(drainForecast({ runs: 2, checks: [], deadline, now })).toEqual({ phase: "waiting", expectedFinishAt: null, overdue: false });
    expect(drainForecast({ runs: 2, checks: [], deadline, now: new Date("2026-11-19T14:01:00Z") }).overdue).toBe(true);
    const check = { companyId: "c1", ticket: "BOS-1", kind: "merge", scope: "full", startedAt: "2026-11-19T13:20:00Z", runningForMinutes: 10, usuallyMinutes: 40 };
    expect(drainForecast({ runs: 0, checks: [check], deadline, now })).toMatchObject({ expectedFinishAt: "2026-11-19T14:00:00.000Z", overdue: false });
    expect(drainForecast({ runs: 0, checks: [{ ...check, usuallyMinutes: null }], deadline, now }).expectedFinishAt).toBeNull();
  });

  it("tells each running agent once to wrap up when the hold starts", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/start", {});
    await c.req("POST", "/api/maintenance/start", {}); // already on: nobody is told twice
    expect(c.messages).toEqual([{ type: "run.message", runId: c.commands[0]!.runId, text: `Message from Boss Man: ${WRAP_UP}`, interrupt: false, steer: true }]);
  });

  it("holds new runs past the deadline until the owner answers, and at its own end goes ahead by itself: stops the run, swaps, tells owner and CEO (BOS-2058, was BOS-1807's lift at 90)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    await c.wake(b);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, waiting: 1 }); // before the deadline: a drain under way, held
    expect(await c.maint()).toMatchObject({ on: true, blocking: true });
    expect((await c.db.select().from(wakes).where(eq(wakes.status, "queued"))).map((w) => w.statusReason)).toEqual([HOLD_REASON]);

    c.advance(31 * MIN);
    await c.maintenance.step();
    const [card] = await c.open(); // the question is open and unanswered
    expect(card).toBeDefined();
    expect(card!.question).toContain("goes ahead by itself at"); // the card says when the update goes ahead
    expect(card!.question).not.toContain("lifts by itself");
    // Past the deadline, still held: work started now would outlast the drain (16:02 on 18 Nov).
    expect(await c.maint()).toMatchObject({ on: true, blocking: true });
    // Only the CEO's one-off reply (BOS-1954: woken once as the swap is late) goes through; Home Lab's wake stays held.
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
    expect(c.commands.map((x) => x.company)).toEqual(["App Co", "App Co"]);
    const appRun = c.commands[0]!.runId;
    c.advance(DRAIN_GO_AHEAD_MINUTES * MIN - 31 * MIN - 2 * MIN);
    await c.maintenance.step();
    expect(await c.maint()).toMatchObject({ blocking: true }); // just under its end: still waiting, nothing stopped
    expect(c.cancels).toEqual([]);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    // At its own end it goes ahead by itself, with nobody pressing anything: App Co's run (and the CEO's alert run) are
    // stopped with the per-run Stop, the runners are swapped, the card is withdrawn, owner and CEO are told.
    c.advance(3 * MIN);
    await c.maintenance.step();
    expect(c.cancels).toContain(appRun);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(c.fake.runnersBySlug.get("home-lab")!.current).toBe(true);
    expect(await c.open()).toHaveLength(0);
    expect(await c.titles()).toContain("note: Runner update went ahead by itself");
    expect(await c.titles()).not.toContain("note: Runner update: new work is no longer held");
    const goAheadNote = (await c.db.select().from(wakes).where(and(eq(wakes.agentId, a.ceo), eq(wakes.reason, UPDATE_ALERT_REASON)))).map((w) => w.note ?? "").find((n) => n.includes("went ahead by itself"));
    expect(goAheadNote).toContain("stopped:");
    // Once the swap is done the hold ends by itself, and its closing pass starts Home Lab's held wake.
    expect(await getHold(c.db)).toBeNull();
    await c.scheduler.tick();
    await vi.waitFor(() => expect(c.commands.map((x) => x.company)).toContain("Home Lab"));
    expect((await c.db.select().from(wakes).where(eq(wakes.statusReason, HOLD_REASON))).length).toBe(0);
  });

  it("a scheduling pass that never ends doesn't freeze the drain: the swap goes ahead on the first pass after it ends (BOS-1954)", async () => {
    const c = (ctx = await setup({ settleMs: 20 }));
    await c.company("App Co", "app-co");
    await c.maintenance.start({ minutes: 30 });
    // Stand-in for the hang that kept 22:13 to 22:46 on 19 Nov frozen: the scheduler lane never settles.
    const hung = vi.spyOn(c.scheduler, "settled").mockImplementation(() => new Promise(() => undefined));
    await c.maintenance.step(); // returns after the bounded wait instead of never
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    hung.mockRestore();
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("wakes the CEO once, naming what the swap waits on, when it waits past its expected finish; stops nothing (BOS-1954)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    const ceoWakes = async () => (await c.db.select().from(wakes).where(and(eq(wakes.agentId, a.ceo), eq(wakes.reason, UPDATE_ALERT_REASON)))).filter((w) => (w.note ?? "").includes("runner update"));
    c.advance(10 * MIN);
    await c.maintenance.step();
    expect(await ceoWakes()).toHaveLength(0); // an agent run has no usual length: nothing is late before the deadline
    c.advance(21 * MIN);
    await c.maintenance.step();
    const [w] = await ceoWakes();
    expect(w!.note).toContain("31 minutes ago");
    expect(w!.note).toContain("running 31 min");
    expect(w!.note).toContain("Stop these and carry on");
    // Once per hold: later passes (even much later) wake nobody again, and nothing was stopped.
    c.advance(20 * MIN);
    await c.maintenance.step();
    expect(await ceoWakes()).toHaveLength(1);
    expect(c.cancels).toEqual([]);
    expect((await getHold(c.db))!.ceoWokenAt).toBeDefined();
  });

  it("each company's CEO is told only about that company's own work (BOS-1954, security round 1)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Other Co", "other-co");
    await c.wake(a);
    await c.wake(b);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    c.advance(31 * MIN);
    await c.maintenance.step();
    const noteOf = async (ceo: string) => (await c.db.select().from(wakes).where(and(eq(wakes.agentId, ceo), eq(wakes.reason, UPDATE_ALERT_REASON)))).map((w) => w.note ?? "").filter((n) => n.includes("runner update"));
    const [forA, forB] = [await noteOf(a.ceo), await noteOf(b.ceo)];
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    // Each note lists one run (its own), never the other company's.
    expect(forA[0]!.match(/running \d+ min/g)).toHaveLength(1);
    expect(forB[0]!.match(/running \d+ min/g)).toHaveLength(1);
  });

  it("a check row stuck as running (no sign of life past the stuck window) is not waited on; the row is left alone (BOS-1982)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    const base = Date.now();
    // One that never printed and started 30 min ago, and one whose last output is 25 min old: both dead.
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(base - 30 * MIN), lastOutputAt: null });
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "quick", commit: "c2", tree: "t2", state: "running", startedAt: new Date(base - 60 * MIN), lastOutputAt: new Date(base - 25 * MIN) });
    await c.maintenance.start({ minutes: 30 });
    expect(await c.maint()).toMatchObject({ checks: 0 });
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await c.db.select().from(checkJobs).where(eq(checkJobs.state, "running"))).toHaveLength(2);
  });

  it("a check row with recent output still holds the swap (BOS-1982)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    const base = Date.now();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(base - 60 * MIN), lastOutputAt: new Date(base - 5 * MIN) });
    await c.maintenance.start({ minutes: 30 });
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
  });

  it("wakes the CEO once when nothing is counted, runners still wait and a scheduling pass never ends; the text names no closed card (BOS-1982)", async () => {
    const c = (ctx = await setup({ settleMs: 20, reconnectMs: MIN }));
    const a = await c.company("App Co", "app-co");
    const ceoWakes = async () => (await c.db.select().from(wakes).where(and(eq(wakes.agentId, a.ceo), eq(wakes.reason, UPDATE_ALERT_REASON)))).filter((w) => (w.note ?? "").includes("runner update"));
    await c.maintenance.start({ minutes: 30 });
    vi.spyOn(c.scheduler, "settled").mockImplementation(() => new Promise(() => undefined));
    await c.maintenance.step();
    c.advance(MIN);
    await c.maintenance.step();
    expect(await ceoWakes()).toHaveLength(0); // before twice the reconnect time
    c.advance(2 * MIN);
    await c.maintenance.step();
    const [w] = await ceoWakes();
    expect(w!.note).toContain("scheduling pass");
    expect(w!.note).toContain("No question to the owner is open right now");
    expect(w!.note).not.toContain("Stop these and carry on");
    c.advance(5 * MIN);
    await c.maintenance.step();
    expect(await ceoWakes()).toHaveLength(1);
    // BOS-2058: 8 minutes on, past the scheduling pass's own 5-minute end, the swap went ahead without it.
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("a scheduling pass that never ends holds the swap for its own end only, and the screen says so meanwhile (BOS-2058)", async () => {
    const c = (ctx = await setup({ settleMs: 20 }));
    await c.company("App Co", "app-co");
    await c.maintenance.start({ minutes: 30 });
    vi.spyOn(c.scheduler, "settled").mockImplementation(() => new Promise(() => undefined));
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    const settle = (await activeWaits(c.db)).find((w) => w.kind === "runner-settle");
    expect(settle?.waitingOn).toContain("scheduling pass");
    expect(Date.parse(settle!.endsAt) - Date.parse(settle!.since)).toBe(WAIT_RULES["runner-settle"].endMin * MIN);
    c.advance(4 * MIN);
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    c.advance(MIN + 1000);
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
  });

  it("a launcher that stops answering: the update gives up at its own end, lifts the hold and wakes the CEO, not only the owner (BOS-2058)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.maintenance.start({ minutes: 30 });
    c.fake.setDown(true);
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull();
    const row = (await activeWaits(c.db)).find((w) => w.kind === "runner-launcher");
    expect(row?.waitingOn).toContain("launcher");
    expect(row?.atEnd).toBe("give-up");
    c.advance(14 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull();
    c.advance(MIN + 1000);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("page: Runner update gave up: the launcher does not answer");
    const notes = (await c.db.select().from(wakes).where(and(eq(wakes.agentId, a.ceo), eq(wakes.reason, UPDATE_ALERT_REASON)))).map((w) => w.note ?? "");
    expect(notes.some((n) => n.includes("launcher did not answer"))).toBe(true);
  });

  it("a launcher that answers again before its end clears the wait; the next outage starts its own clock (BOS-2058)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    // A run still going keeps the hold on after the launcher answers again.
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    c.fake.setDown(true);
    await c.maintenance.step();
    expect((await getHold(c.db))?.launcherDownSince).toBeDefined();
    c.advance(10 * MIN);
    c.fake.setDown(false);
    await c.maintenance.step();
    const h = await getHold(c.db);
    expect(h).not.toBeNull();
    expect(h!.launcherDownSince).toBeUndefined();
    expect((await activeWaits(c.db)).map((w) => w.kind)).not.toContain("runner-launcher");
    // Down again 10 minutes later: a fresh 15 minutes, not the 10 already spent.
    c.fake.setDown(true);
    c.advance(MIN);
    await c.maintenance.step();
    c.advance(10 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull();
  });

  it("holdEndsAt: swap-when-done ends SWAP_WHEN_DONE_CAP_MINUTES after the answer, other answers are unchanged (BOS-1982)", () => {
    const since = new Date("2026-11-20T04:00:00Z");
    const base = { reason: "runner update", kind: "update" as const, since: since.toISOString(), deadline: since.toISOString(), minutes: 30 };
    const answered = new Date(since.getTime() + 80 * MIN);
    const hold = { ...base, swapWhenDone: true, swapWhenDoneAt: answered.toISOString() };
    expect(holdEndsAt(hold).getTime()).toBe(answered.getTime() + SWAP_WHEN_DONE_CAP_MINUTES * MIN);
    expect(holdBlocksStarts(hold, new Date(answered.getTime() + 59 * MIN))).toBe(true);
    expect(holdBlocksStarts(hold, new Date(answered.getTime() + 60 * MIN))).toBe(false);
    // A hold saved before this change (no answer time) still ends, at the ordinary cap.
    expect(holdBlocksStarts({ ...base, swapWhenDone: true }, new Date(since.getTime() + HOLD_CAP_MINUTES * MIN))).toBe(false);
    expect(holdBlocksStarts({ ...base, swapWhenDone: true }, new Date(since.getTime() + 5 * MIN))).toBe(true);
    // The owner's other choices are as before.
    const far = new Date(since.getTime() + 500 * MIN);
    for (const flag of [{ force: true }, { ignoreChecks: true }, { wrapSince: since.toISOString() }]) expect(holdBlocksStarts({ ...base, ...flag }, far)).toBe(true);
  });

  it("the general rule: a drain hold never lets work in between its start and its cap, whatever the deadline (BOS-1807)", () => {
    const since = new Date("2026-11-18T14:00:00Z");
    for (const minutes of [10, 30, 60]) {
      const hold = { reason: "runner update", kind: "update" as const, since: since.toISOString(), deadline: new Date(since.getTime() + minutes * MIN).toISOString(), minutes };
      // Every minute from the start to the cap blocks; the minute after the cap does not.
      for (let m = 0; m < HOLD_CAP_MINUTES; m++) expect(holdBlocksStarts(hold, new Date(since.getTime() + m * MIN)), `${minutes} min deadline, minute ${m}`).toBe(true);
      expect(holdBlocksStarts(hold, new Date(since.getTime() + HOLD_CAP_MINUTES * MIN))).toBe(false);
    }
    // A deadline the owner pushed past the cap is honoured; the owner's own choices hold with no cap.
    const late = { reason: "runner update", kind: "update" as const, since: since.toISOString(), deadline: new Date(since.getTime() + 120 * MIN).toISOString(), minutes: 30 };
    expect(holdBlocksStarts(late, new Date(since.getTime() + 100 * MIN))).toBe(true);
    const after = new Date(since.getTime() + 500 * MIN);
    expect(holdBlocksStarts({ ...late, deadline: since.toISOString(), swapWhenDone: true }, after)).toBe(false); // BOS-1982: it has its own end
    expect(holdBlocksStarts({ ...late, deadline: since.toISOString(), ignoreChecks: true }, after)).toBe(true);
    expect(holdBlocksStarts(null, since)).toBe(false);
  });

  it("with checks and runs together the card lists each with its time left and offers every stop option, and 'Swap as soon as these finish' keeps the hold with no more presses (BOS-1807)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick(); // one run going
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    // A passed check of 40 min gives the "usually" length; the live one has run for 10.
    const base = Date.now();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c0", tree: "t0", state: "passed", startedAt: new Date(base - 100 * MIN), endedAt: new Date(base - 60 * MIN), lastOutputAt: new Date(base - 60 * MIN) });
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(base + 25 * MIN), lastOutputAt: new Date(base + 25 * MIN) });
    await c.maintenance.start({ minutes: 30 });
    c.advance(31 * MIN);
    await c.maintenance.step();
    const [d] = await c.open();
    expect(d!.options).toEqual(["Stop these and carry on", "Stop the checks and update now", "Swap as soon as these finish", "Wait 10 more minutes", "Cancel the runner update"]);
    expect(d!.recommendedOption).toBe("Swap as soon as these finish");
    expect(d!.question).toMatch(/merge check for .*\(full\): running \d+ min, usually 40 min, about \d+ min left/);
    expect(d!.question).toMatch(/running \d+ min, an agent run has no usual length/);
    expect(d!.question).toContain("The swap is expected when the last run ends");
    // Swap as soon as these finish (BOS-1982): the hold stays for SWAP_WHEN_DONE_CAP_MINUTES at most, one more question comes
    // half way (without that option), nothing starts before the cap, and the checks are not killed.
    const fresh = () => c.db.update(checkJobs).set({ lastOutputAt: new Date(Date.now() + offsetNow()) }).where(eq(checkJobs.state, "running"));
    const offsetNow = () => c.now().getTime() - Date.now();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Swap as soon as these finish" });
    expect(await c.open()).toHaveLength(0);
    c.advance(20 * MIN);
    await fresh();
    await c.maintenance.step();
    expect(await c.open()).toHaveLength(0); // not yet half way
    c.advance(11 * MIN);
    await fresh();
    await c.maintenance.step();
    const [again] = await c.open();
    expect(again!.options).toEqual(["Stop these and carry on", "Stop the checks and update now", "Wait 10 more minutes", "Cancel the runner update"]);
    expect(again!.question).toContain("You chose");
    expect(await c.maint()).toMatchObject({ on: true, blocking: true });
    c.advance(28 * MIN); // 59 minutes after the answer
    await fresh();
    await c.maintenance.step();
    expect(await c.maint()).toMatchObject({ on: true, blocking: true });
    c.advance(2 * MIN); // 61 minutes after the answer: BOS-2058, the update goes ahead by itself, once
    await fresh();
    await c.maintenance.step();
    await c.maintenance.step();
    expect((await c.titles()).filter((x) => x === "note: Runner update went ahead by itself")).toHaveLength(1);
    expect(await c.titles()).not.toContain("note: Runner update: new work is no longer held");
    // The run was stopped and the swap no longer waited for the check (it goes back in line after the swap).
    expect(c.cancels.length).toBeGreaterThan(0);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await getHold(c.db)).toBeNull();
  });

  it("'Stop the checks and update now' with runs still going ends the wait for checks only; the runs are still waited for (BOS-1807)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    const [proj] = await c.db.insert(projects).values({ companyId: a.id, name: "Dev" }).returning();
    const [t] = await c.db.insert(tickets).values({ companyId: a.id, projectId: proj!.id, title: "T", number: 1 }).returning();
    await c.db.insert(checkJobs).values({ companyId: a.id, projectId: proj!.id, ticketId: t!.id, kind: "merge", scope: "full", commit: "c1", tree: "t1", state: "running", startedAt: new Date(), lastOutputAt: new Date() });
    await c.maintenance.start({ minutes: 30 });
    c.advance(31 * MIN);
    await c.maintenance.step();
    const [d] = await c.open();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Stop the checks and update now" });
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false); // the run is still going: not killed
    await c.finish(a);
    await c.scheduler.tick(); // BOS-2058: the CEO's late-update note passes the hold; its short reply run is waited for
    await c.finish(a);
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true); // the check no longer holds the swap
  });

  it("asks the owner once at the deadline; each answer does what it says", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    await c.maintenance.step();
    expect(await c.open()).toHaveLength(0); // nothing to ask before the deadline

    c.advance(31 * MIN);
    await c.maintenance.step();
    await c.maintenance.step();
    const [d] = await c.open();
    expect(await c.open()).toHaveLength(1);
    expect(d).toMatchObject({ tier: "owner", options: ["Stop these and carry on", "Swap as soon as these finish", "Wait 10 more minutes", "Cancel the runner update"] });
    expect(d!.question).toContain("1 run is still going in 1 company");
    expect(d!.question).toContain("anything they haven't saved is lost");
    expect((d!.context as { runIds: string[] }).runIds).toHaveLength(1);
    expect(await c.notes.syncDecisions()).toBeGreaterThan(0);

    // Wait 10 more minutes: the deadline moves, the question goes, nothing else changes.
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Wait 10 more minutes" })).statusCode).toBe(200);
    const hold = (await getHold(c.db))!;
    expect(new Date(hold.deadline).getTime()).toBeGreaterThan(c.advance(0) + Date.now() - 1000 + 9 * MIN);
    await c.maintenance.step();
    expect(await c.open()).toHaveLength(0);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);

    // The next deadline earns a new question; "Stop these and carry on" stops the listed run, not the runner.
    c.advance(11 * MIN);
    await c.maintenance.step();
    const [d2] = await c.open();
    expect(d2!.id).not.toBe(d!.id);
    const [listed] = (d2!.context as { runIds: string[] }).runIds;
    await c.req("POST", `/api/decisions/${d2!.id}/answer`, { answer: "Stop these and carry on" });
    const [stoppedRun] = await c.db.select().from(runs).where(eq(runs.id, listed!));
    expect(stoppedRun!.cancelRequestedAt).not.toBeNull();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);
    expect(await getHold(c.db)).not.toBeNull();
    // The runner confirms the stop, the company is idle, and the update goes ahead by itself.
    await c.finish(a);
    // BOS-2058: the CEO's "update is late" note (woken at 30 minutes) is let through the hold even with no work left; its
    // short reply run is waited for, never killed, and then the swap goes ahead.
    await c.scheduler.tick();
    await c.finish(a);
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await getHold(c.db)).toBeNull();
    expect(await c.open()).toHaveLength(0);
  });

  it("'Stop these' skips a run that has ended and any run the card did not list; Cancel the runner update lifts the hold (BOS-1377)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 30 });
    await c.maintenance.step();
    const live = await c.db.select().from(runs);
    const runId = live[0]!.id;
    // An unrelated id and a run that has ended are both skipped; nothing is cancelled.
    await c.finish(a);
    const res = await c.maintenance.stopRuns([runId, randomUUID()]);
    expect(res.stopped).toEqual([]);
    expect(res.skipped).toHaveLength(2);
    // The card's cancel answer lifts the hold.
    await c.maintenance.answered("Cancel the runner update");
    expect(await getHold(c.db)).toBeNull();
  });

  it("pages once when no runner has been swapped for twice the reconnect time, and says plainly the wait is for running work (BOS-497)", async () => {
    const c = (ctx = await setup({ reconnectMs: 5 * MIN }));
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 60 });
    await c.maintenance.step();
    c.advance(9 * MIN);
    await c.maintenance.step();
    expect((await c.titles()).filter((t) => t.includes("Runner update is"))).toHaveLength(0);
    c.advance(2 * MIN);
    await c.maintenance.step();
    await c.maintenance.step();
    const all = await c.db.select().from(notifications);
    // The only company waited on has a work run going: that wait is on purpose, so it is not called stuck.
    expect(all.filter((n) => n.title === "Runner update is stuck")).toHaveLength(0);
    const waiting = all.filter((n) => n.title === "Runner update is waiting for running work");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ level: "page" });
    expect(waiting[0]!.body).toContain("app-co still has work runs or checks going");
    expect(waiting[0]!.body).toContain("on purpose");
    expect(await getHold(c.db)).not.toBeNull(); // the hold stays; the owner decides
  });

  it("cancel lifts the hold and lets queued wakes run", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.maintenance.start();
    await c.wake(a);
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(0);
    expect((await c.req("POST", "/api/maintenance/cancel", {})).json()).toEqual({ cancelled: true });
    expect(await getHold(c.db)).toBeNull();
    expect(c.commands).toHaveLength(1);
    expect(await c.titles()).toContain("note: Runner update cancelled");
    expect((await c.req("GET", "/api/maintenance")).json()).toMatchObject({ on: false, last: { ok: true, title: "Runner update cancelled" } });
  });

  it("a deadline answer after the hold is gone does nothing", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ minutes: 1 });
    c.advance(2 * MIN);
    await c.maintenance.step();
    const [d] = await c.open();
    await c.maintenance.cancel();
    expect(await c.open()).toHaveLength(0); // withdrawn with the hold
    expect(d).toBeTruthy();
  });

  it("starts from update-runner.sh's drain.json, once, and consumes it", async () => {
    const c = (ctx = await setup());
    await c.company("App Co", "app-co");
    await writeFile(path.join(c.dir, "inbox", "drain.json"), '{"by":"update-runner.sh"}');
    await c.maintenance.step();
    // Idle company: swapped in the same pass, so the drain is already over.
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await stat(path.join(c.dir, "inbox", "drain.json")).catch(() => null)).toBeNull();
    expect(await c.titles()).toEqual(expect.arrayContaining(["note: Update pending: waiting for runs to finish", "note: Runners updated"]));
  });

  it("pages and lifts the hold when a runner cannot be recreated or never reconnects", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    await c.company("Silent Co", "silent-co", false);
    await c.company("Broken Co", "broken-co");
    c.fake.broken.add("broken-co");
    c.fake.setNoPrevious(true);
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull(); // Broken Co is tried again, and Silent Co is given time to dial in
    await retryOut(c);
    expect(await getHold(c.db)).toBeNull();
    const page = (await c.db.select().from(notifications)).find((n) => n.title === "Runner update finished with problems");
    expect(page).toMatchObject({ level: "page" });
    expect(page!.body).toContain("broken-co: the new runner would not start (3 tries: Creating the runner failed");
    expect(page!.body).toContain("going back to the previous runner image failed too");
    expect(page!.body).toContain("Press Start runner");
    expect(page!.body).toContain("silent-co: has not reconnected");
  });

  // BOS-382: a swap that fails is tried again on its own, then goes back to the previous image, then says so once.
  it("tells the owner the check workers need updating by hand (BOS-1437), and only when one is set up", async () => {
    const c = (ctx = await setup());
    await c.company("App Co", "app-co");
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.maint()).last.body).not.toContain("Check workers");

    await c.db.insert(checkWorkers).values([
      { name: "second-host", tokenHash: "h1" },
      { name: "turned-off-host", tokenHash: "h2", enabled: false },
    ]);
    await c.maintenance.start();
    await c.maintenance.step();
    const body = (await c.maint()).last.body as string;
    expect(body).toContain("Check workers are not swapped by this update");
    expect(body).toContain("second-host");
    expect(body).not.toContain("turned-off-host");
    expect(body).toContain("docs/34-check-workers.md");
  });

  it("tries a failed swap again by itself, and needs nobody when a later try works", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.failTimes.set("app-co", 2);
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ tries: { "app-co": { n: 1 } } });
    await c.maintenance.step(); // still waiting for the next try: no second call yet
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(1);
    await retryOut(c);
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(3);
    expect(c.fake.rolledBack).toEqual([]);
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("note: Runners updated");
    expect((await c.titles()).some((t) => t.startsWith("page:"))).toBe(false);
  });

  it("after the last try, puts the runner back on the previous image and pages once, in plain words", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.broken.add("app-co");
    await c.maintenance.start();
    await retryOut(c);
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(3);
    expect(c.fake.rolledBack).toEqual(["app-co"]);
    expect(await getHold(c.db)).toBeNull();
    const pages = (await c.db.select().from(notifications)).filter((n) => n.level === "page");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toContain("app-co: the new runner would not start (3 tries: Creating the runner failed: no such image), so it was put back on the previous runner image and is running that");
  });

  it("a network guard failure is reported at once: trying again or going back can't fix it", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.guardBroken.add("app-co");
    await c.maintenance.start();
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(1);
    expect(c.fake.rolledBack).toEqual([]);
    expect(await getHold(c.db)).toBeNull();
    const page = (await c.db.select().from(notifications)).find((n) => n.level === "page");
    expect(page!.body).toContain("app-co: The network guard for app-co stopped");
  });

  it("a failed swap lifts the hold; once the runner is back on the new image the panel shows the current state, not the failure", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.broken.add("app-co");
    await c.maintenance.start();
    await retryOut(c);
    expect(await getHold(c.db)).toBeNull();
    expect(await c.maint()).toMatchObject({ on: false, last: { ok: false }, healthy: false });
    c.fake.runnersBySlug.get("app-co")!.current = true; // it came back by itself (compose recreated it)
    expect(await c.maint()).toMatchObject({ on: false, last: { ok: false }, healthy: true });
  });

  it("a runner that failed to swap but came back on the new image by itself is not reported", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.broken.add("app-co");
    const recreate = c.fake.fetch;
    c.fake.runnersBySlug.get("app-co")!.current = false;
    await c.maintenance.start();
    // The recreate call fails, yet the container is on the new image by the time the pass re-reads the fleet.
    const orig = c.fake.runnersBySlug.get("app-co")!;
    Object.defineProperty(orig, "current", { get: (() => { let n = 0; return () => ++n > 1; })(), set: () => undefined });
    void recreate;
    await retryOut(c);
    expect(await getHold(c.db)).toBeNull();
    expect((await c.db.select().from(notifications)).map((n) => n.title)).toContain("Runners updated");
  });

  it("needs the launcher, and stops cleanly with an older one", async () => {
    const none = (ctx = await setup({ launcher: false }));
    expect((await none.req("POST", "/api/maintenance/start", {})).statusCode).toBe(409);
    await none.app.close();
    await none.close();
    await rm(none.dir, { recursive: true, force: true });

    const c = (ctx = await setup());
    await c.company("App Co", "app-co");
    c.fake.setOldLauncher(true);
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.db.select().from(notifications)).find((n) => n.title === "Runner update stopped")).toMatchObject({ level: "page" });
  });

  it("tells the CEO in its brief, and the missed-work sweep does not pile wakes onto the hold", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const project = (await c.req("POST", `/api/companies/${a.id}/projects`, { name: "Site" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Forgotten" })).json() as { id: string };
    await c.db.update(tickets).set({ assigneeAgentId: a.ceo, systemState: "ready", lastActivityAt: new Date(Date.now() - 3_600_000) }).where(eq(tickets.id, t.id));
    expect((await c.req("GET", `/api/companies/${a.id}/brief`)).json().markdown).not.toContain("UPDATE PENDING");

    await c.maintenance.start();
    const brief = (await c.req("GET", `/api/companies/${a.id}/brief`)).json().markdown as string;
    expect(brief).toContain("UPDATE PENDING");
    expect(brief).toContain("do not delegate new work");
    expect(await c.sweeps.run()).toMatchObject({ missedWork: { woken: 0 } });
    expect(await c.db.select().from(wakes).where(eq(wakes.reason, MISSED_REASON))).toHaveLength(0);

    await c.maintenance.cancel();
    expect(await c.sweeps.run()).toMatchObject({ missedWork: { woken: 1 } });
  });

  it("a restart keeps the hold: it is one settings row", async () => {
    const c = (ctx = await setup());
    await c.maintenance.start({ reason: "runner update", minutes: 45 });
    const [row] = await c.db.select().from(settings).where(eq(settings.key, "maintenance"));
    expect(row!.value).toMatchObject({ reason: "runner update", minutes: 45 });
    expect((await c.maintenance.start()).minutes).toBe(45); // idempotent
  });
});

describe("setting change drain and restart reasons (BOS-594)", () => {
  const runnerOf = async (c: { db: Awaited<ReturnType<typeof setup>>["db"] }, companyId: string) => (await c.db.select().from(runners).where(eq(runners.companyId, companyId)))[0]!;

  it("recreates every runner once, even on the current image, after its runs end, then wakes and says so", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    // Both already run the current image: an image update would have nothing to do.
    for (const r of c.fake.runnersBySlug.values()) r.current = true;
    await c.wake(a);
    await c.scheduler.tick();

    // scripts/update-runner.sh --settings drops this.
    await writeFile(path.join(c.dir, "inbox", "drain.json"), JSON.stringify({ requestedAt: new Date().toISOString(), by: "update-runner.sh", reason: "setting change" }));
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "settings", reason: "setting change" });
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP_SETTINGS}`]);
    expect(await c.titles()).toContain("note: Setting change pending: waiting for runs to finish");
    // Idle B is recreated at once; busy A waits for its run. B's restart is expected as a setting change.
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate"]);
    const [intent] = await c.db.select().from(settings).where(eq(settings.key, `runner-restart-intent:${b.id}`));
    expect(intent!.value).toMatchObject({ reason: "setting change" });
    // Further passes don't recreate B again.
    c.advance(2 * MIN);
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate"]);

    await c.finish(a);
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate", "POST /runners/app-co/recreate"]);
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("note: Runners restarted with the new settings");
  });

  it("a setting change asked for during an image update recreates every runner, including ones already swapped", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/start", {});
    await c.maintenance.step(); // home-lab swapped onto the new image with the old settings
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate"]);
    await writeFile(path.join(c.dir, "inbox", "drain.json"), JSON.stringify({ reason: "setting change" }));
    c.advance(2 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "settings" });
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/home-lab/recreate", "POST /runners/home-lab/recreate"]);
  });

  it("an image update's drain.json (no reason) is an update, as before", async () => {
    const c = (ctx = await setup());
    await c.company("Home Lab", "home-lab");
    await writeFile(path.join(c.dir, "inbox", "drain.json"), JSON.stringify({ by: "update-runner.sh" }));
    await c.maintenance.step();
    expect(await c.titles()).toContain("note: Runners updated");
  });

  it("the runner's next hello records the reason in the owner's feed and server_status", async () => {
    const c = (ctx = await setup());
    const b = await c.company("Home Lab", "home-lab");
    const runner = await runnerOf(c, b.id);
    await c.runners.bootSeen(runner, "boot-1", {}); // first known boot: a baseline, no notice
    await c.maintenance.start({ kind: "settings" });
    await c.maintenance.step();
    await c.runners.bootSeen(await runnerOf(c, b.id), "boot-2", { previousExit: "stopped", hostBootAt: "2026-11-05T16:28:00.000Z" });
    // A crash afterwards, which Boss Man didn't ask for, is a flag the owner can act on.
    await c.runners.bootSeen(await runnerOf(c, b.id), "boot-3", { previousExit: "crashed", hostBootAt: "2026-11-05T16:28:00.000Z" });
    // The notice is sent without blocking the hello: wait for the second one to land, with a deadline.
    const restartTitles = async () => (await c.titles()).filter((t) => t.includes("Runner restarted"));
    await vi.waitFor(async () => expect(await restartTitles()).toHaveLength(2), { timeout: 10_000 });
    expect(await restartTitles()).toEqual(["note: Runner restarted: setting change", "flag: Runner restarted: crash or out of memory"]);
    const status = (await c.serverStatus.status(b.id)) as { runner: { lastRestart: { reason: string; bootId: string } } };
    expect(status.runner.lastRestart).toMatchObject({ reason: "crash or out of memory", bootId: "boot-3" });
  });
});

describe("Ask agents to wrap up (BOS-929): a mode of the same hold", () => {
  it("messages each running work run once, and holds new runs until cancelled, with none lost", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);

    // The button: every live work run gets exactly one wrap-up message, the same way the update tells them.
    // steer (BOS-1016): an agent that can take it inside its running step gets it there.
    expect((await c.req("POST", "/api/maintenance/wrapup", {})).statusCode).toBe(200);
    expect(c.messages).toEqual([{ type: "run.message", runId: c.commands[0]!.runId, text: `Message from Boss Man: ${WRAP_UP_ASKED}`, interrupt: false, steer: true }]);
    // Pressing it again does not tell them twice.
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(c.messages).toHaveLength(1);
    // A full check takes 30 to 50 minutes, so a run is only flagged after 30 (BOS-1016).
    expect(await c.maint()).toMatchObject({ on: true, kind: "wrapup", runs: 1, notRespondingAfter: 30 });

    // Nothing new starts anywhere while wrap-up is on; the wake waits, and is not dropped.
    await c.wake(b);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, waiting: 1 });
    expect(c.commands).toHaveLength(1);
    const held = await c.db.select().from(wakes).where(eq(wakes.status, "queued"));
    expect(held.map((w) => w.statusReason)).toContain(HOLD_REASON);

    // Cancelling lets the waiting wake run: nothing was lost.
    expect((await c.req("POST", "/api/maintenance/cancel", {})).json()).toEqual({ cancelled: true });
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("note: Wrap-up cancelled");
    expect(c.commands.map((x) => x.company)).toEqual(["App Co", "Home Lab"]);
  });

  it("lists each run still going with its ticket, and names one waiting on a card as waiting, not stuck", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const project = (await c.req("POST", `/api/companies/${a.id}/projects`, { name: "Site" })).json() as { id: string };
    const t = (await c.req("POST", `/api/projects/${project.id}/tickets`, { title: "Add a footer" })).json() as { id: string };
    await c.db.update(tickets).set({ assigneeAgentId: a.ceo, systemState: "ready" }).where(eq(tickets.id, t.id));
    await c.scheduler.wake({ agentId: a.ceo, reason: "woken by owner", ticketId: t.id });
    await c.scheduler.tick();
    const run = c.commands[0]!;
    await c.req("POST", "/api/maintenance/wrapup", {});
    const [ticketRow] = await c.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, t.id));
    const [companyRow] = await c.db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, a.id));
    const ref = `${companyRow?.prefix ?? "T"}-${ticketRow!.number}`;

    const list = (await c.maint()) as { runsList: Array<{ runId: string; agent: string | null; ticket: string | null; waitingOn: unknown }> };
    expect(list.runsList).toHaveLength(1);
    expect(list.runsList[0]).toMatchObject({ runId: run.runId, agent: "CEO", ticket: ref });
    expect(list.runsList[0]!.waitingOn).toBeNull();

    // An open permission card for the run makes it "waiting for an answer", even past the not-responding time.
    c.advance(11 * MIN);
    await c.db.insert(decisions).values({
      companyId: a.id,
      kind: "permission",
      question: "May I run the full test suite?",
      options: ["Allow once", "Deny"],
      recommendedOption: "Allow once",
      tier: "ceo",
      context: { type: "permission", runnerId: "r", runId: run.runId, requestId: "req-1" },
    });
    const waiting = (await c.maint()) as { runsList: Array<{ sinceWrapUpMinutes: number; waitingOn: { question: string } | null }> };
    expect(waiting.runsList[0]!.sinceWrapUpMinutes).toBeGreaterThanOrEqual(10);
    expect(waiting.runsList[0]!.waitingOn).toMatchObject({ question: "May I run the full test suite?" });
  });

  it("says when a run is inside a long step, and when the message has reached it (BOS-1016)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    const runId = c.commands[0]!.runId;
    type Row = { gotMessage: boolean; step: { title: string; sinceMinutes: number } | null };
    const row = async () => ((await c.maint()) as { runsList: Row[] }).runsList[0]!;
    const update = (u: Record<string, unknown>) => a.event({ type: "run.update", runId, update: u });

    // A finished step, an owner chat message delivered before the ask: neither counts.
    await update({ kind: "tool_call", title: "Read file", toolKind: "read", status: "pending" });
    await update({ kind: "tool_call_update", title: null, toolKind: null, status: "completed" });
    await update({ kind: "message_delivered", text: "Message from Boss Man: an earlier note", fullLength: 37 });
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await row()).toMatchObject({ gotMessage: false, step: null });

    // A long command starts: the panel names it. Its updates carry no title, so the title comes from its start.
    await update({ kind: "tool_call", title: "scripts/check-all.sh", toolKind: "execute", status: "pending" });
    await update({ kind: "tool_call_update", title: null, toolKind: null, status: "in_progress" });
    expect(await row()).toMatchObject({ gotMessage: false, step: { title: "scripts/check-all.sh", sinceMinutes: 0 } });
    c.advance(12 * MIN);
    expect((await row()).step?.sinceMinutes).toBe(12);

    // An owner chat message isn't the wrap-up; a Boss Man message steered in is.
    await update({ kind: "message_delivered", text: "Message from the owner: hello", fullLength: 29 });
    expect((await row()).gotMessage).toBe(false);
    await update({ kind: "message_delivered", text: `Message from Boss Man: ${WRAP_UP_ASKED}`.slice(0, 4000), fullLength: 400, steered: true });
    expect(await row()).toMatchObject({ gotMessage: true, step: { title: "scripts/check-all.sh" } });

    // The step ends (the command was moved to the background): no step any more.
    await update({ kind: "tool_call_update", title: null, toolKind: null, status: "completed" });
    expect((await row()).step).toBeNull();
  });

  it("BOS-2058: a wrap-up with no update behind it lifts by itself after 60 minutes and stops no run", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", forUpdate: "none" });
    c.advance(61 * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(c.commands).toHaveLength(1); // the run was not touched
    expect(await c.titles()).toContain("note: Wrap-up lifted after 60 minutes");
  });

  // 20 Nov 11:48: the CEO's note that the update was late sat "update pending" because the swap waited on something it could
  // not name (or on a merge record). A wake that reports on the update is never held by it; every other wake still is.
  it("BOS-2058: the CEO's update-alert note starts while the hold is on and nothing nameable is left; other wakes, routine replies included, stay held", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Other Co", "other-co");
    await c.maintenance.start({ minutes: 30 });
    c.advance(3 * MIN); // past UNKNOWN_WAIT_MS: no run, check or merge is left, and the swap has still not happened
    await c.scheduler.wake({ agentId: a.ceo, reason: "nudge", note: "routine" });
    // A routine reply-lane wake (DR-048 A) stays held: the swap may happen at any moment.
    await c.scheduler.notify(b.ceo, { reason: CEO_REPLY_REASON, ticketId: null, priority: 4, note: "A card is waiting." });
    await c.scheduler.notify(a.ceo, { reason: UPDATE_ALERT_REASON, ticketId: null, priority: 4, note: "The update is late." });
    await c.scheduler.tick();
    const started = await c.db.select().from(runs);
    expect(started.map((r) => [r.purpose, r.origin])).toEqual([["reply", UPDATE_ALERT_REASON]]);
    const held = await c.db.select().from(wakes).where(eq(wakes.status, "queued"));
    expect(held.map((w) => [w.reason, w.statusReason]).sort()).toEqual([[CEO_REPLY_REASON, HOLD_REASON], ["nudge", HOLD_REASON]]);
  });

  it("BOS-2058: a wrap-up pressed while a server update waits belongs to it and lifts when that wait is over", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    const wait = { decisionId: randomUUID(), commit: "b".repeat(40), fromCommit: "a".repeat(40), approvedAt: new Date().toISOString(), phase: "waiting", deadline: new Date().toISOString(), minutes: 30, origin: "approve" };
    await c.db.insert(settings).values({ key: "deploy_wait", value: wait });
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", forUpdate: "server" });
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull(); // the update still waits
    await c.db.update(settings).set({ value: { ...wait, phase: "sent" } }).where(eq(settings.key, "deploy_wait"));
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("note: Wrap-up lifted");
  });

  // BOS-2056: the screen names which update a wrap-up is for, and the owner is told once that it ended with the update.
  it("BOS-2056: the status says which update a wrap-up is for (none, server, runner)", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await c.maint()).toMatchObject({ kind: "wrapup", wrapForUpdate: "none", wrapSince: expect.any(String) });
    await c.req("POST", "/api/maintenance/cancel", {});
    const wait = { decisionId: randomUUID(), commit: "b".repeat(40), fromCommit: "a".repeat(40), approvedAt: new Date().toISOString(), phase: "waiting", deadline: new Date().toISOString(), minutes: 30, origin: "approve" };
    await c.db.insert(settings).values({ key: "deploy_wait", value: wait });
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await c.maint()).toMatchObject({ kind: "wrapup", wrapForUpdate: "server" });
    await c.req("POST", "/api/maintenance/cancel", {});
    await c.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await c.maintenance.start();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await c.maint()).toMatchObject({ kind: "update", wrapAsked: true, wrapForUpdate: "runner", wrapSince: expect.any(String) });
  });

  for (const how of ["swap", "cancel"] as const)
    it(`BOS-2056: a wrap-up tied to a runner update lifts with it on a ${how}, and says so once`, async () => {
      const c = (ctx = await setup());
      const a = await c.company("App Co", "app-co");
      await c.wake(a);
      await c.scheduler.tick();
      await c.maintenance.start();
      await c.req("POST", "/api/maintenance/wrapup", {});
      expect((await getHold(c.db))!.wrapSince).toBeTruthy();
      if (how === "swap") {
        await c.finish(a);
        await c.maintenance.step();
      } else await c.req("POST", "/api/maintenance/cancel", {});
      expect(await getHold(c.db), how).toBeNull(); // no press needed to lift the wrap-up
      const last = ((await c.maint()) as { last?: { body: string } }).last;
      expect(last?.body.match(/wrap-up you asked for ended with it/g), how).toHaveLength(1);
    });

  it("BOS-2056: an update with no wrap-up asked does not mention one when it ends", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start();
    await c.finish(a);
    await c.maintenance.step();
    const last = ((await c.maint()) as { last?: { body: string } }).last;
    expect(last?.body).not.toContain("wrap-up");
  });

  it("never stops a run by itself, even well past the not-responding time", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    c.advance(50 * MIN);
    // Passes of the drain do nothing for a wrap-up: no swap, no page, and the run is still there. (BOS-2058: it lifts by
    // itself after 60 minutes when no update is behind it; see the next test.)
    await c.maintenance.step();
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual([]);
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup" });
    expect(await c.open()).toHaveLength(0); // no "stop them now?" question for a wrap-up
    expect(c.commands).toHaveLength(1); // not stopped, not restarted
    const list = (await c.maint()) as { runsList: unknown[] };
    expect(list.runsList).toHaveLength(1);
  });

  it("a permission request raised during a wrap-up can still be answered and reaches the run, so the drain can't deadlock", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    const run = c.commands[0]!;
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup" });
    // The run asks for permission to finish its step, while the wrap-up holds new work everywhere.
    const [runnerRow] = await c.db.select().from(runners).where(eq(runners.companyId, a.id));
    const requestId = "req-wrap-1";
    await c.runners.ingest(runnerRow!, { seq: 9001, at: new Date().toISOString(), event: { type: "run.permission_request", runId: run.runId, requestId, title: "Run a command", kind: "execute", rawInput: { command: "rm -rf /tmp/opencode/probe" }, optionKinds: ["allow_once", "reject_once"] } as never });
    const [card] = await c.db.select().from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open")));
    expect(card, "a card is raised during the wrap-up").toBeTruthy();
    // Answering it gets the verdict to the run, so it can go on and wrap up.
    const answer = (card!.options as string[])[0]!;
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer })).statusCode).toBe(200);
    expect(c.decides.find((d) => d.runId === run.runId && d.requestId === requestId)?.verdict).toBe("allow");
    // The wrap-up is still on: answering a card did not quietly start the world again.
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup" });
  });

  it("a real update asked for during a wrap-up takes the hold over and swaps as usual", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup" });
    // The owner presses "Build and update runners": the hold becomes an update, and the update message goes out.
    expect((await c.req("POST", "/api/maintenance/start", {})).statusCode).toBe(200);
    expect(await getHold(c.db)).toMatchObject({ kind: "update" });
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP_ASKED}`, `Message from Boss Man: ${WRAP_UP}`]);
    await c.finish(a);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await c.titles()).toContain("note: Runners updated");
  });

  it("an update-runner.sh trigger file during a wrap-up takes the hold over, swaps, and lifts by itself", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup" });
    // The script asks for the update through drain.json, not the button: the hold must still take it over (BOS-929).
    await writeFile(path.join(c.dir, "inbox", "drain.json"), JSON.stringify({ by: "update-runner.sh" }));
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "update" });
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP_ASKED}`, `Message from Boss Man: ${WRAP_UP}`]);
    // The run ends, the drain swaps the idle company's runner and lifts the hold by itself: new work is not stuck held.
    await c.finish(a);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/app-co/recreate"]);
    expect(await c.titles()).toContain("note: Runners updated");
  });
});

describe("Ask agents to wrap up while an update waits (BOS-988)", () => {
  it("messages every still-running run, shows them, and leaves the update waiting so it goes ahead as normal", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    // The owner presses Build and update runners: an update hold starts and its own message goes out.
    await c.maintenance.start();
    expect(await getHold(c.db)).toMatchObject({ kind: "update" });

    // The owner then presses "Ask agents to wrap up": it is allowed while the update waits, and the run is told.
    const r = (await c.req("POST", "/api/maintenance/wrapup", {})).json() as { on: boolean; kind: string; wrapAsked?: boolean; runsList?: unknown[] };
    expect(r).toMatchObject({ on: true, kind: "update", wrapAsked: true });
    expect(r.runsList).toHaveLength(1);
    const told = c.messages.map((m) => m.text);
    expect(told).toEqual([`Message from Boss Man: ${WRAP_UP}`, `Message from Boss Man: ${WRAP_UP_DURING_UPDATE}`]);

    // The update hold is still there (it did not cancel or replace it), waiting for the same run.
    const hold = (await getHold(c.db))!;
    expect(hold.kind).toBe("update");
    expect(hold.wrapSince).toBeTruthy();

    // Pressing again tells nobody twice.
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(c.messages).toHaveLength(2);

    // The run ends: the update goes ahead by itself, as though the wrap-up had not been asked.
    await c.finish(a);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual(["POST /runners/app-co/recreate"]);
    expect(await c.titles()).toContain("note: Runners updated");
  });

  it("Cancel wrap-up during an update takes back only the ask, never the update", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect((await getHold(c.db))!.wrapSince).toBeTruthy();

    expect((await c.req("POST", "/api/maintenance/cancel-wrap", {})).json()).toEqual({ cancelled: true });
    const hold = (await getHold(c.db))!;
    expect(hold.kind).toBe("update");
    expect(hold.wrapSince).toBeUndefined();
    expect(hold.wrapTold).toBeUndefined();
    // No "wrap-up cancelled" or "update cancelled" notice: the update is untouched and still swaps when the run ends.
    expect(await c.titles()).not.toContain("note: Wrap-up cancelled");
    expect(await c.titles()).not.toContain("note: Runner update cancelled");
    await c.finish(a);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
  });

  it("the update's own message reaches a run that starts just after the hold (it is told on the next pass), once", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.maintenance.start();
    expect(c.messages).toHaveLength(0); // nothing running yet
    // A run whose start was already on its way when the hold began (BOS-988): it appears after the start message.
    await c.db.insert(runs).values({ id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: null, model: "m", startedAt: new Date(0) });
    await c.maintenance.step();
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP}`]);
    await c.maintenance.step();
    expect(c.messages).toHaveLength(1); // once per run, as before
  });
});

describe("QA: wrap-up during an update, the cases a regression would slip past (BOS-988)", () => {
  it("a run that starts after the ask is told the wrap-up on the next pass, once, beside the update's own message", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.maintenance.start();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(c.messages).toHaveLength(0); // nobody was running when the hold and the ask began
    await c.db.insert(runs).values({ id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: null, model: "m", startedAt: new Date(0) });
    await c.maintenance.step();
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP}`, `Message from Boss Man: ${WRAP_UP_DURING_UPDATE}`]);
    await c.maintenance.step();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(c.messages).toHaveLength(2);
  });

  it("chat and reply runs are never messaged", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.db.insert(runs).values([
      { id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: "chat", model: "m", startedAt: new Date(0) },
      { id: randomUUID(), companyId: a.id, agentId: a.ceo, purpose: "reply", model: "m", startedAt: new Date(0) },
    ]);
    await c.maintenance.start();
    await c.req("POST", "/api/maintenance/wrapup", {});
    await c.maintenance.step();
    expect(c.messages).toHaveLength(0);
  });

  it("during a setting-change hold the hold keeps its kind and the run is told the setting message, then the ask", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ kind: "settings" });
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect((await getHold(c.db))!.kind).toBe("settings");
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP_SETTINGS}`, `Message from Boss Man: ${WRAP_UP_DURING_UPDATE}`]);
  });

  it("each run's 'asked N min ago' counts from when that run was told", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start();
    c.advance(10 * MIN);
    await c.req("POST", "/api/maintenance/wrapup", {});
    c.advance(4 * MIN);
    const m = (await c.maint()) as { runsList: Array<{ sinceWrapUpMinutes: number }> };
    expect(m.runsList.map((r) => r.sinceWrapUpMinutes)).toEqual([4]);
  });

  it("Cancel wrap-up: nothing to cancel says so; with no update it lifts the whole wrap-up hold; with an update but no ask it changes nothing", async () => {
    const c = (ctx = await setup());
    await c.company("App Co", "app-co");
    expect((await c.req("POST", "/api/maintenance/cancel-wrap", {})).json()).toEqual({ cancelled: false });
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect((await getHold(c.db))!.kind).toBe("wrapup");
    expect((await c.req("POST", "/api/maintenance/cancel-wrap", {})).json()).toEqual({ cancelled: true });
    expect(await getHold(c.db)).toBeNull();
    await c.maintenance.start();
    expect((await c.req("POST", "/api/maintenance/cancel-wrap", {})).json()).toEqual({ cancelled: false });
    expect((await getHold(c.db))!.kind).toBe("update");
  });

  it("after Cancel wrap-up the status drops the wrap-up list and the update is still on the banner", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start();
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await c.maint()).toMatchObject({ on: true, kind: "update", wrapAsked: true });
    await c.req("POST", "/api/maintenance/cancel-wrap", {});
    const after = (await c.maint()) as Record<string, unknown>;
    expect(after).toMatchObject({ on: true, kind: "update" });
    expect(after.wrapAsked).toBeUndefined();
    expect(after.runsList).toBeUndefined();
  });
});

describe("Stop N and carry on with the update (BOS-1238)", () => {
  it("refuses an unauthenticated request", async () => {
    const c = (ctx = await setup());
    const r = await c.app.inject({ method: "POST", url: "/api/maintenance/stop-stragglers", payload: { runIds: [randomUUID()] } });
    expect(r.statusCode).toBe(401);
    expect((await c.app.inject({ method: "GET", url: "/api/self-deploy/history" })).statusCode).toBe(401);
  });

  it("is refused with no wrap-up on, and before the deadline", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    const id = c.commands[0]!.runId;
    expect((await c.req("POST", "/api/maintenance/stop-stragglers", { runIds: [id] })).statusCode).toBe(409);
    await c.req("POST", "/api/maintenance/start", {});
    await c.req("POST", "/api/maintenance/wrapup", {});
    const early = await c.req("POST", "/api/maintenance/stop-stragglers", { runIds: [id] });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: "too_early" });
    expect(c.cancels).toEqual([]);
  });

  it("stops only the shown runs that were told and still go; an ended run is skipped and an unshown one is never stopped", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    const d = await c.company("Third Co", "third-co");
    for (const co of [a, b, d]) await c.wake(co);
    await c.scheduler.tick();
    const [runA, runB, runC] = c.commands.map((x) => x.runId) as [string, string, string];
    await c.req("POST", "/api/maintenance/start", {});
    await c.req("POST", "/api/maintenance/wrapup", {});
    // Run B ends on its own after the owner was shown the list.
    await c.finish(b);
    c.advance(31 * MIN);
    // The page shows A and B only; C is going but was never in the shown set, and a made-up id was never told.
    const r = await c.req("POST", "/api/maintenance/stop-stragglers", { runIds: [runA, runB, randomUUID()] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ stopped: 1, skipped: 2 });
    expect(c.cancels).toEqual([runA]);
    expect(c.cancels).not.toContain(runC);
    // It pauses no lane and moves no ticket: the hold is as it was.
    expect(await getHold(c.db)).toMatchObject({ kind: "update" });
  });

  it("lists the newest answered update cards for Recent updates", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.db.insert(decisions).values([
      { companyId: a.id, kind: "question", question: "Update?", options: ["Deploy"], recommendedOption: "Deploy", status: "answered", answer: "Deploy", answeredAt: new Date("2026-11-10T10:00:00Z"), context: { type: "self_deploy", target: "server", commit: "a".repeat(40), fromCommit: "b".repeat(40), changes: ["x", "y"], result: { result: "deployed", message: "ok", at: "2026-11-10T10:05:00Z" } } },
      { companyId: a.id, kind: "question", question: "Update?", options: ["Deploy"], recommendedOption: "Deploy", status: "open", context: { type: "self_deploy", target: "server", commit: "c".repeat(40), fromCommit: "a".repeat(40) } },
    ]);
    const h = (await c.req("GET", "/api/self-deploy/history?limit=5")).json() as Array<{ target: string; result: string | null; changes: number }>;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ target: "server", result: "deployed", changes: 2 });
  });
});

// BOS-2088: while a runner update held work, a wake about an urgent ticket, or about one that fixes a live problem, sat
// "update pending" behind it, even when it was the fix the update waited to deliver. Now it passes, its run is marked, no
// wait counts that run, and the swap cuts it off and the interrupted-run recovery picks it up again.
describe("urgent and fixes-live wakes pass an update's hold (BOS-2088)", () => {
  async function seed(c: Awaited<ReturnType<typeof setup>>) {
    const a = await c.company("App Co", "app-co");
    const b = await c.company("Home Lab", "home-lab");
    const ticket = async (co: { id: string; ceo: string }, number: number, o: Partial<typeof tickets.$inferInsert> = {}) => {
      const [p] = await c.db.insert(projects).values({ companyId: co.id, name: `P${number}` }).returning();
      const [t] = await c.db.insert(tickets).values({ companyId: co.id, projectId: p!.id, title: `T${number}`, number, systemState: "ready", assigneeAgentId: co.ceo, ...o }).returning();
      return t!.id;
    };
    const urgent = await ticket(a, 1, { urgent: true });
    const plain = await ticket(a, 2);
    const fixes = await ticket(b, 3, { fixesLive: "server freezes as memory climbs" });
    const merged = await ticket(b, 4, { fixesLive: "server freezes as memory climbs", systemState: "review", mergeCommit: "c".repeat(40) });
    return { a, b, urgent, plain, fixes, merged };
  }

  it("starts the urgent and the fixes-live wake, marks their runs, and the swap does not wait for them; routine and merged-fix wakes stay held", async () => {
    const c = (ctx = await setup());
    const { a, b, urgent, plain, fixes, merged } = await seed(c);
    await c.maintenance.start({ minutes: 30 });
    await c.scheduler.wake({ agentId: a.ceo, reason: "assigned", ticketId: urgent });
    await c.scheduler.wake({ agentId: a.ceo, reason: "nudge", ticketId: plain, note: "routine" });
    await c.scheduler.wake({ agentId: b.ceo, reason: "assigned", ticketId: fixes });
    await c.scheduler.wake({ agentId: b.ceo, reason: "live release", ticketId: merged });
    await c.scheduler.tick();

    const started = await c.db.select().from(runs);
    expect(started.map((r) => [r.ticketId, r.passedUpdateHold]).sort()).toEqual([[urgent, true], [fixes, true]].sort());
    expect(c.commands.every((x) => x.prompt.includes("This run started while an update holds other work"))).toBe(true);
    const held = await c.db.select().from(wakes).where(eq(wakes.status, "queued"));
    expect(held.map((w) => [w.ticketId, w.statusReason]).sort()).toEqual([[plain, HOLD_REASON], [merged, HOLD_REASON]].sort());

    // No wait counts the marked runs: the banner shows none, and both runners are swapped on the next step.
    expect(await c.maint()).toMatchObject({ on: true, runs: 0 });
    await c.maintenance.step();
    expect([...c.fake.runnersBySlug.values()].map((r) => r.current)).toEqual([true, true]);
    expect(c.cancels).toEqual([]); // nothing was stopped by the go-ahead; the swap itself cuts them off

    // A new update holds work again; the swap cut the urgent run off. Recovery queues "resume", which passes again.
    if (!(await getHold(c.db))) await c.maintenance.start({ minutes: 30 });
    const runA = started.find((r) => r.ticketId === urgent)!.id;
    await a.event({ type: "run.ended", runId: runA, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    const deadline = Date.now() + 10_000;
    while (!(await c.db.select().from(wakes).where(and(eq(wakes.reason, "resume"), eq(wakes.ticketId, urgent)))).length) {
      if (Date.now() > deadline) throw new Error("no resume wake was queued for the cut-off urgent run");
      await new Promise((r) => setTimeout(r, 10));
    }
    await c.scheduler.tick();
    const resumed = (await c.db.select().from(runs)).filter((r) => r.origin === "resume");
    expect(resumed.map((r) => [r.ticketId, r.passedUpdateHold])).toEqual([[urgent, true]]);
    // The routine wake is still held by the new hold.
    expect((await c.db.select().from(wakes).where(and(eq(wakes.status, "queued"), eq(wakes.ticketId, plain)))).map((w) => w.statusReason)).toEqual([HOLD_REASON]);
  });

  it("a wrap-up with no update behind it still holds an urgent ticket's wake: the owner asked for quiet", async () => {
    const c = (ctx = await setup());
    const { a, urgent } = await seed(c);
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(await getHold(c.db)).toMatchObject({ kind: "wrapup", forUpdate: "none" });
    await c.scheduler.wake({ agentId: a.ceo, reason: "assigned", ticketId: urgent });
    await c.scheduler.tick();
    expect(await c.db.select().from(runs)).toEqual([]);
    expect((await c.db.select().from(wakes).where(eq(wakes.status, "queued"))).map((w) => w.statusReason)).toEqual([HOLD_REASON]);
  });
});

describe("early building hold (BOS-1955)", () => {
  const drainFile = (dir: string, reason?: string) => writeFile(path.join(dir, "inbox", "drain.json"), JSON.stringify({ by: "update-runner.sh", ...(reason ? { reason } : {}) }));
  const cancelFile = (dir: string) => writeFile(path.join(dir, "inbox", "drain-cancel.json"), "{}");
  const gone = (p: string) => stat(p).then(() => false, () => true);

  it("a building request holds new starts, swaps nothing and asks nobody to stop", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    expect(c.commands).toHaveLength(1);
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "building" });
    expect(await gone(path.join(c.dir, "inbox", "drain.json"))).toBe(true);
    // A new wake waits; the run going carries on and was not told to wrap up; no runner is touched.
    await c.wake(a);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0 });
    expect(c.commands).toHaveLength(1);
    expect(c.messages).toHaveLength(0);
    await c.finish(a);
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual([]);
    expect(await c.maint()).toMatchObject({ on: true, kind: "building", blocking: true, phase: "waiting", chatOpen: true });
    expect(await c.titles()).toContain("note: Runner update building: new work held");
  });

  it("the real drain takes the hold over and keeps its start; its own deadline starts then", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    const first = (await getHold(c.db))!;
    c.advance(6 * MIN);
    await drainFile(c.dir); // the image is built: a plain drain
    await c.maintenance.step();
    const h = await getHold(c.db);
    // The only runner was idle, so it was swapped by the same pass; the hold is the update's, not the building one.
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(1);
    expect(h === null || (h.kind === "update" && h.since === first.since)).toBe(true);
    if (h) expect(new Date(h.deadline).getTime()).toBeGreaterThan(new Date(first.deadline).getTime() - 40 * MIN);
  });

  it("keeps since when the drain waits for a busy company", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    const first = (await getHold(c.db))!;
    c.advance(6 * MIN);
    await drainFile(c.dir);
    await c.maintenance.step();
    const h = (await getHold(c.db))!;
    expect(h).toMatchObject({ kind: "update", since: first.since, reason: "runner update" });
    const nowMs = Date.now();
    expect(new Date(h.deadline).getTime()).toBeGreaterThan(nowMs + 20 * MIN); // 30 minutes from the takeover, not from the build start
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toEqual([]);
    expect(c.messages.map((m) => m.text)).toEqual([`Message from Boss Man: ${WRAP_UP}`]); // the update's own message now goes to the run going
  });

  it("a cancel file ends a building hold, and never a real update", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    await cancelFile(c.dir);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await gone(path.join(c.dir, "inbox", "drain-cancel.json"))).toBe(true);
    expect((await c.maint()).last).toMatchObject({ ok: true, title: "Runner update build stopped" });
    // New work starts again.
    await c.wake(a);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
    // A real update under way is not touched by a stale cancel file.
    await c.finish(a);
    await c.maintenance.start({ kind: "update" });
    await cancelFile(c.dir);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull(); // swapped and finished on its own pass, not cancelled
    expect((await c.titles()).filter((t) => t.includes("build stopped"))).toHaveLength(1);
  });

  it("a real update asked together with a cancel is not cancelled", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    await drainFile(c.dir);
    await cancelFile(c.dir);
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "update" });
  });

  it("a building request and a cancel in the same pass start no hold (a build that failed fast)", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await cancelFile(c.dir);
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect(await gone(path.join(c.dir, "inbox", "drain.json"))).toBe(true);
    expect(await gone(path.join(c.dir, "inbox", "drain-cancel.json"))).toBe(true);
    await c.wake(a);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
  });

  it("a building request while an old building hold is on pushes its deadline out and keeps since", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    const first = await getHold(c.db);
    c.advance((BUILD_HOLD_MAX_MINUTES - 5) * MIN);
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    const again = await getHold(c.db);
    expect(again).toMatchObject({ kind: "building", since: first!.since });
    expect(new Date(again!.deadline).getTime()).toBeGreaterThan(new Date(first!.deadline).getTime());
    c.advance(10 * MIN); // past the first deadline, inside the refreshed one
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "building" });
  });

  it("ends by itself at BUILD_HOLD_MAX_MINUTES, on the injected clock", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    c.advance((BUILD_HOLD_MAX_MINUTES - 1) * MIN);
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "building" });
    expect(await c.maint()).toMatchObject({ blocking: true });
    c.advance(2 * MIN);
    // Even before the drain pass has run, the hold no longer blocks starts at its limit.
    expect(await c.maint()).toMatchObject({ blocking: false });
    await c.maintenance.step();
    expect(await getHold(c.db)).toBeNull();
    expect((await c.maint()).last).toMatchObject({ ok: true, title: "Runner update build hold ended" });
    await c.wake(a);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
  });

  it("is not offered the owner's deadline question or 'update now', and Cancel lifts it", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    expect((await c.req("POST", "/api/maintenance/update-now", {})).json()).toMatchObject({ error: "no_update" });
    await c.maintenance.answered("Wait 10 more minutes");
    expect(await c.open()).toHaveLength(0);
    expect((await c.req("POST", "/api/maintenance/cancel", {})).statusCode).toBe(200);
    expect(await getHold(c.db)).toBeNull();
  });

  it("a building request while another hold is on changes nothing", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.maintenance.start({ kind: "update" });
    const before = await getHold(c.db);
    await drainFile(c.dir, "building");
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "update", since: before!.since });
  });

  it("a failed swap is tried again inside the same hold: no lift and no page until the last try fails", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.failTimes.set("app-co", 1);
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).toMatchObject({ kind: "update", tries: { "app-co": { n: 1 } } });
    expect((await c.titles()).some((t) => t.startsWith("page:"))).toBe(false);
    c.advance(MIN);
    await c.maintenance.step();
    expect(c.fake.calls.filter((x) => x.includes("recreate"))).toHaveLength(2);
    expect(c.fake.rolledBack).toEqual([]);
  });
});

describe("holdCapAt and drainGoAheadAt: the times a hold ends by itself", () => {
  const start = "2026-11-15T10:00:00Z";
  const hold = (extra: Record<string, unknown> = {}) => ({ reason: "a server update", kind: "update", since: start, deadline: "2026-11-15T10:30:00Z", minutes: 30, ...extra }) as never;
  const cap = new Date(Date.parse(start) + HOLD_CAP_MINUTES * MIN).toISOString();
  const drain = new Date(Date.parse(start) + DRAIN_GO_AHEAD_MINUTES * MIN).toISOString();

  it("holdCapAt: the cap from the start when the owner's deadline is sooner", () => {
    expect(holdCapAt(hold()).toISOString()).toBe(cap);
  });

  it("holdCapAt: a later owner deadline is honoured past the cap", () => {
    expect(holdCapAt(hold({ deadline: "2026-11-15T13:00:00Z" })).toISOString()).toBe("2026-11-15T13:00:00.000Z");
  });

  it("holdCapAt: the edge where the deadline reaches the cap exactly returns that moment", () => {
    expect(holdCapAt(hold({ deadline: cap })).toISOString()).toBe(cap);
  });

  it("drainGoAheadAt: its own end from the start, when the deadline is sooner", () => {
    expect(drainGoAheadAt(hold()).toISOString()).toBe(drain);
    // The edge where the deadline reaches its own end exactly returns that moment.
    expect(drainGoAheadAt(hold({ deadline: drain })).toISOString()).toBe(drain);
  });

  it("drainGoAheadAt: an owner's later wait is honoured", () => {
    expect(drainGoAheadAt(hold({ deadline: "2026-11-15T13:00:00Z" })).toISOString()).toBe("2026-11-15T13:00:00.000Z");
  });

  it("drainGoAheadAt: 'Swap as soon as these finish' adds its own cap from when it was chosen", () => {
    const swap = new Date(Date.parse(drain) + 10 * MIN).toISOString();
    expect(drainGoAheadAt(hold({ swapWhenDone: true, swapWhenDoneAt: swap })).toISOString()).toBe(new Date(Date.parse(swap) + SWAP_WHEN_DONE_CAP_MINUTES * MIN).toISOString());
  });
});
