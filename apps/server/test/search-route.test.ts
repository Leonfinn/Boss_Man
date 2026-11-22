// The search box's route (BOS-2192): tickets, wiki pages and chat messages of one company, grouped, with snippets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, ownerChatMessages, projects, tickets, wikiPages } from "../src/db/schema.js";
import { refOf, SEARCH_GROUP_MAX, snippetOf, type SearchResults } from "../src/routes/search.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
let cookie: string;
let A: { company: string; project: string; agent: string };
let B: { company: string; project: string; agent: string };

async function seedCompany(name: string, prefix: string) {
  const [co] = await t.db.insert(companies).values({ name, ticketPrefix: prefix }).returning();
  const [p] = await t.db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [a] = await t.db.insert(agents).values({ companyId: co!.id, name: `${name} CEO`, title: "CEO", role: "ceo", agentKind: "claude" }).returning();
  return { company: co!.id, project: p!.id, agent: a!.id };
}

const get = async (companyId: string, q: string, withCookie = true) =>
  t.app.inject({ method: "GET", url: `/api/companies/${companyId}/search?q=${encodeURIComponent(q)}`, headers: withCookie ? { cookie } : {} });
const find = async (companyId: string, q: string) => {
  const res = await get(companyId, q);
  expect(res.statusCode).toBe(200);
  return res.json() as SearchResults;
};

beforeAll(async () => {
  t = await makeApp();
  ({ cookie } = await signIn(t));
  A = await seedCompany("Alpha", "BOS");
  B = await seedCompany("Beta", "BET");
  // Alpha: one of each kind holds "pelican"; Beta holds the same word everywhere, and must never show.
  for (const c of [A, B]) {
    await t.db.insert(tickets).values({ companyId: c.company, projectId: c.project, title: "Teach the pelican to land", body: "Runway notes.", number: 7 });
    await t.db.insert(wikiPages).values({ companyId: c.company, slug: "birds", title: "Birds", body: `${"Intro text. ".repeat(40)}The pelican page body says it eats fish.${" More.".repeat(40)}` });
    await t.db.insert(ownerChatMessages).values({ companyId: c.company, agentId: c.agent, role: "owner", text: "Did the pelican ticket get done?" });
  }
  // Ticket 12 doesn't mention the word: only its reference finds it.
  await t.db.insert(tickets).values({ companyId: A.company, projectId: A.project, title: "Unrelated chore", body: "Nothing here.", number: 12 });
}, 60_000);
afterAll(async () => void (await t?.close()));

