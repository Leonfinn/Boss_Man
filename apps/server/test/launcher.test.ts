import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, notifications, projects, settings } from "../src/db/schema.js";
import { allowsPrivate, gitHostAddress, isLanHost, isStackAddress, resolvesStack, slugify, toolServerAddress } from "../src/services/launcher.js";

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

/** A made-up DNS: a name not in the table resolves public (93.184.216.34), so a test never depends on the real network. */
const fakeLookup = (table: Record<string, string[]> = {}) => async (host: string) => table[host] ?? ["93.184.216.34"];

async function setup(options: { launcher?: boolean; lookup?: ReturnType<typeof fakeLookup> } = {}) {
  const opts = { launcher: true, ...options };
  const fake = fakeLauncher();
  const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-key-")), "key");
  writeFileSync(keyFile, `${KEY}\n`);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch: fake.fetch, launcher: opts.launcher ? { url: "http://launcher:3105", keyFile } : undefined, lookup: opts.lookup ?? fakeLookup() });
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
    // The token body stays { token, allow }: an older launcher refuses any other key (BOS-708).
    expect(Object.keys(put.body as object)).toEqual(["token", "allow"]);
    // The token the launcher got is the runner's real one.
    expect(await c.runners.authenticate((put.body as { token: string }).token)).toMatchObject({ companyId: company.id });

    const status = (await c.req("GET", `/api/companies/${company.id}/runner`)).json();
    // The guard's state reaches Settings (BOS-335): the launcher reports it per runner, and this carries it through.
    expect(status).toMatchObject({ registered: true, connected: false, launcher: { slug: "app-co", container: { state: "running", guard: "on" } } });
  });

  it("starts a runner against an old launcher that refuses extra fields, and its token still works (BOS-708, Dougal's blocker)", async () => {
    // An older launcher accepts only { token, allow } on PUT /runners/<slug> and 400s anything else, and its /allow route
    // ignores the private field. The server must not lose the rotated token to that 400.
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const running = new Set<string>();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const slug = url.pathname.split("/")[2];
      if (method === "GET" && url.pathname === "/runners") return json(200, []);
      if (method === "PUT" && url.pathname.endsWith("/allow")) return json(200, { slug, allow: (body as { allow: string[] }).allow });
      if (method === "PUT") {
        const keys = Object.keys(body as object);
        if (keys.some((k) => k !== "token" && k !== "allow")) return json(400, { error: "Only { token, allow } is accepted." });
        running.add(slug!);
        return json(200, { slug, id: "abc" });
      }
      if (method === "DELETE") return json(200, { slug, removed: running.delete(slug!) });
      return json(404, { error: "unknown" });
    }) as typeof globalThis.fetch;
    const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-key-")), "key");
    writeFileSync(keyFile, `${KEY}\n`);
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch, launcher: { url: "http://launcher:3105", keyFile } });
    ctx = { ...built, db, close, req: undefined as never, fake: undefined as never };
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const { company } = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Old Co" } })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(calls.some((x) => x.method === "PUT" && x.path === "/runners/old-co")).toBe(true));
    const put = calls.find((x) => x.method === "PUT" && x.path === "/runners/old-co")!;
    // The token went in a body the old launcher accepts.
    expect(Object.keys(put.body as object)).toEqual(["token", "allow"]);
    // No 400 was ever seen for that runner, and the token that was handed over still authenticates.
    expect(await built.runners.authenticate((put.body as { token: string }).token)).toMatchObject({ companyId: company.id });
  });

  it("reconnects with a new token, restarts and stops, keeping the slug after a rename", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.method === "PUT" && x.path === "/runners/app-co")).toHaveLength(1));
    const first = (c.fake.calls.find((x) => x.method === "PUT" && x.path === "/runners/app-co")!.body as { token: string }).token;
    await c.req("PATCH", `/api/companies/${company.id}`, { name: "Apps Ltd" });

    expect((await c.req("POST", `/api/companies/${company.id}/runner/launch`)).json()).toEqual({ slug: "app-co" });
    const second = (c.fake.calls.filter((x) => x.method === "PUT" && x.path === "/runners/app-co")[1]!.body as { token: string }).token;
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
    const added = await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "crawl", url: "http://192.168.1.20:11235/mcp", transport: "http" });
    expect(added.statusCode).toBe(201);
    // A private literal the owner typed in is trusted for private, so the guard keeps it (BOS-708).
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: ["192.168.1.20:11235"], private: ["192.168.1.20:11235"] }));
    await c.req("DELETE", `/api/mcp-servers/${(added.json() as { id: string }).id}`);
    await vi.waitFor(() => expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: [], private: [] }));
    expect(toolServerAddress("https://tools.lan/mcp")).toBe("tools.lan:443");
    expect(toolServerAddress("http://[fd00::1]/mcp")).toBeNull();
  });

  it("answers a bad repo address with a neutral example address, not the owner's own (BOS-906)", async () => {
    const c = (ctx = await setup());
    const { company } = (await c.req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    const res = await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "ftp://files.example.org/o/r.git" });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("http://192.0.2.10:3003/you/repo.git");
    expect(JSON.stringify(res.json())).not.toContain("192.168.1.50");
  });

  it("lists the addresses Boss Man opens by itself, per company, with what each one is (BOS-791)", async () => {
    // A made-up DNS: `repointed.example.net` now resolves to a private address, every other name to a public one.
    const c = (ctx = await setup({ lookup: fakeLookup({ "repointed.example.net": ["172.18.0.2"] }) }));
    const { company } = (await c.req("POST", "/api/companies", { name: "Acme Tools" })).json() as { company: { id: string } };
    // A public-name tool server (resolves to 93.184.216.34): allowed, listed with its company.
    expect((await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "scrapling", url: "http://example.com:8000/mcp", transport: "http" })).statusCode).toBe(201);
    // A tool server whose public name now resolves to a private address, with the owner's trust off: shown as not allowed (BOS-708).
    const repointed = (await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "db-client", url: "http://repointed.example.net:5432/mcp", transport: "http" })).json() as { id: string };
    await c.db.execute(sql`update mcp_servers set allow_private = false where id = ${repointed.id}`);
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
    expect(at("repointed.example.net:5432")).toMatchObject({ kind: "tool server", name: "db-client", company: "Acme Tools", notAllowed: expect.stringContaining("Not allowed") });
    expect(at("git.example.lan:3003")).toMatchObject({ kind: "git host", name: "Website", company: "Acme Tools", notAllowed: null });
    expect(at("oldgit.example.lan:3003")).toBeUndefined();
    // Only host:port and names come out.
    expect(JSON.stringify(report)).not.toMatch(/https?:\/\/|\/mcp|\/team\/site/);
    // The CEO's server status carries the same list.
    const status = (await c.serverStatus.status(company.id)) as { netguardAllow: { automatic: Array<{ address: string }> } | null };
    expect(status.netguardAllow?.automatic.map((e) => e.address)).toContain("git.example.lan:3003");
  });

  it("keeps a tool server the owner trusted for private (BOS-708) out of the not-allowed list, and drops one that isn't trusted (BOS-791)", async () => {
    const c = (ctx = await setup({ lookup: fakeLookup({ "private.example.net": ["172.18.0.2"] }) }));
    const { company } = (await c.req("POST", "/api/companies", { name: "Nested Co" })).json() as { company: { id: string } };
    // A tool server whose name points at a private address, with the owner's trust on (allow_private, the real migration-0128 column):
    // a LAN host added on purpose, so the guard keeps it.
    const trusted = (await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "lan-tool", url: "http://private.example.net:8080/mcp", transport: "http" })).json() as { id: string };
    await c.db.execute(sql`update mcp_servers set allow_private = true where id = ${trusted.id}`);
    // The same name with trust off: a public name that now resolves privately, which the guard drops.
    const untrusted = (await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name: "repointed", url: "http://private.example.net:8081/mcp", transport: "http" })).json() as { id: string };
    await c.db.execute(sql`update mcp_servers set allow_private = false where id = ${untrusted.id}`);
    const report = (await c.req("GET", "/api/netguard-allow")).json() as { report: { automatic: Array<{ address: string; notAllowed: string | null }> } };
    const at = (a: string) => report.report.automatic.find((e) => e.address === a);
    expect(at("private.example.net:8080")).toMatchObject({ notAllowed: null });
    expect(at("private.example.net:8081")).toMatchObject({ notAllowed: expect.stringContaining("Not allowed") });
  });

  it("judges each row by the exact list the guard is sent, not a rule of its own (BOS-791 review)", async () => {
    const c = (ctx = await setup({ lookup: fakeLookup({ "penpot.example.lan": ["192.168.1.5"], "both.example.net": ["172.18.0.9"] }) }));
    const { company } = (await c.req("POST", "/api/companies", { name: "Rule Co" })).json() as { company: { id: string } };
    const add = async (name: string, url: string, allowPrivate: boolean) => {
      const { id } = (await c.req("POST", `/api/companies/${company.id}/mcp-servers`, { name, url, transport: "http" })).json() as { id: string };
      await c.db.execute(sql`update mcp_servers set allow_private = ${allowPrivate} where id = ${id}`);
    };
    // A private IP literal: the guard keeps it whatever its flag says (it can't be re-pointed).
    await add("literal", "http://192.168.1.7:9000/mcp", false);
    // One host:port named by a trusted row and an untrusted one: allowFor sends it trusted, so neither row is dropped.
    await add("trusted-copy", "http://both.example.net:7000/mcp", true);
    await add("untrusted-copy", "http://both.example.net:7000/other", false);
    // A dropped tool server at the address of the owner's .env line: the line still matters, so it must not say "can go".
    await add("penpot-as-tool", "http://penpot.example.lan:9001/mcp", false);
    const report = (await c.req("GET", "/api/netguard-allow")).json() as { report: { automatic: Array<{ address: string; notAllowed: string | null }>; entries: Array<{ entry: string; note: string | null }> } };
    const at = (a: string) => report.report.automatic.filter((e) => e.address === a);
    expect(at("192.168.1.7:9000")).toEqual([expect.objectContaining({ notAllowed: null })]);
    expect(at("both.example.net:7000")).toEqual([expect.objectContaining({ notAllowed: null })]);
    expect(at("penpot.example.lan:9001")).toEqual([expect.objectContaining({ notAllowed: expect.stringContaining("Not allowed") })]);
    expect(report.report.entries.find((e) => e.entry === "penpot.example.lan:9001")).toMatchObject({ note: null });
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
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://192.168.1.50:3003/team/site.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["192.168.1.50:3003"], private: ["192.168.1.50:3003"] }));
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "https://github.com/o/r.git" });
    // A public git name is allowed but never trusted for private: its DNS could be pointed at the stack later (BOS-777).
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["github.com:443"], private: [] }));
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "https://git.example.org/o/r.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["git.example.org:443"], private: [] }));
    // A LAN-style name, ssh scp-style too, is still the owner's LAN host.
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "git@git.lan:o/r.git" });
    await vi.waitFor(() => expect(last()).toEqual({ allow: ["git.lan:22"], private: ["git.lan:22"] }));
    // A row saved before BOS-777 has the flag on for a public name; it is still not trusted.
    await c.db.update(projects).set({ repoUrl: "https://git.example.org/o/r.git", allowPrivate: true }).where(eq(projects.id, p.id));
    await c.launcher.syncAllow(company.id);
    expect(last()).toEqual({ allow: ["git.example.org:443"], private: [] });
    expect(gitHostAddress("http://192.168.1.50:3003/o/r.git")).toBe("192.168.1.50:3003");
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
    // Each background sync sends exactly one allow call, so count them: the start's own, then one per patch. Waiting for a
    // count (not a fixed sleep) means clearing the log below cannot race a sync that is still on its way.
    const allowCalls = () => c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").length;
    await vi.waitFor(() => expect(allowCalls()).toBe(1));
    const p = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
    const q = (await c.req("POST", `/api/companies/${company.id}/projects`, { name: "Odd" })).json() as { id: string };
    await c.req("PATCH", `/api/projects/${p.id}`, { repoUrl: "http://192.168.1.50:3003/team/site.git" });
    await vi.waitFor(() => expect(allowCalls()).toBe(2));
    await c.req("PATCH", `/api/projects/${q.id}`, { repoUrl: "https://my_git.lan/o/r" });
    await vi.waitFor(() => expect(allowCalls()).toBe(3));
    expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow").at(-1)?.body).toEqual({ allow: ["192.168.1.50:3003"], private: ["192.168.1.50:3003"] });
    c.fake.calls.length = 0;
    await c.launcher.syncAll(1);
    expect(c.fake.calls.filter((x) => x.path === "/runners/app-co/allow")).toEqual([expect.objectContaining({ method: "PUT", body: { allow: ["192.168.1.50:3003"], private: ["192.168.1.50:3003"] } })]);
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
    expect((await c.req("GET", `/api/companies/${company.id}/runner`)).json()).toEqual({ registered: false, launcher: null, memoryLine: null });
    expect(c.fake.calls).toEqual([]);
  });
});

