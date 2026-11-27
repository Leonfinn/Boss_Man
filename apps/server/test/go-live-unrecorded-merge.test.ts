// BOS-1640: BOS-1601 merged as 0c5917c5 at 23:53, main went live three times after it, yet its Go-live line kept saying
// "live on the server: no (the server runs commit 24b77dd8)". 24b77dd8 was BOS-1635's merge, which landed on main but was
// never recorded on that ticket (the merge reply was lost to a runner restart). The server has no git and places "is this
// merge live?" by merge order, so a live commit that is no ticket's recorded merge made EVERY merge read "not live".
// The fix: a host-deployer deploy is always a fast-forward of what ran, so its from_commit is kept as a commit the live one
// contains, and an unplaceable live commit is placed by that.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm as rmFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { settings, tickets } from "../src/db/schema.js";
import { goLiveLine, goLiveWaitOf, serverContains } from "../src/services/go-live-wait.js";
import { imageContains } from "../src/services/runner-image.js";

const EARLY = "a".repeat(40); // BOS-1601: merged, recorded, before the deploys
const PREV = "b".repeat(40); // a recorded merge that went live (d915d70f)
const LOST = "c".repeat(40); // a merge on main that no ticket records (24b77dd8)
const AFTER = "d".repeat(40); // a recorded merge after PREV, not in what runs
const NEXT = "e".repeat(40); // another unrecorded live commit, deployed over LOST

describe("placing a live commit that is no ticket's merge (pure)", () => {
  const order = [EARLY, PREV, AFTER];
  it("before the fix's record: an unplaceable live commit says no for everything (never assumed live)", () => {
    expect(serverContains(LOST, EARLY, order)).toBe(false);
    expect(serverContains(LOST, PREV, order)).toBe(false);
  });
  it("with the commit it was deployed over: every merge at or before that one is live, later ones are not", () => {
    expect(serverContains(LOST, EARLY, order, [PREV])).toBe(true);
    expect(serverContains(LOST, PREV, order, [PREV])).toBe(true);
    expect(serverContains(LOST, AFTER, order, [PREV])).toBe(false);
  });
  it("a commit the live one is known to contain counts even when it is not in merge order itself", () => {
    expect(serverContains(NEXT, LOST, order, [LOST, PREV])).toBe(true);
    expect(serverContains(NEXT, EARLY, order, [LOST, PREV])).toBe(true);
  });
  it("a live commit that IS a recorded merge keeps its own place", () => {
    expect(serverContains(PREV, AFTER, order, [AFTER])).toBe(true); // the record says it contains AFTER, so it does
    expect(serverContains(PREV, AFTER, order)).toBe(false);
    expect(serverContains(PREV, EARLY, order)).toBe(true);
  });
  it("the runner image is placed the same way", () => {
    expect(imageContains(LOST, EARLY, order)).toBe(false);
    expect(imageContains(LOST, EARLY, order, [PREV])).toBe(true);
    expect(imageContains(LOST, AFTER, order, [PREV])).toBe(false);
  });
});

let ctx: Awaited<ReturnType<typeof setupApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rmFile(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setupApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-golive-lost-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: dir });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Home Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Development" })).json() as { id: string };
  return { ...built, db, close, dir, req, companyId: company.id, projectId: project.id };
}

type Ctx = Awaited<ReturnType<typeof setupApp>>;

async function merged(c: Ctx, commit: string, at: string) {
  const t = (await c.req("POST", `/api/projects/${c.projectId}/tickets`, { title: `Merged ${commit.slice(0, 1)}` })).json() as { id: string };
  await c.db.update(tickets).set({ mergeCommit: commit, mergedAt: new Date(at), touchesRunner: false, systemState: "done" }).where(eq(tickets.id, t.id));
  return { companyId: c.companyId, mergeCommit: commit, touchesRunner: false, liveMarkedAt: null };
}

