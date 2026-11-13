// BOS-1387: outgoing email. A local fake SMTP server stands in for Proton Mail, Cloudflare or any other provider.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { secrets, settings } from "../src/db/schema.js";
import { startFakeSmtp, makeTestCert } from "./fake-smtp.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const PASSWORD = "proton-token-Zx9!qL2mN7";
let cert: { key: string; cert: string };
beforeAll(() => {
  cert = makeTestCert();
});

let t: TestApp;
let cookie: string;
let fake: Awaited<ReturnType<typeof startFakeSmtp>> | undefined;
beforeEach(async () => {
  t = await makeApp({ mailTlsOptions: { ca: cert.cert } });
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await t.close();
});
afterAll(() => undefined);

const save = (body: Record<string, unknown>) => t.app.inject({ method: "PUT", url: "/api/settings/email", headers: { cookie }, payload: body });
const test = (to: string) => t.app.inject({ method: "POST", url: "/api/settings/email/test", headers: { cookie }, payload: { to } });
const base = (port: number, over: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port, security: "none", username: "sender@example.com", fromAddress: "boss@example.com", fromName: "Boss Man", password: PASSWORD, ...over });

describe("outgoing email is off until configured", () => {
  it("says so plainly and answers 401 without a session", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/settings/email" })).statusCode).toBe(401);
    const got = await t.app.inject({ method: "GET", url: "/api/settings/email", headers: { cookie } });
    expect(got.json()).toEqual({ settings: null, configured: false });
    const res = await test("me@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("isn't set up");
    await expect(t.mailer.send({ to: "a@example.com", subject: "x", text: "y" })).rejects.toThrow(/isn't set up/);
  });
});

describe("saving the settings", () => {
  it("keeps the password in the secret store and never returns or stores it elsewhere", async () => {
    fake = await startFakeSmtp();
    const res = await save(base(fake.port));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(PASSWORD);
    expect(res.json().settings).toMatchObject({ host: "127.0.0.1", security: "none", username: "sender@example.com", hasPassword: true });
    expect((await t.app.inject({ method: "GET", url: "/api/settings/email", headers: { cookie } })).body).not.toContain(PASSWORD);
    expect(JSON.stringify(await t.db.select().from(settings))).not.toContain(PASSWORD);
    const rows = await t.db.select().from(secrets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ciphertext).not.toContain(PASSWORD);
  });

  it("keeps the saved password when none is sent, replaces it when one is, and removes it on null", async () => {
    fake = await startFakeSmtp();
    await save(base(fake.port));
    const { password: _drop, ...noPassword } = base(fake.port, { fromName: "Renamed" });
    const kept = await save(noPassword);
    expect(kept.json().settings).toMatchObject({ hasPassword: true, fromName: "Renamed" });
    expect(await t.db.select().from(secrets)).toHaveLength(1);
    await save(base(fake.port, { password: "second-password-123" }));
    expect(await t.db.select().from(secrets)).toHaveLength(1);
    const removed = await save(base(fake.port, { password: null }));
    expect(removed.json().settings.hasPassword).toBe(false);
    expect(await t.db.select().from(secrets)).toHaveLength(0);
  });

  it("refuses an address that isn't a server name or a bad port", async () => {
    expect((await save(base(25, { host: "https://smtp.example.com" }))).statusCode).toBe(400);
    expect((await save(base(25, { port: 70000 }))).statusCode).toBe(400);
    expect((await save(base(25, { fromAddress: "not-an-address" }))).statusCode).toBe(400);
    expect((await save(base(25, { security: "ssl" }))).statusCode).toBe(400);
  });

  it("turns email off again with DELETE and drops the password", async () => {
    fake = await startFakeSmtp();
    await save(base(fake.port));
    const res = await t.app.inject({ method: "DELETE", url: "/api/settings/email", headers: { cookie } });
    expect(res.json()).toEqual({ settings: null, configured: false });
    expect(await t.db.select().from(secrets)).toHaveLength(0);
  });
});

describe("Send test email", () => {
  it("delivers through plain authenticated SMTP and sends a readable message", async () => {
    fake = await startFakeSmtp({ auth: { user: "sender@example.com", pass: PASSWORD } });
    await save(base(fake.port));
    const res = await test("owner@example.com");
    expect(res.json()).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
    const m = fake.received[0]!;
    expect(m).toMatchObject({ from: "boss@example.com", to: ["owner@example.com"], authed: "sender@example.com" });
    expect(m.data).toContain('From: "Boss Man" <boss@example.com>');
    expect(m.data).toContain("To: owner@example.com");
    const body = m.data.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString()).toContain("outgoing email works");
  });

  it("upgrades with STARTTLS (the default) before it sends the password", async () => {
    fake = await startFakeSmtp({ starttls: true, cert, auth: { user: "sender@example.com", pass: PASSWORD } });
    await save(base(fake.port, { security: "starttls" }));
    expect((await test("owner@example.com")).json()).toEqual({ ok: true });
    expect(fake.received[0]).toMatchObject({ encrypted: true, authed: "sender@example.com" });
  });

  it("refuses replies injected in plaintext after the STARTTLS 220 instead of reading them over TLS", async () => {
    // BOS-1410: "220 go" and a fake "250" arrive together; the fake 250 must never be taken as an answer.
    for (const injected of ["250 fake\r\n", "250 fa", "250-fake\r\n"]) {
      fake = await startFakeSmtp({ starttls: true, cert, auth: { user: "sender@example.com", pass: PASSWORD }, starttlsInjected: injected });
      await save(base(fake.port, { security: "starttls" }));
      const res = await test("owner@example.com");
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain("sent data before the encryption started");
      expect(fake.received).toHaveLength(0);
      await fake.close();
      fake = undefined;
    }
  });

  it("works over TLS from the first byte (port 465 style)", async () => {
    fake = await startFakeSmtp({ implicitTls: true, cert, auth: { user: "sender@example.com", pass: PASSWORD } });
    await save(base(fake.port, { security: "tls" }));
    expect((await test("owner@example.com")).json()).toEqual({ ok: true });
    expect(fake.received[0]!.encrypted).toBe(true);
  });

  it("says so when STARTTLS is asked for and the server doesn't offer it", async () => {
    fake = await startFakeSmtp();
    await save(base(fake.port, { security: "starttls" }));
    const res = await test("owner@example.com");
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("doesn't offer STARTTLS");
  });

  it("shows the server's plain answer on a refused login, with the password hidden", async () => {
    // A server that echoes what it was given: the answer must not carry the password back to the page.
    fake = await startFakeSmtp({ auth: { user: "sender@example.com", pass: "different" }, authFailReply: (given) => `535 5.7.8 bad login for ${given}` });
    await save(base(fake.port));
    const res = await test("owner@example.com");
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("535 5.7.8");
    expect(res.body).not.toContain(PASSWORD);
  });

  it("shows a refused recipient in the server's words", async () => {
    fake = await startFakeSmtp({ rejectRcpt: "550 5.1.1 no such mailbox" });
    await save(base(fake.port, { username: null, password: null }));
    const res = await test("nobody@example.com");
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("550 5.1.1 no such mailbox");
  });

  it("says when it can't reach the server", async () => {
    fake = await startFakeSmtp();
    const port = fake.port;
    await fake.close();
    fake = undefined;
    await save(base(port));
    const res = await test("owner@example.com");
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/ECONNREFUSED/);
  });

  it("refuses a recipient with a line break instead of sending it", async () => {
    fake = await startFakeSmtp();
    await save(base(fake.port));
    expect((await test("a@example.com\r\nBcc: x@example.com")).statusCode).toBe(400);
    expect(fake.received).toHaveLength(0);
  });

  it("dot-stuffs a body line that starts with a dot and encodes a non-ASCII subject", async () => {
    fake = await startFakeSmtp();
    await save(base(fake.port, { username: null, password: null }));
    await t.mailer.send({ to: "a@example.com", subject: "Café", text: "one\n.two\nthree" });
    const m = fake.received[0]!;
    expect(m.data).toContain("Subject: =?UTF-8?B?");
    const body = m.data.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString()).toBe("one\r\n.two\r\nthree");
  });
});
