import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

// BOS-242: Secure cookies per request, and X-Forwarded-* believed only from the exact Tailscale Serve hop.
const HOP = "172.30.0.2";
const pw = "correct horse battery";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const { db, close: closeDb } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: "auto", trustedProxies: [HOP], loginLimits: { maxFailures: 3, windowMs: 60_000 } });
  close = async () => (await built.app.close(), await closeDb());
  await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: pw } });
  const login = (remoteAddress: string, headers: Record<string, string> = {}, password = pw, username = "leon") =>
    built.app.inject({ method: "POST", url: "/api/login", remoteAddress, headers, payload: { username, password } });
  return { login };
}
const session = (r: { cookies: { name: string; secure?: boolean }[] }) => r.cookies.find((c) => c.name === "bm_session");

describe("BOS-242 https through the trusted hop", () => {
  it("sets a Secure cookie over https via the trusted hop", async () => {
    const { login } = await setup();
    const r = await login(HOP, { "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.9" });
    expect(r.statusCode).toBe(200);
    expect(session(r)?.secure).toBe(true);
  });

  it("still logs in over plain LAN http, without Secure", async () => {
    const { login } = await setup();
    const r = await login("192.168.68.20");
    expect(r.statusCode).toBe(200);
    expect(session(r)?.secure).toBeFalsy();
  });

  it("ignores spoofed forwarded headers from an untrusted address", async () => {
    const { login } = await setup();
    const r = await login("192.168.68.20", { "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.9" });
    expect(r.statusCode).toBe(200);
    expect(session(r)?.secure).toBeFalsy();
    // Rotating a spoofed client address must not dodge the per-address limit (a different username each time, so only the address counts).
    for (let i = 0; i < 3; i++) await login("192.168.68.21", { "x-forwarded-for": `10.9.9.${i}` }, "wrong password here", `guess${i}`);
    expect((await login("192.168.68.21", { "x-forwarded-for": "10.9.9.99" }, "wrong password here", "guess9")).statusCode).toBe(429);
  });

  it("limits logins per client behind the hop, not for everyone", async () => {
    const { login } = await setup();
    const via = (client: string, username: string, password = "wrong password here") => login(HOP, { "x-forwarded-proto": "https", "x-forwarded-for": client }, password, username);
    for (let i = 0; i < 3; i++) await via("100.64.0.1", `guess${i}`);
    expect((await via("100.64.0.1", "guess9")).statusCode).toBe(429);
    // A second phone behind the same hop is not locked out by the first.
    expect((await via("100.64.0.2", "leon", pw)).statusCode).toBe(200);
  });
});
