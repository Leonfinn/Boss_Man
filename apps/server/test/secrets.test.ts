import { randomBytes, randomUUID } from "node:crypto";
import { summariseUse } from "../src/services/secrets.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import { and, eq } from "drizzle-orm";
import { activity, agents, runs, secretAccessLog, secrets } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// Made-up key shapes, joined at run time so this file holds no key-shaped line for the secret scans (BOS-1932).
const TOKEN = ["sk-ant-oat01", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
const PEM_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");

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

  it("checks a value without saving it, and checks a saved one again (R58)", async () => {
    const bad = (await t.app.inject({ method: "POST", url: "/api/secrets/check", headers: { cookie }, payload: { kind: "anthropic_api_key", value: " sk-ant-api03-bad\n" } })).json();
    expect(bad.live).toEqual({ ok: false, message: "The provider rejected the key (HTTP 401)." });
    const good = (await t.app.inject({ method: "POST", url: "/api/secrets/check", headers: { cookie }, payload: { kind: "anthropic_api_key", value: "sk-ant-api03-good" } })).json();
    expect(good).toEqual({ problems: [], live: { ok: true, message: "ok" } });
    // A kind the provider can't be asked about only gets its format checked.
    const token = (await t.app.inject({ method: "POST", url: "/api/secrets/check", headers: { cookie }, payload: { kind: "claude_oauth_token", value: "sk-ant-api03-wrongkind" } })).json();
    expect(token.live).toBeNull();
    expect(token.problems.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: "GET", url: "/api/secrets", headers: { cookie } })).json()).toEqual([]);

    const saved = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "API", kind: "anthropic_api_key", value: "sk-ant-api03-good" } })).json();
    expect((await t.app.inject({ method: "POST", url: `/api/secrets/${saved.secret.id}/check`, headers: { cookie } })).json()).toEqual({ live: { ok: true, message: "ok" } });
    expect((await t.app.inject({ method: "POST", url: `/api/secrets/${crypto.randomUUID()}/check`, headers: { cookie } })).statusCode).toBe(404);
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

  it("keeps the end date when a token's value is replaced without a new date, and takes the new one when given (BOS-2825)", async () => {
    const saved = await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Claude setup-token date", kind: "claude_oauth_token", value: TOKEN, endsOn: "2027-11-27" } });
    expect(saved.statusCode).toBe(201);
    const secretId = saved.json().secret.id;
    expect(saved.json().secret.expiresAt).toBe("2027-11-27");
    // A rotated token that still works keeps its date, so the reminder still knows when it ends.
    const kept = await t.app.inject({ method: "PUT", url: `/api/secrets/${secretId}/value`, headers: { cookie }, payload: { value: `${TOKEN.slice(0, -4)}1111` } });
    expect(kept.json().secret.expiresAt).toBe("2027-11-27");
    expect(kept.json().secret.version).toBe(2);
    // A new date given with the new value is stored.
    const changed = await t.app.inject({ method: "PUT", url: `/api/secrets/${secretId}/value`, headers: { cookie }, payload: { value: `${TOKEN.slice(0, -4)}2222`, endsOn: "2028-01-15" } });
    expect(changed.json().secret.expiresAt).toBe("2028-01-15");
    // An empty date clears it, so the token stops reminding (e.g. one that never expires).
    const cleared = await t.app.inject({ method: "PUT", url: `/api/secrets/${secretId}/value`, headers: { cookie }, payload: { value: `${TOKEN.slice(0, -4)}3333`, endsOn: null } });
    expect(cleared.json().secret.expiresAt).toBeNull();
  });

  it("keeps companies' secrets apart and refuses two grants on one variable", async () => {
    const appCo = await company("App Co");
    const homelab = await company("Homelab Co");
    const key = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Deploy key", kind: "ssh_private_key", value: `${PEM_BEGIN}\nabc\n-----END OPENSSH PRIVATE KEY-----` } })).json().secret.id;
    await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "DEPLOY_SSH_KEY" } });
    expect(await t.secrets.resolveCompanyEnv(appCo, "run")).toEqual({});
    const dup = await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "DEPLOY_SSH_KEY" } });
    expect(dup.statusCode).toBe(409);
    const badName = await t.app.inject({ method: "POST", url: `/api/secrets/${key}/grants`, headers: { cookie }, payload: { companyId: homelab, envName: "deploy-key" } });
    expect(badName.statusCode).toBe(400);
  });
});

