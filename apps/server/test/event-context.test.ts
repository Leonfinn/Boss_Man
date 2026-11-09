import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, ticketArtifacts, ticketDependencies, ticketMessages, tickets, wakes, workflowColumns } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup(tickOnWake = false) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (title: string, patch: Partial<typeof tickets.$inferInsert> = {}) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title, systemState: "in_progress", ...patch }).returning())[0]!;
  return { ...built, db, close, base, req, co, dev, project, ticket };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const row = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function agent(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.co.company.id, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

describe("state notes (R85)", () => {
  it("saves a note in the same state without moving the card to another column", async () => {
    const [later] = await ctx.db.insert(workflowColumns).values({ projectId: ctx.project.id, name: "Testing", systemState: "in_progress", position: 99 }).returning();
    const t = await ctx.ticket("Add rate limiting", { columnId: later!.id, assigneeAgentId: ctx.dev.id });
    const c = await agent(ctx.dev.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Limiter written; tests next." } });
    expect(await row(t.id)).toMatchObject({ systemState: "in_progress", columnId: later!.id, stateNote: "Limiter written; tests next." });
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Ready." } });
    expect((await row(t.id)).columnId).not.toBe(later!.id);
    await c.close();
  });

  it("refuses a move to review, done or blocked without a summary", async () => {
    const t = await ctx.ticket("Add rate limiting", { assigneeAgentId: ctx.dev.id });
    const c = await agent(ctx.dev.id);
    for (const state of ["review", "done", "blocked"]) {
      const res = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(new RegExp(`to ${state} needs a summary`));
    }
    expect(await row(t.id)).toMatchObject({ systemState: "in_progress", stateNote: null });
    await c.close();
  });

  it("saves the note, shows it with its age in read, find and list_my_work, and flags it when the ticket moved on", async () => {
    const t = await ctx.ticket("Add rate limiting", { assigneeAgentId: ctx.dev.id });
    const c = await agent(ctx.dev.id);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Limiter added; tests pass." } }))).toMatch(/now review/);
    expect(await row(t.id)).toMatchObject({ systemState: "review", stateNote: "Limiter added; tests pass." });
    const read = () => c.callTool({ name: "tickets", arguments: { action: "read", ticketId: t.id } }).then(textOf);
    expect(await read()).toContain("State note (0m ago): Limiter added; tests pass.\n");
    expect(await read()).not.toContain("out of date");

    // Written two hours ago, and the ticket has moved since.
    await ctx.db.update(tickets).set({ stateNoteAt: hoursAgo(2), lastActivityAt: new Date() }).where(eq(tickets.id, t.id));
    const stale = "State note (2h ago): Limiter added; tests pass. (may be out of date)";
    expect(await read()).toContain(stale);
    expect(textOf(await c.callTool({ name: "tickets", arguments: { action: "find" } }))).toContain(stale);
    expect(textOf(await c.callTool({ name: "list_my_work", arguments: {} }))).toContain(stale);
    await c.close();
  });

  it("does not bump the version", async () => {
    const t = await ctx.ticket("Add rate limiting", { assigneeAgentId: ctx.dev.id });
    const c = await agent(ctx.dev.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "First." } });
    expect((await row(t.id)).version).toBe(2); // the state change, once
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Second." } });
    await ctx.db.update(tickets).set({ stateNote: "Third.", stateNoteAt: new Date() }).where(eq(tickets.id, t.id));
    expect(await row(t.id)).toMatchObject({ version: 2, stateNote: "Third." });
    await c.close();
  });
});

