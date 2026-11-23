import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";

// BOS-2187: GET /api/decisions/answered pages through settled and withdrawn cards, newest first.
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string } };
  const get = (url: string) => built.app.inject({ method: "GET", url, headers: { cookie } });
  return { app: built.app, db, close, get, companyId: co.company.id };
}

describe("answered cards list (BOS-2187)", () => {
  it("pages newest first with a cursor, names who answered, and leaves open cards out", async () => {
    ctx = await setup();
    const base = Date.parse("2026-11-01T10:00:00Z");
    const mk = (n: number, over: Partial<typeof decisions.$inferInsert> = {}) => ({
      companyId: ctx!.companyId,
      kind: "question" as const,
      question: `Question number ${n}\nmore detail`,
      options: ["Yes", "No"],
      recommendedOption: "Yes",
      status: "answered" as const,
      answer: "Yes",
      answeredAt: new Date(base + n * 60_000),
      ...over,
    });
    await ctx.db.insert(decisions).values([
      ...[1, 2, 3, 4, 5].map((n) => mk(n)),
      mk(6, { status: "withdrawn", answer: null }),
      mk(7, { status: "open", answer: null, answeredAt: null }),
      mk(8, { context: { settled: { agentId: "00000000-0000-0000-0000-000000000000", name: "Ceo Person", note: null, at: "x" } } }),
    ]);
    const first = (await ctx.get("/api/decisions/answered?limit=3")).json() as { items: Array<{ question: string; by: string; byName: string | null; status: string; answer: string | null }>; next: string | null };
    expect(first.items.map((i) => i.question.split("\n")[0])).toEqual(["Question number 8", "Question number 6", "Question number 5"]);
    expect(first.items[0]).toMatchObject({ by: "ceo", byName: "Ceo Person", answer: "Yes" });
    expect(first.items[1]).toMatchObject({ by: "withdrawn", status: "withdrawn", answer: null });
    expect(first.next).toBeTruthy();
    const second = (await ctx.get(`/api/decisions/answered?limit=3&cursor=${encodeURIComponent(first.next!)}`)).json() as { items: Array<{ question: string; by: string }>; next: string | null };
    expect(second.items.map((i) => i.question.split("\n")[0])).toEqual(["Question number 4", "Question number 3", "Question number 2"]);
    expect(second.items[0]!.by).toBe("owner");
    const third = (await ctx.get(`/api/decisions/answered?limit=3&cursor=${encodeURIComponent(second.next!)}`)).json() as { items: unknown[]; next: string | null };
    expect(third.items).toHaveLength(1);
    expect(third.next).toBeNull();
  });

  it("returns the company name and the owner's note (BOS-2312), and no note on a withdrawn card", async () => {
    ctx = await setup();
    const at = new Date("2026-11-03T09:00:00.000Z");
    const base = { companyId: ctx.companyId, kind: "question" as const, options: [], recommendedOption: "a" };
    await ctx.db.insert(decisions).values([
      { ...base, question: "Noted", status: "answered", answer: "a", answeredAt: at, context: { answerNote: "Because of cost" } },
      { ...base, question: "CEO noted", status: "answered", answer: "a", answeredAt: new Date(at.getTime() - 1000), context: { settled: { name: "Casey", note: "CEO says so", at: "x" } } },
      { ...base, question: "Gone", status: "withdrawn", answer: null, answeredAt: new Date(at.getTime() - 2000), context: { answerNote: "stale" } },
    ]);
    const r = (await ctx.get("/api/decisions/answered")).json() as { items: Array<{ question: string; companyName: string; note: string | null }> };
    expect(r.items.map((i) => [i.question, i.companyName, i.note])).toEqual([
      ["Noted", "App Co", "Because of cost"],
      ["CEO noted", "App Co", "CEO says so"],
      ["Gone", "App Co", null],
    ]);
  });

  it("filters by text in the question, and a malformed cursor is ignored rather than failing", async () => {
    ctx = await setup();
    await ctx.db.insert(decisions).values([
      { companyId: ctx.companyId, kind: "question", question: "Pick a PAYMENT provider", options: [], recommendedOption: "a", status: "answered", answer: "a", answeredAt: new Date() },
      { companyId: ctx.companyId, kind: "question", question: "Pick a colour", options: [], recommendedOption: "a", status: "answered", answer: "a", answeredAt: new Date() },
    ]);
    const r = (await ctx.get("/api/decisions/answered?q=payment")).json() as { items: Array<{ question: string }> };
    expect(r.items.map((i) => i.question)).toEqual(["Pick a PAYMENT provider"]);
    const bad = await ctx.get("/api/decisions/answered?cursor=junk");
    expect(bad.statusCode).toBe(200);
  });

  it("returns only the one closed card an id names, and nothing for an open card's id (BOS-2326)", async () => {
    ctx = await setup();
    const rows = await ctx.db
      .insert(decisions)
      .values([
        { companyId: ctx.companyId, kind: "question", question: "Pick a host", options: [], recommendedOption: "a", status: "answered", answer: "a", answeredAt: new Date() },
        { companyId: ctx.companyId, kind: "question", question: "Pick a colour", options: [], recommendedOption: "a", status: "answered", answer: "a", answeredAt: new Date() },
        { companyId: ctx.companyId, kind: "question", question: "Still open", options: [], recommendedOption: "a" },
      ])
      .returning({ id: decisions.id });
    const one = (await ctx.get(`/api/decisions/answered?id=${rows[1]!.id}`)).json() as { items: Array<{ question: string }> };
    expect(one.items.map((i) => i.question)).toEqual(["Pick a colour"]);
    expect(((await ctx.get(`/api/decisions/answered?id=${rows[2]!.id}`)).json() as { items: unknown[] }).items).toEqual([]);
    expect((await ctx.get("/api/decisions/answered?id=not-a-uuid")).statusCode).toBe(400);
  });

  it("pages through cards answered in the same millisecond with no repeat or gap", async () => {
    ctx = await setup();
    const at = new Date("2026-11-02T09:00:00.000Z");
    await ctx.db.insert(decisions).values(
      [1, 2, 3, 4, 5].map((n) => ({ companyId: ctx!.companyId, kind: "question" as const, question: `Same ms ${n}`, options: [], recommendedOption: "a", status: "answered" as const, answer: "a", answeredAt: at })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = (await ctx.get(`/api/decisions/answered?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as { items: Array<{ id: string }>; next: string | null };
      seen.push(...r.items.map((x) => x.id));
      cursor = r.next;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("is refused without the owner's session", async () => {
    ctx = await setup();
    const r = await ctx.app.inject({ method: "GET", url: "/api/decisions/answered" });
    expect(r.statusCode).toBe(401);
  });
});
