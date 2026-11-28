// BOS-2862 (28 Nov 10:36): e071cf14 went live by the host deployer with its trial, and three merge checks restarted on
// the company runner 35 to 50 s after the takeover. The trial's soft hold lived only in a `deploy_wait` row that
// begin() writes, so an update that reached the host any other way (an approval held behind a runner update and sent
// later, a row that had already ended) had no hold. The wait now opens the window itself from the host's own status.
// These tests run the real services (buildApp) with no wait row at all.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { DEPLOY_WAIT_KEY, softHold } from "../src/services/deploy-wait-hold.js";
import type { DeployWait } from "../src/services/deploy-wait.js";

const LIVE_BEFORE = "47be6dfa".padEnd(40, "0");
const DEPLOYED = "e071cf14".padEnd(40, "0");
const MIN = 60_000;

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-trial-adopt-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [], deployer: { scriptSha: "1".repeat(64), repoSha: "1".repeat(64) } }));
  const { db, close } = await openPglite();
  // The deploy wait's clock; self-deploy reads the real one, so the trial is set relative to it.
  let clock = new Date();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: dir, now: () => clock });
  const status = (over: Record<string, unknown>) =>
    writeFile(path.join(dir, "outbox", "status.json"), JSON.stringify({ id: randomUUID(), target: "server", result: "deployed", message: "Deployed.", from_commit: LIVE_BEFORE, to_commit: DEPLOYED, started: "", ended: "", backup: "", ...over }));
  const wait = async () => ((await db.select().from(settings).where(eq(settings.key, DEPLOY_WAIT_KEY)))[0]?.value as DeployWait | undefined) ?? null;
  return { ...built, db, close, dir, status, wait, setClock: (d: Date) => (clock = d) };
}

/** The host's report of a server deploy that went live `agoMs` ago, sent with no wait row (as 28 Nov's was). */
async function liveWithNoWait(c: Awaited<ReturnType<typeof setup>>, t0: number, agoMs: number, over: Record<string, unknown> = {}) {
  const ended = t0 - agoMs;
  await c.status({ started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(ended).toISOString(), ...over });
  c.setClock(new Date(t0));
  expect(await c.wait()).toBeNull();
  return ended;
}

describe("trial soft hold for a server update with no wait row (BOS-2862)", () => {
  it("holds merge checks for the whole trial and lifts by itself at its end, without opening again", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const ended = await liveWithNoWait(c, t0, 10_000);
    // Before the fix step() returned null here: no row, so no hold, and the checks started.
    expect((await softHold(c.db, new Date(t0))).on).toBe(false);
    const w = await c.deployWait.step();
    expect(w?.phase).toBe("window");
    expect(w?.adopted).toBe(true);
    expect(w?.windowUntil).toBe(new Date(ended + 15 * MIN).toISOString());
    expect((await softHold(c.db, new Date(t0))).on).toBe(true);

    c.setClock(new Date(ended + 14 * MIN));
    expect((await c.deployWait.step())?.phase).toBe("window");
    expect((await softHold(c.db, new Date(ended + 14 * MIN))).on).toBe(true);

    const after = new Date(ended + 15 * MIN + 1000);
    c.setClock(after);
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.deployWait.step()).toBeNull(); // the same deploy is not adopted twice
    expect((await softHold(c.db, after)).on).toBe(false);
  });

  it("keeps a hold the owner lifted lifted for the rest of that trial", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    await liveWithNoWait(c, t0, 10_000);
    expect((await c.deployWait.step())?.phase).toBe("window");
    expect((await c.deployWait.cancel()).cancelled).toBe(true);
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.wait()).toBeNull();
    expect((await softHold(c.db, new Date(t0))).on).toBe(false);
  });

  it("does not re-open the hold of an approved update whose window the owner lifted", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const id = randomUUID();
    const ended = t0 - 10_000;
    const sent: DeployWait = { decisionId: id, commit: DEPLOYED, fromCommit: LIVE_BEFORE, approvedAt: new Date(t0 - 10 * MIN).toISOString(), phase: "sent", sentAt: new Date(t0 - 5 * MIN).toISOString(), deadline: new Date(t0 + 25 * MIN).toISOString(), minutes: 30, origin: "approve" };
    await c.db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: sent });
    await c.status({ id, started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(ended).toISOString() });
    c.setClock(new Date(t0));
    expect((await c.deployWait.step())?.phase).toBe("window");
    expect((await c.deployWait.cancel()).cancelled).toBe(true);
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.wait()).toBeNull();
  });

  it("lifts an adopted hold when the trial is switched back, even when the host's status had no id", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const ended = await liveWithNoWait(c, t0, 10_000, { id: "" });
    expect((await c.deployWait.step())?.phase).toBe("window");
    await c.status({ id: "", result: "rolled_back", message: "Switched back.", started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(t0 + MIN).toISOString() });
    c.setClock(new Date(t0 + 2 * MIN));
    expect(await c.deployWait.step()).toBeNull();
    expect((await softHold(c.db, new Date(t0 + 2 * MIN))).on).toBe(false);
  });

  it("opens nothing for a deploy whose trial is already over, or for a runner update", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    await liveWithNoWait(c, t0, 16 * MIN);
    expect(await c.deployWait.step()).toBeNull();
    await liveWithNoWait(c, t0, 10_000, { target: "runner" });
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.wait()).toBeNull();
  });
});