describe("30-day use summary", () => {
  it("counts per company, purpose and day, and tags a secret with no recent read", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const s = summariseUse(
      [
        { at: day(0), company: "A", purpose: "run" },
        { at: day(0), company: "A", purpose: "deploy" },
        { at: day(29), company: "B", purpose: "merge" },
        { at: day(1), company: null, purpose: "github_watch" },
        { at: day(30), company: "A", purpose: "run" },
      ],
      now,
    );
    expect(s.total).toBe(5);
    expect(s.byPurpose).toEqual({ run: 2, deploy: 1, merge: 1, other: 1 });
    expect(s.byCompany[0]).toEqual({ company: "A", reads: 3 });
    expect(s.perDay[29]).toBe(2);
    expect(s.perDay[28]).toBe(1);
    expect(s.perDay[0]).toBe(1);
    expect(s.perDay.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("list() gives last used and the unused tag, one query for all secrets", async () => {
    const { secret } = await t.secrets.create({ name: "Idle", kind: "generic", value: "v-idle-value" });
    const [row] = (await t.secrets.list()).filter((r) => r.id === secret.id);
    expect(row!.lastUsedAt).toBeNull();
    expect(row!.unusedIn30Days).toBe(true);
    expect(JSON.stringify(row)).not.toContain("v-idle-value");
    await t.db.insert(secretAccessLog).values({ secretId: secret.id, companyId: randomUUID(), purpose: "run", at: new Date(Date.now() - 40 * 86_400_000) });
    expect((await t.secrets.list()).find((r) => r.id === secret.id)!.unusedIn30Days).toBe(true);
    await t.db.insert(secretAccessLog).values({ secretId: secret.id, companyId: randomUUID(), purpose: "run" });
    const after = (await t.secrets.list()).find((r) => r.id === secret.id)!;
    expect(after.unusedIn30Days).toBe(false);
    expect(after.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe("which agents get a key", () => {
  async function setup() {
    const c = await company("App Co");
    const other = await company("Homelab Co");
    const [a, b] = await t.db.insert(agents).values([{ companyId: c, name: "A", role: "worker", agentKind: "claude" }, { companyId: c, name: "B", role: "worker", agentKind: "claude" }]).returning();
    const [foreign] = await t.db.insert(agents).values({ companyId: other, name: "F", role: "worker", agentKind: "claude" }).returning();
    const [ra] = await t.db.insert(runs).values({ companyId: c, agentId: a!.id }).returning();
    const [rb] = await t.db.insert(runs).values({ companyId: c, agentId: b!.id }).returning();
    const grant = async (name: string, envName: string) => {
      const sid = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name, kind: "generic", value: `v-${envName}` } })).json().secret.id;
      return (await t.app.inject({ method: "POST", url: `/api/secrets/${sid}/grants`, headers: { cookie }, payload: { companyId: c, envName } })).json().id as string;
    };
    const put = (grantId: string, agentIds: string[]) => t.app.inject({ method: "PUT", url: `/api/grants/${grantId}/agents`, headers: { cookie }, payload: { agentIds } });
    return { c, a: a!.id, b: b!.id, foreign: foreign!.id, ra: ra!.id, rb: rb!.id, grant, put };
  }

  it("gives a restricted key only to the listed agents' runs, and company jobs still get it", async () => {
    const s = await setup();
    const limited = await s.grant("Limited", "LIMITED_KEY");
    await s.grant("Open", "OPEN_KEY");
    expect((await s.put(limited, [s.a])).statusCode).toBe(204);
    expect(await t.secrets.resolveCompanyEnv(s.c, "run", s.ra)).toEqual({ LIMITED_KEY: "v-LIMITED_KEY", OPEN_KEY: "v-OPEN_KEY" });
    expect(await t.secrets.resolveCompanyEnv(s.c, "run", s.rb)).toEqual({ OPEN_KEY: "v-OPEN_KEY" });
    expect(await t.secrets.resolveCompanyEnv(s.c, "merge")).toEqual({ LIMITED_KEY: "v-LIMITED_KEY", OPEN_KEY: "v-OPEN_KEY" });
    const listed = (await t.app.inject({ method: "GET", url: `/api/companies/${s.c}/grants`, headers: { cookie } })).json();
    expect(listed.find((g: { id: string }) => g.id === limited).agentIds).toEqual([s.a]);
    // An empty list opens it to every agent again.
    expect((await s.put(limited, [])).statusCode).toBe(204);
    expect(await t.secrets.resolveCompanyEnv(s.c, "run", s.rb)).toHaveProperty("LIMITED_KEY");
  });

  it("keeps GITHUB_WATCH_TOKEN out of agent runs and runner jobs; only the watcher purpose reads it (BOS-1450)", async () => {
    const s = await setup();
    await s.grant("Watch", "GITHUB_WATCH_TOKEN");
    await s.grant("Open", "OPEN_KEY");
    expect(await t.secrets.resolveCompanyEnv(s.c, "run", s.ra)).toEqual({ OPEN_KEY: "v-OPEN_KEY" });
    expect(await t.secrets.resolveCompanyEnv(s.c, "merge")).toEqual({ OPEN_KEY: "v-OPEN_KEY" });
    expect(await t.secrets.resolveCompanyEnv(s.c, "github_watch")).toEqual({ GITHUB_WATCH_TOKEN: "v-GITHUB_WATCH_TOKEN", OPEN_KEY: "v-OPEN_KEY" });
  });

  it("refuses an agent from another company, and an unknown grant", async () => {
    const s = await setup();
    const g = await s.grant("Key", "SOME_KEY");
    expect((await s.put(g, [s.a, s.foreign])).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: `/api/companies/${s.c}/grants`, headers: { cookie } })).json()[0].agentIds).toEqual([]);
    expect((await s.put(crypto.randomUUID(), [])).statusCode).toBe(404);
  });
});

