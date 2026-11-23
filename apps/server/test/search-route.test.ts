// The search box's route (BOS-2192): tickets, wiki pages and chat messages of one company, grouped, with snippets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, decisions, features, ownerChatMessages, projects, runs, skills, tickets, wikiPages } from "../src/db/schema.js";
import { decisionTitle, refOf, runResultWord, SEARCH_EXTRA_MAX, SEARCH_GROUP_MAX, snippetOf, type SearchResults } from "../src/routes/search.js";
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
  // (BOS-2326) A feature, a closed and an open decision and a run per company, all about the osprey. The answer
  // and the run's outcome carry text that must never reach the results.
  for (const c of [A, B]) {
    const [ticket] = await t.db.insert(tickets).values({ companyId: c.company, projectId: c.project, title: "Osprey landing gear", number: 30 }).returning();
    await t.db.insert(features).values({ companyId: c.company, title: "Bird tracking", description: "Follow each osprey on a map.", status: "planned" });
    await t.db.insert(decisions).values([
      { companyId: c.company, kind: "question", question: "Approve the osprey deploy?\nThe long detail of the card.", options: ["Yes", "No"], recommendedOption: "Yes", status: "answered", answer: "Yes, my secret note SEKRIT", answeredAt: new Date("2026-11-20T09:00:00Z"), createdAt: new Date("2026-11-20T08:00:00Z") },
      { companyId: c.company, kind: "question", question: "Paint the osprey hangar?", options: ["Yes", "No"], recommendedOption: "Yes", createdAt: new Date("2026-11-10T08:00:00Z") },
    ]);
    await t.db.insert(runs).values({ companyId: c.company, agentId: c.agent, ticketId: ticket!.id, outcome: "error: token SEKRIT expired", startedAt: new Date("2026-11-23T07:00:00Z"), endedAt: new Date("2026-11-23T07:10:00Z") });
  }
  // Ticket 12 doesn't mention the word: only its reference finds it.
  await t.db.insert(tickets).values({ companyId: A.company, projectId: A.project, title: "Unrelated chore", body: "Nothing here.", number: 12 });
}, 60_000);
afterAll(async () => void (await t?.close()));

