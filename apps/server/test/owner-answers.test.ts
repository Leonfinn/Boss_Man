// Owner-answer memory (BOS-1593): one search over everything the owner already answered or said.
// Texts here are made up; the real repeats it is measured on are on the ticket's wiki study.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { issueRunToken } from "../src/mcp.js";
import { openPglite } from "../src/db/client.js";
import { agentNotes, decisions, ownerChatMessages, ticketMessages } from "../src/db/schema.js";
import { describeOwnerAnswer, isRepeat, searchOwnerAnswers } from "../src/services/owner-answers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
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
      expect(found.content[0]!.text).toMatch(/^The owner has already answered this \(1 match\):/);
      expect(found.content[0]!.text).toContain(`card `);
      expect(found.content[0]!.text).toContain(`on APP-${launch.number}`);
      expect(found.content[0]!.text).toContain("Done, I've made it public.");
      const none = (await client.callTool({ name: "owner_answers", arguments: { q: "Which font should the blog use?" } })) as { content: Array<{ text: string }> };
      expect(none.content[0]!.text).toMatch(/^Nothing the owner has said matches/);
    } finally {
      await client.close();
    }
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
