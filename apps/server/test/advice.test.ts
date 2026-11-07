import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

const MIN = 60_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
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
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
  const question = async () => {
    const t = await ticket("Pick a provider");
    const d = await built.decisions.raise({ companyId: company.id, agentId: worker.id, question: "Which one?", options: ["A", "B"], recommended: "A", blocksTicketId: t.id, triedFirst: "Looked at both and could not choose" });
    return { t, d };
  };
  return { ...built, db, close, req, company, ceo, worker, mcp, clients, ticket, question, advance: (ms: number) => (offset += ms) };
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const row = async (c: NonNullable<typeof ctx>, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const reissue = { outcome: "reissue", question: "Which payment provider: Stripe or Mollie?", options: ["Stripe", "Mollie"], recommended: "Stripe", triedFirst: "Compared fees and checked that neither needs a secret from us" };

describe("lessons the CEO raised itself", () => {
  it("the CEO can answer a lesson decision from its own review, but not its other own requests", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Add this lesson?", options: ["Add", "Edit", "Drop"], recommendedOption: "Add", tier: "ceo", raisedByAgentId: c.ceo.id, context: { type: "lesson", ticketId: randomUUID(), projectId: randomUUID(), projectName: "Customer app", lesson: "Keep tests fast." } })
      .returning();
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d!.id, answer: "Drop", note: "Too vague." } });
    expect(isError(r)).toBe(false);
    expect((await row(c, d!.id)).status).toBe("answered");
  });
});

