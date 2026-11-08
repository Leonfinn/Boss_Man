import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, notifications, settings } from "../src/db/schema.js";
import { gitHostAddress, resolvesStack, slugify, toolServerAddress, toolServerDropped } from "../src/services/launcher.js";

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
    if (method === "GET" && url.pathname === "/netguard") return json(200, { mode: "auto", allow: ["git.example.lan:3003", "penpot.example.lan:9001"] });
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
    expect(Object.keys(put.body as object)).toEqual(["token", "allow"]);
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
    await vi.waitFor(() => expect(c.fake.calls.find((x) => x.path === "/runners/app-co/allow")?.body).toEqual({ allow: ["192.168.68.20:11235"] }));
    await c.req("DELETE", `/api/mcp-servers/${(added.json() as { id: string }).id}`);
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: [] }));
    expect(toolServerAddress("https://tools.lan/mcp")).toBe("tools.lan:443");
    expect(toolServerAddress("http://[fd00::1]/mcp")).toBeNull();
  });

  it("lists the addresses Boss Man opens by itself, per company, with what each one is (BOS-791)", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "Acme Tools" })).json() as { company: { id: string } };
    // A public-name tool server (resolves to 93.184.216.34): allowed, listed with its company.
    expect((await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "scrapling", url: "http://example.com:8000/mcp", transport: "http" })).statusCode).toBe(201);
    // A tool server whose name points at the stack: shown as not allowed, with the reason (the BOS-708 rule).
    expect((await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "db-client", url: "http://db:5432/", transport: "http" })).statusCode).toBe(201);
    // A project with a LAN git host: allowed for this company.
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Website" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://git.example.lan:3003/team/site.git" });
    // An archived project's git host is no longer opened.
    const gone = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Old" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${gone.id}`, { repoUrl: "http://oldgit.example.lan:3003/o/r.git" });
    await c.req("PATCH", `/api/projects/${gone.id}`, { archived: true });

    const report = (await c.req("GET", "/api/netguard-allow")).json() as { report: { automatic: Array<{ address: string; kind: string; name: string; company: string | null; notAllowed: string | null }> } };
    const at = (a: string) => report.report.automatic.find((e) => e.address === a);
    expect(at("example.com:8000")).toMatchObject({ kind: "tool server", name: "scrapling", company: "Acme Tools", notAllowed: null });
    expect(at("db:5432")).toMatchObject({ kind: "tool server", name: "db-client", company: "Acme Tools", notAllowed: expect.stringContaining("Not allowed") });
    expect(at("git.example.lan:3003")).toMatchObject({ kind: "git host", name: "Website", company: "Acme Tools", notAllowed: null });
    expect(at("oldgit.example.lan:3003")).toBeUndefined();
    // Only host:port and names come out.
    expect(JSON.stringify(report)).not.toMatch(/https?:\/\/|\/mcp|\/team\/site/);
    // The CEO's server status carries the same list.
    const status = (await c.serverStatus.status(company.id)) as { netguardAllow: { automatic: Array<{ address: string }> } | null };
    expect(status.netguardAllow?.automatic.map((e) => e.address)).toContain("git.example.lan:3003");
  });

  it("shows the owner the launcher's BOSSMAN_NETGUARD_ALLOW entries and marks the ones a project's git host covers (BOS-770)", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const before = (await c.req("GET", "/api/netguard-allow")).json() as { report: { entries: Array<{ entry: string; note: string | null }> } };
    expect(before.report.entries.map((e) => e.note)).toEqual([null, null]);
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://git.example.lan:3003/team/site.git" });
    const after = (await c.req("GET", "/api/netguard-allow")).json() as { report: { mode: string; entries: Array<{ entry: string; coveredBy: string[]; note: string | null }>; lineCanGo: boolean } };
    expect(after.report).toMatchObject({ mode: "auto", lineCanGo: false });
    expect(after.report.entries[0]).toMatchObject({ entry: "git.example.lan:3003", coveredBy: ["git host"] });
    expect(after.report.entries[0]!.note).toMatch(/^Already allowed by Boss Man/);
    expect(after.report.entries[1]).toMatchObject({ entry: "penpot.example.lan:9001", note: null });
    // The CEO's server status carries the same report.
    const status = (await c.serverStatus.status(company.id)) as { netguardAllow: { entries: unknown[] } | null };
    expect(status.netguardAllow?.entries).toHaveLength(2);
  });

  it("lets the runner reach the company's own git host only, and follows a changed repo address", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.some((x) => x.method === "PUT")).toBe(true));
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    const last = () => c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body;
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://192.168.68.67:3003/team/site.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["192.168.68.67:3003"] }));
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "https://github.com/o/r.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["github.com:443"] }));
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
    expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow")).toEqual([expect.objectContaining({ method: "PUT", body: { allow: ["192.168.68.67:3003"] } })]);
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

  it("toolServerDropped matches the guard: a private IP literal is kept, and so is an entry trusted for private; other names that resolve privately are dropped (BOS-791)", () => {
    // A private IP literal can't be re-pointed, so the guard keeps it.
    expect(toolServerDropped("http://192.168.68.20:11235/mcp", "stack")).toBe(false);
    // A name that resolves to a private address (a compose name like db, a re-pointed name, a LAN name) is dropped,
    // unless the owner allowed a private address for it (an import tick or a tool server they added on a LAN host).
    expect(toolServerDropped("http://db:5432/", "stack")).toBe(true);
    expect(toolServerDropped("http://evil.example.org:5432/", "stack")).toBe(true);
    expect(toolServerDropped("http://evil.example.org:5432/", "stack", true)).toBe(false);
    // A public name, or one that couldn't be looked up, is not dropped.
    expect(toolServerDropped("http://example.com:8000/mcp", "ok")).toBe(false);
    expect(toolServerDropped("http://broken.example.net:8000/", "lookup-failed")).toBe(false);
  });

  it("resolvesStack tells a private name from a public one and a failed lookup (BOS-791)", async () => {
    const lookup = async (h: string) => (h === "private.example.net" ? ["172.18.0.2"] : h === "public.example.net" ? ["93.184.216.34"] : (() => { throw new Error("ENOTFOUND"); })());
    expect(await resolvesStack("http://private.example.net:8080/mcp", lookup)).toBe("stack");
    expect(await resolvesStack("http://public.example.net:8080/mcp", lookup)).toBe("ok");
    // A failed lookup is its own answer (the guard would drop nothing it couldn't resolve): never a false "stack".
    expect(await resolvesStack("http://broken.example.net:8080/mcp", lookup)).toBe("lookup-failed");
    expect(await resolvesStack("http://db:5432/", lookup)).toBe("stack");
    expect(await resolvesStack("http://10.1.2.3:3100/", lookup)).toBe("stack");
    expect(await resolvesStack("http://93.184.216.34:3100/", lookup)).toBe("ok");
  });

  it("does nothing without the launcher", async () => {
    const c = (ctx = await setup({ launcher: false }));
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    expect((await c.req("POST", `/api/companies/${company.id}/runner/launch`)).statusCode).toBe(409);
    expect((await c.req("GET", `/api/companies/${company.id}/runner`)).json()).toEqual({ registered: false, launcher: null });
    expect(c.fake.calls).toEqual([]);
  });
});
