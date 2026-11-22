import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, ticketDependencies, tickets, wakes as wakesTable } from "../src/db/schema.js";
import { CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP, ceoAnswerRefusal, isSystemCard, raiseMergeStuck } from "../src/services/decisions.js";
import { issueRunToken } from "../src/mcp.js";

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
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (title: string, body: Record<string, unknown> = {}) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, ...body })).json() as { id: string };
  return { ...built, db, close, req, company, ceo, worker, project, mcp, clients, ticket };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const row = async (id: string) => (await ctx!.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;

describe("the CEO sees the whole Decisions queue (BOS-149)", () => {
  it("lists every open card, any tier, with the detail the owner sees", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Ship the app");
    const ownerCard = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both providers and neither needs a secret" });
    const [ceoCard] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: "A plan to approve", options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", tier: "ceo" }).returning();
    const [held] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Boss Man alert still with the Scrum Master", options: ["Got it"], recommendedOption: "Got it", tier: "ceo", context: { type: "question", ladder: { rung: "scrum_master", since: new Date().toISOString(), ticketId: t.id, about: [], hops: [] } } })
      .returning();

    const list = textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toContain(`${ownerCard.id}: [question/owner]`);
    expect(list).toContain("Which payment provider?");
    expect(list).toContain(`${ceoCard!.id}: [question/ceo]`);
    expect(list).toContain("A plan to approve");
    // An alert still with the Scrum Master is not the CEO's yet (BOS-64), so it stays off this list.
    expect(list).not.toContain(held!.id);
    expect(list).not.toContain("still with the Scrum Master");
    expect(list).toContain("Raised by: Engineer");
    expect(list).toContain("Age:");
    expect(list).toContain("Score:");
    expect(list).toContain("Options: Stripe | Mollie (recommended: Stripe)");
    expect(list).toContain("What was tried first:");
    expect(list).toContain("Compared both providers");
    expect(list).toContain("Ship the app");
    // Card text is marked as untrusted data, not orders for the CEO.
    expect(list).toContain('<untrusted source="decision card">');
    // The owner's own queue is unchanged.
    const ownerQueue = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>;
    expect(ownerQueue.map((d) => d.id)).not.toContain(held!.id);
  });

  it("shows a hand-apply update card's steps (BOS-2208: they live in handSteps, not steps)", async () => {
    const c = (ctx = await setup());
    const [card] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Main has moved to b07c5beb.", options: ["Approve", "Not now"], recommendedOption: "Approve", tier: "owner", context: { type: "self_deploy", target: "server", commit: "b".repeat(40), fromCommit: "a".repeat(40), infra: true, handSteps: ["Pin the approved commit with this command", "Apply it with this command"] } })
      .returning();
    const list = textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toContain(card!.id);
    expect(list).toContain("Steps for the owner:");
    expect(list).toContain("Pin the approved commit with this command / Apply it with this command");
  });

  it("read by id shows a card's steps and what was tried first, like the list (BOS-2211)", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    const [hand] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Main has moved to b07c5beb.", options: ["Approve", "Not now"], recommendedOption: "Approve", tier: "owner", context: { type: "self_deploy", target: "server", commit: "b".repeat(40), infra: true, steps: ["Old plain step"], handSteps: ["Pin the approved commit with this command", "Apply it with this command"] } })
      .returning();
    const read = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "read", id: hand!.id } }));
    // handSteps win over steps, inside the untrusted wrapper.
    expect(read).toMatch(/Steps for the owner: <untrusted[^>]*>[\s\S]*Pin the approved commit with this command \/ Apply it with this command/);
    expect(read).not.toContain("Old plain step");

    const [plain] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Add the key?", options: ["Done", "Not now"], recommendedOption: "Done", tier: "owner", context: { triedFirst: "Looked for it in the vault.", steps: ["Open Settings", "Paste the key"] } })
      .returning();
    const read2 = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "read", id: plain!.id } }));
    expect(read2).toContain("What was tried first:");
    expect(read2).toContain("Looked for it in the vault.");
    expect(read2).toContain("Steps for the owner:");
    expect(read2).toContain("Open Settings / Paste the key");

    const [bare] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Which colour?", options: ["Red", "Blue"], recommendedOption: "Red", tier: "owner", context: {} })
      .returning();
    const read3 = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "read", id: bare!.id } }));
    expect(read3).not.toContain("Steps for the owner:");
    expect(read3).not.toContain("What was tried first:");
  });
});

