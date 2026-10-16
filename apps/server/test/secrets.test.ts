import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import { secretAccessLog, secrets } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const TOKEN = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeApp({
    // Stands in for the provider check; never touches the network.
    liveValidator: async (kind, value) => (kind === "anthropic_api_key" ? { ok: value.endsWith("good"), message: value.endsWith("good") ? "ok" : "The provider rejected the key (HTTP 401)." } : null),
  });
  ({ cookie } = await signIn(t));
});
afterEach(async () => {
  await t.close();
});

async function company(name: string): Promise<string> {
  return (await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name } })).json().company.id;
}

describe("envelope encryption", () => {
  it("round-trips and fails under the wrong master key", () => {
    const m1 = { version: 1, key: randomBytes(32) };
    const m2 = { version: 1, key: randomBytes(32) };
    const sealed = encryptSecret(m1, "hello");
    expect(decryptSecret(m1, sealed)).toBe("hello");
    expect(() => decryptSecret(m2, sealed)).toThrow();
  });
});

describe("secrets store", () => {
  it("strips whitespace from a pasted token and never returns the value (R13a)", async () => {
    const pasted = `${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}  `;
    const res = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Claude setup-token", kind: "claude_oauth_token", value: pasted } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(TOKEN);
    expect(res.json().secret.hint).toBe(`••••${TOKEN.slice(-4)}`);

    const [row] = await t.db.select().from(secrets);
    expect(row!.ciphertext).not.toContain(TOKEN);
    expect(decryptSecret(t.master, row!)).toBe(TOKEN);

    const list = await t.app.inject({ method: "GET", url: "/api/secrets", headers: { cookie } });
    expect(list.body).not.toContain(TOKEN);
    expect(list.json()[0]).not.toHaveProperty("ciphertext");
  });

  it("rejects a token with the wrong prefix unless the owner insists", async () => {
    const bad = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "x", kind: "claude_oauth_token", value: "sk-ant-api03-wrongkind" } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().problems[0]).toMatch(/sk-ant-oat01-/);
    const forced = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "x", kind: "claude_oauth_token", value: "sk-ant-api03-wrongkind", acceptUnusualFormat: true } });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().warnings).toHaveLength(1);
  });

  it("runs the live check only when asked, and refuses a key the provider rejects", async () => {
    const rejected = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "API", kind: "anthropic_api_key", value: "sk-ant-api03-bad", verify: true } });
    expect(rejected.statusCode).toBe(422);
    const ok = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "API", kind: "anthropic_api_key", value: "sk-ant-api03-good", verify: true } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().verified).toEqual({ ok: true, message: "ok" });
  });

  it("grants one secret to several companies, logs each use, and rotates once for all", async () => {
    const appCo = await company("App Co");
    const homelab = await company("Homelab Co");
    const created = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Claude setup-token", kind: "claude_oauth_token", value: TOKEN } });
    const secretId = created.json().secret.id;
    for (const c of [appCo, homelab]) {
      const g = await t.app.inject({ method: "POST", url: `/api/secrets/${secretId}/grants`, headers: { cookie }, payload: { companyId: c, envName: "CLAUDE_CODE_OAUTH_TOKEN" } });
      expect(g.statusCode).toBe(201);
    }

    expect(await t.secrets.resolveCompanyEnv(homelab, "spike-test")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(await t.db.select().from(secretAccessLog)).toHaveLength(1);

    const rotated = `${TOKEN.slice(0, -4)}9999`;
    const r = await t.app.inject({ method: "PUT", url: `/api/secrets/${secretId}/value`, headers: { cookie }, payload: { value: rotated } });
    expect(r.json().secret.version).toBe(2);
    expect(await t.secrets.resolveCompanyEnv(appCo, "run")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: rotated });
    expect(await t.secrets.resolveCompanyEnv(homelab, "run")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: rotated });
  });

  it("keeps companies' secrets apart and refuses two grants on one variable", async () => {
    const appCo = await company("App Co");
    const homelab = await company("Homelab Co");
    const key = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Deploy key", kind: "ssh_private_key", value: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----" } })).json().secret.id;
    await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "DEPLOY_SSH_KEY" } });
    expect(await t.secrets.resolveCompanyEnv(appCo, "run")).toEqual({});
    const dup = await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "DEPLOY_SSH_KEY" } });
    expect(dup.statusCode).toBe(409);
    const badName = await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "deploy-key" } });
    expect(badName.statusCode).toBe(400);
  });
});
