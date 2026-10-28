import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, ticketDependencies, tickets } from "../src/db/schema.js";
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
    expect(list).toContain(`${ownerCard.id}: [question/owner] Which payment provider?`);
    expect(list).toContain(`${ceoCard!.id}: [question/ceo] A plan to approve`);
    // The CEO now sees cards it used to be kept from (BOS-149).
    expect(list).toContain(held!.id);
    expect(list).toContain("Raised by: Engineer");
    expect(list).toContain("Age:");
    expect(list).toContain("Score:");
    expect(list).toContain("Options: Stripe | Mollie (recommended: Stripe)");
    expect(list).toContain("What was tried first: Compared both providers");
    expect(list).toContain("Ship the app");
    // The owner's own queue is unchanged.
    const ownerQueue = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>;
    expect(ownerQueue.map((d) => d.id)).not.toContain(held!.id);
  });
});

describe("the CEO clears stale and duplicate cards (BOS-149)", () => {
  it("withdraws a card whose ticket is done, with a reason the owner can read", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Old work");
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "A stale question", options: ["A", "B"], recommended: "A", blocksTicketId: t.id, triedFirst: "Looked into this already and it needs a decision" });
    await c.work.updateTicket(t.id, { state: "done", overLimit: true });

    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: "short" } }))).toBe(true);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: d.id, note: "The ticket is finished, so this card no longer applies." } });
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
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: first.id, note: "The ticket is finished, so this card no longer applies." } }))).toBe(false);
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
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: stale!.id, note: "The ticket is finished, so this card no longer applies." } }))).toBe(false);
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

  it("caps the CEO's list and says how many cards were left out", async () => {
    const c = (ctx = await setup());
    for (let i = 0; i < 25; i++) {
      await c.db.insert(decisions).values({ companyId: c.company.id, kind: "question", question: `Question ${i}`, options: ["Got it"], recommendedOption: "Got it", tier: "ceo" });
    }
    const body = textOf(await (await c.mcp(c.ceo.id)).callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(body).toContain("5 more open cards are not shown; the list shows the top 20 by score.");
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
  it("answers a 'Got it' alert at the owner's tier with a logged reason", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Some work");
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

  it("refuses every owner-only kind on the server, even when the tool is bypassed", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Owner work");
    const owned = [
      { kind: "permission" as const, options: ["Allow once", "Deny"], context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID() } },
      { kind: "approval" as const, options: ["Approve", "Reject"], context: { type: "deploy", deployId: randomUUID() } },
      { kind: "question" as const, options: ["Deploy", "Not now"], context: { type: "self_deploy", target: "server", commit: "abc", fromCommit: "def" } },
      { kind: "question" as const, options: ["Hire", "Not now"], context: { type: "hire", proposal: { name: "X" }, byAgentId: c.ceo.id } },
      { kind: "question" as const, options: ["Apply the change", "Not now"], context: { type: "instructions", agentId: c.worker.id, instructions: "Be nice", byAgentId: c.ceo.id } },
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
