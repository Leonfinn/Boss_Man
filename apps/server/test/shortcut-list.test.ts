// BOS-2669 ticket 1: the owner's ordered shortcut list on the server, shared with the keyboard off-switch
// (BOS-2689). These prove it survives a restart and an update, gives a plain reason when a save can't be made,
// never drops a page a later build has lost, and no agent tool can read or change it.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shortcutEntries } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ownerPreferences, owners } from "../src/db/schema.js";
import { ownerPreferencesService } from "../src/services/owner-preferences.js";
import { issueRunToken } from "../src/mcp.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0207_shortcut_entries.sql");

let t: TestApp;
let cookie: string;
let ownerId: string;
beforeEach(async () => {
  t = await makeApp();
  cookie = (await signIn(t)).cookie;
  ownerId = (await t.db.select({ id: owners.id }).from(owners))[0]!.id;
});
afterEach(async () => {
  await t.close();
});

const req = (method: "GET" | "PATCH", payload?: unknown) => t.app.inject({ method, url: "/api/preferences", headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("the shortcut list is saved on the server (BOS-2669)", () => {
  it("reads back unchanged by a freshly started server on the same database", async () => {
    // Save on one server.
    const saved = await req("PATCH", { pinnedPages: [{ id: "updates" }, { id: "agents", name: "My team" }] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ singleLetterKeys: true, pinnedPages: [{ id: "updates" }, { id: "agents", name: "My team" }] });

    // A fresh server over the same database (a restart) reads the same list back.
    const fresh = await buildApp({ db: t.db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
    const again = await fresh.app.inject({ method: "GET", url: "/api/preferences", headers: { cookie } });
    expect(again.json()).toEqual({ singleLetterKeys: true, pinnedPages: [{ id: "updates" }, { id: "agents", name: "My team" }] });
    await fresh.app.close();
  });

  it("saves a second per-login value beside the shortcut list, through the same store", async () => {
    // The single-letter-key switch is the other value in this store; both are kept side by side.
    await req("PATCH", { singleLetterKeys: false });
    const saved = await req("PATCH", { pinnedPages: [{ id: "updates" }] });
    expect(saved.json()).toEqual({ singleLetterKeys: false, pinnedPages: [{ id: "updates" }] });
    expect((await req("GET")).json()).toEqual({ singleLetterKeys: false, pinnedPages: [{ id: "updates" }] });
    expect(await t.db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId))).toHaveLength(1);
  });
});

describe("saving the shortcut list gives a plain reason (BOS-2669)", () => {
  const fails = async (payload: unknown, pattern: RegExp) => {
    const res = await req("PATCH", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect((res.json() as { message: string }).message).toMatch(pattern);
    return res;
  };

  it("refuses more than six, the same page twice, a page not in the list, or a name over 40 characters", async () => {
    await req("PATCH", { pinnedPages: [{ id: "updates" }, { id: "agents" }] });
    await fails({ pinnedPages: [{ id: "updates" }, { id: "agents" }, { id: "runs" }, { id: "plan" }, { id: "skills" }, { id: "team" }, { id: "wiki" }] }, /at most 6 shortcuts/);
    await fails({ pinnedPages: [{ id: "updates" }, { id: "updates" }] }, /already in your shortcuts/);
    await fails({ pinnedPages: [{ id: "no-such-page" }] }, /isn't in the list of pages/);
    await fails({ pinnedPages: [{ id: "updates", name: "x".repeat(41) }] }, /at most 40 characters/);
    // And the good save before them is still the one saved.
    expect((await req("GET")).json()).toEqual({ singleLetterKeys: true, pinnedPages: [{ id: "updates" }, { id: "agents" }] });
  });

  it("refuses a save with no owner sign-in", async () => {
    const res = await t.app.inject({ method: "PATCH", url: "/api/preferences", payload: { pinnedPages: [{ id: "updates" }] } });
    expect(res.statusCode).toBe(401);
  });
});

describe("a page this build no longer knows is kept, not dropped (BOS-2669)", () => {
  it("returns a stored unknown id marked as gone, with its name", () => {
    // A saved list holding an id no build offers any more.
    const entries = shortcutEntries([{ id: "old-page", name: "Old thing" }, { id: "updates" }], "c1");
    expect(entries[0]).toMatchObject({ id: "old-page", name: "Old thing", gone: true });
    expect(entries[1]).toMatchObject({ id: "updates", gone: false, address: "#/settings/c1/updates" });
  });

  it("reorders and removes around the gone id without dropping it: an update never touches a stored list", async () => {
    // The raw store keeps whatever it is given; only the owner changes it. A gone id saved earlier stays where it was.
    await t.db.insert(ownerPreferences).values({ ownerId, pinnedPages: [{ id: "old-page", name: "Old thing" }, { id: "updates" }] });
    const read = await ownerPreferencesService(t.db).get(ownerId);
    expect(read.pinnedPages).toEqual([{ id: "old-page", name: "Old thing" }, { id: "updates" }]);
  });
});

describe("an existing shortcut list is unchanged after the next migration (BOS-2669)", () => {
  const statements = () => readFileSync(migrationPath, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0 && !s.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("--")));

  it("turns early bare ids into the new shape without dropping, reordering or renaming any", async () => {
    await t.db.insert(ownerPreferences).values({ ownerId, pinnedPages: ["updates", "agents", "old-page"] as unknown as { id: string }[] });
    for (const stmt of statements()) await t.db.execute(sql.raw(stmt));
    const [row] = await t.db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId));
    expect(row!.pinnedPages).toEqual([{ id: "updates" }, { id: "agents" }, { id: "old-page" }]);
  });

  it("leaves a list already in the new shape exactly as it was, with names kept", async () => {
    const shaped = [{ id: "updates", name: "Ship it" }, { id: "agents" }];
    await t.db.insert(ownerPreferences).values({ ownerId, pinnedPages: shaped });
    for (const stmt of statements()) await t.db.execute(sql.raw(stmt));
    const [row] = await t.db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId));
    expect(row!.pinnedPages).toEqual(shaped);
  });
});

describe("no agent tool can read or write the shortcut list (BOS-2669)", () => {
  it("is not an MCP tool", async () => {
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const ownerCookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const created = await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie: ownerCookie }, payload: { name: "App Co" } });
    const { company, ceo } = created.json() as { company: { id: string }; ceo: { id: string } };
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() });
    const client = new Client({ name: "t", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      const names = tools.map((x) => x.name.toLowerCase());
      // No tool is named for preferences or shortcuts, and no tool's schema mentions the field.
      expect(names.some((n) => n.includes("preference") || n.includes("shortcut") || n.includes("pinned"))).toBe(false);
      for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/pinnedPages|preferences/i);
    } finally {
      await client.close().catch(() => undefined);
      await built.app.close();
      await close();
    }
  });
});