describe("the CEO clears stale and duplicate cards (BOS-149)", () => {
  it("withdraws a card whose ticket is done, with a reason the owner can read", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Old work");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "A stale question", options: ["A", "B"], recommended: "A", blocksTicketId: t.id, triedFirst: "Looked into this already and it needs a decision" });
    // Finished behind the card's back (no state-change event), so the CEO's own withdraw path is what runs. Finishing it through
    // the normal path closes the card by itself now (BOS-1193, card-recheck.test.ts).
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));

    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: "short" } }))).toBe(true);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: "The ticket is finished, so this card no longer applies.", replacedBy: "none" } });
    expect(isError(r)).toBe(false);
    const after = await row(d.id);
    expect(after.status).toBe("withdrawn");
    expect(after.context).toMatchObject({ withdrawn: { by: "ceo", note: "The ticket is finished, so this card no longer applies.", name: "CEO" } });
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id))).toEqual([]);
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_withdrawn"))).length).toBe(1);
    // The owner sees why in the audit list.
    const advised = (await c.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; withdrawn?: { by: string; note: string } }>;
    expect(advised.find((a) => a.id === d.id)!.withdrawn).toMatchObject({ by: "CEO", note: "The ticket is finished, so this card no longer applies." });
  });

  it("never treats one of the owner's own cards as a duplicate", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Sign this off");
    const insert = async () =>
      (
        await c.db
          .insert(decisions)
          .values({ companyId: c.company.id, kind: "approval", question: "Sign off the release", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" } })
          .returning()
      )[0]!;
    const first = await insert();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "I just don't think this is needed." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");

    // Two open sign-offs for one ticket are normal, so neither can be cleared as a duplicate.
    const second = await insert();
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "This is a duplicate of the newer sign-off card." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: second.id, note: "This one is also a duplicate, honestly." } }))).toBe(true);
    expect((await row(second.id)).status).toBe("open");

    // Once its ticket is finished it is stale, and may go.
    await c.work.updateTicket(t.id, { state: "done", overLimit: true });
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "The ticket is finished, so this card no longer applies.", replacedBy: "none" } }))).toBe(false);
    expect((await row(first.id)).status).toBe("withdrawn");
  });

  it("leaves a live merge card alone and clears it once its ticket is done", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merge me");
    await c.work.updateTicket(t.id, { state: "review", overLimit: true });
    const [live] = await raiseMergeStuck(c.db, { id: t.id, title: "Merge me", companyId: c.company.id }, "The merge check timed out after 10 minutes.");
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: live!.id, note: "I will just drop this merge card for now." } }))).toBe(true);
    expect((await row(live!.id)).status).toBe("open");

    // Finishing the ticket clears the card by itself.
    await c.work.updateTicket(t.id, { state: "done", overLimit: true, outcome: "completed" });
    expect((await row(live!.id)).status).toBe("withdrawn");

    // A merge card left on a finished ticket is stale, so the CEO may clear it.
    const done = await c.ticket("Already finished");
    await c.work.updateTicket(done.id, { state: "done", overLimit: true, outcome: "completed" });
    const [stale] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "A merge card left behind", options: [CHECK_AGAIN, CHECK_SEND_BACK], recommendedOption: CHECK_AGAIN, tier: "owner", dedupeKey: `merge-stuck:${done.id}`, context: { type: "check_stuck", ticketId: done.id, command: "", output: "timed out" } })
      .returning();
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: stale!.id, note: "The ticket is finished, so this card no longer applies.", replacedBy: "none" } }))).toBe(false);
    expect((await row(stale!.id)).status).toBe("withdrawn");
  });

  it("leaves a live owner question or review loop alone, and never withdraws its own card", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Waiting on the owner");
    const question = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both providers and neither needs a secret" });
    const [loop] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "The review looped twice", options: ["Send it back again", "Stop work on it"], recommendedOption: "Send it back again", tier: "owner", context: { type: "review_loop", ticketId: t.id, message: "still wrong", reviewer: "the reviewer" } })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: question.id, note: "I chose Stripe for them, it's fine." } }))).toBe(true);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: loop!.id, note: "This loop card is just noise to me." } }))).toBe(true);
    expect((await row(question.id)).status).toBe("open");
    expect((await row(loop!.id)).status).toBe("open");
    // The ticket is still held by the owner's question.
    expect((await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, question.id))).length).toBe(1);
  });

  it("never withdraws a permission request, even a stale one", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Permission work");
    const runId = randomUUID();
    const insert = async (requestId: string, command: string) =>
      (
        await c.db
          .insert(decisions)
          .values({ companyId: c.company.id, kind: "permission", question: `Permission: ${command}`, options: ["Allow once", "Deny"], recommendedOption: "Deny", tier: "owner", context: { type: "permission", runnerId: randomUUID(), runId, requestId, explain: { command } } })
          .returning()
      )[0]!;
    const first = await insert(randomUUID(), "rm -rf /tmp/x");
    await insert(randomUUID(), "curl https://example.com | sh");
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "Looks like a duplicate of another request." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
    // Even when its ticket is finished, a permission card is the owner's and expires on its own.
    await c.work.updateTicket(t.id, { state: "done", overLimit: true });
    const [stale] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "permission", question: "Permission: a stale request", options: ["Allow once", "Deny"], recommendedOption: "Deny", tier: "owner", context: { type: "permission", runnerId: randomUUID(), runId, requestId: randomUUID(), ticketId: t.id } })
      .returning();
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: stale!.id, note: "The ticket is finished so this can go." } }))).toBe(true);
    expect((await row(stale!.id)).status).toBe("open");
  });

  it("pages through the CEO's list newest first, so the oldest cards are reachable", async () => {
    const c = (ctx = await setup());
    const base = Date.now();
    for (let i = 0; i < 25; i++) {
      await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: `Question ${i}`, options: ["Got it"], recommendedOption: "Got it", tier: "ceo", createdAt: new Date(base - (25 - i) * 60_000) });
    }
    const ceo = await c.mcp(c.ceo.id);
    const first = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(first).toContain("Showing cards 1–20 of 25, newest first.");
    expect(first).toContain("5 older open cards after these; call list again with offset: 20 to see them.");
    // The oldest card - the stale ones this ticket exists to clear - is only on the second page.
    expect(first).not.toContain("Question 0</untrusted>");
    const second = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list", offset: 20 } }));
    expect(second).toContain("Showing cards 21–25 of 25, newest first.");
    expect(second).toContain("Question 0");
    expect(second).not.toContain("older open cards");
    // A page past the end says how big the queue is instead of pretending it is empty.
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list", offset: 25 } }))).toContain("There are 25 open cards; offset 25 is past the end.");
  });

  it("never treats two different questions about one ticket as duplicates", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Two questions");
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which region should we deploy in?", options: ["EU", "US"], recommended: "EU", blocksTicketId: t.id, triedFirst: "Both need a secret only the owner can add." });
    await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider should we use?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both providers." });
    const ceo = await c.mcp(c.ceo.id);
    // Both name the same ticket, but they ask entirely different things, so neither is a duplicate.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "This duplicates the other card on the same ticket." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, first.id))).toHaveLength(1);
  });

  it("never treats same-text cards with different options as duplicates (BOS-195)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider");
    const narrower = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider should we use?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both providers and neither needs a secret." });
    const wider = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider should we use?", options: ["Stripe", "Mollie", "Adyen"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared all three providers and none needs a secret." });
    const ceo = await c.mcp(c.ceo.id);
    // The wider card offers a choice the narrower one does not, so it must survive as its own card.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: wider.id, note: "Looks like a duplicate of the other card." } }))).toBe(true);
    expect((await row(wider.id)).status).toBe("open");
    // Nor is the narrower one a duplicate of the wider one.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: narrower.id, note: "Looks like a duplicate of the other card." } }))).toBe(true);
    expect((await row(narrower.id)).status).toBe("open");
  });

  it("treats cards with a different recommended option as different questions (BOS-195)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a provider");
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider should we use?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared both providers and neither needs a secret." });
    await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which payment provider should we use?", options: ["Stripe", "Mollie"], recommended: "Mollie", blocksTicketId: t.id, triedFirst: "Compared both providers and neither needs a secret." });
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "Looks like a duplicate of the other card." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
  });

  it("withdraws a true duplicate and drops the hold its withdrawn card had on the ticket", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Held twice");
    const first = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Should we ship on Friday?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Read the release notes." });
    // Raised by another agent: the same agent asking again would have closed the first card by itself (BOS-1193).
    const second = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "Should we ship on Friday?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, triedFirst: "Read the release notes." });
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "This duplicates the other card that asks the same thing.", replacedBy: "none" } }))).toBe(false);
    expect((await row(first.id)).status).toBe("withdrawn");
    // The withdrawn card no longer holds the ticket; the identical open card still does.
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, first.id))).toHaveLength(0);
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, second.id))).toHaveLength(1);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).not.toBe("ready");
    // Answering the surviving card releases the ticket: no stale hold is left behind.
    await c.decisions.answer(second.id, "Yes", {});
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("ready");
  });

  it("leaves a merge-retry card open when the owner's sign-off is still waiting", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Signed off but not answered");
    await c.db.insert(decisions).values({
      companyId: c.company.id,
      kind: "approval",
      question: "Merge it, or send it back?",
      options: ["Approve and merge", "Send it back"],
      recommendedOption: "Approve and merge",
      tier: "owner",
      context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" },
    });
    const [merge] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "The merge check timed out", options: [CHECK_AGAIN, CHECK_SEND_BACK], recommendedOption: CHECK_AGAIN, tier: "owner", context: { type: "check_stuck", ticketId: t.id, command: "pnpm test", output: "timed out" } })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: merge!.id, answer: CHECK_AGAIN, note: "The runner is back, so run the check again." } }))).toBe(true);
    // The original card stays open; no replacement card is raised and no merge starts.
    expect((await row(merge!.id)).status).toBe("open");
    const merges = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type?: string }).type === "check_stuck");
    expect(merges.map((d) => d.id)).toEqual([merge!.id]);
  });

  it("needs a reason for a system card on the CEO's own tier too", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "A notice on the CEO tier", options: ["Got it"], recommendedOption: "Got it", tier: "ceo", context: { type: "question" } })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Got it" } }))).toBe(true);
    expect((await row(d!.id)).status).toBe("open");
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Got it", note: "Acknowledged, the team handles it." } }))).toBe(false);
  });
});

