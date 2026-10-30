import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { migrationsFolder, openPglite } from "../src/db/client.js";

const KEY = "sk-syn-QA-dummy-7f3a91c2";
const MODEL = "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
  vi.restoreAllMocks();
});

async function setup(fetch: typeof globalThis.fetch) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, req };
}

async function syntheticSource(c: Awaited<ReturnType<typeof setup>>) {
  const { secret } = (await c.req("POST", "/api/secrets", { name: "Synthetic key", kind: "generic", value: KEY })).json();
  return (await c.req("POST", "/api/funding-sources", { name: "Synthetic", kind: "subscription", provider: "synthetic", secretId: secret.id })).json() as { id: string };
}

const UNKNOWN = { used: null, limit: null, renewsAt: null };

describe("Synthetic provider QA (BOS-226)", () => {
  it("sets an agent to OpenCode + the Synthetic model + paid from Synthetic", async () => {
    const c = (ctx = await setup((async () => new Response("{}", { status: 500 })) as typeof fetch));
    const src = await syntheticSource(c);
    const { company } = (await c.req("POST", "/api/companies", { name: "Test Co" })).json();
    const hired = await c.req("POST", `/api/companies/${company.id}/agents`, { name: "Syn", role: "worker", agentKind: "opencode", model: MODEL, fundingSourceId: src.id });
    expect(hired.statusCode, hired.body).toBe(201);
    expect(hired.json()).toMatchObject({ agentKind: "opencode", model: MODEL, fundingSourceId: src.id });
    const patched = await c.req("PATCH", `/api/agents/${hired.json().id}`, { model: "synthetic/other" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().fundingSourceId).toBe(src.id);
  });

  it("shows unknown on a 500 and on a timeout, and the status call still succeeds", async () => {
    for (const fetchImpl of [
      (async () => new Response("boom " + KEY, { status: 500 })) as typeof fetch,
      (async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }) as typeof fetch,
      (async () => new Response("not json", { status: 200 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ subscription: { limit: 0 } }), { status: 200 })) as typeof fetch,
    ]) {
      const c = (ctx = await setup(fetchImpl));
      const src = await syntheticSource(c);
      const res = await c.req("GET", `/api/funding-sources/${src.id}/status`);
      expect(res.statusCode).toBe(200);
      expect(res.json().providerQuota).toMatchObject(UNKNOWN);
      expect(res.body).not.toContain(KEY);
      await c.app.close();
      await c.close();
      ctx = undefined;
    }
  });

  it("never lets the key into logs, console output, secret listings, activity or error messages", async () => {
    const out: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    const w = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
    const e = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
    const c = (ctx = await setup((async () => {
      throw new Error(`connect failed with Bearer ${KEY}`);
    }) as typeof fetch));
    const src = await syntheticSource(c);
    const bodies = [
      (await c.req("GET", `/api/funding-sources/${src.id}/status`)).body,
      (await c.req("GET", "/api/funding-sources")).body,
      (await c.req("GET", "/api/secrets")).body,
      (await c.req("POST", "/api/funding-sources", { name: "bad", kind: "api_credit", provider: "nope", secretId: "x" })).body,
      (await c.req("GET", "/api/companies")).body,
    ];
    const { company } = (await c.req("POST", "/api/companies", { name: "T" })).json();
    for (const url of [`/api/companies/${company.id}/activity`, `/api/companies/${company.id}/agents`]) bodies.push((await c.req("GET", url)).body);
    w.mockRestore();
    e.mockRestore();
    for (const b of bodies) expect(b).not.toContain(KEY);
    expect(out.join("\n")).not.toContain(KEY);
  });
});

describe("migration 0080 (synthetic provider)", () => {
  it("applies on top of a database sitting at the previous migration", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const old = mkdtempSync(path.join(tmpdir(), "mig-old-"));
    cpSync(migrationsFolder, old, { recursive: true });
    const jp = path.join(old, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(jp, "utf8")) as { entries: Array<{ tag: string }> };
    // Roll back to just before 0080, dropping it and any migration that landed after it.
    const at = journal.entries.findIndex((e) => e.tag === "0080_synthetic_provider");
    expect(at).toBeGreaterThan(0);
    journal.entries.splice(at);
    writeFileSync(jp, JSON.stringify(journal));
    const client = new PGlite({ extensions: { vector } });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: old });
    const before = await client.query<{ e: string }>("select unnest(enum_range(null::provider))::text as e");
    expect(before.rows.map((r) => r.e)).not.toContain("synthetic");
    await client.query("insert into funding_sources (name, kind, provider) values ('old', 'api_credit', 'anthropic')");
    await migrate(db, { migrationsFolder });
    const after = await client.query<{ e: string }>("select unnest(enum_range(null::provider))::text as e");
    expect(after.rows.map((r) => r.e)).toContain("synthetic");
    expect((await client.query("select name from funding_sources")).rows).toEqual([{ name: "old" }]);
    await client.close();
  }, 120_000);

  it("is in a fresh database", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite({ extensions: { vector } });
    await migrate(drizzle(client), { migrationsFolder });
    const r = await client.query<{ e: string }>("select unnest(enum_range(null::provider))::text as e");
    expect(r.rows.map((x) => x.e)).toContain("synthetic");
    await client.close();
  }, 120_000);
});