describe("unblocked wakes (R85)", () => {
  it("carry the blocker's note and what it produced", async () => {
    const blocker = await ctx.ticket("Pick a payments provider");
    const blocked = await ctx.ticket("Add checkout", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerTicketId: blocker.id });
    await ctx.db.insert(ticketArtifacts).values({ companyId: ctx.co.company.id, ticketId: blocker.id, kind: "url", title: "Provider comparison", url: "https://example.test/compare" });
    const c = await agent(ctx.co.ceo.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: blocker.id, state: "done", summary: "Chose Stripe; keys in the vault." } });
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.reason, "unblocked"));
    expect(w).toMatchObject({ agentId: ctx.dev.id, ticketId: blocked.id });
    expect(w!.note).toContain('"Pick a payments provider" is done. Its note: Chose Stripe; keys in the vault.');
    expect(w!.note).toContain("It produced: Provider comparison.");
    expect(w!.note!.length).toBeLessThanOrEqual(800);
    await c.close();
  });

  it("carry the question and answer when a decision was the blocker", async () => {
    const blocked = await ctx.ticket("Add checkout", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
    const [d] = await ctx.db
      .insert(decisions)
      .values({ companyId: ctx.co.company.id, kind: "question", question: "Which provider?", options: ["Stripe", "Adyen"], recommendedOption: "Stripe", raisedByAgentId: ctx.co.ceo.id })
      .returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerDecisionId: d!.id });
    await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Adyen" });
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.reason, "unblocked"));
    expect(w).toMatchObject({ agentId: ctx.dev.id, ticketId: blocked.id });
    expect(w!.note).toContain('You asked "Which provider?"; the answer was: Adyen');
  });

  describe("the owner's answer reaches the ticket it blocked (BOS-951)", () => {
    const posted = (ticketId: string) => ctx.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticketId));

    it("posts the chosen option and the whole long note on the blocked ticket, and the wake keeps the answer", async () => {
      const blocked = await ctx.ticket("Run the desktop test", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      // A long question, the shape that lost the answer before: 800 characters of question left no room for the output.
      const question = `${"Does the app open and show the board with a test ticket on it when you follow the install steps on your own machine? ".repeat(10)}`.trim();
      const output = "PASS  Board opens\nPASS  Test ticket shows\nPASS  Details fold opens\nResult: all green on macOS 14.4";
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question, options: ["Works", "Broken"], recommendedOption: "Works", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerDecisionId: d!.id });
      await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Works", note: output });

      // 1: the whole answer and note are on the blocked ticket's conversation, attributed to the owner.
      const [m] = await posted(blocked.id);
      expect(m).toMatchObject({ author: "owner", agentId: null });
      expect(m!.text).toContain("The owner answered your card on this ticket: Works");
      expect(m!.text).toContain(output);
      expect(m!.text).toContain("macOS 14.4");

      // 2: the wake now shortens the question, not the answer (the answer is what the agent acts on); the
      // note is on the ticket, and a long answer itself is never cut. So a long answer survives whole.
      const [w] = await ctx.db.select().from(wakes).where(and(eq(wakes.reason, "unblocked"), eq(wakes.ticketId, blocked.id)));
      expect(w!.note).toContain("the answer was: Works");
      expect(w!.note!.length).toBeLessThanOrEqual(800 + 1 + "The whole answer and note are on this ticket's conversation.".length);
      expect(w!.note!.indexOf(question)).toBe(-1);
      expect(w!.note!.length).toBeLessThanOrEqual(320);
    });

    it("keeps a long answer whole in the wake, cutting the question instead", async () => {
      const blocked = await ctx.ticket("Long answer", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      const question = `${"Please check whether the board opens, the test ticket shows and the details fold opens on your machine? ".repeat(12)}`.trim();
      const answer = `Here is what I saw:\n${"line of the test output\n".repeat(60)}last line: all green`;
      // The owner answers in their own words (the box under a card), which is where a pasted output goes.
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question, options: ["Works", "Broken"], recommendedOption: "Works", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerDecisionId: d!.id });
      await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer, custom: true });
      const [w] = await ctx.db.select().from(wakes).where(and(eq(wakes.reason, "unblocked"), eq(wakes.ticketId, blocked.id)));
      // The wake keeps the start of the answer (the question is cut, so it reaches much further than before) and
      // points at the ticket; the whole answer is on the ticket's conversation.
      expect(w!.note).toContain("the answer was: Here is what I saw:");
      expect(w!.note).toContain("The whole answer and note are on this ticket's conversation.");
      expect(w!.note!.length).toBeLessThanOrEqual(800 + 2 + "The whole answer and note are on this ticket's conversation.".length);
      const [m] = await posted(blocked.id);
      expect(m!.text).toContain(answer);
    });

    it("posts on the ticket a card names without holding it up (a kept ticket in review)", async () => {
      const t = await ctx.ticket("Check the stage", { systemState: "review", assigneeAgentId: ctx.dev.id });
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question: "How did the stage look?", options: ["Good", "Bad"], recommendedOption: "Good", raisedByAgentId: ctx.co.ceo.id, context: { type: "question", ticketId: t.id } })
        .returning();
      await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Good", note: "The header fold opened." });
      const [m] = await posted(t.id);
      expect(m).toMatchObject({ author: "owner" });
      expect(m!.text).toContain("The header fold opened.");
    });

    it("posts on every ticket the card was about, once each", async () => {
      const a = await ctx.ticket("First", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      const b = await ctx.ticket("Second", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question: "Check both?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      await ctx.db.insert(ticketDependencies).values([
        { blockedTicketId: a.id, blockerDecisionId: d!.id },
        { blockedTicketId: b.id, blockerDecisionId: d!.id },
      ]);
      await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Yes", note: "Both fine." });
      expect((await posted(a.id)).map((m) => m.text)).toEqual([expect.stringContaining("Both fine.")]);
      expect((await posted(b.id)).map((m) => m.text)).toEqual([expect.stringContaining("Both fine.")]);
    });

    it("leaves a decision the CEO settles to the CEO's own wake, not as the owner's words", async () => {
      const blocked = await ctx.ticket("Waits on the CEO", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question: "Which one?", options: ["A", "B"], recommendedOption: "A", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerDecisionId: d!.id });
      const c = await agent(ctx.co.ceo.id);
      // The CEO can't answer its own question, so here Boss Man's own card (no raising agent) is settled by the
      // CEO: the answer is the CEO's, not the owner's words, so it isn't posted as the owner's.
      await ctx.db.update(decisions).set({ raisedByAgentId: null, tier: "ceo" }).where(eq(decisions.id, d!.id));
      const r = await c.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "A", note: "The CEO looked." } });
      expect(textOf(r)).toContain("Answered");
      expect(textOf(r)).not.toContain("Fail");
      await c.close();
      expect(await posted(blocked.id)).toEqual([]);
    });

    it("is readable by id after it drops off the open list", async () => {
      const blocked = await ctx.ticket("Read the answer back", { systemState: "blocked", assigneeAgentId: ctx.dev.id });
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question: "Is the header right?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: blocked.id, blockerDecisionId: d!.id });
      await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "No", note: "The logo overlaps the title." });
      const c = await agent(ctx.co.ceo.id);
      const read = await c.callTool({ name: "decisions", arguments: { action: "read", id: d!.id } });
      expect(textOf(read)).toContain("Is the header right?");
      expect(textOf(read)).toContain("Answer: <untrusted source=\"decision card answer\">\nNo\n</untrusted>");
      expect(textOf(read)).toContain("The logo overlaps the title.");
      // It is not in the open list any more, which is why reading by id matters.
      expect(textOf(await c.callTool({ name: "decisions", arguments: { action: "list" } }))).not.toContain(d!.id);
      await c.close();
    });

    it("reads a card that is still open, and refuses another company's", async () => {
      const [d] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.co.company.id, kind: "question", question: "Still open?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: ctx.co.ceo.id })
        .returning();
      const c = await agent(ctx.co.ceo.id);
      const read = await c.callTool({ name: "decisions", arguments: { action: "read", id: d!.id } });
      expect(textOf(read)).toContain("Still open?");
      expect(textOf(read)).toContain("not answered yet");
      const other = await c.callTool({ name: "decisions", arguments: { action: "read", id: randomUUID() } });
      expect(textOf(other)).toContain("No card with that id");
      await c.close();
    });
  });
});

