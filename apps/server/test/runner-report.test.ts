import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { MAINTENANCE_KEY, MAINTENANCE_LAST_KEY } from "../src/services/maintenance.js";
import { describeLive, judgeUpdate } from "../src/services/runner-report.js";
import { runners as runnersTable, settings } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

const KEY = "k".repeat(43);

async function setup(launched: unknown[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-report-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "key"), `${KEY}\n`);
  const { db, close } = await openPglite();
  const built = await buildApp({
    db,
    master: { version: 1, key: randomBytes(32) },
    secureCookies: false,
    tickOnWake: false,
    limits: { quickBatchMs: 0 },
    workspaceRoot: "/ws",
    launcher: { url: "http://launcher:3105", keyFile: path.join(dir, "key") },
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/runners") return new Response(JSON.stringify(launched), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch,
  });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const company = async (name: string, slug: string) => {
    const { company: c } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    await db.insert(settings).values({ key: `runner-slug:${c.id}`, value: slug }).onConflictDoUpdate({ target: settings.key, set: { value: slug } });
    return c.id;
  };
  /** The runner said hello on this image; `connect` decides whether its socket is still open (BOS-465's healthy reconnect). */
  const runnerHello = async (companyId: string, image: string, connect: boolean) => {
    const reg = (await req("POST", `/api/companies/${companyId}/runner`)).json() as { runnerId: string };
    const [r] = await db.select().from(runnersTable).where(eq(runnersTable.id, reg.runnerId));
    await built.runners.touch(r!, image);
    if (connect) built.runners.connect(reg.runnerId, () => true);
  };
  const last = (value: unknown) => db.insert(settings).values({ key: MAINTENANCE_LAST_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  const hold = (value: unknown) => db.insert(settings).values({ key: MAINTENANCE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return { ...built, db, close, dir, req, company, runnerHello, last, hold };
}

describe("Settings → Runner: the live state first, a past problem as history (BOS-465)", () => {
  it("a failed update whose runner has since connected on its image shows healthy, with the problem resolved", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611040849", true);
    await c.last({ at: new Date().toISOString(), startedAt: null, ok: false, title: "Runner update finished with problems", body: "app-co: has not reconnected" });

    const dev = (await c.req("GET", "/api/runner-report")).json() as { live: Array<{ name: string; connected: boolean; imageVersion: string }>; update: { state: string; todo: string | null } };
    expect(dev.live).toMatchObject([{ name: "App Co", connected: true, imageVersion: "202611040849" }]);
    expect(dev.update).toMatchObject({ state: "resolved", todo: null });
  });

  it("the same past problem stays red while the runner is away, and says what to do", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611040849", false);
    await c.last({ at: new Date().toISOString(), startedAt: null, ok: false, title: "Runner update finished with problems", body: "app-co: has not reconnected" });

    const dev = (await c.req("GET", "/api/runner-report")).json() as { update: { state: string; todo: string | null } };
    expect(dev.update.state).toBe("problem");
    expect(dev.update.todo).toMatch(/start it again/i);
  });

  it("a removal that raced another is not a problem once the runner is back on its image", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611040849", true);
    // The owner's case: an old failure line, and the runner now healthy on the image that update installed.
    await c.last({ at: new Date().toISOString(), startedAt: null, ok: false, title: "Runner update finished with problems", body: "app-co: Removing the runner failed: removal of container abe3a22 is already in progress" });
    const dev = (await c.req("GET", "/api/runner-report")).json() as { update: { state: string; todo: string | null } };
    expect(dev.update).toMatchObject({ state: "resolved", todo: null });
  });

  it("per company: a past problem whose runner is back reads resolved, and a company it doesn't name is not blamed", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611040849", true);
    await c.last({ at: "2026-11-04T10:00:00.000Z", startedAt: null, ok: false, title: "Runner update finished with problems", body: "app-co: has not reconnected" });
    const report = (await c.req("GET", `/api/companies/${id}/runner`)).json() as { report: { live: { ok: boolean; text: string }; last: { state: string } | null } };
    expect(report.report.live).toMatchObject({ ok: true });
    expect(report.report.live.text).toMatch(/Runner connected since \d\d:\d\d · image 202611040849/);
    expect(report.report.last).toMatchObject({ state: "resolved" });

    // A different company isn't named in that problem's lines, so it has no history of its own.
    const other = await c.company("Other Co", "other-co");
    await c.runnerHello(other, "202611040849", true);
    const others = (await c.req("GET", `/api/companies/${other}/runner`)).json() as { report: { last: unknown } };
    expect(others.report.last).toBeNull();
  });

  it("a disconnected runner's live line says to start it again, even with no update history", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611040849", false);
    const r = (await c.req("GET", `/api/companies/${id}/runner`)).json() as { report: { live: { ok: boolean; text: string } } };
    expect(r.report.live.ok).toBe(false);
    expect(r.report.live.text).toMatch(/Not connected/);
    expect(r.report.live.text).toMatch(/start it again/i);
  });
});

