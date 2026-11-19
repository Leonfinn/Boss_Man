// Owner-answer memory (BOS-1593): one search over everything the owner already answered or said.
// Texts here are made up; the real repeats it is measured on are on the ticket's wiki study.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { issueRunToken } from "../src/mcp.js";
import { openPglite } from "../src/db/client.js";
import { agentNotes, decisions, ownerAnswerEmbeddings, ownerChatMessages, paAnswers, ticketMessages } from "../src/db/schema.js";
import { describeOwnerAnswer, embedMissingOwnerAnswers, isRepeat, ownerAnswerSearch, searchOwnerAnswers } from "../src/services/owner-answers.js";

// A fake embedder: words that mean the same thing share a concept, so their vectors point the same way.
const DIMS = 768;
const CONCEPT: Record<string, string> = { repo: "code", code: "code", source: "code", repository: "code", public: "visible", strangers: "visible", see: "visible", anyone: "visible", github: "code" };
const STOP = new Set(["the", "a", "is", "our", "can", "yet", "now", "make", "it", "be", "to", "owner", "yes"]);
function fakeVector(text: string) {
  const v = new Array(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STOP.has(w)) continue;
    v[[...(CONCEPT[w] ?? w)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % DIMS] += 1;
  }
  return v;
}
type Provider = { calls: string[][]; fail: false | "500" | "slow" };
const provider = (): Provider => ({ calls: [], fail: false });
function fakeFetch(p: Provider): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (p.fail === "500") return new Response("provider detail", { status: 500 });
    if (p.fail === "slow")
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    p.calls.push(body.input);
    return Response.json({ data: body.input.map((s, index) => ({ index, embedding: fakeVector(s) })) });
  }) as typeof fetch;
}

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(p: Provider = provider()) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", fetch: fakeFetch(p), semanticDebounceMs: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Website" })).json() as { id: string };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string; number: number };
  const answered = async (input: { question: string; answer: string; ticketId: string | null; note?: string; settledByCeo?: boolean; at?: Date }) => {
    const [d] = await db
      .insert(decisions)
      .values({
        companyId: company.id,
        kind: "question",
        question: input.question,
        options: ["Yes", "No"],
        recommendedOption: "Yes",
        raisedByAgentId: ceo.id,
        status: "answered",
        answer: input.answer,
        answeredAt: input.at ?? new Date(),
        context: {
          type: "question",
          ...(input.ticketId ? { ticketId: input.ticketId } : {}),
          ...(input.note ? { answerNote: input.note } : {}),
          ...(input.settledByCeo ? { settled: { agentId: ceo.id, name: "CEO", note: "routine", at: new Date().toISOString() } } : {}),
        },
      })
      .returning();
    return d!;
  };
  return { ...built, db, close, req, company, ceo, ticket, answered };
}

