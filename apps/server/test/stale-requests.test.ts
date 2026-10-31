import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stateNoteLine } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { STALE_REASON } from "../src/services/stale-requests.js";

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
  const other = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Reviewer" })).json() as { id: string };
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

describe("stale requests (BOS-123)", () => {
  it("flags an open card and the state note when the owner answers a related decision, and wakes the author once", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the footer", c.worker.id);
    await c.work.updateTicket(t.id, { stateNote: "Waiting on the owner to pick a colour." });

    // The card the owner answers, and another open card about the same ticket from the worker.
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Which colour?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Checked the brand guide" });
    const second = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Should I also change the header?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Searched the repo" });

    await c.decisions.answer(first.id, "Blue");

    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, second.id));
    expect(after!.staleAt).toBeInstanceOf(Date);
    expect(after!.staleReason).toMatch(/owner answered/i);
    const [ticketRow] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(ticketRow!.stateNoteStaleAt).toBeInstanceOf(Date);

    const stale = (await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON))));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.note).toMatch(/out of date/i);
  });

  it("refuses a request the owner already answered, quoting the answer, unless a fresh reason is given", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Stripe or Mollie?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared their fees" });
    await c.decisions.answer(d.id, "Mollie");

    const mcp = await c.mcp(c.worker.id);
    const ask = (extra: Record<string, unknown> = {}) =>
      mcp.callTool({
        name: "raise_decision",
        arguments: { question: "Which provider should I use?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Asked again after reading the docs", ...extra },
      });

    const refused = await ask();
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain("Mollie");
    expect(textOf(refused)).toMatch(/already answered/i);

    const allowed = await ask({ stillNeeded: "The owner chose Mollie, but the Mollie key has expired and they must pick again." });
    expect(isError(allowed)).toBe(false);
    expect(textOf(allowed)).toMatch(/in the owner's queue/i);
  });

  it("flags notes and cards that wait on a ticket when that ticket is done", async () => {
    const c = (ctx = await setup());
    const blocker = await c.ticket("Ship the API");
    const waiting = await c.ticket("Show the new data", c.worker.id);
    await c.work.updateTicket(waiting.id, { stateNote: "Waiting on the API ticket to finish." });
    await c.work.addDependency(waiting.id, { ticketId: blocker.id });
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Should the data page wait for the API?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: waiting.id, triedFirst: "Read both tickets" });

    await c.work.updateTicket(blocker.id, { state: "done", outcome: "completed" });

    const [waiter] = await c.db.select().from(tickets).where(eq(tickets.id, waiting.id));
    expect(waiter!.stateNoteStaleAt).toBeInstanceOf(Date);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, card.id));
    expect(after!.staleAt).toBeInstanceOf(Date);
    const stale = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON)));
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("wakes only the agent whose own card or note could be out of date, not every agent downstream (BOS-254)", async () => {
    const c = (ctx = await setup());
    // The alert is about a card George raised on BOS-239; BOS-249 waits on BOS-239 and belongs to Bungle.
    const blocker = await c.ticket("Funding layout base", c.worker.id);
    const downstream = await c.ticket("Funding layout", c.other.id);
    await c.work.addDependency(downstream.id, { ticketId: blocker.id });
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Should the base ship first?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: blocker.id, triedFirst: "Read both tickets" });

    await c.decisions.answer(card.id, "Yes");

    // Bungle (other) is downstream with no card about this. The old code woke it too, for no reason:
    // being listed downstream is not a stale card. It is not woken now; only an agent whose own
    // card could be out of date is, and the card's author is skipped.
    const stale = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.other.id), eq(wakes.reason, STALE_REASON)));
    expect(stale).toEqual([]);
    // The downstream ticket still shows its blocker; it is just not woken for it.
    const [down] = await c.db.select().from(tickets).where(eq(tickets.id, downstream.id));
    expect(down!.systemState).not.toBe("in_progress");
  });

  it("tells a woken agent to end the run when nothing of theirs is affected", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the footer", c.worker.id);
    await c.work.updateTicket(t.id, { stateNote: "Waiting on the owner to pick a colour." });
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Which colour?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Checked the brand guide" });
    await c.decisions.answer(card.id, "Blue");
    const [stale] = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON)));
    expect(stale!.note).toMatch(/If nothing of yours is affected, end the run/i);
  });

  it("stateNoteLine says a note may be out of date when the owner acted after it", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const note = { stateNote: "Waiting on the owner.", stateNoteAt: new Date("2026-10-27T10:00:00Z"), lastActivityAt: new Date("2026-10-27T09:00:00Z") };
    expect(stateNoteLine(note, now)).not.toContain("(may be out of date)");
    expect(stateNoteLine({ ...note, lastActivityAt: new Date("2026-10-27T11:00:00Z") }, now)).toContain("(may be out of date)");
    expect(stateNoteLine({ ...note, stateNoteStaleAt: new Date("2026-10-27T11:00:00Z") }, now)).toContain("(may be out of date)");
    // A flag from before the note was rewritten doesn't make the fresh note stale.
    expect(stateNoteLine({ ...note, stateNoteAt: new Date("2026-10-27T11:30:00Z"), stateNoteStaleAt: new Date("2026-10-27T11:00:00Z") }, now)).not.toContain("(may be out of date)");
  });

  it("clears the stale flag when a fresh note is written, and flags again on the next owner action", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the footer", c.worker.id);
    await c.work.updateTicket(t.id, { stateNote: "Waiting on the owner to pick a colour." });
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Which colour?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Checked the brand guide" });
    await c.decisions.answer(first.id, "Blue");

    let [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.stateNoteStaleAt).toBeInstanceOf(Date);

    await c.work.updateTicket(t.id, { stateNote: "Blue chosen; building it now." });
    [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.stateNoteStaleAt).toBeNull();
    expect(stateNoteLine({ stateNote: row!.stateNote, stateNoteAt: row!.stateNoteAt, stateNoteStaleAt: row!.stateNoteStaleAt, lastActivityAt: row!.lastActivityAt }, new Date())).not.toContain("(may be out of date)");

    const second = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Anything else for the footer?", options: ["No", "Yes"], recommended: "No", blocksTicketId: t.id, triedFirst: "Read the spec" });
    await c.decisions.answer(second.id, "No");
    [row] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.stateNoteStaleAt).toBeInstanceOf(Date);
  });

  it("does not refuse a fresh question because of an unrelated permission answer on the ticket", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Fix the footer", c.worker.id);
    await c.db.insert(decisions).values({
      companyId: c.company.id,
      kind: "permission",
      question: "Allow: rm -rf build",
      options: ["Allow", "Deny"],
      recommendedOption: "Allow",
      raisedByAgentId: c.worker.id,
      context: { type: "permission", ticketId: t.id, runId: randomUUID() },
      status: "answered",
      answer: "Allow",
      answeredAt: new Date(),
    });

    const mcp = await c.mcp(c.worker.id);
    const asked = await mcp.callTool({
      name: "raise_decision",
      arguments: { question: "Which colour for the footer?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Checked the brand guide" },
    });
    expect(isError(asked)).toBe(false);
    expect(textOf(asked)).toMatch(/in the owner's queue/i);
  });

  it("refuses to withdraw an owner sign-off card and keeps its dependency (security review)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Ship the risky change", c.worker.id);
    const [card] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "approval",
        question: "Reviewer approved it, which is high risk. Merge it, or send it back?",
        options: ["Approve and merge", "Send it back"],
        recommendedOption: "Approve and merge",
        raisedByAgentId: c.other.id,
        tier: "owner",
        context: { type: "risk_review", ticketId: t.id, reviewer: "Reviewer" },
      })
      .returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: card!.id });

    const mcp = await c.mcp(c.other.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: card!.id, reason: "The owner already approved" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/another flow/i);

    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("open");
    const deps = await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card!.id));
    expect(deps).toHaveLength(1);
  });

  it("still lets an agent withdraw its own question card", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a colour", c.worker.id);
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Blue or navy?", options: ["Blue", "Navy"], recommended: "Blue", blocksTicketId: t.id, triedFirst: "Read the brand guide" });
    const mcp = await c.mcp(c.worker.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: d.id, reason: "The owner already chose blue" } });
    expect(isError(r)).toBe(false);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("withdrawn");
  });
});