describe("Settings → Runner during a planned swap (BOS-382 slice D)", () => {
  const since = "2026-11-06T12:00:00.000Z";
  const holdOn = (extra: object = {}) => ({ reason: "runner update", since, deadline: "2026-11-06T12:30:00.000Z", minutes: 30, ...extra });
  type Live = { report: { live: { ok: boolean; text: string; state: string } } };

  it("an away runner whose swap is under way says Updating, not Not connected", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611060800", false);
    await c.hold(holdOn({ swapped: { "app-co": since } }));
    const r = (await c.req("GET", `/api/companies/${id}/runner`)).json() as Live;
    expect(r.report.live.state).toBe("updating");
    expect(r.report.live.text).toMatch(/^Updating: swapping to the new runner/);
    expect(r.report.live.text).not.toMatch(/Not connected|start it again/i);
    const dev = (await c.req("GET", "/api/runner-report")).json() as { live: Array<{ swap: unknown }> };
    expect(dev.live[0]!.swap).toMatchObject({ retryAt: null, tries: 0 });
  });

  it("a swap waiting for its next try says when it tries again", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611060800", false);
    await c.hold(holdOn({ tries: { "app-co": { n: 1, next: "2026-11-06T12:01:30.000Z", last: "Creating the runner failed: boom" } } }));
    const r = (await c.req("GET", `/api/companies/${id}/runner`)).json() as Live;
    expect(r.report.live.state).toBe("updating");
    expect(r.report.live.text).toContain("trying again at 12:01 (try 2)");
  });

  it("a swap that failed says Update failed and what to press", async () => {
    const c = (ctx = await setup());
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611060800", false);
    await c.hold(holdOn({ failed: { "app-co": "the new runner would not start (3 tries: boom), and going back to the previous runner image failed too (gone). Press Start runner in Settings > Runner" } }));
    const r = (await c.req("GET", `/api/companies/${id}/runner`)).json() as Live;
    expect(r.report.live).toMatchObject({ ok: false, state: "failed" });
    expect(r.report.live.text).toMatch(/^Update failed: .*Press Start runner below\.$/);
  });

  it("a runner the launcher froze for its network guard says Paused, with the reason", async () => {
    const c = (ctx = await setup([{ slug: "app-co", state: "paused", status: "Up 2 minutes (Paused)", image: "boss-man-runner:latest", current: true, guard: "off", guardReason: "guard container exited", guardSince: since }]));
    const id = await c.company("App Co", "app-co");
    await c.runnerHello(id, "202611060800", false);
    const r = (await c.req("GET", `/api/companies/${id}/runner`)).json() as Live;
    expect(r.report.live).toMatchObject({ ok: false, state: "paused" });
    expect(r.report.live.text).toContain("Paused: the network guard isn't working (guard container exited)");
  });

  it("a connected runner stays Connected while the hold is on", () => {
    const l = describeLive({ registered: true, connected: true, at: since, imageVersion: "1", fault: null, swap: { retryAt: null, tries: 0 } });
    expect(l.state).toBe("connected");
  });

  it("after the hold lifts, a swap that went back or couldn't is told apart", () => {
    const base = { at: since, startedAt: null, ok: false, title: "Runner update finished with problems" };
    const away = { "app-co": { registered: true, connected: false, at: since, imageVersion: "1", fault: null } };
    const back = judgeUpdate({ ...base, body: "app-co: the new runner would not start (3 tries: Creating the runner failed: boom), so it was put back on the previous runner image and is running that" }, away);
    expect(back?.todo).toMatch(/previous version/);
    const stuck = judgeUpdate({ ...base, body: "app-co: the new runner would not start (3 tries: Creating the runner failed: boom), and going back to the previous runner image failed too (gone). Press Start runner in Settings > Runner" }, away);
    expect(stuck?.todo).toMatch(/press Start runner/);
  });
});
