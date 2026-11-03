import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { notifications } from "../src/db/schema.js";
import { slugify, toolServerAddress } from "../src/services/launcher.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const KEY = "launcher-key-".padEnd(43, "x");

/** A stand-in launcher: checks the key, remembers runners, and can be made to fail. */
function fakeLauncher() {
  const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const running = new Map<string, string>();
  let failing = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`) return json(401, { error: "unauthorized" });
    if (failing) return json(502, { error: "Creating the runner failed: No such image: boss-man-runner:current" });
    const slug = url.pathname.split("/")[2];
    if (method === "GET" && url.pathname === "/runners") return json(200, [...running.entries()].map(([s, state]) => ({ slug: s, state, status: "Up 2 seconds", image: "boss-man-runner:current" })));
    if (method === "PUT") return running.set(slug!, "running"), json(200, { slug, id: "abc" });
    if (method === "DELETE") return json(200, { slug, removed: running.delete(slug!) });
    if (method === "POST" && url.pathname.endsWith("/restart")) return running.has(slug!) ? json(200, { slug }) : json(404, { error: "There's no runner for that company." });
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  return { fetch, calls, running, fail: (v: boolean) => (failing = v) };
}

async function setup(opts: { launcher?: boolean } = { launcher: true }) {
  const fake = fakeLauncher();
  const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-key-")), "key");
  writeFileSync(keyFile, `${KEY}\n`);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch: fake.fetch, launcher: opts.launcher ? { url: "http://launcher:3105", keyFile } : undefined });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { ...built, db, close, req, fake };
}

describe("runners through the launcher (R55)", () => {
  it("starts a new company's runner with a fresh token, and shows its state", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    const put = c.fake.calls.find((x) => x.method === "PUT")!;
    expect(put).toMatchObject({ path: "/runners/app-co", auth: `Bearer ${KEY}` });
    expect(Object.keys(put.body as object)).toEqual(["token", "allow"]);
    // The token the launcher got is the runner's real one.
    expect(await c.runners.authenticate((put.body as { token: string }).token)).toMatchObject({ companyId: company.id });

    const status = (await c.req("GET", `/api/companies/${company.id}/runner`)).json();
    expect(status).toMatchObject({ registered: true, connected: false, launcher: { slug: "app-co", container: { state: "running" } } });
  });

  it("reconnects with a new token, restarts and stops, keeping the slug after a rename", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.method === "PUT")).toHaveLength(1));
    const first = (c.fake.calls.find((x) => x.method === "PUT")!.body as { token: string }).token;
    await c.req("PATCH", `/api/companies/${company.id}`, { name: "Apps Ltd" });

    expect((await c.req("POST", `/api/companies/${company.id}/runner/launch`)).json()).toEqual({ slug: "app-co" });
    const second = (c.fake.calls.filter((x) => x.method === "PUT")[1]!.body as { token: string }).token;
    expect(second).not.toBe(first);
    expect(await c.runners.authenticate(first)).toBeNull();
    expect((await c.req("POST", `/api/companies/${company.id}/runner/restart`)).statusCode).toBe(200);
    expect((await c.req("DELETE", `/api/companies/${company.id}/runner/launch`)).json()).toEqual({ slug: "app-co" });
    expect((await c.req("POST", `/api/companies/${company.id}/runner/restart`)).statusCode).toBe(404);
  });

  it("gives each company its own slug, and tells the owner when a runner can't start", async () => {
    const c = (ctx = await setup());
    c.fake.fail(true);
    const failed = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(async () => expect(await c.db.select().from(notifications)).toHaveLength(1));
    expect((await c.db.select().from(notifications))[0]).toMatchObject({ title: "App Co's runner didn't start", body: expect.stringContaining("No such image"), level: expect.any(String) });
    // The launcher didn't answer, so no token was issued.
    expect((await c.req("GET", `/api/companies/${failed.company.id}/runner`)).json()).toMatchObject({ registered: false });
    c.fake.fail(false);
    const { company } = (await c.req("POST", "/api/companies", { name: "app co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.method === "PUT").map((x) => x.path)).toContain("/runners/app-co-2"));
    expect((await c.req("GET", `/api/companies/${company.id}/runner`)).json().launcher.slug).toBe("app-co-2");
    expect(slugify("  Ünïcode & Co!  ")).toBe("unicode-co");
    expect(slugify("***")).toBe("company");
    expect(slugify("x".repeat(80))).toHaveLength(34);
  });

  it("tells the launcher the company's tool servers, so the network guard keeps them reachable", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    const added = await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "crawl", url: "http://192.168.68.20:11235/mcp", transport: "http" });
    expect(added.statusCode).toBe(201);
    await vi.waitFor(() => expect(c.fake.calls.find((x) => x.path === "/runners/app-co/allow")?.body).toEqual({ allow: ["192.168.68.20:11235"] }));
    await c.req("DELETE", `/api/mcp-servers/${(added.json() as { id: string }).id}`);
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: [] }));
    expect(toolServerAddress("https://tools.lan/mcp")).toBe("tools.lan:443");
    expect(toolServerAddress("http://[fd00::1]/mcp")).toBeNull();
  });

  it("does nothing without the launcher", async () => {
    const c = (ctx = await setup({ launcher: false }));
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    expect((await c.req("POST", `/api/companies/${company.id}/runner/launch`)).statusCode).toBe(409);
    expect((await c.req("GET", `/api/companies/${company.id}/runner`)).json()).toEqual({ registered: false, launcher: null });
    expect(c.fake.calls).toEqual([]);
  });
});
