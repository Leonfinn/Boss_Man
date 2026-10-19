import { afterEach, describe, expect, it, vi } from "vitest";
import { wikiSectionEmbeddings } from "../src/db/schema.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const KEY = "sk-or-test-secret-key-123456";
const DIMS = 768;
// Words that mean the same thing share a concept, so the fake embedder puts them close together.
const CONCEPT: Record<string, string> = { login: "auth", authentication: "auth", signin: "auth", password: "auth", invoice: "money", billing: "money" };
function fakeVector(text: string) {
  const v = new Array(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) v[parseInt([...(CONCEPT[w] ?? w)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(), 10) % DIMS] += 1;
  return v;
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup(failing = { on: false }) {
  const inputs: string[][] = [];
  const auth: string[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (failing.on) return new Response("secret provider detail", { status: 500 });
    auth.push(String((init?.headers as Record<string, string>).authorization));
    const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions: number };
    inputs.push(body.input);
    return Response.json({ data: body.input.map((s, index) => ({ index, embedding: fakeVector(s) })) });
  });
  const { randomBytes } = await import("node:crypto");
  const { buildApp } = await import("../src/app.js");
  const { openPglite } = await import("../src/db/client.js");
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch: fetchFn as unknown as typeof fetch, semanticDebounceMs: 0 });
  t = { ...built, db, master: { version: 1, key: randomBytes(32) }, close: async () => (await built.app.close(), await close()) } as unknown as TestApp;
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Acme" })).json() as { company: { id: string } };
  const secret = (await req("POST", "/api/secrets", { name: "embeddings key", kind: "generic", value: KEY })).json() as { secret: { id: string } };
  const settings = (over: object = {}) => req("PUT", `/api/companies/${company.id}/wiki-semantic`, { enabled: true, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-embedding-001", secretId: secret.secret.id, ...over });
  const write = async (title: string, body: string) => {
    const r = await built.wiki.write(company.id, { title, body, agentId: null, runId: null });
    await built.semantic.drain();
    return r.page;
  };
  const rows = () => t!.db.select().from(wikiSectionEmbeddings);
  return { ...built, company: company.id, req, settings, write, rows, inputs, auth, fetchFn, failing };
}

describe("semantic wiki search", () => {
  it("embeds sections after a write, only the changed ones, and drops removed ones", async () => {
    const s = await setup();
    await s.settings();
    const p = await s.write("Handbook", "# Handbook\nintro text\n## Login\nhow to sign in\n## Billing\nsend an invoice");
    expect((await s.rows()).map((r) => r.sectionPath).sort()).toEqual(["Handbook", "Handbook > Billing", "Handbook > Login"]);
    expect(s.inputs.flat()).toHaveLength(3);
    s.inputs.length = 0;
    await s.write("Handbook", "# Handbook\nintro text\n## Login\nhow to sign in\n## Billing\nsend a new invoice");
    expect(s.inputs.flat()).toHaveLength(1);
    expect(s.inputs[0]![0]).toContain("new invoice");
    await s.write("Handbook", "# Handbook\nintro text\n## Billing\nsend a new invoice");
    expect((await s.rows()).map((r) => r.sectionPath).sort()).toEqual(["Handbook", "Handbook > Billing"]);
    expect((await s.rows())[0]!.pageId).toBe(p.id);
    expect(s.auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
  });

  it("fuses meaning with full text: finds a section that shares no word with the query", async () => {
    const s = await setup();
    await s.settings();
    await s.write("Security", "## Authentication\nusers prove who they are with a password\n## Other\nnothing relevant here");
    await s.write("Misc", "## Lunch\npizza on fridays");
    expect(await s.wiki.ftsSearch(s.company, "login")).toEqual([]);
    const hits = await s.wiki.search(s.company, "login");
    expect(hits[0]).toMatchObject({ slug: "security", path: "Authentication" });
    expect(hits[0]!.snippet).toContain("password");
  });

  it("ignores rows made with another model", async () => {
    const s = await setup();
    await s.settings();
    await s.write("Security", "## Authentication\nusers prove who they are with a password");
    expect(await s.wiki.search(s.company, "login")).toHaveLength(1);
    await s.semantic.setSettings(s.company, { model: "other/model" });
    expect(await s.semantic.similar(s.company, "login")).toEqual([]);
    expect((await s.wiki.search(s.company, "login")).map((h) => h.path)).toEqual([]);
    s.fetchFn.mockClear();
    await s.semantic.reindexAll(s.company);
    await s.semantic.drain();
    expect((await s.rows())[0]!.model).toBe("other/model");
  });

  it("falls back to full text when the provider fails, without leaking the key or the reply", async () => {
    const s = await setup();
    await s.settings();
    await s.write("Security", "## Login\nlogin steps");
    const warn = vi.spyOn(s.app.log, "warn");
    s.failing.on = true;
    const hits = await s.wiki.search(s.company, "login");
    expect(hits.map((h) => h.path)).toEqual(["Login"]);
    await s.write("Security", "## Login\nlogin steps changed");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("500");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("secret provider detail");
  });

  it("does nothing when off: no provider calls, full-text results only", async () => {
    const s = await setup();
    await s.write("Security", "## Authentication\npassword rules");
    await s.write("Misc", "## Login\nlogin steps");
    expect(s.fetchFn).not.toHaveBeenCalled();
    expect((await s.wiki.search(s.company, "login")).map((h) => h.path)).toEqual(["Login"]);
    expect(await s.rows()).toEqual([]);
  });

  it("re-embeds everything on demand", async () => {
    const s = await setup();
    await s.write("Security", "## Authentication\npassword rules");
    await s.settings();
    await s.semantic.drain();
    expect((await s.rows()).length).toBe(1);
    s.fetchFn.mockClear();
    expect((await s.req("POST", `/api/companies/${s.company}/wiki-semantic/reindex`)).statusCode).toBe(202);
    await s.semantic.drain();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});
