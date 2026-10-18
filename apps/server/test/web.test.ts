import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup(opts: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, ...opts });
  ctx = { close: async () => (await built.app.close(), await close()) };
  return built;
}

describe("the web UI (R45)", () => {
  it("serves the built page with a strict policy, caches hashed assets, and keeps API errors JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-web-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Boss Man</title>");
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
    const { app } = await setup({ webDir: dir });

    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>Boss Man</title>");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    expect((await app.inject({ method: "GET", url: "/../package.json" })).statusCode).toBe(404);
    const api = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ statusCode: 404 });
    expect(api.headers["content-security-policy"]).toBeUndefined();
  });

  it("locks login after repeated failures, even for the right password, then lets it through again", async () => {
    let clock = 1_000_000;
    const { app } = await setup({ loginLimits: { maxFailures: 3, windowMs: 60_000 }, now: () => new Date(clock) });
    await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const login = (password: string) => app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password } });
    for (let i = 0; i < 3; i++) expect((await login("wrong password!!")).statusCode).toBe(401);
    const locked = await login("correct horse battery");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().message).toBe("Too many failed logins. Try again in 1 minute.");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    clock += 61_000;
    expect((await login("correct horse battery")).statusCode).toBe(200);
  });

  it("lists a company's projects for the board picker", async () => {
    const { app } = await setup();
    const s = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const { company } = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json();
    for (const name of ["Website", "Customer app"]) await app.inject({ method: "POST", url: `/api/companies/${company.id}/projects`, headers: { cookie }, payload: { name } });
    const list = (await app.inject({ method: "GET", url: `/api/companies/${company.id}/projects`, headers: { cookie } })).json();
    expect(list.map((p: { name: string }) => p.name)).toEqual(["Customer app", "Website"]);
  });

  it("says whether a company's runner is registered and connected", async () => {
    const built = await setup();
    const { app } = built;
    const s = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const { company } = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json();
    const status = () => app.inject({ method: "GET", url: `/api/companies/${company.id}/runner`, headers: { cookie } }).then((r) => r.json());
    expect(await status()).toEqual({ registered: false, launcher: null });
    const reg = (await app.inject({ method: "POST", url: `/api/companies/${company.id}/runner`, headers: { cookie } })).json();
    expect(await status()).toMatchObject({ registered: true, runnerId: reg.runnerId, connected: false });
    built.runners.connect(reg.runnerId, () => true);
    expect(await status()).toMatchObject({ connected: true });
    // The token itself is never shown again.
    expect(JSON.stringify(await status())).not.toContain(reg.token);
  });
});
