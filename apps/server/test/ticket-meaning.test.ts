// BOS-2116: meaning search over tickets and the CEO's earlier advice. Texts are made up; the two
// misses that started it (BOS-2114 filed again what BOS-1906 shipped; a stale "Go ahead" in BOS-974)
// are replayed with invented titles. The embedder is fake: words that mean the same share a concept.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { issueRunToken } from "../src/mcp.js";
import { openPglite } from "../src/db/client.js";
import { meaningEmbeddings, ownerChatMessages, ticketMessages, tickets } from "../src/db/schema.js";
import { describeMeaningTicket, embedMissingMeaning, meaningBriefLines, ticketMeaningSearch, type MeaningTicket } from "../src/services/ticket-meaning.js";
import type { Embedder } from "../src/services/wiki-semantic.js";

const DIMS = 768;
const CONCEPT: Record<string, string> = { waiting: "queue", being: "queue", checked: "check", check: "check", label: "mark", section: "mark", release: "ship", live: "ship", deploy: "ship", ahead: "ship", invoice: "money", billing: "money", payments: "money" };
const STOP = new Set(["the", "a", "an", "is", "for", "on", "in", "of", "to", "and", "add", "new", "go", "ticket", "tickets", "under", "own", "their", "show", "it", "now", "with"]);
function fakeVector(text: string) {
  const v = new Array(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STOP.has(w)) continue;
    v[[...(CONCEPT[w] ?? w)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
type Provider = { calls: string[][]; fail: false | "500" | "slow" };
const fakeEmbedder = (p: Provider, model = "fake-model"): Embedder => ({
  model,
  dims: DIMS,
  embed: async (input, timeoutMs = 30_000) => {
    if (p.fail === "500") throw new Error("the embeddings provider answered 500");
    if (p.fail === "slow") await new Promise((_, reject) => setTimeout(() => reject(new Error("the embeddings provider could not be reached")), timeoutMs).unref());
    p.calls.push(input);
    return input.map(fakeVector);
  },
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.done();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({ data: body.input.map((s, index) => ({ index, embedding: fakeVector(s) })) });
  }) as typeof fetch;
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", semanticDebounceMs: 0, fetch: fakeFetch });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "Mean Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Board" })).json() as { id: string };
  const ticket = async (title: string, patch: Record<string, unknown> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string; number: number };
    if (Object.keys(patch).length) await db.update(tickets).set(patch).where(eq(tickets.id, t.id));
    return t;
  };
  const clients: Client[] = [];
  const create = async (args: Record<string, unknown>) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId: ceo.id, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    const r = (await c.callTool({ name: "create_ticket", arguments: { size: 2, risk: "low", project: "Board", ...args } })) as { isError?: boolean; content: Array<{ text: string }> };
    return { error: !!r.isError, text: r.content[0]?.text ?? "" };
  };
  const done = async () => {
    await Promise.all(clients.map((x) => x.close()));
    await built.app.close();
    await close();
  };
  return { ...built, db, req, company, ceo, ticket, create, done };
}

const NEW_ASK = "Add a Waiting for check label on the board";
const idsOf = (r: Awaited<ReturnType<typeof ticketMeaningSearch>>) => (r.ok ? r.matches.map((m) => m.ref) : null);

