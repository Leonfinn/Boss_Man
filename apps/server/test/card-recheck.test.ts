// BOS-1193 (DR-054): a card the owner sees has been checked. Boss Man closes a dead card by itself (one ordered validity
// table), and any other flagged card is "being re-checked": hidden from the owner, its author has 30 minutes, then the CEO has
// 30 more, then it returns to the owner saying plainly who failed to re-check it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runs, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { closeInvalidCards, RECHECK_AUTHOR_MS, RECHECK_CEO_MS } from "../src/services/card-validity.js";
import { ownerActed, recheckDeadlines, STATE_CHANGE_GRACE_MS, ticketStateChanged } from "../src/services/stale-requests.js";

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
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id })).json() as { id: string };
  return { ...built, db, close, company, ceo, worker, mcp, clients, ticket, req, project };
}
type S = Awaited<ReturnType<typeof setup>>;

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const cardOf = async (c: S, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
const ask = (c: S, question: string, ticketId?: string, extra: Record<string, unknown> = {}) =>
  c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question, options: ["Yes", "No"], recommended: "Yes", ...(ticketId ? { blocksTicketId: ticketId } : {}), triedFirst: "Looked", ...extra });
const plan = (c: S, ticketId: string, text = "the plan") => c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: `Plan: ${text}`, options: ["Approve plan", "Keep planning"], recommended: "Approve plan", blocksTicketId: ticketId, triedFirst: "Investigated", plan: text });
const wakeLog = () => {
  const wakes: Array<{ agentId: string; note: string }> = [];
  return { wakes, wake: async (input: { agentId: string; note: string }) => (wakes.push(input), { id: randomUUID(), status: "queued" }) };
};
/** An ExitPlanMode-shaped plan card (kind approval, type permission) whose run is alive or ended. */
async function exitPlanCard(c: S, ticketId: string, runEnded: boolean) {
  const runId = randomUUID();
  const [tk] = await c.db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId));
  await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId, startedAt: new Date(Date.now() - 3_600_000), ...(runEnded ? { endedAt: new Date() } : {}) });
  const [d] = await c.db.insert(decisions).values({
    companyId: c.company.id, kind: "approval", question: `Approve Engineer's plan for "${tk!.title}"?`, options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan", raisedByAgentId: c.worker.id,
    context: { type: "permission", runnerId: randomUUID(), runId, requestId: randomUUID(), plan: true, ticketId, planText: "x" },
  }).returning();
  return d!;
}

