// BOS-1591 (R21): a ticket that waits for something links to what settles it, one card can hold several
// tickets, a question the owner answered anywhere in the company is not asked again, and the CEO is told
// about older tickets that were waiting on an answer in a note only.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { noteMatchesQuestion, waitsForNote } from "../src/services/owner-todo.js";
import { answeredBefore } from "../src/services/stale-requests.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const other = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Writer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, assigneeAgentId?: string) =>
    (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...(assigneeAgentId ? { assigneeAgentId } : {}) })).json() as { id: string };
  return { ...built, db, close, req, company, ceo, project, worker, other, mcp, clients, ticket };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const REPO_Q = "Is the repository public now?";
const REPO_NOTE = "Parked: waits for the repo going public (no date).";

describe("waitsForNote (BOS-1591 step 1)", () => {
  it.each([
    "Waits for the repo going public (no date).",
    "Parked until the website launch.",
    "On hold once the pricing decision is made.",
    "Waiting on BOS-123 to land.",
    "Blocked until the licence is chosen.",
  ])("flags %j", (note) => expect(waitsForNote(note)).toBe(true));

  it.each([
    "Waiting for review.",
    "Waiting on the owner to pick a colour.",
    "Waiting for the quick check to finish.",
    "Not waiting on anything; building the footer.",
    "Run the migration until it passes, then merge.",
    "Done: the footer is built.",
    "",
    null,
  ])("leaves %j", (note) => expect(waitsForNote(note)).toBe(false));

  it("matches a waiting note to the question it was waiting on, and not to an unrelated one", () => {
    expect(noteMatchesQuestion(REPO_NOTE, REPO_Q)).toBe(true);
    expect(noteMatchesQuestion("Parked: waits for the logo from design.", REPO_Q)).toBe(false);
  });
});

describe("a waiting note must link to what settles it (criterion 1)", () => {
  it("refuses a note that says the ticket waits for something with no link, and accepts it once a card is linked", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Launch the website", c.worker.id);
    const mcp = await c.mcp(c.worker.id);
    await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Starting." } });

    const refused = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "backlog", summary: REPO_NOTE } });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/waitsOn|raise_decision|blocked_until/);

    // A card about it is open on another ticket: linking to it (addCards) is the answer, with no second card.
    const home = await c.ticket("Make the repo public");
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: REPO_Q, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: home.id, triedFirst: "Read the repo settings" });
    const ceo = await c.mcp(c.ceo.id);
    const linked = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, waitsOn: { addCards: [card.id] }, reason: "waits on the go-public card" } });
    expect(isError(linked)).toBe(false);
    const [dep] = await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, t.id), eq(ticketDependencies.blockerDecisionId, card.id)));
    expect(dep).toBeTruthy();

    const accepted = await mcp.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "blocked", summary: REPO_NOTE } });
    expect(isError(accepted)).toBe(false);
  });

  it("refuses addCards for an answered card", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Launch the website", c.worker.id);
    const home = await c.ticket("Make the repo public");
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: REPO_Q, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: home.id, triedFirst: "Read the repo settings" });
    await c.decisions.answer(card.id, "Yes");
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "update_ticket", arguments: { ticketId: t.id, waitsOn: { addCards: [card.id] }, reason: "link it" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/already answered/i);
  });
});

describe("one card holds several tickets (criterion 2)", () => {
  it("alsoBlocks holds every ticket and one answer releases and wakes all of them", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket("Make the repo public", c.worker.id);
    const b = await c.ticket("Website launch", c.other.id);
    const d = await c.ticket("Docs site", c.worker.id);
    const mcp = await c.mcp(c.worker.id);
    const raised = await mcp.callTool({ name: "raise_decision", arguments: { question: REPO_Q, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: a.id, alsoBlocks: [b.id, d.id], triedFirst: "Read the repo settings" } });
    expect(isError(raised)).toBe(false);
    const [card] = await c.db.select().from(decisions).where(eq(decisions.question, REPO_Q));
    const held = await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card!.id));
    expect(held.map((h) => h.blockedTicketId).sort()).toEqual([a.id, b.id, d.id].sort());
    for (const id of [a.id, b.id, d.id]) expect((await c.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState).toBe("blocked");

    await c.decisions.answer(card!.id, "Yes");

    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card!.id))).toHaveLength(0);
    for (const id of [a.id, b.id, d.id]) expect((await c.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState).not.toBe("blocked");
    // Everyone's assignee heard the answer: the other agent was woken on its ticket.
    const woken = await c.db.select().from(wakes).where(eq(wakes.agentId, c.other.id));
    expect(woken.some((w) => w.ticketId === b.id)).toBe(true);
  });

  it("alsoBlocks needs blocksTicketId and a ticket in the company", async () => {
    const c = (ctx = await setup());
    const a = await c.ticket("Make the repo public");
    const mcp = await c.mcp(c.worker.id);
    const base = { question: REPO_Q, options: ["Yes", "No"], recommended: "Yes", triedFirst: "Read the repo settings" };
    expect(textOf(await mcp.callTool({ name: "raise_decision", arguments: { ...base, alsoBlocks: [a.id] } }))).toContain("alsoBlocks goes with blocksTicketId");
    expect(textOf(await mcp.callTool({ name: "raise_decision", arguments: { ...base, blocksTicketId: a.id, alsoBlocks: [randomUUID()] } }))).toMatch(/alsoBlocks: no ticket/);
  });
});