describe("search route (BOS-2192)", () => {
  it("finds a ticket title, a wiki page body and a chat message, grouped, each with a snippet", async () => {
    const r = await find(A.company, "PELICAN");
    expect(r.tickets.map((x) => x.title)).toEqual(["Teach the pelican to land"]);
    expect(r.tickets[0]).toMatchObject({ ref: "BOS-7", link: `tickets/${r.tickets[0]!.id}` });
    expect(r.wiki).toHaveLength(1);
    expect(r.wiki[0]).toMatchObject({ title: "Birds", link: `wiki/${A.company}/birds` });
    // The snippet is a short window around the match, cut with "…", not the whole page.
    expect(r.wiki[0]!.snippet).toContain("The pelican page body");
    expect(r.wiki[0]!.snippet.startsWith("…")).toBe(true);
    expect(r.wiki[0]!.snippet.length).toBeLessThan(200);
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0]!.snippet).toBe("Did the pelican ticket get done?");
    expect(r.chats[0]!.link).toBe(`chat/${A.company}/${A.agent}/${r.chats[0]!.id}`);
  });

  it("an exact reference like BOS-12 comes first, ahead of text matches", async () => {
    // "12" also matches nothing by text, so the only hit is the reference; then mix it with a text hit.
    const r = await find(A.company, "BOS-12");
    expect(r.tickets[0]).toMatchObject({ ref: "BOS-12", exact: true, title: "Unrelated chore" });
    await t.db.insert(tickets).values({ companyId: A.company, projectId: A.project, title: "Notes on BOS-12 follow-up", number: 40 });
    const both = await find(A.company, "bos-12");
    expect(both.tickets.map((x) => x.ref)).toEqual(["BOS-12", "BOS-40"]);
    expect((await find(A.company, "#12")).tickets[0]).toMatchObject({ ref: "BOS-12", exact: true });
    // Another company's prefix names nothing here.
    expect((await find(A.company, "BET-12")).tickets).toEqual([]);
  });

  it("never returns another company's tickets, pages or chats", async () => {
    const r = await find(A.company, "pelican");
    const ids = [...r.tickets, ...r.wiki, ...r.chats].map((x) => x.link);
    expect(ids.every((l) => !l.includes(B.company))).toBe(true);
    expect([r.tickets.length, r.wiki.length, r.chats.length]).toEqual([1, 1, 1]);
    // Beta's own search sees only Beta's rows, and Beta's ticket 7 by reference, not Alpha's.
    const b = await find(B.company, "pelican");
    expect([b.tickets.length, b.wiki.length, b.chats.length]).toEqual([1, 1, 1]);
    expect(b.tickets[0]!.ref).toBe("BET-7");
    expect(b.tickets[0]!.id).not.toBe(r.tickets[0]!.id);
    expect((await find(B.company, "BOS-12")).tickets).toEqual([]);
  });

  it("refuses a signed-out request with 401", async () => {
    expect((await get(A.company, "pelican", false)).statusCode).toBe(401);
  });

  it("a query under 2 characters returns nothing, and % or _ match only themselves", async () => {
    expect(await find(A.company, "p")).toMatchObject({ tickets: [], wiki: [], chats: [] });
    expect((await find(A.company, "%%")).tickets).toEqual([]);
    expect((await find(A.company, "__")).tickets).toEqual([]);
  });

  it("caps each group at 8", async () => {
    await t.db.insert(tickets).values(Array.from({ length: 12 }, (_, i) => ({ companyId: A.company, projectId: A.project, title: `Heron task ${i}` })));
    expect((await find(A.company, "heron")).tickets).toHaveLength(SEARCH_GROUP_MAX);
  });

  it("answers within its limit with 2,000 tickets and 2,000 chat messages", async () => {
    const C = await seedCompany("Gamma", "GAM");
    const words = ["deploy", "budget", "runner", "wiki", "board", "review", "merge", "check"];
    for (let i = 0; i < 2000; i += 500) {
      await t.db.insert(tickets).values(Array.from({ length: 500 }, (_, j) => ({ companyId: C.company, projectId: C.project, title: `Task ${i + j} about ${words[(i + j) % 8]}`, body: `Body ${i + j}. ${"Some description text. ".repeat(20)}` })));
      await t.db.insert(ownerChatMessages).values(Array.from({ length: 500 }, (_, j) => ({ companyId: C.company, agentId: C.agent, role: "owner" as const, text: `Message ${i + j} about the ${words[(i + j) % 8]} and more. ${"Chat filler. ".repeat(10)}` })));
    }
    // GitHub's runners are 2.5 to 5 times slower than this host, so they get their own limit; 300 ms
    // is the ticket's figure for this host. Either way it catches a search that reads every row's
    // whole text per query or runs a query per row. Best of three, after one warm-up, so a single GC
    // pause or a cold query plan doesn't decide it.
    const LIMIT_MS = process.env.GITHUB_ACTIONS ? 1500 : 300;
    await find(C.company, "budget");
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await find(C.company, "budget");
      times.push(performance.now() - t0);
      expect(r.tickets).toHaveLength(SEARCH_GROUP_MAX);
      expect(r.chats).toHaveLength(SEARCH_GROUP_MAX);
    }
    expect(Math.min(...times)).toBeLessThan(LIMIT_MS);
  }, 120_000);
});

describe("search helpers", () => {
  it("reads BOS-12 and #12 as references, and nothing else", () => {
    expect(refOf("bos-12")).toEqual({ prefix: "BOS", number: 12 });
    expect(refOf(" #12 ")).toEqual({ prefix: null, number: 12 });
    expect(refOf("12")).toBeNull();
    expect(refOf("BOS-12 login")).toBeNull();
  });
  it("cuts a snippet around the match on one line", () => {
    expect(snippetOf("short\n text", "text")).toBe("short text");
    const s = snippetOf(`${"a ".repeat(100)}needle${" b".repeat(100)}`, "NEEDLE");
    expect(s).toMatch(/^….*needle.*…$/);
  });
});