describe("the validity table closes a dead card by itself (BOS-1193)", () => {
  it("closes a plan card whose ticket is already in review, but not a live-run one, and records the reason", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Built already");
    const ended = await exitPlanCard(c, t.id, true);
    const live = await exitPlanCard(c, t.id, false);
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    expect(await closeInvalidCards(c.db)).toBe(1);
    const closed = await cardOf(c, ended.id);
    expect(closed.status).toBe("withdrawn");
    expect(closed.answer).toBeNull(); // never an answer
    expect((closed.context as { withdrawn: { by: string; note: string } }).withdrawn).toMatchObject({ by: "system", note: expect.stringMatching(/work already built/) });
    expect((await cardOf(c, live.id)).status).toBe("open"); // the run is waiting on it
  });

  it("closes a card whose ticket is done or merged, and frees the ticket it held", async () => {
    const c = (ctx = await setup());
    const done = await c.ticket("Finished");
    const merged = await c.ticket("Merged");
    const q1 = await ask(c, "Which colour for the footer?", done.id);
    const q2 = await ask(c, "Is the second approach fine?", merged.id);
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, done.id));
    await c.db.update(tickets).set({ mergeCommit: "a".repeat(40) }).where(eq(tickets.id, merged.id));
    expect(await closeInvalidCards(c.db)).toBe(2);
    expect((await cardOf(c, q1.id)).status).toBe("withdrawn");
    expect((await cardOf(c, q2.id)).context).toMatchObject({ withdrawn: { by: "system", note: expect.stringMatching(/is merged/) } });
  });

  it("leaves a card that checks a merged ticket's after-merge criterion alone", async () => {
    const c = (ctx = await setup());
    const t = await ask(c, "Did the live check pass?", undefined, { criterionIndexes: [0], optionVerdicts: { Yes: "pass", No: "fail" } });
    const tk = await c.ticket("Merged");
    await c.db.update(decisions).set({ context: { ...(await cardOf(c, t.id)).context as object, ticketId: tk.id } }).where(eq(decisions.id, t.id));
    await c.db.update(tickets).set({ mergeCommit: "b".repeat(40) }).where(eq(tickets.id, tk.id));
    expect(await closeInvalidCards(c.db)).toBe(0);
  });

  it("closes a plan card whose plan was approved on another card, and never touches that approval (BOS-371)", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Approved elsewhere");
    const card = await plan(c, t.id);
    const approvedAt = new Date(Date.now() + 1000);
    await c.db.update(tickets).set({ planApprovedAt: approvedAt }).where(eq(tickets.id, t.id));
    expect(await closeInvalidCards(c.db)).toBe(1);
    expect((await cardOf(c, card.id)).context).toMatchObject({ withdrawn: { note: expect.stringMatching(/already approved on another card/) } });
    const [after] = await c.db.select({ at: tickets.planApprovedAt }).from(tickets).where(eq(tickets.id, t.id));
    expect(after!.at?.getTime()).toBe(approvedAt.getTime());
  });

  it("closes the older of two plan cards from different authors, the old rule only knew one author per ticket", async () => {
    const c = (ctx = await setup());
    const t = await ask(c, "x"); // a throwaway card so the company has a decision
    void t;
    const tk = await c.ticket("Reassigned");
    const older = await plan(c, tk.id, "first");
    const newer = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "Plan: second", options: ["Approve plan", "Keep planning"], recommended: "Approve plan", blocksTicketId: tk.id, triedFirst: "Investigated", plan: "second" });
    // BOS-1219: the note names the replacing card and the author of the newer plan.
    expect((await cardOf(c, older.id)).context).toMatchObject({ withdrawn: { note: expect.stringMatching(new RegExp(`^Superseded by card ${newer.id} \\(newer plan from [^,]+, \\d{4}-`)) } });
    // The same facts as fields, so a screen can say "by a newer plan from <name>" without printing the id.
    expect((await cardOf(c, older.id)).context).toMatchObject({ withdrawn: { newer: { id: newer.id, author: expect.any(String), at: expect.stringMatching(/^\d{4}-/) } } });
  });

  it("BOS-1219: a new plan on an approved ticket says it amends the approved plan, and the approval stays", async () => {
    const c = (ctx = await setup());
    const tk = await c.ticket("Amended");
    const approvedAt = new Date(Date.now() - 60_000);
    await c.db.update(tickets).set({ planApprovedAt: approvedAt, plan: "first" }).where(eq(tickets.id, tk.id));
    const amend = await plan(c, tk.id, "second");
    expect((await cardOf(c, amend.id)).question).toContain(`This amends the approved plan of ${approvedAt.toISOString()}`);
    const [after] = await c.db.select({ at: tickets.planApprovedAt, plan: tickets.plan }).from(tickets).where(eq(tickets.id, tk.id));
    expect(after!.at?.getTime()).toBe(approvedAt.getTime());
    expect(after!.plan).toBe("first"); // the approved plan text is not replaced
    // a first plan carries no such line
    const fresh = await c.ticket("First plan");
    expect((await cardOf(c, (await plan(c, fresh.id)).id)).question).not.toContain("amends");
  });

  // BOS-1247: Claude's plan-mode card (ExitPlanMode, a permission card carrying the plan) is the path most agents use;
  // submit_plan refuses an already-approved plan, so this is the only path that reaches the amend line.
  async function planModeCard(c: S, ticketId: string, planText: string) {
    const runId = randomUUID();
    await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId, startedAt: new Date() });
    const requestId = randomUUID();
    await c.decisions.onPermissionRequest({ id: randomUUID(), companyId: c.company.id }, { type: "run.permission_request", runId, requestId, title: "Approve Plan", kind: "switch_mode", rawInput: {}, optionKinds: ["allow_once", "reject_once"], detail: planText } as never);
    const [card] = await c.db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${requestId}`));
    return card!;
  }

  it("BOS-1247: a plan-mode card on an approved ticket says it amends the approved plan, and the approval and plan text stay", async () => {
    const c = (ctx = await setup());
    const tk = await c.ticket("Amended by plan mode");
    const approvedAt = new Date(Date.now() - 60_000);
    await c.db.update(tickets).set({ planApprovedAt: approvedAt, plan: "first" }).where(eq(tickets.id, tk.id));
    const card = await planModeCard(c, tk.id, "second");
    expect((card.context as { plan?: boolean }).plan).toBe(true); // it is the plan-mode card, not a submitted plan
    expect(card.question).toContain(`This amends the approved plan of ${approvedAt.toISOString()}`);
    const [after] = await c.db.select({ at: tickets.planApprovedAt, plan: tickets.plan }).from(tickets).where(eq(tickets.id, tk.id));
    expect(after!.at?.getTime()).toBe(approvedAt.getTime());
    expect(after!.plan).toBe("first");
  });

  it("BOS-1247: a plan-mode card on a ticket with no approved plan has no amend line", async () => {
    const c = (ctx = await setup());
    const tk = await c.ticket("First plan by plan mode");
    const card = await planModeCard(c, tk.id, "first");
    expect((card.context as { plan?: boolean }).plan).toBe(true);
    expect(card.question).not.toContain("amends");
  });

  it("BOS-1219: the owner's open 'Ask the CEO' request moves to the newer plan card", async () => {
    const c = (ctx = await setup());
    const tk = await c.ticket("Advice moves");
    const older = await plan(c, tk.id, "first");
    const advice = { state: "asking", askedAt: new Date().toISOString(), note: "Why this order?" };
    await c.db.update(decisions).set({ context: { ...((await cardOf(c, older.id)).context as object), advice } }).where(eq(decisions.id, older.id));
    const newer = await plan(c, tk.id, "second");
    expect((await cardOf(c, older.id)).status).toBe("withdrawn");
    expect((await cardOf(c, newer.id)).context).toMatchObject({ advice });
  });

  it("BOS-1219: a card of another kind on the ticket is left alone, and an already-answered plan card is not touched", async () => {
    const c = (ctx = await setup());
    const tk = await c.ticket("Only plans");
    const q = await ask(c, "Which colour for the footer?", tk.id);
    const answered = await plan(c, tk.id, "first");
    await c.db.update(decisions).set({ status: "answered", answer: "Keep planning", answeredAt: new Date() }).where(eq(decisions.id, answered.id));
    await plan(c, tk.id, "second");
    expect((await cardOf(c, q.id)).status).toBe("open");
    expect((await cardOf(c, answered.id)).status).toBe("answered");
  });
});

describe("question cards: replaced only when asked, or repeated (BOS-1193)", () => {
  it("keeps two different questions from one agent on one ticket, and supersedes a repeated one", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Two questions");
    const a = await ask(c, "Which colour should the footer be?", t.id);
    const b = await ask(c, "Should we also move the sign-up button to the header?", t.id);
    expect((await cardOf(c, a.id)).status).toBe("open");
    expect((await cardOf(c, b.id)).status).toBe("open");
    const again = await ask(c, "Which colour should the footer be?", t.id);
    expect((await cardOf(c, a.id)).context).toMatchObject({ withdrawn: { by: "system", note: `superseded by ${again.id}` } });
    expect((await cardOf(c, b.id)).status).toBe("open");
  });

  it("raise_decision replaces closes the old card as superseded in the same call; another agent's card is refused", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Corrected");
    const old = await ask(c, "Shall I wait for the build?", t.id);
    const mcp = await c.mcp(c.worker.id);
    const r = await mcp.callTool({ name: "raise_decision", arguments: { replaces: old.id, question: "Shall I wait for the new build?", options: ["Wait", "Go"], recommended: "Wait", triedFirst: "Checked the live state", blocksTicketId: t.id } });
    expect(isError(r)).toBe(false);
    const newId = /Decision ([0-9a-f-]{36})/.exec(textOf(r))![1]!;
    expect((await cardOf(c, old.id)).context).toMatchObject({ withdrawn: { by: "system", note: `superseded by ${newId}` } });
    expect((await cardOf(c, newId)).status).toBe("open");
    // someone else's card
    const ceoOwn = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "The CEO's own question", options: ["A", "B"], recommended: "A", triedFirst: "Looked" });
    const bad = await mcp.callTool({ name: "raise_decision", arguments: { replaces: ceoOwn.id, question: "Take over that question", options: ["A", "B"], recommended: "A", triedFirst: "Looked" } });
    expect(isError(bad)).toBe(true);
    expect((await cardOf(c, ceoOwn.id)).status).toBe("open");
  });
});

describe("being re-checked (BOS-1193)", () => {
  it("hides a flagged card from the owner's list, wakes the author, and a confirm brings it back with nothing on its face", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a colour");
    const card = await ask(c, "Which colour for the footer?", t.id);
    const log = wakeLog();
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", wake: log.wake, now: new Date() });
    const flagged = await cardOf(c, card.id);
    expect(flagged).toMatchObject({ status: "open", recheckStage: "author" });
    expect(log.wakes.filter((w) => w.agentId === c.worker.id)).toHaveLength(1);
    // The Decisions list folds it into "waiting", and says who checks it.
    const listed = ((await c.decisions.queue({ includeAll: true })) as unknown as Array<{ id: string; waiting?: string }>).find((d) => d.id === card.id);
    expect(listed).toMatchObject({ waiting: expect.stringMatching(/Being re-checked by Engineer/) });
    // The author confirms.
    const mcp = await c.mcp(c.worker.id);
    const short = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: card.id, action: "confirm", checked: "ok" } });
    expect(isError(short)).toBe(true); // a real line is needed
    const ok = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: card.id, action: "confirm", checked: "Read the ticket and the owner's answers; the colour is still undecided." } });
    expect(isError(ok)).toBe(false);
    const after = await cardOf(c, card.id);
    expect(after).toMatchObject({ status: "open", staleAt: null, staleReason: null, recheckStage: null, recheckCount: 1, recheckedByAgentId: c.worker.id });
    expect(after.recheckNote).toMatch(/still undecided/);
    expect(after.question).toBe(flagged.question); // no note on the card itself
  });

  it("refuses a confirm for a card Boss Man can see is dead, and from someone else", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a colour");
    const card = await ask(c, "Which colour for the footer?", t.id);
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", now: new Date() });
    const stranger = await (await c.req("POST", `/api/companies/${c.company.id}/agents`, { name: "Other" })).json() as { id: string };
    const sm = await c.mcp(stranger.id);
    expect(isError(await sm.callTool({ name: "withdraw_decision", arguments: { decisionId: card.id, action: "confirm", checked: "Looks fine to me, honestly." } }))).toBe(true);
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    const mcp = await c.mcp(c.worker.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: card.id, action: "confirm", checked: "Read the ticket, nothing changed." } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/no longer valid/);
    expect((await cardOf(c, card.id)).recheckStage).toBe("author");
  });

  it("closes a card Boss Man can check instead of flagging it, and wakes nobody for it", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Already finished");
    const card = await ask(c, "Which colour for the footer?", t.id);
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    const log = wakeLog();
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "a ticket it is about merged", wake: log.wake, now: new Date() });
    expect((await cardOf(c, card.id)).status).toBe("withdrawn");
    expect(log.wakes.filter((w) => w.agentId === c.worker.id)).toHaveLength(0);
  });

  it("moves to the CEO after 30 minutes with one wake listing the cards, and lapses 30 minutes later saying who didn't re-check", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a colour");
    const t2 = await c.ticket("Pick a font");
    const a = await ask(c, "Which colour for the footer?", t.id);
    const b = await ask(c, "Which font for the headings?", t2.id);
    const t0 = new Date();
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id, t2.id], reason: "the owner wrote on this ticket", now: t0 });
    const early = wakeLog();
    expect((await recheckDeadlines(c.db, { wake: early.wake, now: new Date(t0.getTime() + RECHECK_AUTHOR_MS - 1000) })).movedToCeo).toHaveLength(0);
    const log = wakeLog();
    const moved = await recheckDeadlines(c.db, { wake: log.wake, now: new Date(t0.getTime() + RECHECK_AUTHOR_MS + 1000) });
    expect(moved.movedToCeo.sort()).toEqual([a.id, b.id].sort());
    expect(log.wakes).toHaveLength(1); // one wake for both cards
    expect(log.wakes[0]!.agentId).toBe(c.ceo.id);
    expect(log.wakes[0]!.note).toContain(a.id);
    expect(log.wakes[0]!.note).toContain(b.id);
    expect((await cardOf(c, a.id)).recheckStage).toBe("ceo");
    // Not yet lapsed
    expect((await recheckDeadlines(c.db, { now: new Date(t0.getTime() + RECHECK_AUTHOR_MS + RECHECK_CEO_MS - 5000) })).lapsed).toHaveLength(0);
    const lapsed = await recheckDeadlines(c.db, { now: new Date(t0.getTime() + RECHECK_AUTHOR_MS + RECHECK_CEO_MS + 5000) });
    expect(lapsed.lapsed.sort()).toEqual([a.id, b.id].sort());
    expect((await cardOf(c, a.id))).toMatchObject({ status: "open", recheckStage: "lapsed" });
    // A lapsed card is not flagged again.
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", now: new Date(t0.getTime() + 4 * 3_600_000) });
    expect((await cardOf(c, a.id)).recheckStage).toBe("lapsed");
  });

  it("goes to the CEO at once when the author's wake is dropped, or the author is the CEO", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Dropped");
    const card = await ask(c, "Which colour for the footer?", t.id);
    const log = wakeLog();
    const dropping = async (input: { agentId: string; note: string }) => (input.agentId === c.ceo.id ? log.wake(input) : { status: "dropped" });
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", wake: dropping, now: new Date() });
    expect((await cardOf(c, card.id)).recheckStage).toBe("ceo");
    expect(log.wakes.some((w) => w.agentId === c.ceo.id && w.note.includes(card.id))).toBe(true);

    const t2 = await c.ticket("CEO's own");
    const own = await c.decisions.raise({ companyId: c.company.id, agentId: c.ceo.id, question: "CEO question about this?", options: ["A", "B"], recommended: "A", blocksTicketId: t2.id, triedFirst: "Looked" });
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t2.id], reason: "the owner wrote on this ticket", now: new Date() });
    expect((await cardOf(c, own.id)).recheckStage).toBe("ceo");
  });

  it("the CEO can confirm or withdraw a card at their stage; the Board and the list fold a hidden card, urgent cards stay", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Pick a colour");
    const card = await ask(c, "Which colour for the footer?", t.id);
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", now: new Date() });
    // The Board: no owner action on the ticket, but it says who is re-checking.
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { cards?: unknown };
    const flat = JSON.stringify(board);
    expect(flat).toContain('"recheckingBy":"Engineer"');
    expect(flat).not.toContain('"ownerQuestion":"Which colour');
    const ceo = await c.mcp(c.ceo.id);
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "recheck", id: card.id, note: "Checked the ticket and answers; still open." } });
    expect(isError(ok)).toBe(false);
    expect((await cardOf(c, card.id)).recheckStage).toBeNull();
    // Flag again and let the CEO withdraw it.
    await c.db.update(decisions).set({ staleAt: new Date(), recheckStage: "ceo", recheckStageAt: new Date() }).where(eq(decisions.id, card.id));
    const w = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: card.id, note: "Duplicate of the decision already answered.", replacedBy: "none" } });
    expect(isError(w)).toBe(false);
    expect((await cardOf(c, card.id)).status).toBe("withdrawn");
  });

  it("a card confirmed once is not flagged again by the same old state change, and one confirmed twice goes straight to the CEO", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Moved around");
    const card = await ask(c, "Which colour for the footer?", t.id);
    const later = new Date(Date.now() + 10 * 60_000);
    await c.db.update(tickets).set({ stateChangedAt: later }).where(eq(tickets.id, t.id));
    const sweepAt = new Date(later.getTime() + STATE_CHANGE_GRACE_MS);
    await ticketStateChanged(c.db, { now: sweepAt });
    expect((await cardOf(c, card.id)).recheckStage).toBe("author");
    const mcp = await c.mcp(c.worker.id);
    expect(isError(await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: card.id, action: "confirm", checked: "Checked: the question is still open." } }))).toBe(false);
    // The clock in this test runs ahead of the real one; stand the confirmation at the sweep's time.
    await c.db.update(decisions).set({ recheckedAt: sweepAt }).where(eq(decisions.id, card.id));
    // Two sweeps later: still not flagged.
    await ticketStateChanged(c.db, { now: new Date(sweepAt.getTime() + 60_000) });
    await ticketStateChanged(c.db, { now: new Date(sweepAt.getTime() + 120_000) });
    expect((await cardOf(c, card.id)).staleAt).toBeNull();
    // Confirmed twice within a day, then flagged by a fresh event: straight to the CEO.
    await c.db.update(decisions).set({ recheckCount: 2, recheckedAt: new Date() }).where(eq(decisions.id, card.id));
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", now: new Date() });
    expect((await cardOf(c, card.id)).recheckStage).toBe("ceo");
  });
});

describe("who can withdraw a plan card (BOS-1193)", () => {
  it("the CEO can withdraw an ended-run plan card but not a live-run one; the author can take back an ended-run one", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Plan");
    const live = await exitPlanCard(c, t.id, false);
    const ended = await exitPlanCard(c, t.id, true); // newer, so nothing supersedes it
    const ceo = await c.mcp(c.ceo.id);
    const refused = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: live.id, note: "This plan is a duplicate of another one." } });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/live run/);
    const worker = await c.mcp(c.worker.id);
    expect(isError(await worker.callTool({ name: "withdraw_decision", arguments: { decisionId: live.id } }))).toBe(true);
    // Not being re-checked, not stale, not a duplicate: still the owner's.
    expect(isError(await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: ended.id, note: "I would rather not see this one." } }))).toBe(true);
    // Being re-checked (the owner wrote on the ticket): the CEO settles it, even though it is a permission-type plan card.
    await ownerActed(c.db, { companyId: c.company.id, ticketIds: [t.id], reason: "the owner wrote on this ticket", now: new Date() });
    expect((await cardOf(c, ended.id)).recheckStage).toBe("author");
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "withdraw", id: ended.id, note: "This plan is a duplicate; the work moved on.", replacedBy: "none" } });
    expect(isError(ok)).toBe(false);
    expect((await cardOf(c, ended.id)).status).toBe("withdrawn");
    const second = await exitPlanCard(c, t.id, true);
    expect(isError(await worker.callTool({ name: "withdraw_decision", arguments: { decisionId: second.id, reason: "Replaced by a better plan, so this older plan is no longer needed.", replacedBy: "none" } }))).toBe(false);
  });
});

describe("an owner answer racing a close leaves one outcome (BOS-1193)", () => {
  it("does not close or flag a card the owner has already answered", async () => {
    const c = (ctx = await setup());
    const t = await c.ticket("Race");
    const card = await ask(c, "Which colour for the footer?", t.id);
    await c.decisions.answer(card.id, "Yes");
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    expect(await closeInvalidCards(c.db)).toBe(0);
    expect((await cardOf(c, card.id)).status).toBe("answered");
  });
});
