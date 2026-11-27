// BOS-2789 (27 Nov 09:59): server 62e77f40 went live with a 15-minute trial, and the parked merge checks started 15 s
// after the blue/green takeover, exactly one deploy-wait pass. A new leader's loops have no first pass at start, so the
// deploy wait (every 15 s) read the host's "deployed" before self-deploy's first sync (every 30 s) had written the trial
// end, saw no window and lifted the soft hold for the whole trial. These tests run the real services in that order.
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

const LIVE_BEFORE = "1".repeat(40);
const APPROVED = "afb25027".padEnd(40, "0"); // what the owner's card named
const DEPLOYED = "62e77f40".padEnd(40, "0"); // the newer checked commit the deployer took (BOS-753)
const MIN = 60_000;

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-trial-takeover-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [], deployer: { scriptSha: "1".repeat(64), repoSha: "1".repeat(64) } }));
  const { db, close } = await openPglite();
  // The deploy wait's clock; self-deploy reads the real one, so the trial is set relative to it.
  let clock = new Date();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: dir, now: () => clock });
  const status = (over: Record<string, unknown>) =>
    writeFile(path.join(dir, "outbox", "status.json"), JSON.stringify({ id: "", target: "server", result: "deployed", message: "Deployed.", from_commit: LIVE_BEFORE, to_commit: DEPLOYED, started: "", ended: "", backup: "", ...over }));
  const wait = async () => ((await db.select().from(settings).where(eq(settings.key, DEPLOY_WAIT_KEY)))[0]?.value as DeployWait | undefined) ?? null;
  return { ...built, db, close, dir, status, wait, setClock: (d: Date) => (clock = d) };
}

/** The approved update, sent to the host and being built (what the new leader inherits in the settings row). */
async function sentWait(c: Awaited<ReturnType<typeof setup>>, t0: number) {
  const decisionId = randomUUID();
  const w: DeployWait = { decisionId, commit: APPROVED, fromCommit: LIVE_BEFORE, approvedAt: new Date(t0 - 17 * MIN).toISOString(), phase: "sent", sentAt: new Date(t0 - 5 * MIN).toISOString(), deadline: new Date(t0 + 25 * MIN).toISOString(), minutes: 30, origin: "approve" };
  await c.db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: w });
  // The last update's runner-due row, its trial long over: what trialUntil read before this update's sync.
  await c.db.insert(settings).values({ key: "self_deploy_runner_due", value: { commit: LIVE_BEFORE, fromCommit: LIVE_BEFORE, after: new Date(t0 - 2 * 60 * MIN).toISOString(), offer: false } });
  return decisionId;
}

describe("trial soft hold across a blue/green takeover (BOS-2789)", () => {
  it("keeps merge checks parked for the whole trial when the deploy wait reads the host before self-deploy's first sync", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const id = await sentWait(c, t0);
    const ended = t0 - 15_000; // went live 15 s ago: the new leader's first deploy-wait pass
    await c.status({ id, started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(ended).toISOString() });
    c.setClock(new Date(t0));

    await c.deployWait.step(); // before any selfDeploy.sync(), as on 27 Nov
    const w = await c.wait();
    // Before the fix the row was gone here ("deployed; no standby window") and the parked checks started.
    expect(w?.phase).toBe("window");
    expect(w?.windowUntil).toBe(new Date(ended + 15 * MIN).toISOString());
    expect((await softHold(c.db, new Date(t0))).on).toBe(true);

    // Self-deploy's first pass writes its own trial end; the hold carries on through the window.
    await c.selfDeploy.sync();
    c.setClock(new Date(ended + 14 * MIN));
    expect((await c.deployWait.step())?.phase).toBe("window");
    expect((await softHold(c.db, new Date(ended + 14 * MIN))).on).toBe(true);

    // The trial ends: the hold lifts by itself.
    c.setClock(new Date(ended + 15 * MIN + 1000));
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.wait()).toBeNull();
    expect((await softHold(c.db, new Date(ended + 15 * MIN + 1000))).on).toBe(false);
  });

  it("lifts the hold by itself when the trial is switched back", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const id = await sentWait(c, t0);
    const ended = t0 - 15_000;
    await c.status({ id, started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(ended).toISOString() });
    c.setClock(new Date(t0));
    await c.deployWait.step();
    expect((await c.wait())?.phase).toBe("window");

    await c.status({ id, result: "rolled_back", message: "Switched back.", started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(t0 + MIN).toISOString() });
    c.setClock(new Date(t0 + 2 * MIN));
    expect(await c.deployWait.step()).toBeNull();
    expect((await softHold(c.db, new Date(t0 + 2 * MIN))).on).toBe(false);
  });

  it("still ends at once for a deploy whose trial is already over (a single server, or a late first pass)", async () => {
    const c = (ctx = await setup());
    const t0 = Date.now();
    const id = await sentWait(c, t0);
    const ended = t0 - 16 * MIN;
    await c.status({ id, started: new Date(ended - 3 * MIN).toISOString(), ended: new Date(ended).toISOString() });
    c.setClock(new Date(t0));
    expect(await c.deployWait.step()).toBeNull();
    expect(await c.wait()).toBeNull();
  });
});