/** What the host deployer publishes after a server deploy (or a rollback) it ran. */
async function hostReports(c: Ctx, o: { from: string; to: string; result?: string }) {
  await writeFile(path.join(c.dir, "outbox", "available.json"), JSON.stringify({ checkedAt: new Date().toISOString(), deployed: o.to, tip: o.to, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
  await writeFile(
    path.join(c.dir, "outbox", "status.json"),
    JSON.stringify({ id: randomUUID(), target: "server", result: o.result ?? "deployed", message: "Deployed.", from_commit: o.from, to_commit: o.to, started: "2026-11-16T11:40:00Z", ended: new Date(Date.now() + 1000).toISOString(), backup: "" }),
  );
  await c.selfDeploy.sync();
}

const record = async (c: Ctx) => ((await c.db.select().from(settings).where(eq(settings.key, `live_release:${c.companyId}`)))[0]?.value ?? {}) as { new?: string; contains?: string[] };

describe("go-live resolves for every merge the live commit contains (BOS-1640)", () => {
  it("the BOS-1601 case: deployed over a recorded merge onto an unrecorded one, the earlier merge reads live and a later one doesn't", { timeout: 60_000 }, async () => {
    const c = (ctx = await setupApp());
    const early = await merged(c, EARLY, "2026-11-15T23:53:00Z");
    await merged(c, PREV, "2026-11-16T10:44:00Z");
    const after = await merged(c, AFTER, "2026-11-16T12:00:00Z");
    await c.releaseLog.note(c.companyId, PREV);
    await c.releaseLog.releaseManagerWakes("restarted");
    expect(await goLiveLine(c.db, early)).toContain("live on the server: yes");

    await hostReports(c, { from: PREV, to: LOST });
    expect(await record(c)).toMatchObject({ new: LOST, contains: [PREV] });
    expect(await goLiveLine(c.db, early)).toContain("live on the server: yes (the server runs commit cccccccc)");
    expect(await goLiveWaitOf(c.db, early)).toBeNull();
    // A merge after the one it was deployed over is not assumed to be in it.
    expect(await goLiveLine(c.db, after)).toContain("live on the server: no");
    expect(await goLiveWaitOf(c.db, after)).toBe("server");

    // The record survives the release pass, and a second unrecorded deploy in a row still places by the chain.
    await c.releaseLog.releaseManagerWakes("deployed");
    expect((await record(c)).contains).toEqual([PREV]);
    await hostReports(c, { from: LOST, to: NEXT });
    expect(await record(c)).toMatchObject({ new: NEXT, contains: [LOST, PREV] });
    expect(await goLiveLine(c.db, early)).toContain("live on the server: yes");
  });

  it("backfills a live commit recorded before the host's report (the build's own commit first, the status a tick later)", { timeout: 60_000 }, async () => {
    const c = (ctx = await setupApp());
    const early = await merged(c, EARLY, "2026-11-15T23:53:00Z");
    await merged(c, PREV, "2026-11-16T10:44:00Z");
    // Recorded today, before this fix: the unrecorded commit is live with nothing known about what it contains.
    await c.db.insert(settings).values({ key: `live_release:${c.companyId}`, value: { old: LOST, new: LOST } });
    expect(await goLiveLine(c.db, early)).toContain("live on the server: can't tell (");
    await hostReports(c, { from: PREV, to: LOST });
    expect(await record(c)).toMatchObject({ new: LOST, contains: [PREV] });
    expect(await goLiveLine(c.db, early)).toContain("live on the server: yes");
  });

  it("the runner-update guard (BOS-1467) clears once the unrecorded live commit is placed", { timeout: 60_000 }, async () => {
    // What the owner hit: "Build and update runners" refused with "Waiting for BOS-1583 to go live", though BOS-1583 was
    // inside 24b77dd8. The guard reads "live" the same way as the Go-live line, so it was stuck the same way.
    const c = (ctx = await setupApp());
    await merged(c, EARLY, "2026-11-15T23:53:00Z");
    await c.db.update(tickets).set({ touchesRunnerUpdate: true }).where(eq(tickets.mergeCommit, EARLY));
    await merged(c, PREV, "2026-11-16T10:44:00Z");
    await c.db.insert(settings).values({ key: `live_release:${c.companyId}`, value: { old: LOST, new: LOST } });
    await writeFile(path.join(c.dir, "outbox", "available.json"), JSON.stringify({ checkedAt: new Date().toISOString(), deployed: LOST, tip: LOST, commits: [], paths: [], infraPaths: [], runnerChanged: false }));
    // Boss Man can't place the running commit: that is "can't tell", not "not live" (BOS-1644), so the guard does not
    // refuse with the BOS-1467 "waiting to go live" message. (The update may still queue behind the server's trial.)
    // The service step of the press: since BOS-2859 the route also approves the card it raises, which would make the
    // second press below "already under way" instead of showing the guard's answer.
    const before = (await c.selfDeploy.updateRunners()) as { error?: string; message?: string };
    expect(before.error ?? before.message ?? "").not.toContain("to go live: it fixes the runner update itself.");

    await hostReports(c, { from: PREV, to: LOST });
    const after = await c.req("POST", "/api/self-deploy/update-runners");
    // Accepted (it may queue behind the server update's trial); never the BOS-1467 refusal again.
    expect(after.statusCode).toBe(200);
  });

  it("a rollback says nothing about what the commit contains: still never assumed live", { timeout: 60_000 }, async () => {
    const c = (ctx = await setupApp());
    const early = await merged(c, EARLY, "2026-11-15T23:53:00Z");
    await merged(c, PREV, "2026-11-16T10:44:00Z");
    await c.releaseLog.note(c.companyId, PREV);
    await hostReports(c, { from: PREV, to: LOST, result: "rolled_back" });
    const r = await record(c);
    expect(r.new).toBe(LOST);
    expect(r.contains).toBeUndefined();
    // The running commit can't be placed: "can't tell" (BOS-1644), never "yes", and never a wrong "no".
    const line = await goLiveLine(c.db, early);
    expect(line).toContain("live on the server: can't tell (");
    expect(line).not.toContain("live on the server: yes");
  });
});
