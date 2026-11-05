import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { stateNoteLine } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, deploys, deployTargets, engagements, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { decisionsService } from "../src/services/decisions.js";
import { ownerActed, STALE_REASON } from "../src/services/stale-requests.js";

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
    const ask = (question: string, extra: Record<string, unknown> = {}) =>
      mcp.callTool({
        name: "raise_decision",
        arguments: { question, options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Asked again after reading the docs", ...extra },
      });

    // The same question again, from the same agent, is refused (BOS-175 keeps the similarity check).
    const refused = await ask("Which payment provider should I use, Stripe or Mollie?");
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toContain("Mollie");
    expect(textOf(refused)).toMatch(/already answered/i);

    const allowed = await ask("Which payment provider should I use, Stripe or Mollie?", { stillNeeded: "The owner chose Mollie, but the Mollie key has expired and they must pick again." });
    expect(isError(allowed)).toBe(false);
    expect(textOf(allowed)).toMatch(/in the owner's queue/i);
  });

  it("lets the same agent ask an unrelated question after the owner answered a different one (BOS-175)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Stripe or Mollie?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared their fees" });
    await c.decisions.answer(d.id, "Mollie");

    const mcp = await c.mcp(c.worker.id);
    const asked = await mcp.callTool({
      name: "raise_decision",
      arguments: { question: "Which colour for the checkout button?", options: ["Green", "Brand blue"], recommended: "Green", blocksTicketId: t.id, triedFirst: "Checked the brand guide" },
    });
    expect(isError(asked)).toBe(false);
    expect(textOf(asked)).toMatch(/in the owner's queue/i);
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

  it("marks cards and notes across every kind of card in one action, and wakes each author once (BOS-175 item 3)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Ship the exporter", c.worker.id);
    const blocker = await c.ticket("Unblock the API");
    // A state note is what a ticket's own row marks out of date when the owner acts; the developer
    // who left it is woken for it (the other cards all belong to the reviewer).
    await c.db.update(tickets).set({ stateNote: "Waiting on the owner's answer about the exporter.", stateNoteAt: new Date() }).where(eq(tickets.id, t.id));
    const card = (values: Record<string, unknown>) =>
      c.db
        .insert(decisions)
        .values({ companyId: c.company.id, kind: "question", question: "Something", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: c.other.id, context: { type: "question" }, ...values })
        .returning();
    // One card of each kind the filter has to see: a context ticket, a card that blocks, a run's
    // ticket, an engagement's ticket, and a card about a different ticket that must stay alone.
    const [direct] = await card({ context: { type: "question", ticketId: t.id } });
    const [blocking] = await card({ context: { type: "question" } });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: blocking!.id });
    const [stale] = await card({ context: { type: "stale_blocker", blockedTicketId: t.id } });
    // A deploy card names only its deploy, so the deploy's own ticket is what ties it here.
    const [target] = await c.db.insert(deployTargets).values({ companyId: c.company.id, name: "hosting", kind: "ssh", endpoint: "example" }).returning();
    const [deployRow] = await c.db.insert(deploys).values({ companyId: c.company.id, targetId: target!.id, ticketId: t.id, ref: "v1.2.0", status: "pending_approval", agentId: c.other.id }).returning();
    const [deploy] = await card({ context: { type: "deploy", deployId: deployRow!.id } });
    // A card about a different ticket is not about this one, so its author is not woken for it.
    const [otherTicket] = await card({ context: { type: "question", ticketId: blocker.id } });

    // Without a wake hook the pilot records who it would wake, so the one-note-per-agent rule is checked.
    const notedWakes: Array<{ agentId: string }> = [];
    const result = await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner answered", wake: async (input) => (notedWakes.push(input), { id: randomUUID(), status: "queued" }) });
    expect(result.flaggedDecisions.sort()).toEqual([direct!.id, blocking!.id, stale!.id, deploy!.id].sort());
    expect(result.flaggedDecisions).not.toContain(otherTicket!.id);
    expect(result.flaggedTickets).toEqual([t.id]);
    // Card authors are woken once each, and the worker holding the ticket's note is woken for the note.
    expect(result.woken.sort()).toEqual([c.other.id, c.worker.id].sort());
  });

  it("still marks an engagement card's tickets, which name no ticket id (BOS-175 item 3)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Wait for the other company", c.worker.id);
    const provider = (await c.req("POST", "/api/companies", { name: "Hosting Co" })).json().company as { id: string };
    const [eng] = await c.db
      .insert(engagements)
      .values({ requesterCompanyId: c.company.id, providerCompanyId: provider.id, title: "Deploy it", scope: "Ship the release", status: "in_progress" })
      .returning();
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Engagement done?", options: ["Yes"], recommendedOption: "Yes", raisedByAgentId: c.other.id, context: { type: "engagement", engagementId: eng!.id } })
      .returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerEngagementId: eng!.id });
    const result = await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the engagement finished" });
    expect(result.flaggedDecisions).toEqual([d!.id]);
  });

  it("still tells the asker the answer when marking the related cards out of date fails (BOS-175 item 4)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Ship the exporter", c.worker.id);
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Ship the exporter?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Read the ticket" });
    const woken: Array<{ agentId: string; note?: string | null }> = [];
    const logged: string[] = [];
    // The asker can't be around while another agent worried about an out-of-date note is woken: its
    // own answer is a "decision answered" wake, any other reason is the marking step's.
    const [side] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Which port for the preview?", options: ["3000", "8080"], recommendedOption: "3000", raisedByAgentId: c.worker.id, context: { type: "question", ticketId: t.id } })
      .returning();
    expect(side).toBeTruthy();
    const svc = decisionsService(c.db, () => true, () => new Date(), () => true, (m) => logged.push(m));
    // The marking step wakes agents about out-of-date cards; make its wake fail, so it throws after
    // the answer is saved but before the asker is told or the tickets are released (as a bug might).
    svc.setWakeHook((async (input: { agentId: string; reason: string; note?: string | null }) => {
      // Only the stale-request wake fails; the answer and "unblocked" wakes come after it and must still go out.
      if (input.reason === STALE_REASON) throw new Error("wake hook down");
      woken.push(input);
      return { id: randomUUID(), status: "queued" };
    }) as never);
    const answered = await svc.answer(card.id, "Yes");
    expect(answered).not.toBeNull();
    expect((await c.db.select().from(decisions).where(eq(decisions.id, card.id)))[0]).toMatchObject({ status: "answered", answer: "Yes" });
    // The failure is logged, not thrown; the asker still hears the answer; the ticket is released.
    expect(logged.join(" ")).toMatch(/marking related cards out of date failed: wake hook down/);
    expect(woken.map((w) => w.agentId)).toContain(c.other.id);
    expect(woken.find((w) => w.agentId === c.other.id)!.note).toContain("Ship the exporter?");
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card.id))).toEqual([]);
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

  it("never quotes one card's owner answer on another card about the same ticket (BOS-470, Jane/Rod)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Security review on the payments page", c.worker.id);
    // Jane's answer settles her own card on the ticket.
    const jane = await c.decisions.raise({ companyId: c.company.id, agentId: c.other.id, question: "Jane - Security Reviewer has sent nothing for 5 minutes while working on this.", options: ["Keep waiting", "Cancel run"], recommended: "Keep waiting", blocksTicketId: t.id, triedFirst: "Checked the run's events" });
    // Rod's stalled-run card is Boss Man's own card (raised on the ladder, no author). It must not be
    // flagged by Jane's answer, nor have her answer quoted on it.
    const [rod] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "stalled_run",
        question: 'Rod has sent nothing for 5 minutes while working on "Security review on the payments page".',
        options: ["Keep waiting", "Cancel run"],
        recommendedOption: "Keep waiting",
        tier: "owner",
        dedupeKey: `stalled:${randomUUID()}`,
        raisedByAgentId: c.worker.id,
        context: { type: "stalled_run", runnerId: randomUUID(), runId: randomUUID(), ladder: { rung: "owner", since: new Date().toISOString(), ticketId: t.id, about: [c.worker.id], hops: [] } },
      })
      .returning();

    await c.decisions.answer(jane.id, "Keep waiting");

    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, rod!.id));
    expect(after!.staleAt).toBeNull();
    expect(after!.staleReason).toBeNull();
    // Rod is not woken about a card an owner answer never made out of date.
    const stale = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, STALE_REASON)));
    expect(stale).toHaveLength(0);
  });
});
