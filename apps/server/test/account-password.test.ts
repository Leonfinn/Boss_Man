import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activity, companies, notifications, owners, sessions } from "../src/db/schema.js";
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

// BOS-2177: ten wrong sign-ins tell the owner once, with the address and no guess in the text.
describe("sign-in lockout notice", () => {
  it("raises one alert and one activity line, and none for further refused attempts", async () => {
    await signIn(t);
    await t.db.insert(companies).values({ name: "Example Co" });
    const wrong = (i: number) => t.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: `secret guess ${i}` }, remoteAddress: "192.168.1.50" });
    for (let i = 0; i < 10; i++) expect((await wrong(i)).statusCode).toBe(401);
    expect((await wrong(10)).statusCode).toBe(429);
    expect((await wrong(11)).statusCode).toBe(429);
    // The notice is sent without waiting for it, so wait for the activity line.
    await vi.waitFor(async () => expect(await t.db.select().from(activity).where(eq(activity.kind, "security"))).toHaveLength(1), { timeout: 5000 });
    const notes = (await t.db.select().from(notifications)).filter((n) => n.title.startsWith("Sign-in was locked"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("192.168.1.50");
    expect(notes[0]!.body).toContain("Settings → Account");
    const lines = await t.db.select().from(activity).where(eq(activity.kind, "security"));
    expect(JSON.stringify([notes, lines])).not.toContain("secret guess");
  });

  it("raises nothing for a correct sign-in, and says the username was locked when it locks from several addresses", async () => {
    await signIn(t);
    await t.db.insert(companies).values({ name: "Example Co" });
    const from = (ip: string, password: string) => t.app.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password }, remoteAddress: ip });
    expect((await from("192.168.1.60", OLD)).statusCode).toBe(200);
    expect(await t.db.select().from(activity).where(eq(activity.kind, "security"))).toHaveLength(0);
    for (let i = 0; i < 10; i++) await from(`192.168.1.${100 + i}`, `secret guess ${i}`);
    await vi.waitFor(async () => expect(await t.db.select().from(activity).where(eq(activity.kind, "security"))).toHaveLength(1), { timeout: 5000 });
    const notes = (await t.db.select().from(notifications)).filter((n) => n.title.includes("was locked"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("the owner's username was locked");
  });

  it("BOS-2207: a made-up username is not called the owner's, and only 3 notices go out across addresses", async () => {
    await signIn(t);
    await t.db.insert(companies).values({ name: "Example Co" });
    const from = (ip: string, name: string) => t.app.inject({ method: "POST", url: "/api/login", payload: { username: name, password: "secret guess" }, remoteAddress: ip });
    // Five made-up usernames, each locked from ten different addresses.
    for (let n = 0; n < 5; n++) for (let i = 0; i < 10; i++) await from(`192.168.${n}.${100 + i}`, `made-up-${n}`);
    await vi.waitFor(async () => expect(await t.db.select().from(activity).where(eq(activity.kind, "security"))).toHaveLength(3), { timeout: 5000 });
    const notes = (await t.db.select().from(notifications)).filter((n) => n.title.includes("was locked"));
    expect(notes).toHaveLength(3);
    for (const n of notes) {
      expect(n.title).toContain("a username was locked");
      expect(n.title).not.toContain("owner's");
    }
    expect(await t.db.select().from(activity).where(eq(activity.kind, "security"))).toHaveLength(3);
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