describe("ticket meaning search (BOS-2116)", () => {
  it("replays the BOS-2114 miss: a ticket that says the same in other words is in the top 3, with merged and live", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    const shipped = await c.ticket("Board: Being checked section", { systemState: "done", outcome: "completed", mergedAt: new Date(), liveAt: new Date() });
    await c.ticket("Invoice billing payments export");
    await c.ticket("Weekly digest email");
    const e = fakeEmbedder(p);
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(3);
    const r = await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => e });
    expect(r.ok && r.matches.length).toBeGreaterThan(0);
    expect(r.ok && r.matches[0]).toMatchObject({ id: shipped.id, ref: `MEA-${shipped.number}`, state: "done", merged: true, live: true });
    // The unrelated tickets are below the floor, so they are not shown at all.
    expect(idsOf(r)).toEqual([`MEA-${shipped.number}`]);
  });

  it("leaves out done tickets older than 30 days and cancelled ones, and drops their rows", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    const old = await c.ticket("Board: Being checked section", { systemState: "done", outcome: "completed", stateChangedAt: new Date(Date.now() - 45 * 24 * 3_600_000) });
    const cancelled = await c.ticket("Board: Being checked section v2", { systemState: "done", outcome: "cancelled" });
    const open = await c.ticket("Board: Being checked section v3");
    const e = fakeEmbedder(p);
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(1);
    const r = await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => e });
    expect(idsOf(r)).toEqual([`MEA-${open.number}`]);
    expect((await c.db.select().from(meaningEmbeddings)).map((x) => x.sourceId)).not.toContain(old.id);
    expect((await c.db.select().from(meaningEmbeddings)).map((x) => x.sourceId)).not.toContain(cancelled.id);
    // A ticket that was embedded while open and is later done for over 30 days loses its row at the next pass.
    await c.db.update(tickets).set({ systemState: "done", outcome: "completed", stateChangedAt: new Date(Date.now() - 45 * 24 * 3_600_000) }).where(eq(tickets.id, open.id));
    await embedMissingMeaning(c.db, c.company.id, e);
    expect(await c.db.select().from(meaningEmbeddings)).toHaveLength(0);
  });

  it("re-embeds a ticket whose text changed, and ignores rows of another model until they are re-embedded", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    const t = await c.ticket("Board: Being checked section");
    const e = fakeEmbedder(p);
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(1);
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(0);
    await c.db.update(tickets).set({ stateNote: "Waiting for the check" }).where(eq(tickets.id, t.id));
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(1);
    const other = fakeEmbedder(p, "other-model");
    const r = await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => other });
    expect(r).toEqual({ ok: true, matches: [] });
    expect(await embedMissingMeaning(c.db, c.company.id, other)).toBe(1);
    expect(idsOf(await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => other }))).toEqual([`MEA-${t.number}`]);
  });

  it("is off without an embedder: nothing is sent and callers get no meaning result", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    await c.ticket("Board: Being checked section");
    expect(await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => null })).toEqual({ ok: false, reason: "off" });
    expect(await meaningBriefLines(c.db, c.company.id, NEW_ASK, { embedder: async () => null })).toEqual([]);
    expect(p.calls).toEqual([]);
  });

  it("falls back, quietly, when the provider fails or is slow", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    await c.ticket("Board: Being checked section");
    const e = fakeEmbedder(p);
    await embedMissingMeaning(c.db, c.company.id, e);
    p.fail = "500";
    expect(await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => e })).toEqual({ ok: false, reason: "the embeddings provider answered 500" });
    expect(await meaningBriefLines(c.db, c.company.id, NEW_ASK, { embedder: async () => e })).toEqual([]);
    p.fail = "slow";
    const slow = await ticketMeaningSearch(c.db, c.company.id, NEW_ASK, { embedder: async () => e, timeoutMs: 50 });
    expect(slow.ok).toBe(false);
    expect(await meaningBriefLines(c.db, c.company.id, NEW_ASK, { embedder: async () => { throw new Error("key unreadable"); } })).toEqual([]);
  });
});

describe("the CEO's earlier advice (BOS-2116)", () => {
  it("replays the stale 'Go ahead': a release message brings up the CEO's earlier go-ahead, not its other chatter", async () => {
    const p: Provider = { calls: [], fail: false };
    const c = (ctx = await setup());
    const launch = await c.ticket("Release the update");
    await c.db.insert(ticketMessages).values([
      { companyId: c.company.id, ticketId: launch.id, author: "agent", agentId: c.ceo.id, text: "Go ahead with the release card once the check passes." },
      { companyId: c.company.id, ticketId: launch.id, author: "agent", agentId: c.ceo.id, text: "Lunch is at noon on Friday." },
      { companyId: c.company.id, ticketId: launch.id, author: "owner", text: "Release it when ready." },
    ]);
    await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: "I approve the deploy card; the owner can go live now." });
    const e = fakeEmbedder(p);
    // two advice rows (the go-ahead comment and the chat reply) plus the ticket; the chatter and the owner's own line are not embedded
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(3);
    const lines = await meaningBriefLines(c.db, c.company.id, "Is the release live now?", { embedder: async () => e });
    expect(lines.join("\n")).toContain(`your own earlier advice on MEA-${launch.number}`);
    expect(lines.join("\n")).toContain("Go ahead with the release card");
    expect(lines.join("\n")).not.toContain("Lunch");
    expect(lines.filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(5);
    // Nothing close: no block at all.
    expect(await meaningBriefLines(c.db, c.company.id, "Invoice billing payments", { embedder: async () => e })).toEqual([]);
  });
});