describe("grant changes leave an activity line (BOS-2062)", () => {
  const VALUE = "zq-activity-secret-value-91827";
  async function lines(companyId: string) {
    return (await t.db.select().from(activity).where(and(eq(activity.companyId, companyId), eq(activity.kind, "settings")))).map((r) => r.summary);
  }

  it("records grant, agent limit and revoke against the company, never the value", async () => {
    const c = await company("App Co");
    const other = await company("Homelab Co");
    const [a, b] = await t.db.insert(agents).values([{ companyId: c, name: "A", role: "worker", agentKind: "claude" }, { companyId: c, name: "B", role: "worker", agentKind: "claude" }]).returning();
    const sid = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Deploy key", kind: "generic", value: VALUE } })).json().secret.id;
    const gid = (await t.app.inject({ method: "POST", url: `/api/secrets/${sid}/grants`, headers: { cookie }, payload: { companyId: c, envName: "DEPLOY_KEY" } })).json().id;
    const put = (agentIds: string[]) => t.app.inject({ method: "PUT", url: `/api/grants/${gid}/agents`, headers: { cookie }, payload: { agentIds } });
    await put([a!.id, b!.id]);
    await put([]);
    await t.app.inject({ method: "DELETE", url: `/api/grants/${gid}`, headers: { cookie } });
    const got = await lines(c);
    expect(got).toEqual([
      "Owner gave App Co the secret Deploy key as DEPLOY_KEY",
      "Owner limited DEPLOY_KEY to 2 agents",
      "Owner limited DEPLOY_KEY to every agent",
      "Owner took DEPLOY_KEY away from App Co",
    ]);
    expect(got.join(" ")).not.toContain(VALUE);
    expect(await lines(other)).toEqual([]);
  });

  it("records nothing when the change is refused", async () => {
    const c = await company("App Co");
    const other = await company("Homelab Co");
    const [foreign] = await t.db.insert(agents).values({ companyId: other, name: "F", role: "worker", agentKind: "claude" }).returning();
    const sid = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Key", kind: "generic", value: VALUE } })).json().secret.id;
    const gid = (await t.app.inject({ method: "POST", url: `/api/secrets/${sid}/grants`, headers: { cookie }, payload: { companyId: c, envName: "SOME_KEY" } })).json().id;
    const before = await lines(c);
    expect((await t.app.inject({ method: "PUT", url: `/api/grants/${gid}/agents`, headers: { cookie }, payload: { agentIds: [foreign!.id] } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "PUT", url: `/api/grants/${crypto.randomUUID()}/agents`, headers: { cookie }, payload: { agentIds: [] } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: `/api/grants/${crypto.randomUUID()}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: `/api/secrets/${sid}/grants`, headers: { cookie }, payload: { companyId: c, envName: "SOME_KEY" } })).statusCode).toBeGreaterThanOrEqual(400);
    expect(await lines(c)).toEqual(before);
    expect(before).toEqual(["Owner gave App Co the secret Key as SOME_KEY"]);
  });
});

describe("a run placed on a ranked Claude account (BOS-383)", () => {
  it("carries that account's login, only for that run, and the access log never holds the value", async () => {
    const c = await company("App Co");
    const second = `${TOKEN.slice(0, -4)}7777`;
    const defaultId = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Claude one", kind: "claude_oauth_token", value: TOKEN } })).json().secret.id;
    await t.app.inject({ method: "POST", url: `/api/secrets/${defaultId}/grants`, headers: { cookie }, payload: { companyId: c, envName: "CLAUDE_CODE_OAUTH_TOKEN" } });
    const secondId = (await t.app.inject({ method: "POST", url: "/api/secrets", headers: { cookie }, payload: { name: "Claude two", kind: "claude_oauth_token", value: second } })).json().secret.id;
    const src = (await t.app.inject({ method: "POST", url: "/api/funding-sources", headers: { cookie }, payload: { name: "Max two", kind: "subscription", provider: "anthropic", secretId: secondId, fallbackRank: 2 } })).json();
    const [a] = await t.db.insert(agents).values({ companyId: c, name: "A", role: "worker", agentKind: "claude" }).returning();
    const [plain] = await t.db.insert(runs).values({ companyId: c, agentId: a!.id }).returning();
    const [onSecond] = await t.db.insert(runs).values({ companyId: c, agentId: a!.id, fundingSourceId: src.id }).returning();
    expect(await t.secrets.resolveCompanyEnv(c, "run", plain!.id)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(await t.secrets.resolveCompanyEnv(c, "run", onSecond!.id)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: second });
    expect(JSON.stringify(await t.db.select().from(secretAccessLog))).not.toContain(second);
  });
});