describe("review requests (R85)", () => {
  const reviews = () => ctx.db.select().from(wakes).where(eq(wakes.reason, "review requested"));

  it("are gathered into one deferred CEO wake, each ticket listed once, and not when the CEO moves it", async () => {
    const a = await ctx.ticket("Add rate limiting", { assigneeAgentId: ctx.dev.id });
    const b = await ctx.ticket("Add caching", { assigneeAgentId: ctx.dev.id });
    const dev = await agent(ctx.dev.id);
    const move = (id: string, summary: string) => dev.callTool({ name: "set_ticket_state", arguments: { ticketId: id, state: "review", summary } });
    await move(a.id, "Limiter added; tests pass.");
    await move(b.id, "Cache added.");
    await move(a.id, "Limiter added again.");
    const [w, ...rest] = await reviews();
    expect(rest).toEqual([]);
    expect(w).toMatchObject({ agentId: ctx.co.ceo.id, ticketId: null, status: "deferred" });
    expect(w!.note).toContain(`- ${a.id} "Add rate limiting": Limiter added; tests pass.`);
    expect(w!.note).toContain(`- ${b.id} "Add caching": Cache added.`);
    expect(w!.note!.split(a.id)).toHaveLength(2);

    const own = await ctx.ticket("CEO's own", { assigneeAgentId: ctx.co.ceo.id });
    const ceo = await agent(ctx.co.ceo.id);
    await ceo.callTool({ name: "set_ticket_state", arguments: { ticketId: own.id, state: "review", summary: "Done by me." } });
    expect((await reviews())[0]!.note).not.toContain(own.id);
    await dev.close();
    await ceo.close();
  });

  it("are never dropped by the no-ticket limit", async () => {
    await ctx.db.insert(wakes).values(Array.from({ length: 8 }, () => ({ companyId: ctx.co.company.id, agentId: ctx.co.ceo.id, reason: "chasing", status: "launched" as const })));
    const t = await ctx.ticket("Add rate limiting", { assigneeAgentId: ctx.dev.id });
    const dev = await agent(ctx.dev.id);
    await dev.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Ready." } });
    expect((await reviews())[0]!.status).toBe("deferred");
    await dev.close();
  });
});

describe("wakes start at once (R85)", () => {
  it("launches a run from wake() without an explicit tick", async () => {
    await ctx.app.close();
    await ctx.close();
    ctx = await setup(true);
    const reg = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/runner`)).json() as { runnerId: string };
    const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
    ctx.runners.connect(reg.runnerId, (c) => (c.type === "run.start" && commands.push(c), true));
    const t = await ctx.ticket("Add rate limiting", { stateNote: "Half done.", stateNoteAt: hoursAgo(3) });
    await ctx.scheduler.wake({ agentId: ctx.dev.id, ticketId: t.id, reason: "assigned" });
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]!.prompt).toContain("State note (3h ago): Half done.");
    expect(commands[0]!.prompt).toContain("needs a summary");
  });
});
