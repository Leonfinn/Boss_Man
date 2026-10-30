import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url, authorization });
    if (url !== "https://api.synthetic.new/v2/quotas") return new Response("{}", { status: 404 });
    if (authorization === "Bearer sk-syn-good") {
      return new Response(JSON.stringify({ subscription: { limit: 1000, requests: 123, renewsAt: "2026-11-30T00:00:00.000Z" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 });
  }) as typeof globalThis.fetch;
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, req, calls };
}

async function source(t: Awaited<ReturnType<typeof setup>>, value: string) {
  const { secret } = (await t.req("POST", "/api/secrets", { name: `Synthetic ${value}`, kind: "generic", value })).json();
  return (await t.req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic", secretId: secret.id })).json() as { id: string };
}

describe("Synthetic quota", () => {
  it("reads used, limit and renewal with the key, and never puts the key in the answer", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-syn-good");
    const res = await c.req("GET", `/api/funding-sources/${s.id}/status`);
    expect(res.statusCode).toBe(200);
    expect(res.json().providerQuota).toEqual({ used: 123, limit: 1000, renewsAt: "2026-11-30T00:00:00.000Z" });
    expect(c.calls.find((x) => x.url === "https://api.synthetic.new/v2/quotas")!.authorization).toBe("Bearer sk-syn-good");
    expect(res.body).not.toContain("sk-syn-good");
  });

  it("uses the key granted to the company when the funding source has none attached", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json();
    const { secret } = (await c.req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: "sk-syn-good" })).json();
    await c.req("POST", `/api/secrets/${secret.id}/grants`, { companyId: company.id, envName: "SYNTHETIC_API_KEY" });
    const s = (await c.req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic" })).json();
    expect((await c.req("GET", `/api/funding-sources/${s.id}/status`)).json().providerQuota).toEqual({ used: 123, limit: 1000, renewsAt: "2026-11-30T00:00:00.000Z" });
  });

  it("shows an unknown quota on a failed call instead of failing the request", async () => {
    const c = (ctx = await setup());
    const s = await source(c, "sk-bad");
    const res = await c.req("GET", `/api/funding-sources/${s.id}/status`);
    expect(res.statusCode).toBe(200);
    expect(res.json().providerQuota).toEqual({ used: null, limit: null, renewsAt: null });
  });

  it("doesn't call Synthetic for other providers", async () => {
    const c = (ctx = await setup());
    const s = (await c.req("POST", "/api/funding-sources", { name: "Ollama Cloud", kind: "subscription", provider: "ollama" })).json();
    expect((await c.req("GET", `/api/funding-sources/${s.id}/status`)).json().providerQuota).toBeNull();
    expect(c.calls.some((x) => x.url === "https://api.synthetic.new/v2/quotas")).toBe(false);
  });
});