describe("the CEO may answer only system and info cards (BOS-149)", () => {
  it("answers a 'Got it' notice at the owner's tier with a logged reason", async () => {
    const c = (ctx = await setup());
    await c.ticket("Some work");
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "question",
        question: "Your answer couldn't reach the runner, so it will try again.",
        options: ["Got it"],
        recommendedOption: "Got it",
        tier: "owner",
        context: { type: "question" },
      })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    const bare = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Got it" } });
    expect(isError(bare)).toBe(true);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Got it", note: "I checked the reviewer and woke it again; it is working." } });
    expect(isError(ok)).toBe(false);
    const after = await row(d!.id);
    expect(after.status).toBe("answered");
    expect(after.context).toMatchObject({ settled: { note: "I checked the reviewer and woke it again; it is working." } });
    const logged = (await c.db.select().from(activity).where(eq(activity.kind, "decision_answered")))[0]!;
    expect(logged.summary).toContain("Reason: I checked the reviewer");
  });

  it("never answers or withdraws an alert the ladder has already handed to the owner", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Looped work");
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "question",
        question: "Adversarial Reviewer was woken 4 times without a verdict.",
        options: ["Got it"],
        recommendedOption: "Got it",
        tier: "owner",
        context: { type: "question", ladder: { rung: "owner", since: new Date().toISOString(), ticketId: t.id, about: [], hops: [] } },
      })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    // It failed both the Scrum Master and the CEO, so it is the owner's now.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Got it", note: "I have looked into it and it is fine." } }))).toBe(true);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d!.id, note: "This alert is noise and the owner does not need it." } }))).toBe(true);
    await expect(c.decisions.answer(d!.id, "Got it", { settledBy: { agentId: c.ceo.id }, note: "Bypassing the tool." })).rejects.toThrow(/owner/i);
    expect((await row(d!.id)).status).toBe("open");
  });

  it("refuses every owner-only kind on the server, even when the tool is bypassed", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Owner work");
    const owned = [
      { kind: "permission" as const, options: ["Allow once", "Deny"], context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID() } },
      { kind: "approval" as const, options: ["Approve", "Reject"], context: { type: "deploy", deployId: randomUUID() } },
      { kind: "question" as const, options: ["Deploy", "Not now"], context: { type: "self_deploy", target: "server", commit: "abc", fromCommit: "def" } },
      { kind: "question" as const, options: ["Hire", "Not now"], context: { type: "hire", proposal: { name: "X" }, byAgentId: c.ceo.id } },
      { kind: "question" as const, options: ["Apply the change", "Not now"], context: { type: "instructions", agentId: c.worker.id, instructions: "Be nice", byAgentId: c.ceo.id } },
      { kind: "approval" as const, options: ["Approve", "Edit", "Reject"], context: { type: "model_change", agentId: c.worker.id, before: { harness: "claude", provider: "anthropic", model: "claude-sonnet", fundingSourceId: randomUUID() }, proposed: { harness: "claude", provider: "anthropic", model: "claude-opus", fundingSourceId: randomUUID() }, byAgentId: c.ceo.id } },
      { kind: "approval" as const, options: ["Approve and merge", "Send it back"], context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" } },
      { kind: "budget" as const, options: ["Raise it by half", "Leave it"], context: { type: "budget_limit", policyId: randomUUID() } },
      { kind: "question" as const, options: ["Hire the ticked ones", "Not now"], context: { type: "team_plan", projectId: null, covered: "", hires: [], byAgentId: c.ceo.id } },
    ];
    for (const o of owned) {
      const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: o.kind, question: `Owner only ${o.context.type}`, options: o.options, recommendedOption: o.options[0]!, tier: "owner", context: o.context }).returning();
      // The server's guard, called without the MCP tool text.
      await expect(c.decisions.answer(d!.id, o.options[0]!, { settledBy: { agentId: c.ceo.id }, note: "I think this is fine." })).rejects.toThrow(/owner/i);
      expect((await row(d!.id)).status, o.context.type).toBe("open");
    }
    // The same guard is what the tool sees too.
    const [perm] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "permission", question: "Owner permission", options: ["Allow once", "Deny"], recommendedOption: "Deny", tier: "owner", context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID() } })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: perm!.id, answer: "Allow once", note: "It looks safe to me, honestly." } }))).toBe(true);
    expect((await row(perm!.id)).status).toBe("open");
  });
});