describe("ask the CEO for advice", () => {
  it("keeps the decision open and answerable, and wakes the CEO with the note", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, { note: "What does A mean?" })).statusCode).toBe(200);
    expect((await row(c, d.id)).status).toBe("open");
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "asking", note: "What does A mean?" } });
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id));
    expect(w!.note).toContain("What does A mean?");
    expect(w!.note).toContain(d.id);
    // Pressing it twice is harmless: same state, one wake, one log line.
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, { note: "again" })).statusCode).toBe(200);
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "asking", note: "What does A mean?" } });
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).length).toBe(1);
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_advice_asked"))).length).toBe(1);
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, { note: "x".repeat(501) })).statusCode).toBe(400);
    // Still in the owner's queue.
    expect(((await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>).map((r) => r.id)).toContain(d.id);
  });

  it("reissue moves the blocker to the new decision and closes the original", async () => {
    const c = (ctx = await setup());
    const { t, d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    const ceo = await c.mcp(c.ceo.id);
    const out = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } }));
    expect(out).toMatch(/Reissued as decision/);
    const old = await row(c, d.id);
    expect(old.status).toBe("withdrawn");
    expect(old.answer).toBeNull();
    const newId = (old.context as { advice: { replacedBy: string } }).advice.replacedBy;
    const fresh = await row(c, newId);
    expect(fresh).toMatchObject({ status: "open", question: reissue.question, raisedByAgentId: c.worker.id });
    expect(fresh.context).toMatchObject({ triedFirst: reissue.triedFirst, advice: { state: "replacement", replaces: d.id } });
    const q = (await c.req("GET", "/api/decisions")).json() as Array<{ id: string; blocks: Array<{ ticketId: string }> }>;
    expect(q.map((r) => r.id)).toEqual([newId]);
    expect(q[0]!.blocks.map((b) => b.ticketId)).toEqual([t.id]);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("blocked");
    // The owner can see where it went.
    expect(((await c.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; advice: { replacedBy: string } }>)[0]).toMatchObject({ id: d.id, advice: { replacedBy: newId } });
    // Answering the new one frees the ticket and wakes the original asker.
    expect((await c.req("POST", `/api/decisions/${newId}/answer`, { answer: "Stripe" })).statusCode).toBe(200);
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("ready");
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_reissued"))).length).toBe(1);
  });

  it("a reissue is held to the raise_decision rules", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue, triedFirst: "n/a" } }))).toBe(true);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue, ownerMustDo: true } }))).toBe(true);
    expect((await row(c, d.id)).status).toBe("open");
  });

  it("handled settles a question and tells the owner; workers can't advise", async () => {
    const c = (ctx = await setup());
    const { t, d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    const worker = await c.mcp(c.worker.id);
    expect(isError(await worker.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, outcome: "handled", summary: "I did it myself, honest." } }))).toBe(true);
    const ceo = await c.mcp(c.ceo.id);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, outcome: "handled", summary: "Chose A because it is the cheaper plan." } }))).toMatch(/Handled/);
    const done = await row(c, d.id);
    expect(done).toMatchObject({ status: "answered", answer: "Handled by the CEO: Chose A because it is the cheaper plan." });
    expect(done.context).toMatchObject({ advice: { state: "handled" } });
    expect((await c.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("ready");
    const [w] = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "decision answered")));
    expect(w!.note).toContain("The CEO settled");
  });

  it("handled is refused for owner-only kinds", async () => {
    const c = (ctx = await setup());
    const ceo = await c.mcp(c.ceo.id);
    const owned = [
      { kind: "approval" as const, context: { type: "permission", plan: true }, options: ["Approve plan", "Keep planning"] },
      { kind: "question" as const, context: { type: "self_deploy", target: "server", commit: "abc", fromCommit: "def" }, options: ["Deploy", "Not now"] },
      { kind: "question" as const, context: { type: "question", steps: ["Open Settings", "Click Save"] }, options: ["Done", "Not now"] },
      { kind: "budget" as const, context: { type: "budget_limit", policyId: randomUUID() }, options: ["Raise it by half", "Leave it"] },
      { kind: "question" as const, context: { type: "hire", proposal: { name: "X" }, byAgentId: c.ceo.id }, options: ["Hire", "Not now"] },
      { kind: "question" as const, context: { type: "rule_proposal", rule: {} }, options: ["Add this rule", "Don't add"] },
      { kind: "approval" as const, context: { type: "deploy", deployId: randomUUID() }, options: ["Approve", "Reject"] },
      { kind: "approval" as const, context: { type: "risk_review", ticketId: randomUUID(), reviewer: "x" }, options: ["Approve and merge", "Send it back"] },
    ];
    for (const o of owned) {
      const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: o.kind, question: `Owner only ${o.context.type}`, options: o.options, recommendedOption: o.options[0]!, context: o.context }).returning();
      expect((await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, {})).statusCode).toBe(200);
      const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "handled", summary: "I decided this on the owner's behalf.", answer: o.options[0] } });
      expect(isError(r), o.context.type).toBe(true);
      expect((await row(c, d!.id)).status).toBe("open");
    }
    // A question the CEO raised itself can only be reissued.
    const own = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "CEO's own question?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Tried everything I could on my own" });
    await c.req("POST", `/api/decisions/${own.id}/ask-advice`, {});
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: own.id, outcome: "handled", summary: "I answered my own question.", answer: "Yes" } }))).toBe(true);
    expect((await row(c, own.id)).status).toBe("open");
  });

  it("rewrites a decision that isn't a plain question in place, keeping its id, options and context", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Hire a designer?", options: ["Approve", "Decline"], recommendedOption: "Approve", context: { type: "hire", marker: 1 } }).returning();
    expect((await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, {})).statusCode).toBe(200);
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, ...reissue } }))).toBe(false);
    const after = await row(c, d!.id);
    expect(after.status).toBe("open");
    expect(after.question).toBe(reissue.question);
    expect(after.options).toEqual(["Approve", "Decline"]);
    expect(after.context).toMatchObject({ type: "hire", marker: 1, advice: { state: "clarified", originalQuestion: "Hire a designer?" } });
    // Once clarified, the CEO can't act on it again.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, ...reissue } }))).toBe(true);
  });

  it("a reissue after the time ran out is refused and moves nothing", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    c.advance(200 * MIN);
    await c.req("POST", "/api/sweep");
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } }))).toBe(true);
    expect((await row(c, d.id)).status).toBe("open");
  });

  it("asks the CEO for advice on a permission request, and shows the advice on the card", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "permission",
        question: "Run dd?",
        options: ["Allow once", "Deny"],
        recommendedOption: "Deny",
        tier: "owner",
        context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), explain: { title: "Engineer wants to run a command", summary: "Only reads information", effect: "reads", command: "dd if=/tmp/session.db count=40" } },
      })
      .returning();
    expect((await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, {})).statusCode).toBe(200);
    const [w] = await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id));
    expect(w!.note).toContain("dd if=/tmp/session.db count=40");
    expect(w!.note).toContain("outcome advice");
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "advice", what: "Copies part of a database file into another file.", needed: "No, this ticket doesn't need it.", recommendation: "deny", why: "It reads data the ticket can get another way." } });
    expect(textOf(r)).toMatch(/Advice saved/);
    const after = await row(c, d!.id);
    expect(after.status).toBe("open");
    expect(after.context).toMatchObject({ advice: { state: "advised", recommendation: "deny", why: "It reads data the ticket can get another way." } });
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_advised"))).length).toBe(1);
    // An owner-tier permission request stays the owner's: the CEO can advise, not settle it.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "handled", summary: "I decided this on the owner's behalf.", answer: "Allow once" } }))).toBe(true);
    expect((await row(c, d!.id)).status).toBe("open");
  });

  it("settles a permission request the CEO is allowed to settle", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "permission",
        question: "Clean up /tmp?",
        options: ["Allow once", "Deny"],
        recommendedOption: "Allow once",
        tier: "ceo",
        context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), tempCleanup: true, explain: { title: "Engineer wants to run a command", summary: "Deletes temp files", effect: "deletes", command: "rm /tmp/probe" } },
      })
      .returning();
    expect((await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, {})).statusCode).toBe(200);
    const ceo = await c.mcp(c.ceo.id);
    expect(textOf(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "handled", summary: "It only deletes its own temp file, so allow it.", answer: "Allow once" } }))).toMatch(/Handled/);
    expect(await row(c, d!.id)).toMatchObject({ status: "answered", answer: "Allow once" });
  });

  it("a skill card can't be put to the CEO, since the CEO proposed it (BOS-168)", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "skill", question: "Add this skill?", options: ["Add", "Reject"], recommendedOption: "Add", raisedByAgentId: c.ceo.id, context: { type: "skill", proposalId: randomUUID() } }).returning();
    const r = await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, {});
    expect(r.statusCode).toBe(422);
    expect((r.json() as { message: string }).message).toMatch(/ask the CEO about it in chat/);
    expect((await row(c, d!.id)).context).toEqual({ type: "skill", proposalId: expect.any(String) });
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).length).toBe(0);
  });

  it("a skill card is refused a reissue, and the card is left exactly as it was (BOS-168)", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "skill", question: "Add this skill?", options: ["Add", "Reject"], recommendedOption: "Add", raisedByAgentId: c.ceo.id, context: { type: "skill", proposalId: randomUUID(), advice: { state: "asking", askedAt: new Date().toISOString() } } })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, ...reissue } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/proposed this skill/);
    expect((await row(c, d!.id)).status).toBe("open");
    expect((await row(c, d!.id)).question).toBe("Add this skill?");
    expect((await row(c, d!.id)).options).toEqual(["Add", "Reject"]);
  });

  it("a timeout after the CEO has advised changes nothing", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    const ceo = await c.mcp(c.ceo.id);
    await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } });
    c.advance(200 * MIN);
    await c.req("POST", "/api/sweep");
    expect((await row(c, d.id)).status).toBe("withdrawn");
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "reissued" } });
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_advice_timed_out"))).length).toBe(0);
  });

  it("logs the CEO's run", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    const ceo = await c.mcp(c.ceo.id);
    await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } });
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_reissued")))[0]!.summary).toMatch(/CEO run [0-9a-f-]{36}/);
  });

  it("returns to the owner when the CEO doesn't act in time (default 2 hours, a setting)", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, { note: "unclear" });
    c.advance(119 * MIN);
    await c.req("POST", "/api/sweep");
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "asking" } });
    c.advance(2 * MIN);
    await c.req("POST", "/api/sweep");
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "timed_out" } });
    expect((await row(c, d.id)).status).toBe("open");
    expect((await c.db.select().from(activity).where(eq(activity.kind, "decision_advice_timed_out"))).length).toBe(1);
    // Too late for the CEO, but the owner can ask again.
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } }))).toBe(true);
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {})).statusCode).toBe(200);
    // The limit is the company's setting.
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { adviceTimeoutMinutes: 10 })).statusCode).toBe(200);
    c.advance(11 * MIN);
    await c.req("POST", "/api/sweep");
    expect((await row(c, d.id)).context).toMatchObject({ advice: { state: "timed_out" } });
  });

  it("the owner answering meanwhile wins", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {});
    expect((await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "B" })).statusCode).toBe(200);
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/owner answered it first/);
    expect(await row(c, d.id)).toMatchObject({ status: "answered", answer: "B" });
    expect((await c.db.select().from(decisions)).length).toBe(1);
    // And asking about an answered decision finds nothing.
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {})).statusCode).toBe(404);
  });
});