describe("owner-answer memory (BOS-1593)", () => {
  it("finds an answer given on another ticket's card and counts it as a repeat (the BOS-976 / BOS-1240 case)", async () => {
    const c = (ctx = await setup());
    const launch = await c.ticket("Open-source launch");
    await c.ticket("Website links to the code");
    const card = await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, I've made it public.", ticketId: launch.id, at: new Date("2026-11-14T10:00:00Z") });

    // The repeat ask comes from an unrelated ticket: the ticket-scoped check never saw this card.
    const hits = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Is the repo going public?" });
    expect(hits[0]).toMatchObject({ kind: "card", sourceId: card.id, answer: "Yes", ownerNote: "Done, I've made it public.", ticketId: launch.id, ticketRef: `APP-${launch.number}` });
    expect(isRepeat(hits[0]!)).toBe(true);
    const line = describeOwnerAnswer(hits[0]!);
    expect(line).toContain(`on APP-${launch.number}, 2026-11-14 10:00 UTC`);
    expect(line).toContain("Done, I've made it public.");
  });

  it("finds what the owner said in chat and in a ticket message, not only on cards", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Staging site");
    await c.db.insert(ownerChatMessages).values([
      { companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: "Which port should staging use?", createdAt: new Date("2026-11-10T09:00:00Z") },
      { companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: "Use port 8080 for the staging site, never 3000.", createdAt: new Date("2026-11-10T09:01:00Z") },
    ]);
    await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: t.id, author: "owner", text: "Don't send the weekly email on Sundays." });

    const chat = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Which port should the staging site use?" });
    expect(chat[0]).toMatchObject({ kind: "chat", question: "Which port should staging use?", answer: "Use port 8080 for the staging site, never 3000." });
    expect(isRepeat(chat[0]!)).toBe(true);

    const reply = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Should the weekly email go out on Sunday?" });
    expect(reply[0]).toMatchObject({ kind: "ticket_reply", ticketId: t.id, ticketRef: `APP-${t.number}` });
    // Most, not all, of the ask's words: shown to the asker, not a refusal.
    expect(isRepeat(reply[0]!)).toBe(false);
  });

  it("finds the owner's corrections kept as lasting notes", async () => {
    const c = (ctx = await setup());
    await c.db.insert(agentNotes).values({ companyId: c.company.id, agentId: c.ceo.id, title: "Invoices go out in euros", text: "Bill every customer in EUR.", why: "Owner: always invoice in euros, never pounds.", source: "chat" });
    const hits = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Which currency should invoices use, euros or pounds?" });
    expect(hits[0]).toMatchObject({ kind: "note", question: "Invoices go out in euros", answer: "Owner: always invoice in euros, never pounds.", ownerNote: "Bill every customer in EUR." });
  });

  it("leaves out cards the CEO settled and card answers echoed onto tickets", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pricing page");
    await c.answered({ question: "Show prices with tax included?", answer: "Yes", ticketId: t.id, settledByCeo: true });
    await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: t.id, author: "owner", text: "The owner answered your card on this ticket: Yes\n\nThe card asked: Show prices with tax included?" });
    expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Show prices with tax included?" })).toEqual([]);
  });

  it("keeps an unrelated ask apart, honours since and kinds, and returns nothing for an ask of stop words", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Launch");
    await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", ticketId: t.id, at: new Date("2026-10-01T00:00:00Z") });
    const other = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Which font should the blog use?" });
    expect(other).toEqual([]);
    expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Is the repo public?", since: new Date("2026-11-01T00:00:00Z") })).toEqual([]);
    expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Is the repo public?", kinds: ["chat"] })).toEqual([]);
    expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "is it the one?" })).toEqual([]);
    // A loosely related card is found, but doesn't count as the same question.
    const loose = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Should the docs site link to the GitHub organisation page and the team blog?" });
    expect(loose[0]?.kind).toBe("card");
    expect(isRepeat(loose[0]!)).toBe(false);
  });

  it("answers agents through the owner_answers tool, marking a settled question apart from related ones", async () => {
    const c = (ctx = await setup());
    const launch = await c.ticket("Open-source launch");
    await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, I've made it public.", ticketId: launch.id });
    await c.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (c.app.server.address() as { port: number }).port;
    const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.ceo.id, runId: randomUUID() });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const found = (await client.callTool({ name: "owner_answers", arguments: { q: "Is the repo going public?" } })) as { content: Array<{ text: string }> };
      expect(found.content[0]!.text).toMatch(/^Searched by words \(meaning search is off for this company\)\.\nThe owner has already answered this \(1 match\):/);
      expect(found.content[0]!.text).toContain(`card `);
      expect(found.content[0]!.text).toContain(`on APP-${launch.number}`);
      expect(found.content[0]!.text).toContain("Done, I've made it public.");
      const none = (await client.callTool({ name: "owner_answers", arguments: { q: "Which font should the blog use?" } })) as { content: Array<{ text: string }> };
      expect(none.content[0]!.text).toMatch(/^Nothing the owner has said matches/);
    } finally {
      await client.close();
    }
  });

  // The study rows (BOS-1593 wiki study): each is shaped like a real repeat from the cock-ups log,
  // reworded. They pin what word search alone does with each, so a change to the scoring that loses
  // one shows here. "refused": counts as already answered; "shown": found, but the ask goes ahead.
  it.each([
    { name: "answer on another ticket's card (15 Nov)", kind: "card", earlier: { question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, I've made it public." }, ask: "Is the repo going public, so the CI wait switch can go on?", words: "shown" },
    // The same ask without the extra clause: the card's question is matched, so it counts as answered.
    { name: "answer on another ticket's card, short ask", kind: "card", earlier: { question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, I've made it public." }, ask: "Is the repo going public?", words: "refused" },
    { name: "same check asked three times (9 Nov)", kind: "card", earlier: { question: "Does the screenshot criterion pass on your phone?", answer: "Pass" }, ask: "Can you confirm the after-merge screenshot criterion passes?", words: "refused" },
    { name: "sign-off asked again (10 Nov)", kind: "card", earlier: { question: "Approve merging T-979?", answer: "Approve" }, ask: "Sign off T-979 for merge?", words: "refused" },
    { name: "text pasted in the next chat message (13 Nov)", kind: "chat", earlier: { question: "Is issue 147 done?", answer: "Here it is: email confirmation for portal posts, SMTP settings and a trusted proxy." }, ask: "Can you paste the text of GitHub issue 147?", words: "shown" },
    { name: "runner already rebuilt (8 Nov)", kind: "ticket_reply", earlier: { question: null, answer: "The runner is already working, I rebuilt it at 16:00." }, ask: "Please press Build and update runners so the token fix is active.", words: "missed" },
  ] as const)("study: $name → words $words", async ({ kind, earlier, ask, words }) => {
    const c = (ctx = await setup());
    const t = await c.ticket("Earlier ticket");
    if (kind === "card") await c.answered({ question: earlier.question!, answer: earlier.answer, ticketId: t.id, ...("note" in earlier ? { note: earlier.note } : {}) });
    if (kind === "chat")
      await c.db.insert(ownerChatMessages).values([
        { companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: earlier.question!, createdAt: new Date(Date.now() - 60_000) },
        { companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: earlier.answer },
      ]);
    if (kind === "ticket_reply") await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: t.id, author: "owner", text: earlier.answer });
    // The same floor the owner_answers tool uses for "related".
    const hits = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: ask, minScore: 0.34 });
    const got = hits.some(isRepeat) ? "refused" : hits.length ? "shown" : "missed";
    expect(got).toBe(words);
  });

  describe("meaning search (opt-in)", () => {
    const enable = async (c: Awaited<ReturnType<typeof setup>>, over: object = {}) => {
      const secret = (await c.req("POST", "/api/secrets", { name: "embeddings key", kind: "generic", value: "sk-test-embeddings-0001" })).json() as { secret: { id: string } };
      const r = await c.req("PUT", `/api/companies/${c.company.id}/wiki-semantic`, { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-embedding-001", secretId: secret.secret.id, ownerAnswers: true, ...over });
      expect(r.statusCode).toBe(200);
      return r.json() as { ownerAnswers: boolean };
    };
    const embedder = (c: Awaited<ReturnType<typeof setup>>) => (companyId: string) => c.semantic.ownerAnswerEmbedder(companyId);
    const ASK = "Can strangers see our source code?";

    it("is off by default: nothing is sent to a provider and word search answers alone", async () => {
      const p = provider();
      const c = (ctx = await setup(p));
      const t = await c.ticket("Launch");
      await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", ticketId: t.id });
      const got = (await c.req("GET", `/api/companies/${c.company.id}/wiki-semantic`)).json() as { ownerAnswers: boolean };
      expect(got.ownerAnswers).toBe(false);
      const r = await ownerAnswerSearch(c.db, { companyId: c.company.id, q: ASK }, { embedder: embedder(c) });
      expect(r.meaning).toBe("off");
      expect(r.hits).toEqual([]);
      expect(p.calls).toEqual([]);
    });

    it("finds the same question in different words once switched on, and counts it as a repeat", async () => {
      const p = provider();
      const c = (ctx = await setup(p));
      const t = await c.ticket("Launch");
      const card = await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, it's public.", ticketId: t.id });
      await c.answered({ question: "Which font for the blog?", answer: "Inter", ticketId: t.id });
      expect((await enable(c)).ownerAnswers).toBe(true);
      // Switching it on embeds the owner's past answers at once, in the background.
      await c.ownerAnswerEmbeds.drain();
      expect(await c.db.select().from(ownerAnswerEmbeddings)).toHaveLength(2);
      expect(p.calls.flat()).toHaveLength(2);
      // Nothing new: the next pass sends nothing; a new answer is picked up by the next pass.
      const e = (await c.semantic.ownerAnswerEmbedder(c.company.id))!;
      expect(await embedMissingOwnerAnswers(c.db, c.company.id, e)).toBe(0);
      await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: "Keep the old logo." });
      expect(await embedMissingOwnerAnswers(c.db, c.company.id, e)).toBe(1);

      // Words alone miss it: the ask shares no word with the card.
      expect((await searchOwnerAnswers(c.db, { companyId: c.company.id, q: ASK })).filter(isRepeat)).toEqual([]);
      const r = await ownerAnswerSearch(c.db, { companyId: c.company.id, q: ASK }, { embedder: embedder(c) });
      expect(r.meaning).toBe("used");
      expect(r.hits[0]).toMatchObject({ kind: "card", sourceId: card.id, method: "meaning", ticketRef: `APP-${t.number}` });
      expect(isRepeat(r.hits[0]!)).toBe(true);
      expect(describeOwnerAnswer(r.hits[0]!)).toMatch(/meaning \d+%/);
      expect(r.hits.some((h) => h.answer === "Inter" && isRepeat(h))).toBe(false);
    });

    it("falls back to word search, and says why, when the provider fails or is slow", async () => {
      const p = provider();
      const c = (ctx = await setup(p));
      const t = await c.ticket("Launch");
      await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", ticketId: t.id });
      await enable(c);
      p.fail = "500";
      const failed = await ownerAnswerSearch(c.db, { companyId: c.company.id, q: "Is the repo going public?" }, { embedder: embedder(c) });
      expect(failed.meaning).toEqual({ unavailable: "the embeddings provider answered 500" });
      expect(failed.hits[0]).toMatchObject({ kind: "card", method: "words" });
      p.fail = "slow";
      const t0 = Date.now();
      const slow = await ownerAnswerSearch(c.db, { companyId: c.company.id, q: "Is the repo going public?" }, { embedder: embedder(c), timeoutMs: 50 });
      expect(slow.meaning).toEqual({ unavailable: "the embeddings provider could not be reached" });
      expect(slow.hits[0]).toMatchObject({ kind: "card", method: "words" });
      // The wait is the timeout passed in, not the wiki's 30 s: this catches a lost timeout, not a speed.
      expect(Date.now() - t0).toBeLessThan(20_000);
    });
  });

  // Step 4: the re-ask check at all three ask points (raise_decision, notify_owner, the Scrum Master's
  // raise) uses this search, so an answer given in chat, a ticket message or a kept correction stops a
  // repeat card too, not only an earlier card (BOS-1591 looked at cards alone).
  describe("the re-ask refusal", () => {
    const clients: Client[] = [];
    afterEach(async () => {
      for (const cl of clients.splice(0)) await cl.close();
    });
    const mcpAs = async (c: Awaited<ReturnType<typeof setup>>, agentId: string) => {
      if (!c.app.server.listening) await c.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (c.app.server.address() as { port: number }).port;
      const token = await issueRunToken(c.db, { companyId: c.company.id, agentId, runId: randomUUID() });
      const cl = new Client({ name: "t", version: "0" });
      await cl.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(cl);
      return cl;
    };
    const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
    const raise = (cl: Client, question: string, extra: Record<string, unknown> = {}) =>
      cl.callTool({ name: "raise_decision", arguments: { question, options: ["Yes", "No"], recommended: "Yes", triedFirst: "Read the ticket and the earlier tickets about it.", ...extra } });

    it("replays 15 Nov: the CEO's go-public question on another ticket is refused and quotes the owner's answer from the day before", async () => {
      const c = (ctx = await setup());
      const launch = await c.ticket("Open-source launch");
      const yesterday = new Date(Date.now() - 86_400_000);
      const card = await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, I've made it public.", ticketId: launch.id, at: yesterday });
      const ci = await c.ticket("CI wait switch");
      const r = await raise(await mcpAs(c, c.ceo.id), "Is the repo going public?", { blocksTicketId: ci.id });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain("Done, I've made it public.");
      expect(textOf(r)).toContain(card.id);
      expect(textOf(r)).toContain(`APP-${launch.number}`);
      expect(textOf(r)).toContain(yesterday.toISOString().slice(0, 10));
      expect(textOf(r)).toContain("stillNeeded");
    });

    it("R34: an answered step card is shown to the raiser as a warning, never a refusal", async () => {
      const c = (ctx = await setup());
      const done = await c.ticket("CI access");
      const [step] = await c.db
        .insert(decisions)
        .values({
          companyId: c.company.id,
          kind: "question",
          question: "Give the deploy key write access to the staging server?",
          options: ["Done"],
          recommendedOption: "Done",
          raisedByAgentId: c.ceo.id,
          status: "answered",
          answer: "Done",
          answeredAt: new Date(Date.now() - 3_600_000),
          context: { type: "question", ticketId: done.id, steps: ["Open the host settings.", "Give the deploy key write access."], ownerMustDo: true },
        })
        .returning();
      const asking = await c.ticket("Staging deploy");
      const r = await raise(await mcpAs(c, c.ceo.id), "Give the deploy key write access to the staging server?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(false); // a step can need redoing, so it is not a refusal
      expect(textOf(r)).toContain("The owner already did these steps");
      expect(textOf(r)).toContain(`the owner did this on card ${step!.id.slice(0, 8)}`);
      expect(textOf(r)).toContain("Check the live state first");
    });

    it("R49: an answered action card about a setting is listed as related ('owner did this'), not dropped and not a refusal", async () => {
      const c = (ctx = await setup());
      const done = await c.ticket("Worker off");
      const [step] = await c.db
        .insert(decisions)
        .values({
          companyId: c.company.id,
          kind: "question",
          question: "Please turn the check worker Truenas off for now so the merge line stops using it",
          options: ["Done"],
          recommendedOption: "Done",
          raisedByAgentId: c.ceo.id,
          status: "answered",
          answer: "Done: worker is off",
          answeredAt: new Date(Date.now() - 86_400_000),
          context: { type: "question", ticketId: done.id, steps: ["Open Settings → Server and runner → Checks.", "Switch Truenas off."], ownerMustDo: true },
        })
        .returning();
      const asking = await c.ticket("Merge slots");
      const r = await raise(await mcpAs(c, c.ceo.id), "Should we let the check worker Truenas take merges as the fourth slot?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(false);
      expect(textOf(r)).toContain("Possibly related earlier owner answers");
      expect(textOf(r)).toContain(`card ${step!.id.slice(0, 8)}`);
      expect(textOf(r)).toContain("(owner did this)");
    });

    it.each([
      { kind: "chat", ask: "Which port should the staging site use?", said: "Use port 8080 for the staging site, never 3000." },
      { kind: "ticket message", ask: "Send the weekly email on Sundays?", said: "Never send the weekly email on Sundays." },
      { kind: "lasting note", ask: "Do invoices go out in euros?", said: "Owner: always invoice in euros, never pounds." },
    ])("refuses a card the owner already answered in a $kind, and lets it through with stillNeeded", async ({ kind, ask, said }) => {
      const c = (ctx = await setup());
      const earlier = await c.ticket("Earlier work");
      if (kind === "chat")
        await c.db.insert(ownerChatMessages).values([
          { companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: "Which port should staging use?", createdAt: new Date(Date.now() - 60_000) },
          { companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: said },
        ]);
      if (kind === "ticket message") await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: earlier.id, author: "owner", text: said });
      if (kind === "lasting note") await c.db.insert(agentNotes).values({ companyId: c.company.id, agentId: c.ceo.id, title: "Invoices go out in euros", text: "Bill every customer in EUR.", why: said, source: "chat" });
      const asking = await c.ticket("Unrelated ticket");
      const cl = await mcpAs(c, c.ceo.id);
      const r = await raise(cl, ask, { blocksTicketId: asking.id });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain(`The owner already answered`);
      expect(textOf(r)).toContain(`(${kind} `);
      expect(textOf(r)).toContain(said);
      expect(isError(await raise(cl, ask, { blocksTicketId: asking.id, stillNeeded: "The owner said it would change this month." }))).toBe(false);
    });

    it("refuses notify_owner and the Scrum Master's card the same way", async () => {
      const c = (ctx = await setup());
      const earlier = await c.ticket("Newsletter");
      await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: earlier.id, author: "owner", text: "Never send the weekly email on Sundays." });
      const asking = await c.ticket("Email schedule");
      const n = await (await mcpAs(c, c.ceo.id)).callTool({ name: "notify_owner", arguments: { level: "flag", title: "Needs you: send the weekly email on Sundays?", ticketId: asking.id } });
      expect(isError(n)).toBe(true);
      expect(textOf(n)).toContain("Never send the weekly email on Sundays.");

      const sm = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Scrum Master" })).json() as { id: string };
      expect((await c.req("PATCH", `/api/companies/${c.company.id}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true })).statusCode).toBe(200);
      const smAsk = c.watchdog.raiseDecision(c.company.id, sm.id, randomUUID(), { ticketId: asking.id, question: "Send the weekly email on Sundays?", options: ["Yes", "No"], recommended: "No", triedFirst: "Read the ticket and its history.", reason: "the ticket has waited a day" });
      await expect(smAsk).rejects.toThrow(/Never send the weekly email on Sundays\./);
    });

    it("lets a different question through and lists the close earlier answer", async () => {
      const c = (ctx = await setup());
      const earlier = await c.ticket("Newsletter");
      await c.db.insert(ticketMessages).values({ companyId: c.company.id, ticketId: earlier.id, author: "owner", text: "Don't send the weekly email on Sundays." });
      const asking = await c.ticket("Email schedule");
      const r = await raise(await mcpAs(c, c.ceo.id), "Should the weekly email go out on Sunday?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(false);
      expect(textOf(r)).toContain("Possibly related earlier owner answers");
      expect(textOf(r)).toContain("Don't send the weekly email on Sundays.");
    });

    // Security review: only the owner's own words may refuse a card or be quoted as their answer.
    it("doesn't count a note kept at an agent's request as the owner's answer", async () => {
      const c = (ctx = await setup());
      await c.db.insert(agentNotes).values({ companyId: c.company.id, agentId: c.ceo.id, title: "Repo visibility", text: "Making the GitHub repo public is fine.", why: "I think the owner wants the repo public.", source: "request" });
      expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Is making the GitHub repo public fine?" })).toEqual([]);
      const asking = await c.ticket("Launch");
      const r = await raise(await mcpAs(c, c.ceo.id), "Is making the GitHub repo public fine?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(false);
      expect(textOf(r)).not.toContain("Making the GitHub repo public is fine.");
    });

    it("doesn't count the PA's escalation brief copied into the CEO's thread as an owner chat answer", async () => {
      const c = (ctx = await setup());
      const pa = (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "PA" })).json() as { id: string };
      const [asked] = await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: pa.id, role: "owner", text: "What's happening with the launch?" }).returning();
      // The PA's words, written from wiki and ticket text, stored under the owner's role in the CEO thread.
      const found = "What the PA found: the staging site uses port 8080, never 3000.";
      const [copy] = await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: `Your PA is passing this on from the owner.\nThe owner asked: What's happening with the launch?\n${found}` }).returning();
      // A copy without the opening line (a later wording) is still left out through pa_answers.
      const [reworded] = await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: `From the PA: ${found}` }).returning();
      await c.db.insert(paAnswers).values({ companyId: c.company.id, chatMessageId: asked!.id, question: asked!.text, outcome: "escalated:judgement", ceoMessageId: reworded!.id });
      const hits = await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Does the staging site use port 8080?" });
      expect(hits.map((h) => h.sourceId)).not.toContain(copy!.id);
      expect(hits.map((h) => h.sourceId)).not.toContain(reworded!.id);
      const asking = await c.ticket("Staging");
      const r = await raise(await mcpAs(c, c.ceo.id), "Does the staging site use port 8080?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(false);
      expect(textOf(r)).not.toContain("What the PA found");
    });

    it("redacts a token the owner pasted into chat before quoting it to an agent", async () => {
      const c = (ctx = await setup());
      await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: "Use port 8080 for the staging site, never 3000.\napi_key = made-up-key-0123456789" });
      const asking = await c.ticket("Staging");
      const r = await raise(await mcpAs(c, c.ceo.id), "Which port should the staging site use?", { blocksTicketId: asking.id });
      expect(isError(r)).toBe(true);
      expect(textOf(r)).toContain("Use port 8080 for the staging site");
      expect(textOf(r)).not.toContain("made-up-key-0123456789");
    });

    it("with meaning search on, refuses the same question in other words; with the provider down, warns and checks by words", async () => {
      const p = provider();
      const c = (ctx = await setup(p));
      const launch = await c.ticket("Launch");
      await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", note: "Done, it's public.", ticketId: launch.id });
      const secret = (await c.req("POST", "/api/secrets", { name: "embeddings key", kind: "generic", value: "sk-test-embeddings-0001" })).json() as { secret: { id: string } };
      expect((await c.req("PUT", `/api/companies/${c.company.id}/wiki-semantic`, { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-embedding-001", secretId: secret.secret.id, ownerAnswers: true })).statusCode).toBe(200);
      await c.ownerAnswerEmbeds.drain();
      const cl = await mcpAs(c, c.ceo.id);
      const asking = await c.ticket("Docs site");

      const meant = await raise(cl, "Can strangers see our source code?", { blocksTicketId: asking.id });
      expect(isError(meant)).toBe(true);
      expect(textOf(meant)).toContain("Done, it's public.");

      p.fail = "500";
      const down = await raise(cl, "Can strangers see our source code?", { blocksTicketId: asking.id });
      expect(isError(down)).toBe(false);
      expect(textOf(down)).toContain("Meaning search was unavailable (the embeddings provider answered 500)");
    });
  });

  it("never reads another company's answers", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Launch");
    await c.answered({ question: "Make the GitHub repo public now?", answer: "Yes", ticketId: t.id });
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    expect(await searchOwnerAnswers(c.db, { companyId: other.company.id, q: "Is the repo going public?" })).toEqual([]);
    expect(await searchOwnerAnswers(c.db, { companyId: c.company.id, q: "Is the repo going public?" })).toHaveLength(1);
  });
});