describe("merge cards clean themselves up (BOS-149)", () => {
  it("keeps one open merge card per ticket, and removes it when the ticket is done", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merge me");
    const mergeCards = async () =>
      c.db
        .select()
        .from(decisions)
        .where(and(eq(decisions.status, "open"), eq(decisions.companyId, c.company.id)))
        .then((rows) => rows.filter((d) => (d.context as { type?: string }).type === "check_stuck"));

    await raiseMergeStuck(c.db, { id: t.id, title: "Merge me", companyId: c.company.id }, "the merge check timed out after 10 min");
    expect(await mergeCards()).toHaveLength(1);
    const first = (await mergeCards())[0]!;

    await raiseMergeStuck(c.db, { id: t.id, title: "Merge me", companyId: c.company.id }, "approved but the merge didn't finish");
    expect(await mergeCards()).toHaveLength(1);
    expect((await row(first.id)).status).toBe("withdrawn");
    expect((await row(first.id)).context).toMatchObject({ withdrawn: { by: "system" } });

    // A ticket that is closed no longer carries a merge card.
    await c.work.updateTicket(t.id, { state: "done", overLimit: true });
    expect(await mergeCards()).toHaveLength(0);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("done");
  });

  it("clears a closed ticket's merge card on the agent's set_ticket_state path, and never raises one for a done ticket", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merge me too");
    await raiseMergeStuck(c.db, { id: t.id, title: "Merge me too", companyId: c.company.id }, "the merge check timed out after 10 min");
    const ceo = await c.mcp(c.ceo.id);
    const moved = await ceo.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "1 pass; the work is finished." } });
    expect(isError(moved)).toBe(false);
    expect((await c.db.select().from(decisions).where(and(eq(decisions.status, "open"), eq(decisions.companyId, c.company.id)))).filter((d) => (d.context as { type?: string }).type === "check_stuck")).toHaveLength(0);
    // A late failure for a finished ticket leaves no card behind either.
    expect(await raiseMergeStuck(c.db, { id: t.id, title: "Merge me too", companyId: c.company.id }, "the runner went away")).toEqual([]);
  });

  it("treats a merge retry as a system card the CEO may answer", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "The merge check timed out", options: [CHECK_AGAIN, "Send it back to the agent"], recommendedOption: CHECK_AGAIN, tier: "owner", context: { type: "check_stuck", ticketId: randomUUID(), command: "pnpm test", output: "timed out" } })
      .returning();
    expect(textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: { action: "list" } }))).toContain("Last output:");
    // The server guard allows exactly this kind at the owner's tier and nothing owner-only.
    expect(isSystemCard(d!)).toBe(true);
    expect(ceoAnswerRefusal(d!, CHECK_AGAIN)).toBeNull();
  });

  it("refuses 'Merge without the check' from the CEO, on the service and through the tool", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("High risk work");
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "question",
        question: "The merge check timed out",
        options: [CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP],
        recommendedOption: CHECK_AGAIN,
        tier: "owner",
        context: { type: "check_stuck", ticketId: t.id, command: "pnpm test", output: "timed out" },
      })
      .returning();
    // The server guard itself, called without the tool text.
    await expect(c.decisions.answer(d!.id, CHECK_SKIP, { settledBy: { agentId: c.ceo.id }, note: "The check is too slow, merge it anyway." })).rejects.toThrow(/Merge without the check|owner/i);
    expect((await row(d!.id)).status).toBe("open");
    // The CEO's tool refuses it too, and the card stays open.
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: CHECK_SKIP, note: "The check is too slow, merge it anyway." } }))).toBe(true);
    expect((await row(d!.id)).status).toBe("open");
    // The safe choices are the only ones the guard allows.
    expect(ceoAnswerRefusal(d!, CHECK_AGAIN)).toBeNull();
    expect(ceoAnswerRefusal(d!, CHECK_SEND_BACK)).toBeNull();
  });
});