// BOS-233, item 3: the CEO can add advice to a card the owner can see without the owner asking first,
// and can answer a non-permission card with a plain note. Advice never settles the card.
describe("the CEO advises without being asked (BOS-233)", () => {
  it("advises an owner-rung permission card unasked, and the owner still decides", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "permission",
        question: "Run dd?",
        options: ["Allow once", "Deny"],
        recommendedOption: "Deny",
        tier: "owner",
        context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), explain: { title: "Engineer wants to run a command", summary: "Only reads information", effect: "reads", command: "dd if=/tmp/session.db count=40" } },
      })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "advice", what: "Copies part of a database file into another file.", needed: "No, this ticket doesn't need it.", recommendation: "deny", why: "It reads data the ticket can get another way." } });
    expect(textOf(r)).toMatch(/Advice saved/);
    const after = await row(c, d!.id);
    expect(after.status).toBe("open");
    expect(after.tier).toBe("owner");
    expect(after.context).toMatchObject({ advice: { state: "advised", recommendation: "deny" } });
  });

  it("advises a non-permission card with a plain note, when the owner asked", async () => {
    const c = (ctx = await setup());
    const { d } = await c.question();
    expect((await c.req("POST", `/api/decisions/${d.id}/ask-advice`, {})).statusCode).toBe(200);
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, outcome: "advice", why: "Either is fine; Stripe is the one the team already uses." } });
    expect(isError(r)).toBe(false);
    expect(textOf(r)).toMatch(/Advice saved/);
    const after = await row(c, d.id);
    expect(after.status).toBe("open");
    expect(after.context).toMatchObject({ advice: { state: "advised", summary: expect.stringContaining("Stripe") } });
  });

  it("a permission card the CEO raised itself can't be advised by the CEO", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db
      .insert(decisions)
      .values({
        companyId: c.company.id,
        kind: "permission",
        question: "Run the deploy?",
        options: ["Allow once", "Deny"],
        recommendedOption: "Deny",
        tier: "owner",
        raisedByAgentId: c.ceo.id,
        context: { type: "permission", runnerId: randomUUID(), runId: randomUUID(), requestId: randomUUID(), explain: { title: "The CEO wants to run a command", summary: "Deploys", effect: "changes", command: "scripts/deploy.sh" } },
      })
      .returning();
    const ceo = await c.mcp(c.ceo.id);
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d!.id, outcome: "advice", what: "It deploys the release to staging.", needed: "Yes, the release needs it.", recommendation: "allow", why: "It is the normal deploy step." } }))).toBe(true);
    expect((await row(c, d!.id)).status).toBe("open");
  });
});
