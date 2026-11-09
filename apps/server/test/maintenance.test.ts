import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, notifications, runners, runs, settings, tickets, wakes } from "../src/db/schema.js";
import { getHold, HOLD_REASON, WRAP_UP, WRAP_UP_ASKED, WRAP_UP_DURING_UPDATE, WRAP_UP_SETTINGS } from "../src/services/maintenance.js";
import { MISSED_REASON } from "../src/services/scheduler.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  await rm(ctx!.dir, { recursive: true, force: true });
  ctx = undefined;
});

const MIN = 60_000;
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
    const m = /^\/runners\/([^/]+)\/recreate$/.exec(url.pathname);
    if (method === "POST" && m) {
      if (broken.has(m[1]!)) return json(502, { error: "Creating the runner failed: no such image" });
      runnersBySlug.get(m[1]!)!.current = true;
      return json(200, { slug: m[1] });
    }
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  let old = false;
  const broken = new Set<string>();
  return { fetch, calls, runnersBySlug, broken, setOldLauncher: (v: boolean) => (old = v) };
}

async function setup(opts: { launcher?: boolean; reconnectMs?: number } = {}) {
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
  });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  const commands: Array<Extract<RunnerCommand, { type: "run.start" }> & { company: string }> = [];
  const messages: Array<Extract<RunnerCommand, { type: "run.message" }>> = [];
  const decides: Array<Extract<RunnerCommand, { type: "permission.decide" }>> = [];
  let seq = 0;
  /** A company with its runner (connected unless said otherwise) and a launcher slug. */
  const company = async (name: string, slug: string, connect = true) => {
    const { company: c, ceo } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
    const reg = (await req("POST", `/api/companies/${c.id}/runner`)).json() as { runnerId: string };
    const [row] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
    if (connect)
      built.runners.connect(reg.runnerId, (cmd) => {
        if (cmd.type === "run.start") commands.push({ ...cmd, company: name });
        if (cmd.type === "run.message") messages.push(cmd);
        if (cmd.type === "permission.decide") decides.push(cmd);
        return true;
      });
    await db.insert(settings).values({ key: `runner-slug:${c.id}`, value: slug }).onConflictDoUpdate({ target: settings.key, set: { value: slug } });
    fake.runnersBySlug.set(slug, { current: false });
    const endRun = (runId: string) => built.runners.ingest(row!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
    const out = { id: c.id, ceo: ceo.id, name, endRun };
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
  return { ...built, db, close, dir, fake, finish, req, company, wake, commands, messages, decides, advance, maint, open, titles };
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

  it("a live chat run doesn't stop a busy company's runner swapping", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    // The owner's chat is answering when the update starts to drain.
    await c.req("POST", `/api/companies/${a.id}/chat`, { text: "Are you there?" });
    await c.scheduler.tick();
    expect(c.commands.filter((x) => x.type === "run.start" && x.boardToolsOnly)).toHaveLength(1);
    await c.req("POST", "/api/maintenance/start", {});
    // The chat run is live but it isn't work: the banner counts nothing and chat is not "open".
    expect(await c.maint()).toMatchObject({ on: true, runs: 0, chatOpen: false });
    // With no work run to wait for, the runner swaps even though the chat run is still live.
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await getHold(c.db)).toBeNull();
  });

  it("tells each running agent once to wrap up when the hold starts", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.company("Home Lab", "home-lab");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/start", {});
    await c.req("POST", "/api/maintenance/start", {}); // already on: nobody is told twice
    expect(c.messages).toEqual([{ type: "run.message", runId: c.commands[0]!.runId, text: `Message from Boss Man: ${WRAP_UP}`, interrupt: false }]);
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
    expect(d).toMatchObject({ tier: "owner", options: ["Stop the remaining runs and update now", "Keep waiting another 30 min", "Cancel the update"] });
    expect(d!.question).toContain("1 run is still going in 1 company");
    expect(await c.notes.syncDecisions()).toBeGreaterThan(0);

    // Keep waiting: the deadline moves, the question goes, nothing else changes.
    expect((await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Keep waiting another 30 min" })).statusCode).toBe(200);
    const hold = (await getHold(c.db))!;
    expect(new Date(hold.deadline).getTime()).toBeGreaterThan(c.advance(0) + Date.now() - 1000 + 29 * MIN);
    await c.maintenance.step();
    expect(await c.open()).toHaveLength(0);
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(false);

    // The next deadline earns a new question; "stop and update now" swaps the busy runner too.
    c.advance(31 * MIN);
    await c.maintenance.step();
    const [d2] = await c.open();
    expect(d2!.id).not.toBe(d!.id);
    await c.req("POST", `/api/decisions/${d2!.id}/answer`, { answer: "Stop the remaining runs and update now" });
    await c.maintenance.step();
    expect(c.fake.runnersBySlug.get("app-co")!.current).toBe(true);
    expect(await getHold(c.db)).toBeNull();
    expect(await c.open()).toHaveLength(0);
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
    expect(waiting[0]!.body).toContain("app-co still has work runs going");
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
    await c.maintenance.start();
    await c.maintenance.step();
    expect(await getHold(c.db)).not.toBeNull(); // Silent Co has been given time to dial in; Broken Co is tried again, not given up on
    expect((await getHold(c.db))!.failed ?? {}).toEqual({});
    c.advance(31_000);
    await c.maintenance.step();
    expect((await getHold(c.db))!.failed ?? {}).toEqual({});
    c.advance(31_000);
    await c.maintenance.step(); // third failed try: now it counts as failed
    expect(await getHold(c.db)).toBeNull();
    const page = (await c.db.select().from(notifications)).find((n) => n.title === "Runner update finished with problems");
    expect(page).toMatchObject({ level: "page" });
    expect(page!.body).toContain("broken-co: Creating the runner failed");
    expect(page!.body).toContain("silent-co: has not reconnected");
  });

  it("a failed swap lifts the hold; once the runner is back on the new image the panel shows the current state, not the failure", async () => {
    const c = (ctx = await setup({ reconnectMs: 1000 }));
    await c.company("App Co", "app-co");
    c.fake.broken.add("app-co");
    await c.maintenance.start();
    await c.maintenance.step();
    c.advance(31_000);
    await c.maintenance.step();
    c.advance(31_000);
    await c.maintenance.step(); // third failed try: now it counts as failed
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
    await c.maintenance.step();
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
    await new Promise((r) => setTimeout(r, 20)); // the notice is sent without blocking the hello
    const restarts = (await c.titles()).filter((t) => t.includes("Runner restarted"));
    expect(restarts).toEqual(["note: Runner restarted: setting change", "flag: Runner restarted: crash or out of memory"]);
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
    expect((await c.req("POST", "/api/maintenance/wrapup", {})).statusCode).toBe(200);
    expect(c.messages).toEqual([{ type: "run.message", runId: c.commands[0]!.runId, text: `Message from Boss Man: ${WRAP_UP_ASKED}`, interrupt: false }]);
    // Pressing it again does not tell them twice.
    await c.req("POST", "/api/maintenance/wrapup", {});
    expect(c.messages).toHaveLength(1);
    expect(await c.maint()).toMatchObject({ on: true, kind: "wrapup", runs: 1, notRespondingAfter: 10 });

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

  it("never stops a run by itself, even well past the not-responding time", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co", "app-co");
    await c.wake(a);
    await c.scheduler.tick();
    await c.req("POST", "/api/maintenance/wrapup", {});
    c.advance(120 * MIN);
    // Passes of the drain do nothing for a wrap-up: no swap, no page, and the run is still there.
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