describe("the one tick box (BOS-2116)", () => {
  it("is off by default; ticking it embeds everything in the background with no other step, and a restart-style pass finds nothing left", async () => {
    const c = (ctx = await setup());
    await c.ticket("Board: Being checked section");
    const url = `/api/companies/${c.company.id}/wiki-semantic`;
    expect(((await c.req("GET", url)).json() as { ticketMeaning: boolean }).ticketMeaning).toBe(false);
    await c.ticketMeaningEmbeds.run();
    expect(await c.db.select().from(meaningEmbeddings)).toHaveLength(0);
    const secret = (await c.req("POST", "/api/secrets", { name: "embeddings key", kind: "generic", value: "sk-test-embeddings-0001" })).json() as { secret: { id: string } };
    const put = await c.req("PUT", url, { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-embedding-001", secretId: secret.secret.id, ticketMeaning: true });
    expect(put.json()).toMatchObject({ ticketMeaning: true });
    await c.ticketMeaningEmbeds.drain();
    expect(await c.db.select().from(meaningEmbeddings)).toHaveLength(1);
    const e = (await c.semantic.ticketEmbedder(c.company.id))!;
    expect(await embedMissingMeaning(c.db, c.company.id, e)).toBe(0);
    // The owner-answers box stays separate: it is still off.
    expect(await c.semantic.ownerAnswerEmbedder(c.company.id)).toBeNull();
  });
});

describe("create_ticket with meaning search switched on (BOS-2116)", () => {
  it("lists the ticket by meaning once, then lets the repeat call through; off, it creates as before", async () => {
    const c = (ctx = await setup());
    const shipped = await c.ticket("Board: Being checked section", { systemState: "done", outcome: "completed", mergedAt: new Date(), liveAt: new Date() });
    // Off by default: no shared title words, so the same idea in other words is created (today's miss).
    expect((await c.create({ title: "Mark queued cards with a waiting badge" })).error).toBe(false);
    // The owner ticks the box (the same provider key the wiki card holds); the fake fetch is the app's, so use the embedder directly.
    const e = fakeEmbedder({ calls: [], fail: false });
    (c.semantic as { ticketEmbedder: unknown }).ticketEmbedder = async () => e;
    await embedMissingMeaning(c.db, c.company.id, e);
    const refused = await c.create({ title: "Show a Waiting for check label on cards" });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain(`MEA-${shipped.number}`);
    expect(refused.text).toContain("(done, merged, live)");
    expect(refused.text).toContain("same idea in other words");
    // A different ask is unaffected, and the reason path still works.
    expect((await c.create({ title: "Invoice billing payments", body: "x" })).error).toBe(false);
    expect((await c.create({ title: "Show a Waiting for check label on cards", notDuplicateReason: "It is the card label, not the section" })).error).toBe(false);
  });
});

describe("describeMeaningTicket: one line for a create_ticket refusal", () => {
  const ticket = (over: Partial<MeaningTicket> = {}): MeaningTicket => ({
    id: "11111111-1111-4111-8111-111111111111",
    ref: "EXA-12",
    title: "Add a waiting badge",
    state: "in_progress",
    merged: false,
    live: false,
    score: 0.7123,
    ...over,
  });

  it("writes the ref, title, state and a rounded percentage", () => {
    expect(describeMeaningTicket(ticket())).toBe('- EXA-12 "Add a waiting badge" (in_progress); same idea in other words, 71% match by meaning');
  });

  it("falls back to the id with no ref, adds merged and live words, and rounds up at the edge", () => {
    expect(describeMeaningTicket(ticket({ ref: null, state: "done", merged: true, live: true, score: 0.995 }))).toBe(
      '- 11111111-1111-4111-8111-111111111111 "Add a waiting badge" (done, merged, live); same idea in other words, 100% match by meaning',
    );
  });

  it("leaves out a blank state word and shows zero as 0%", () => {
    expect(describeMeaningTicket(ticket({ state: "", score: 0 }))).toBe('- EXA-12 "Add a waiting badge" (); same idea in other words, 0% match by meaning');
  });
});
