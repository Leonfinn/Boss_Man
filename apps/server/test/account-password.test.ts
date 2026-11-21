import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { owners, sessions } from "../src/db/schema.js";
import { hashToken } from "../src/auth.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// BOS-2159: change password, sign out other devices, clear expired logins. Passwords here are made up.
const OLD = "correct horse battery";
const NEW = "a brand new passphrase";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const login = async (password: string) => t.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password } });
const cookieOf = (res: Awaited<ReturnType<typeof login>>) => `bm_session=${res.cookies.find((x) => x.name === "bm_session")!.value}`;
const me = (cookie: string) => t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
const change = (cookie: string | undefined, payload: unknown) => t.app.inject({ method: "POST", url: "/api/account/password", headers: cookie ? { cookie } : {}, payload: payload as object });

describe("change password", () => {
  it("needs a signed-in owner", async () => {
    await signIn(t);
    expect((await change(undefined, { currentPassword: OLD, newPassword: NEW })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/api/account/sign-out-others" })).statusCode).toBe(401);
  });

  it("sets the new password, keeps this device signed in and ends the others", async () => {
    const { cookie } = await signIn(t);
    const other = cookieOf(await login(OLD));
    const res = await change(cookie, { currentPassword: OLD, newPassword: NEW });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, signedOut: 1 });
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await me(other)).statusCode).toBe(401);
    expect((await login(OLD)).statusCode).toBe(401);
    expect((await login(NEW)).statusCode).toBe(200);
    expect(res.body).not.toContain(NEW);
  });

  it("refuses a wrong current password and a bad new one, changing nothing", async () => {
    const { cookie } = await signIn(t);
    const [before] = await t.db.select().from(owners);
    expect((await change(cookie, { currentPassword: "not the password", newPassword: NEW })).statusCode).toBe(403);
    expect((await change(cookie, { currentPassword: OLD, newPassword: "short" })).statusCode).toBe(400);
    expect((await change(cookie, { currentPassword: OLD, newPassword: OLD })).statusCode).toBe(400);
    const [after] = await t.db.select().from(owners);
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect((await login(OLD)).statusCode).toBe(200);
  });

  it("counts wrong current passwords with the login limiter, so guessing here is locked out too", async () => {
    const { cookie } = await signIn(t);
    for (let i = 0; i < 10; i++) expect((await change(cookie, { currentPassword: `wrong guess ${i}`, newPassword: NEW })).statusCode).toBe(403);
    const locked = await change(cookie, { currentPassword: OLD, newPassword: NEW });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeTruthy();
    // The limiter is shared with login, so the lock-out covers both; the password was not changed.
    expect((await login(NEW)).statusCode).toBe(429);
    const [row] = await t.db.select().from(owners);
    expect(row!.passwordHash).not.toContain(NEW);
  });
});

describe("sign out other devices", () => {
  it("ends every other login and keeps this one", async () => {
    const { cookie } = await signIn(t);
    const a = cookieOf(await login(OLD));
    const b = cookieOf(await login(OLD));
    const res = await t.app.inject({ method: "POST", url: "/api/account/sign-out-others", headers: { cookie } });
    expect(res.json()).toEqual({ ok: true, signedOut: 2 });
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(401);
    expect((await login(OLD)).statusCode).toBe(200);
  });
});

describe("expired logins", () => {
  it("the sweep deletes expired rows and keeps live ones", async () => {
    const { cookie } = await signIn(t);
    const [owner] = await t.db.select().from(owners);
    await t.db.insert(sessions).values({ tokenHash: hashToken("kit-expired-token"), ownerId: owner!.id, expiresAt: new Date(Date.now() - 60_000) });
    expect(await t.sweepExpiredSessions()).toBe(1);
    expect(await t.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken("kit-expired-token")))).toHaveLength(0);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await t.sweepExpiredSessions()).toBe(0);
  });
});