describe("more attempts the CEO must fail (BOS-149 adversarial round 2)", () => {
  it("cannot answer a sign-off, deploy or hire card even when it sits at the CEO's own tier", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Signed-off work");
    const cases = [
      { kind: "approval" as const, options: ["Approve and merge", "Send it back"], context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" } },
      { kind: "question" as const, options: ["Hire", "Not now"], context: { type: "hire", proposal: { name: "X" }, byAgentId: c.ceo.id } },
      { kind: "approval" as const, options: ["Approve", "Reject"], context: { type: "deploy", deployId: randomUUID() } },
      { kind: "approval" as const, options: ["Approve", "Edit", "Reject"], context: { type: "model_change", agentId: c.worker.id, before: { harness: "claude", provider: "anthropic", model: "claude-sonnet", fundingSourceId: randomUUID() }, proposed: { harness: "claude", provider: "anthropic", model: "claude-opus", fundingSourceId: randomUUID() }, byAgentId: c.ceo.id } },
    ];
    const ceo = await c.mcp(c.ceo.id);
    for (const o of cases) {
      const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: o.kind, question: `CEO tier ${o.context.type}`, options: o.options, recommendedOption: o.options[0]!, tier: "ceo", context: o.context }).returning();
      await expect(c.decisions.answer(d!.id, o.options[0]!, { settledBy: { agentId: c.ceo.id }, note: "This looks fine to me." }), o.context.type).rejects.toThrow(/owner/i);
      expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: o.options[0]!, note: "This looks fine to me." } })), o.context.type).toBe(true);
      expect((await row(d!.id)).status, o.context.type).toBe("open");
    }
  });

  it("cannot withdraw a card that holds both a finished and a live ticket", async () => {
    const c = (ctx = await setup());
    const done = await c.ticket("Finished work");
    const live = await c.ticket("Live work");
    await c.work.updateTicket(done.id, { state: "done", overLimit: true });
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which way for both?", options: ["A", "B"], recommended: "A", blocksTicketId: live.id, triedFirst: "Read both tickets and they need a decision" });
    await c.db.update(decisions).set({ context: { ...(d.context as object), ticketId: done.id } as never }).where(eq(decisions.id, d.id));
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: "One of its tickets is finished." } }))).toBe(true);
    expect((await row(d.id)).status).toBe("open");
  });
});

