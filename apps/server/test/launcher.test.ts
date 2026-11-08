import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, notifications, settings } from "../src/db/schema.js";
import { gitHostAddress, slugify, toolServerAddress } from "../src/services/launcher.js";

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
    if (method === "GET" && url.pathname === "/wanted") return json(200, [...running.keys()].sort());
    if (method === "GET" && url.pathname === "/runners") return json(200, [...running.entries()].map(([s, state]) => ({ slug: s, state, status: "Up 2 seconds", image: "boss-man-runner:current", guard: "on" })));
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
    expect(Object.keys(put.body as object)).toEqual(["token", "allow", "private"]);
    // The token the launcher got is the runner's real one.
    expect(await c.runners.authenticate((put.body as { token: string }).token)).toMatchObject({ companyId: company.id });

    const status = (await c.req("GET", `/api/companies/${company.id}/runner`)).json();
    // The guard's state reaches Settings (BOS-335): the launcher reports it per runner, and this carries it through.
    expect(status).toMatchObject({ registered: true, connected: false, launcher: { slug: "app-co", container: { state: "running", guard: "on" } } });
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
    // A private literal the owner typed in is trusted for private, so the guard keeps it (BOS-708).
    await vi.waitFor(() => expect(c.fake.calls.find((x) => x.path === "/runners/app-co/allow")?.body).toEqual({ allow: ["192.168.68.20:11235"], private: ["192.168.68.20:11235"] }));
    await c.req("DELETE", `/api/mcp-servers/${(added.json() as { id: string }).id}`);
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: [], private: [] }));
    expect(toolServerAddress("https://tools.lan/mcp")).toBe("tools.lan:443");
    expect(toolServerAddress("http://[fd00::1]/mcp")).toBeNull();
  });

  it("lets the runner reach the company's own git host only, and follows a changed repo address", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    const last = () => c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body;
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://192.168.68.67:3003/team/site.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["192.168.68.67:3003"], private: ["192.168.68.67:3003"] }));
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "https://github.com/o/r.git" });
    // A git host is the owner's own setting, so it is trusted for private however its name resolves now.
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["github.com:443"], private: ["github.com:443"] }));
    expect(gitHostAddress("http://192.168.68.67:3003/o/r.git")).toBe("192.168.68.67:3003");
    expect(gitHostAddress("git@git.lan:o/r.git")).toBe("git.lan:22");
    expect(gitHostAddress("ssh://git@h.lan:2222/o/r")).toBe("h.lan:2222");
    expect(gitHostAddress("http://gitea.lan/o/r")).toBe("gitea.lan:80");
    expect(gitHostAddress("/srv/repos/r")).toBeNull();
    expect(gitHostAddress("file:///srv/r")).toBeNull();
    // The launcher refuses a whole list over one bad entry, so these are never sent.
    expect(gitHostAddress("https://my_git.lan/o/r")).toBeNull();
    expect(gitHostAddress("http://h.lan:0/o/r")).toBeNull();
    expect(gitHostAddress("https://h.lan./o/r")).toBeNull();
  });

  it("sends every launched company its allow list once at server start, and keeps the good entries next to a bad host", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    const q = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Odd" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://192.168.68.67:3003/team/site.git" });
    await c.req("PATCH", `/api/projects/${q.id}`, { repoUrl: "https://my_git.lan/o/r" });
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").length).toBeGreaterThan(0));
    c.fake.calls.length = 0;
    await c.launcher.syncAll(1);
    expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow")).toEqual([expect.objectContaining({ method: "PUT", body: { allow: ["192.168.68.67:3003"], private: ["192.168.68.67:3003"] } })]);
  });

  it("start-up sync tries again while the launcher is coming up, and never throws", async () => {
    const c = (ctx = await setup());
    await c.req("POST", "/api/companies", { name: "App Co" });
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    c.fake.calls.length = 0;
    c.fake.fail(true);
    const done = c.launcher.syncAll(1, 3);
    await vi.waitFor(() => expect(c.fake.calls.length).toBe(3));
    await expect(done).resolves.toBeUndefined();
  });

  it("counts a company the launcher was never given as wanted, and looking at its runner doesn't give it a slug (BOS-497)", async () => {
    const c = (ctx = await setup());
    const { company: launched } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    // A company whose runner is registered by hand: no launcher start, so no slug.
    const [byHand] = await c.db.insert(companies).values({ name: "app co" }).returning();
    const shown = (await c.req("GET", `/api/companies/${byHand!.id}/runner`)).json() as { launcher: { slug: string; container: unknown } };
    // It would get app-co-2 (app-co is taken), shows no container, and nothing was saved.
    expect(shown.launcher).toMatchObject({ slug: "app-co-2", container: null });
    expect(await c.db.select().from(settings).where(eq(settings.key, `runner-slug:${byHand!.id}`))).toHaveLength(0);
    expect(await c.launcher.wantedCompanies()).toEqual(new Set([launched.id, byHand!.id]));
    // A launched company the owner stopped is not wanted; the hand-run one still is.
    await c.req("DELETE", `/api/companies/${launched.id}/runner/launch`);
    expect(await c.launcher.wantedCompanies()).toEqual(new Set([byHand!.id]));
  });

  it("at server start, removes the runner and token the launcher keeps for a company that no longer exists (BOS-497)", async () => {
    const c = (ctx = await setup());
    await c.req("POST", "/api/companies", { name: "App Co" });
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    // A leftover: the launcher still has a runner (and token file) for a company deleted from the database.
    await c.db.insert(settings).values({ key: `runner-slug:${randomUUID()}`, value: "gone-co" });
    c.fake.running.set("gone-co", "exited");
    c.fake.calls.length = 0;
    await c.launcher.syncAll(1);
    expect(c.fake.calls.map((x) => `${x.method} ${x.path}`).sort()).toEqual(["DELETE /runners/gone-co", "PUT /runners/app-co/allow"]);
    expect(c.fake.running.has("gone-co")).toBe(false);
    expect((await c.db.select().from(settings)).some((s) => s.value === "gone-co")).toBe(false);
    // Nothing is left to retry on the next start.
    c.fake.calls.length = 0;
    await c.launcher.syncAll(1);
    expect(c.fake.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["PUT /runners/app-co/allow"]);
  });

  it("does nothing without the launcher", async () => {
    const c = (ctx = await setup({ launcher: false }));
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    expect((await c.req("POST", `/api/companies/${company.id}/runner/launch`)).statusCode).toBe(409);
    expect((await c.req("GET", `/api/companies/${company.id}/runner`)).json()).toEqual({ registered: false, launcher: null });
    expect(c.fake.calls).toEqual([]);
  });
});
