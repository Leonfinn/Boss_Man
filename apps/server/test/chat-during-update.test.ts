// BOS-2404: on 23 Nov the owner's CEO chat sent at ~20:28 started only at 20:47:47. A server update had lowered the
// all-companies limit to 3 and a runner update hold stood, with no work run, check or merge the swap could name. The chat
// passed a hold only while one of those was going (BOS-349, BOS-1877, BOS-1951), so it waited with everything else. Now it
// passes every hold; the one time it waits is its own runner being swapped, and the chat screen says so with a time.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runs, settings, wakes } from "../src/db/schema.js";
import { DEPLOY_WAIT_KEY } from "../src/services/deploy-wait-hold.js";
import { MAINTENANCE_KEY, swapInProgressUntil, type Hold } from "../src/services/maintenance.js";

const KEY = "k".repeat(43);
const MIN = 60_000;

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-chat-update-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "key"), `${KEY}\n`);
  // A stand-in launcher with one runner, "app-co", not yet on the new image.
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/runners") return json(200, [{ slug: "app-co", state: "running", status: "Up", image: "boss-man-runner:current", current: false }]);
    if (method === "PUT") return json(200, { slug: url.pathname.split("/")[2], id: "x" });
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  // An injected clock: the test sets the time instead of waiting.
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now, fetch, deployerDir: dir, launcher: { url: "http://launcher:3105", keyFile: path.join(dir, "key") } });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  await db.insert(settings).values({ key: `runner-slug:${company.id}`, value: "app-co" }).onConflictDoUpdate({ target: settings.key, set: { value: "app-co" } });
  const starts: Array<Extract<RunnerCommand, { type: "run.start" }>> = [];
  const sender = (c: RunnerCommand) => {
    if (c.type === "run.start") starts.push(c);
    return true;
  };
  let disconnect = built.runners.connect(reg.runnerId, sender);

  /** Saves a runner-update hold as the drain would, started `ago` ms before the clock's now. */
  const hold = async (h: Partial<Hold> = {}, ago = 0) => {
    const since = new Date(now().getTime() - ago);
    const value: Hold = { reason: "runner update", kind: "update", since: since.toISOString(), deadline: new Date(since.getTime() + 30 * MIN).toISOString(), minutes: 30, ...h };
    await db.insert(settings).values({ key: MAINTENANCE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  };
  /** The 23 Nov shape: a server update being applied (the all-companies limit down to 3) and 3 work runs going that the swap doesn't wait on. */
  const capFull = async () => {
    await db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: { phase: "sent", approvedAt: now().toISOString() } });
    for (let i = 0; i < 3; i++) await db.insert(runs).values({ id: randomUUID(), companyId: company.id, agentId: worker.id, model: "m", passedUpdateHold: true, startedAt: now() });
  };
  /** Owner chat message, then one scheduling pass: whether a chat run started. */
  const chatStarts = async () => {
    const before = starts.length;
    expect((await req("POST", `/api/companies/${company.id}/chat`, { text: "Are you there?" })).statusCode).toBe(201);
    await built.scheduler.tick();
    return starts.slice(before).some((x) => x.agentId === ceo.id && x.boardToolsOnly);
  };
  const chatState = async () => ((await req("GET", `/api/companies/${company.id}/chat`)).json() as { state: string }).state;
  const status = async () => (await req("GET", "/api/maintenance")).json() as { on: boolean; chatOpen: boolean; chatBackBy: string | null };
  return {
    ...built,
    db,
    close,
    dir,
    req,
    company,
    ceo,
    worker,
    now,
    hold,
    capFull,
    chatStarts,
    chatState,
    status,
    starts,
    advance: (ms: number) => (offset += ms),
    goOffline: () => disconnect(),
    comeBack: () => (disconnect = built.runners.connect(reg.runnerId, sender)),
  };
}