describe("more attempts the CEO must fail (BOS-149 adversarial round 6)", () => {
  it("cannot answer an alert still with the Scrum Master, and never lists it", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Some work");
    const insert = async (tier: "ceo" | "owner") =>
      (
        await c.db
          .insert(decisions)
          .values({
            companyId: c.company.id,
            kind: "question",
            question: "A run has stalled; keep waiting or cancel it?",
            options: ["Got it"],
            recommendedOption: "Got it",
            tier,
            context: { type: "question", ladder: { rung: "scrum_master", since: new Date().toISOString(), ticketId: t.id, about: [], hops: [] } },
          })
          .returning()
      )[0]!;
    const ceo = await c.mcp(c.ceo.id);
    const ceoTier = await insert("ceo");
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }))).not.toContain(ceoTier.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: ceoTier.id, answer: "Got it", note: "I looked at the stuck run and it is fine." } }))).toBe(true);
    expect((await row(ceoTier.id)).status).toBe("open");
    // The server's own guard refuses it too, so the alert can still reach the owner.
    await expect(c.decisions.answer(ceoTier.id, "Got it", { settledBy: { agentId: c.ceo.id }, note: "I looked at the stuck run and it is fine." })).rejects.toThrow(/Scrum Master|owner/i);
    const ownerTier = await insert("owner");
    await expect(c.decisions.answer(ownerTier.id, "Got it", { settledBy: { agentId: c.ceo.id }, note: "I looked at the stuck run and it is fine." })).rejects.toThrow(/Scrum Master|owner/i);
    expect((await row(ownerTier.id)).status).toBe("open");
  });

  it("never withdraws one of two review-loop escalations as a duplicate", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Review bounces");
    const insert = async () =>
      (
        await c.db
          .insert(decisions)
          .values({ companyId: c.company.id, kind: "approval", question: "Review looks stuck", options: ["Send it back again", "Stop work on it"], recommendedOption: "Stop work on it", tier: "owner", context: { type: "review_loop", ticketId: t.id, message: "still wrong", reviewer: "the reviewer" } })
          .returning()
      )[0]!;
    const first = await insert();
    const second = await insert();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "This one duplicates the newer review-loop card." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
    expect((await row(second.id)).status).toBe("open");
    // Once the ticket is finished they are stale, and may go.
    await c.work.updateTicket(t.id, { state: "done", overLimit: true });
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "The ticket is finished, so this card no longer applies.", replacedBy: "none" } }))).toBe(false);
  });

  it("never withdraws one of two merge cards as a duplicate", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merge me twice");
    const insert = async () =>
      (
        await c.db
          .insert(decisions)
          .values({ companyId: c.company.id, kind: "question", question: "The merge check timed out", options: [CHECK_AGAIN, CHECK_SEND_BACK], recommendedOption: CHECK_AGAIN, tier: "owner", context: { type: "check_stuck", ticketId: t.id, command: "pnpm test", output: "timed out" } })
          .returning()
      )[0]!;
    const first = await insert();
    await insert();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "This merge card duplicates the other one." } }))).toBe(true);
    expect((await row(first.id)).status).toBe("open");
  });

  it("never dismisses the owner's merge-failure notice", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Merge failed");
    const d = await c.decisions.raise({
      companyId: c.company.id,
      agentId: null,
      question: `You approved "${t.id}", but it couldn't be merged: the runner is offline. Approve it again from the ticket once that's fixed.`,
      options: ["Got it"],
      recommended: "Got it",
      steps: ["Fix what stopped the merge, then open the ticket and approve the merge again."],
    });
    expect(isSystemCard(d)).toBe(false);
    expect(ceoAnswerRefusal(d, "Got it")).not.toBeNull();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Got it", note: "Acknowledged, the owner will see it." } }))).toBe(true);
    expect((await row(d.id)).status).toBe("open");
  });

  it("lists every card Boss Man closed by itself, with its reason (BOS-740)", async () => {
    const c = (ctx = await setup());
    const now = new Date();
    const insert = (over: Record<string, unknown>) => c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", tier: "owner", question: "A card", options: ["Done"], recommendedOption: "Done", status: "withdrawn", answeredAt: now, context: { type: "owner_setup", steps: ["Settings → Funding → Add account"] } as never, ...over } as never).returning();
    // A setup card switched back by Boss Man, a hand-apply card closed as live, an old one past 30 days, and one the CEO cleared.
    const [switchedBack] = await insert({ question: "Switch-back setup", context: { type: "owner_setup", steps: ["Settings → Funding → Add account"], withdrawn: { by: "system", note: "Switched back: not running any more.", at: now.toISOString() }, closedNotice: { why: "switched-back", text: "Switched back.", at: now.toISOString(), until: now.toISOString() } } });
    const [live] = await insert({ question: "Hand-apply card", context: { type: "self_deploy", commit: "b".repeat(40), handSteps: ["Apply it."], withdrawn: { by: "system", note: "The update is live already.", at: now.toISOString() }, closedNotice: { why: "live", text: "It's live.", at: now.toISOString(), until: now.toISOString() } } });
    await insert({ question: "Long gone", context: { type: "owner_setup", withdrawn: { by: "system", note: "Old.", at: new Date(now.getTime() - 40 * 24 * 3_600_000).toISOString() } } });
    const [byCeo] = await insert({ question: "Ceo cleared", context: { type: "owner_setup", withdrawn: { by: "ceo", name: "CEO", note: "Stale.", at: now.toISOString() } } });
    const advised = (await c.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; withdrawn?: { by: string; note: string } }>;
    const ids = advised.map((a) => a.id);
    expect(ids).toContain(switchedBack!.id);
    expect(ids).toContain(live!.id);
    expect(ids).toContain(byCeo!.id);
    expect(ids).not.toContain(await c.db.select({ id: decisions.id }).from(decisions).where(eq(decisions.question, "Long gone")).then((r) => r[0]!.id));
    expect(advised.find((a) => a.id === switchedBack!.id)!.withdrawn).toMatchObject({ by: "Boss Man", note: "Switched back: not running any more." });
    expect(advised.find((a) => a.id === live!.id)!.withdrawn).toMatchObject({ by: "Boss Man", note: "The update is live already." });
    // The closed-card notice rides along, so the owner reads why it closed and what is left (QA, BOS-800); a CEO withdrawal has none.
    expect(advised.find((a) => a.id === switchedBack!.id)!.withdrawn).toMatchObject({ notice: "Switched back." });
    expect(advised.find((a) => a.id === live!.id)!.withdrawn).toMatchObject({ notice: "It's live." });
    expect(advised.find((a) => a.id === byCeo!.id)!.withdrawn).not.toHaveProperty("notice");
  });

  it("does not merge a ticket whose owner sign-off is still open", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Waiting for sign-off");
    await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "approval", question: "Sign off the release", options: ["Approve and merge", "Send it back"], recommendedOption: "Approve and merge", tier: "owner", context: { type: "risk_review", ticketId: t.id, reviewer: "the owner" } });
    await expect(c.review.land(t.id, "the owner")).rejects.toThrow(/sign-off/i);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).not.toBe("done");
  });
});

