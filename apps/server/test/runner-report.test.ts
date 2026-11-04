import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { MAINTENANCE_LAST_KEY } from "../src/services/maintenance.js";
import { runners as runnersTable, settings } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  await rm(ctx!.dir, { recursive: true, force: true });
  ctx = undefined;
});

const KEY = "k".repeat(43);

async function setup() {
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
      if (url.pathname === "/runners") return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
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
  return { ...built, db, close, dir, req, company, runnerHello, last };
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