describe("search route (BOS-2192)", () => {
  it("does not return a wiki page that is in the Deleted pages bin (BOS-2197)", async () => {
    await t.db.insert(wikiPages).values({ companyId: A.company, slug: "binned-page", title: "Binned quokka", body: "The quokka notes.", deletedAt: new Date() });
    const r = await find(A.company, "quokka");
    expect(r.wiki).toEqual([]);
  });

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

  it("finds a feature, decisions (open first) and a run, with titles and status words only (BOS-2326)", async () => {
    const r = await find(A.company, "osprey");
    // The feature matched on its description; only its title and status come back.
    expect(r.features).toEqual([{ id: expect.any(String), title: "Bird tracking", snippet: "Planned", link: expect.stringMatching(new RegExp(`^features/${A.company}/`)) }]);
    // The open card first, though older; a card's title is its first line.
    expect(r.decisions.map((d) => [d.title, d.snippet])).toEqual([["Paint the osprey hangar?", "Open"], ["Approve the osprey deploy?", "Answered"]]);
    expect(r.decisions[1]!.link).toBe(`decisions/${r.decisions[1]!.id}`);
    // The run matched on its ticket's title: the agent, the ticket and "Failed", never the error's text.
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ title: "Alpha CEO on Osprey landing gear", ref: "BOS-30", snippet: "Failed", at: "2026-11-23T07:00:00.000Z" });
    expect(r.runs[0]!.link).toBe(`runs/${r.runs[0]!.id}`);
    expect(JSON.stringify(r)).not.toContain("SEKRIT");
    expect(JSON.stringify(r)).not.toContain("long detail");
  });

  it("finds a run by the agent's name or its ticket's reference, and never another company's features, decisions or runs", async () => {
    const byAgent = await find(A.company, "alpha ceo");
    expect(byAgent.runs.map((x) => x.title)).toEqual(["Alpha CEO on Osprey landing gear"]);
    expect((await find(A.company, "BOS-30")).runs.map((x) => x.ref)).toEqual(["BOS-30"]);
    const a = await find(A.company, "osprey");
    const b = await find(B.company, "osprey");
    expect([b.features.length, b.decisions.length, b.runs.length]).toEqual([1, 2, 1]);
    const aIds = new Set([...a.features, ...a.decisions, ...a.runs].map((x) => x.id));
    expect([...b.features, ...b.decisions, ...b.runs].some((x) => aIds.has(x.id))).toBe(false);
    expect(b.runs[0]!.title).toBe("Beta CEO on Osprey landing gear");
    // Beta's agent finds no run in Alpha.
    expect((await find(A.company, "beta ceo")).runs).toEqual([]);
  });

  it("caps features, decisions and runs at 5 each", async () => {
    const [ticket] = await t.db.insert(tickets).values({ companyId: A.company, projectId: A.project, title: "Kestrel work", number: 50 }).returning();
    await t.db.insert(features).values(Array.from({ length: 8 }, (_, i) => ({ companyId: A.company, title: `Kestrel feature ${i}` })));
    await t.db.insert(decisions).values(Array.from({ length: 8 }, (_, i) => ({ companyId: A.company, kind: "question" as const, question: `Kestrel card ${i}`, options: [], recommendedOption: "a" })));
    await t.db.insert(runs).values(Array.from({ length: 8 }, () => ({ companyId: A.company, agentId: A.agent, ticketId: ticket!.id })));
    const r = await find(A.company, "kestrel");
    expect([r.features.length, r.decisions.length, r.runs.length]).toEqual([SEARCH_EXTRA_MAX, SEARCH_EXTRA_MAX, SEARCH_EXTRA_MAX]);
    // A run still going says so.
    expect(r.runs[0]!.snippet).toBe("Running");
  });

  it("finds agents by name or job and skills by name or description, never their instructions or another company's (BOS-2347)", async () => {
    for (const c of [A, B]) {
      await t.db.insert(agents).values([
        { companyId: c.company, name: "Zippy", title: "Senior Developer", role: "worker", agentKind: "claude", instructions: "Secret plan: wombat" },
        { companyId: c.company, name: "Old Zippy", title: "Tester", role: "worker", agentKind: "claude", retiredAt: new Date("2026-11-01T00:00:00Z") },
      ]);
      await t.db.insert(skills).values([
        { companyId: c.company, name: "penpot", description: "Draw mock-ups in the company's Penpot, board by board.", source: "written", files: [{ path: "SKILL.md", content: "d29tYmF0" }], sizeBytes: 6 },
        { companyId: c.company, name: "drawing-help", description: `${"Filler words. ".repeat(30)}Exports a Penpot board as a PNG.`, source: "written", files: [], sizeBytes: 0 },
      ]);
    }
    const r = await find(A.company, "zippy");
    // The working agent before the retired one; the job in the Agents page's words.
    expect(r.agents.map((a) => [a.title, a.snippet])).toEqual([["Zippy", "Senior Developer"], ["Old Zippy", "Tester · Retired"]]);
    expect(r.agents[0]!.link).toBe(`agents/${r.agents[0]!.id}`);
    expect((await find(A.company, "senior dev")).agents.map((a) => a.title)).toEqual(["Zippy"]);
    // The instructions are never searched or returned.
    expect((await find(A.company, "wombat")).agents).toEqual([]);
    const s = await find(A.company, "PENPOT");
    // A name match first, its description from the start; a description match shows the text around the match.
    expect(s.skills.map((x) => x.title)).toEqual(["penpot", "drawing-help"]);
    expect(s.skills[0]).toMatchObject({ snippet: "Draw mock-ups in the company's Penpot, board by board.", link: `skills/${s.skills[0]!.id}` });
    expect(s.skills[1]!.snippet).toMatch(/^….*Penpot board as a PNG\.$/);
    expect(JSON.stringify([r, s])).not.toContain("wombat");
    // Beta's rows have the same names but never show in Alpha's search.
    const b = await find(B.company, "zippy");
    const aIds = new Set([...r.agents, ...s.skills].map((x) => x.id));
    expect([...b.agents, ...(await find(B.company, "penpot")).skills].some((x) => aIds.has(x.id))).toBe(false);
    expect(b.agents).toHaveLength(2);
  });

  it("caps agents and skills at 5 each (BOS-2347)", async () => {
    await t.db.insert(agents).values(Array.from({ length: 8 }, (_, i) => ({ companyId: A.company, name: `Puffin ${i}`, role: "worker" as const, agentKind: "claude" })));
    await t.db.insert(skills).values(Array.from({ length: 8 }, (_, i) => ({ companyId: A.company, name: `puffin-${i}`, description: "x", source: "written" as const, files: [], sizeBytes: 0 })));
    const r = await find(A.company, "puffin");
    expect([r.agents.length, r.skills.length]).toEqual([SEARCH_EXTRA_MAX, SEARCH_EXTRA_MAX]);
    // An agent with no job title is an "Agent", as on the Agents page.
    expect(r.agents[0]!.snippet).toBe("Agent");
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
  it("names a run's result in the Runs page's words and cuts a card's title to its first line (BOS-2326)", () => {
    expect(["error: x", "interrupted", "cancelled", "stopped: limit", "lost: y", "done", null].map((o) => runResultWord(o))).toEqual(["Failed", "Interrupted", "Stopped", "Stopped", "Lost", "Finished", "Running"]);
    expect(decisionTitle("\n  First line \nsecond")).toBe("First line");
    expect(decisionTitle("x".repeat(300))).toHaveLength(160);
  });
  it("cuts a snippet around the match on one line", () => {
    expect(snippetOf("short\n text", "text")).toBe("short text");
    const s = snippetOf(`${"a ".repeat(100)}needle${" b".repeat(100)}`, "NEEDLE");
    expect(s).toMatch(/^….*needle.*…$/);
  });
});