describe("the launcher's private addresses (BOS-886): the shared table, pinned to today's answers", () => {
  // The same list the permission check and the skill fetcher agree on (skill-security-bos88.test.ts), with the launcher's
  // own answer: private means part of the stack, so multicast, 192.0.0.0/24 and 198.18.0.0/15 stay out (and a mapped
  // address in hex form is only stack if the IPv4 it carries is).
  const LIST: Array<[string, boolean]> = [
    ["10.1.2.3", true], ["127.0.0.1", true], ["169.254.1.1", true], ["100.64.0.1", true], ["192.0.0.1", false], ["198.18.0.1", false], ["224.0.0.251", false],
    ["::1", true], ["fd00::1", true], ["ff02::1", false], ["::ffff:192.168.0.1", true], ["::ffff:10.0.0.1", true],
    // fe80::/10 (fe80 to febf) is link-local and part of the stack; fec0::/10 is deprecated site-local, never trusted, as before.
    ["fe80::1", true], ["febf::1", true], ["fec0::1", false], ["feff::1", false],
    ["8.8.8.8", false], ["2606:4700::1", false],
  ];
  it("answers each address the same way as before for the stack's ranges, and does not widen to the fetch-only ones", async () => {
    const lookup = async (h: string) => ({ "mcast.example.org": ["224.0.0.251"], "public.example.org": ["93.184.216.34"] })[h] ?? (() => { throw new Error("ENOTFOUND"); })();
    for (const [ip, stack] of LIST) {
      expect(isStackAddress(ip), ip).toBe(stack);
      // Through a URL: an IPv6 literal is flagged by guardHost (unhandled, fail closed for the preview) and never trusted.
      const u = `http://${ip.includes(":") ? `[${ip}]` : ip}:1/`;
      if (!ip.includes(":")) {
        expect(await resolvesStack(u, lookup), u).toBe(stack ? "stack" : "ok");
        expect(await allowsPrivate(u, lookup), u).toBe(stack);
      }
    }
    // A name that resolves to a fetch-only range is not the stack; one that resolves to a stack range is.
    expect(await resolvesStack("http://mcast.example.org:1/", lookup)).toBe("ok");
    expect(await allowsPrivate("http://mcast.example.org:1/", lookup)).toBe(false);
  });
});