describe("an answer in the owner's own words carries attachments (BOS-759)", () => {
  it("uploads a picture to the card's ticket and tells the agent to open it", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Paste a screenshot");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which screen is wrong?", options: ["The list", "The detail"], recommended: "The list", blocksTicketId: t.id });
    // The page's own upload endpoint, on the ticket the card blocks.
    const up = await c.req("POST", `/api/companies/${c.company.id}/images`, { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), name: "wrong.png", ticketId: t.id });
    expect(up.statusCode).toBe(201);
    const { markdown } = up.json() as { markdown: string };
    expect(markdown).toMatch(/^!\[wrong\.png\]\(\/api\/ticket-images\/[0-9a-f-]{36}\)$/);
    expect((await c.req("GET", `/api/tickets/${t.id}/images`)).json()).toHaveLength(1);

    const answer = `It's the detail screen. Here:\n${markdown}\n`;
    expect((await c.req("POST", `/api/decisions/${d.id}/answer`, { answer, custom: true })).statusCode).toBe(200);
    const after = await row(d.id);
    expect(after.answer).toContain(markdown);
    // The asking agent is woken with the links and told how to open them.
    const [w] = await c.db.select().from(wakesTable).where(and(eq(wakesTable.agentId, c.worker.id), eq(wakesTable.reason, "decision answered")));
    expect(w!.note).toContain(markdown);
    expect(w!.note).toContain("open_attachment");
  });

  it("says nothing about attachments when an ordinary answer has none", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("No screenshot");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Which one?", options: ["A", "B"], recommended: "A", blocksTicketId: t.id });
    expect((await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "B, because it is simpler.", custom: true })).statusCode).toBe(200);
    const [w] = await c.db.select().from(wakesTable).where(and(eq(wakesTable.agentId, c.worker.id), eq(wakesTable.reason, "decision answered")));
    expect(w!.note).toContain("B, because it is simpler.");
    expect(w!.note).not.toContain("open_attachment");
  });
});