describe("the owner's chat starts at once through every update hold (BOS-2404)", () => {
  it("23 Nov: server update cap of 3 full, runner hold with nothing it can name: the chat starts on the first pass", async () => {
    const c = (ctx = await setup());
    await c.capFull();
    // The runner hold had stood for minutes, waiting on the server update on the host (nothing on the drain's list).
    await c.hold({ tries: { "app-co": { n: 1, next: new Date(c.now().getTime() + 10 * MIN).toISOString(), last: "launcher busy" } } }, 5 * MIN);
    // A work wake is still held: the hold and the cap are unchanged for work.
    await c.scheduler.wake({ agentId: c.worker.id, reason: "decision" });
    expect(await c.chatStarts()).toBe(true);
    expect(await c.chatState()).toBe("answering");
    expect(c.starts.filter((x) => x.agentId === c.worker.id)).toHaveLength(0);
    const [work] = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), isNull(wakes.runId)));
    expect(work?.status).toBe("queued");
    expect(await c.status()).toMatchObject({ on: true, chatOpen: true, chatBackBy: null });
  });

  // Each hold shape the old allow-list held the chat in, with no run, check or merge going.
  const shapes: Array<[string, Partial<Hold>, number]> = [
    ["an update hold in its first two minutes", {}, 30_000],
    ["a swap waiting for its retry", { tries: { "app-co": { n: 1, next: new Date(Date.now() + 60 * MIN).toISOString(), last: "x" } } }, 10 * MIN],
    ["another company's runner just recreated", { swapped: { "other-co": new Date(Date.now() - 30_000).toISOString() } }, 10 * MIN],
    ["the owner's wrap-up for a runner update", { wrapSince: new Date().toISOString(), forUpdate: "runner" }, 10 * MIN],
    ["the owner's wrap-up for a server update", { kind: "wrapup", reason: "asking agents to wrap up for the waiting server update", forUpdate: "server" }, 10 * MIN],
    ["the owner's wrap-up with no update", { kind: "wrapup", reason: "asking agents to wrap up", forUpdate: "none" }, 10 * MIN],
    ["a runner image being built", { kind: "building", reason: "building the new runner image" }, 30_000],
    ["a setting change", { kind: "settings", reason: "setting change" }, 10 * MIN],
  ];
  for (const [name, h, ago] of shapes) {
    it(`${name}: the chat starts`, async () => {
      const c = (ctx = await setup());
      await c.hold(h, ago);
      expect(await c.chatStarts()).toBe(true);
      expect(await c.status()).toMatchObject({ on: true, chatOpen: true });
    });
  }

  it("the swap itself: while its runner is recreated and not back, the chat waits and says why and until when; it starts once the runner is back", async () => {
    const c = (ctx = await setup());
    const swappedAt = c.now();
    await c.hold({ swapped: { "app-co": swappedAt.toISOString() } }, 10 * MIN);
    c.goOffline();
    expect(await c.chatStarts()).toBe(false);
    const backBy = new Date(swappedAt.getTime() + 5 * MIN);
    expect(await c.chatState()).toBe(`waiting: your runner is being swapped to the new version, usually under a minute (back by ${backBy.toISOString().slice(11, 16)} UTC at the latest)`);
    expect(await c.status()).toMatchObject({ chatOpen: false, chatBackBy: backBy.toISOString() });
    // The runner dials back in 40 s later: the next pass starts the chat.
    c.advance(40_000);
    c.comeBack();
    expect(await c.status()).toMatchObject({ chatOpen: true, chatBackBy: null });
    const before = c.starts.length;
    await c.scheduler.tick();
    expect(c.starts.slice(before).some((x) => x.agentId === c.ceo.id && x.boardToolsOnly)).toBe(true);
  });

  it("swapInProgressUntil: only a recreate inside the reconnect window, of a runner not back yet", () => {
    const at = new Date("2026-11-23T20:30:00Z");
    const base: Hold = { reason: "runner update", kind: "update", since: "2026-11-23T20:20:00Z", deadline: "2026-11-23T20:50:00Z", minutes: 30 };
    expect(swapInProgressUntil(null, at)).toBeNull();
    expect(swapInProgressUntil(base, at)).toBeNull();
    const h = { ...base, swapped: { a: "2026-11-23T20:29:00Z", b: "2026-11-23T20:20:00Z" } };
    expect(swapInProgressUntil(h, at, 5 * MIN)?.toISOString()).toBe("2026-11-23T20:34:00.000Z");
    expect(swapInProgressUntil(h, at, 5 * MIN, (slug) => slug === "a")).toBeNull();
  });
});