describe("an answered question is not asked again, anywhere in the company (criterion 3)", () => {
  async function answeredOnOtherTicket(c: Awaited<ReturnType<typeof setup>>) {
    const home = await c.ticket("Make the repo public");
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: REPO_Q, options: ["I've made it public", "Not yet"], recommended: "I've made it public", blocksTicketId: home.id, triedFirst: "Read the repo settings" });
    await c.decisions.answer(card.id, "I've made it public");
    return { home, card };
  }

  it("raise_decision from an unlinked ticket is refused with the quote, the card and the ticket; stillNeeded lets it through", async () => {
    const c = (ctx = await setup());
    const { card } = await answeredOnOtherTicket(c);
    const asking = await c.ticket("Website launch", c.worker.id);
    const mcp = await c.mcp(c.worker.id);
    const ask = (extra: Record<string, unknown> = {}) => mcp.callTool({ name: "raise_decision", arguments: { question: "Is the repository public yet?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: asking.id, triedFirst: "Looked at the ticket", ...extra } });

    const refused = await ask();
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain("I've made it public");
    expect(textOf(refused)).toContain(card.id);
    expect(textOf(refused)).toMatch(/BOS-\d+/);

    expect(isError(await ask({ stillNeeded: "It was made private again on the 15th." }))).toBe(false);
  });

  it("a card with no ticket is checked too, and an answer older than 30 days no longer counts", async () => {
    const c = (ctx = await setup());
    const { card } = await answeredOnOtherTicket(c);
    const mcp = await c.mcp(c.worker.id);
    const bare = () => mcp.callTool({ name: "raise_decision", arguments: { question: "Is the repository public yet?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Read the repo settings page and the earlier tickets about it." } });
    const first = await bare();
    expect(isError(first) ? textOf(first) : "ok").toContain("I've made it public");
    await c.db.update(decisions).set({ answeredAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(decisions.id, card.id));
    const later = await bare();
    expect(isError(later) ? textOf(later) : "ok").toBe("ok");
  });

  it("a card the CEO settled, or an action card with steps, is not the owner's word", async () => {
    const c = (ctx = await setup());
    const { card } = await answeredOnOtherTicket(c);
    await c.db.update(decisions).set({ context: { type: "question", settled: { name: "CEO" } } }).where(eq(decisions.id, card.id));
    expect(await answeredBefore(c.db, { companyId: c.company.id, question: "Is the repository public yet?" })).toBeNull();
  });

  it("notify_owner that says the ticket needs the owner is refused the same way", async () => {
    const c = (ctx = await setup());
    await answeredOnOtherTicket(c);
    const asking = await c.ticket("Website launch", c.worker.id);
    const mcp = await c.mcp(c.worker.id);
    const r = await mcp.callTool({ name: "notify_owner", arguments: { level: "flag", title: "Needs you: is the repo public yet?", body: "Waiting on you to make the repository public.", ticketId: asking.id } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain("I've made it public");
  });
});

describe("answering a card tells the CEO about unlinked waiters, once (criterion 4)", () => {
  it("lists the parked ticket whose note matches and that has no link, and not a linked or unrelated one", async () => {
    const c = (ctx = await setup());
    const home = await c.ticket("Make the repo public");
    const unlinked = await c.ticket("Release the SDK", c.worker.id);
    const linked = await c.ticket("Website launch", c.other.id);
    const unrelated = await c.ticket("Brand refresh", c.other.id);
    await c.work.updateTicket(unlinked.id, { stateNote: REPO_NOTE });
    await c.work.updateTicket(linked.id, { stateNote: REPO_NOTE });
    await c.work.updateTicket(unrelated.id, { stateNote: "Parked: waits for the logo from design." });
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: REPO_Q, options: ["I've made it public", "Not yet"], recommended: "I've made it public", blocksTicketId: home.id, triedFirst: "Read the repo settings" });
    const { addTicketDependency } = await import("../src/services/ticket-links.js");
    await addTicketDependency(c.db, { companyId: c.company.id, blockedTicketId: linked.id, blockerDecisionId: card.id, actor: { type: "system" }, hold: false });

    await c.decisions.answer(card.id, "I've made it public");

    const told = (await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).filter((w) => /aren't linked/.test(w.note ?? ""));
    expect(told).toHaveLength(1);
    expect(told[0]!.note).toContain(unlinked.id);
    expect(told[0]!.note).not.toContain(linked.id);
    expect(told[0]!.note).not.toContain(unrelated.id);
  });
});