describe("isLanHost (BOS-777): whether a git host is trusted for private addresses, with no DNS", () => {
  it("trusts private IP literals and LAN-style names only", () => {
    for (const u of ["http://192.168.1.50:3003/o/r.git", "https://10.0.0.5/o/r", "git@git.lan:o/r.git", "ssh://git@h.local:2222/o/r", "http://gitea/o/r", "https://git.corp.internal/o/r", "http://nas.home/o/r"]) expect(isLanHost(u), u).toBe(true);
    for (const u of ["https://git.example.org/o/r.git", "https://github.com/o/r.git", "git@github.com:o/r.git", "http://8.8.8.8/o/r", "https://lan.example.org/o/r", "/srv/repos/r", "not a url"]) expect(isLanHost(u), u).toBe(false);
  });
});

describe("allowsPrivate (BOS-708): whether a tool server is trusted for private addresses", () => {
  const lookup = (table: Record<string, string[]>, fail = false) => async (host: string) => {
    if (fail) throw new Error("ENOTFOUND");
    const addrs = table[host];
    if (!addrs) throw new Error("ENOTFOUND");
    return addrs;
  };

  it("trusts only what the owner meant for a private address", async () => {
    // A private IP literal can't be re-pointed; a LAN or stack-style name is the owner's own host.
    expect(await allowsPrivate("http://172.18.0.2:5432/mcp", lookup({}))).toBe(true);
    expect(await allowsPrivate("http://10.0.0.5:1/", lookup({}))).toBe(true);
    expect(await allowsPrivate("http://db:5432/mcp", lookup({}))).toBe(true);
    expect(await allowsPrivate("http://penpot.lan:8080/", lookup({}))).toBe(true);
    // A public IP literal or a public name is not trusted.
    expect(await allowsPrivate("http://8.8.8.8:80/", lookup({}))).toBe(false);
    expect(await allowsPrivate("https://tools.example.org/mcp", lookup({ "tools.example.org": ["93.184.216.34"] }))).toBe(false);
  });

  it("does not trust a name whose lookup fails (Jane's finding 1): a DNS error or empty answer is not a private address", async () => {
    expect(await allowsPrivate("https://evil.example.org/mcp", lookup({}, true))).toBe(false);
    expect(await allowsPrivate("https://evil.example.org/mcp", lookup({ "evil.example.org": [] }))).toBe(false);
  });

  it("trusts a name only when every address it resolves to is private, so a mixed answer is not trusted", async () => {
    expect(await allowsPrivate("https://mixed.example.org/mcp", lookup({ "mixed.example.org": ["93.184.216.34", "172.18.0.2"] }))).toBe(false);
    expect(await allowsPrivate("https://lan.example.org/mcp", lookup({ "lan.example.org": ["172.18.0.2", "172.18.0.3"] }))).toBe(true);
  });
});
