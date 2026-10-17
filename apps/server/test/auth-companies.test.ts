import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agents } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe("owner setup and sessions", () => {
  it("allows setup once, then refuses", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/setup" })).json()).toEqual({ needsSetup: true });
    await signIn(t);
    const again = await t.app.inject({ method: "POST", url: "/api/setup", payload: { username: "x", password: "another long password" } });
    expect(again.statusCode).toBe(409);
  });

  it("rejects short passwords", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "short" } });
    expect(res.statusCode).toBe(400);
  });

  it("protects owner routes and sets a strict httpOnly cookie", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const setup = await t.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const c = setup.cookies.find((x) => x.name === "bm_session")!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe("strict");
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `bm_session=${c.value}` } });
    expect(me.json()).toEqual({ username: "leon" });
  });

  it("logs in with the right password only, and logout ends the session", async () => {
    await signIn(t);
    const bad = await t.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "wrong password here" } });
    expect(bad.statusCode).toBe(401);
    const good = await t.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } });
    expect(good.statusCode).toBe(200);
    const cookie = `bm_session=${good.cookies.find((x) => x.name === "bm_session")!.value}`;
    await t.app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("companies", () => {
  it("creates a real CEO with every company (R18)", async () => {
    const { cookie } = await signIn(t);
    const res = await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Homelab Co", ceo: { agentKind: "claude", model: "claude-opus-5-5" } } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ceo).toMatchObject({ role: "ceo", agentKind: "claude", model: "claude-opus-5-5" });
    const list = await t.app.inject({ method: "GET", url: "/api/companies", headers: { cookie } });
    // Each company also gets a wiki maintainer, paused until the owner gives it a model (R73).
    expect(list.json()[0].agents.map((a: { role: string; duty: string | null; paused: boolean }) => [a.role, a.duty, a.paused]).sort()).toEqual([
      ["ceo", null, false],
      ["worker", "wiki", true],
    ]);
  });

  it("refuses a second CEO in the same company", async () => {
    const { cookie } = await signIn(t);
    const { company } = (await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json();
    await expect(t.db.insert(agents).values({ companyId: company.id, name: "CEO 2", role: "ceo", agentKind: "claude" })).rejects.toThrow();
  });

  it("refuses duplicate company names", async () => {
    const { cookie } = await signIn(t);
    await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } });
    const dup = await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } });
    expect(dup.statusCode).toBe(409);
  });
});
