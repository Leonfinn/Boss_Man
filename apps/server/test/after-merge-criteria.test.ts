// "On a real host" criteria (DR-024 #5): a check only the live host can settle must not bounce rounds of
// review. Each test here fails on the old code and passes with the after-merge mark.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REVIEW_POLICY, afterMergeLint, carryFailedOver, criteriaForCard, failedAfterMerge, isAfterMerge, mentionsCriterion, missingVerdicts, readCriteria, readVerdicts, unreportedAfterMerge } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, reviewRequests, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { landingText } from "../src/services/review.js";
import { type StandInReplies, standInRunner } from "./helpers/stand-in-runner.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

/** One database and server for the file: opening them is most of a test's cost (BOS-663). */
async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

/** Each test gets its own company, agent and project on that server, so nothing one test makes reaches another. */
async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  // Company names are unique on a server, so each test's company is numbered.
  const co = (await req("POST", "/api/companies", { name: `App Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const ticket = async (patch: Record<string, unknown> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Rate limiting", systemState: "in_progress", ...patch }).returning())[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return {
    ...built,
    db,
    req,
    co,
    dev,
    project,
    ticket,
    agent,
    row: async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!,
    done: async () => {
      await Promise.all(clients.map((c) => c.close()));
    },
  };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

/**
 * What a merge asks the runner, answered as a clean branch with one commit that merges as `commit`. The
 * stand-in refuses anything else at once, and each merge test checks nothing was refused (BOS-663).
 */
const mergeReplies = (commit: string): StandInReplies => ({
  "workspace.diff": { baseCommit: "0".repeat(40), head: "1".repeat(40), commits: [{ sha: "1".repeat(40), subject: "The change" }], files: [{ path: "src/health.ts", added: 3, removed: 0 }], diff: "", truncated: false },
  "workspace.verify": { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 },
  "workspace.merge": { status: "merged", commit },
  "workspace.carried": { carried: [] },
  "workspace.migrations": { needed: false, reason: "No other branch uses this ticket's migration numbers." },
});

const BEFORE = "Health check returns 200";
const LIVE = { text: "Answers from the owner's Tailscale name on a real host", after: "merge" as const };

// BOS-575: BOS-525 merged with "3 fail: timing measured after merge (owner accepted, follow-up ticket)",
// closed as done, and its measurement went to a bare, unowned hand-made ticket (BOS-542).
const SLOTS = ["Where the check slot count is set is stated on the ticket", "Slot count is configurable (default 1) and 2 slots run two checks at once, with a test", "A full check with 2 slots running still finishes inside the run limit (timing shown)", "No host-specific values", "check-quick passes"];
const SLOTS_NOTE = "Owner approved merging with setting off, measuring afterwards. 1 pass; 2 pass; 3 fail: timing measured after merge (owner accepted, follow-up ticket); 4 pass; 5 pass: typechecks pass by hand, merge gate runs tests.";

// The rules alone: no server or database, so these don't pay for a fresh app each (BOS-663).
describe("after-merge criteria: the rules", () => {
  it("tells the two kinds apart and reads verdicts by the criterion's words", () => {
    expect(isAfterMerge(LIVE)).toBe(true);
    expect(isAfterMerge(BEFORE)).toBe(false);
    const rows = readVerdicts([BEFORE, LIVE], "Health check returns 200 pass");
    expect(rows.map((r) => r.verdict)).toEqual(["pass", null]);
    expect(missingVerdicts([BEFORE, LIVE], "Health check returns 200 pass")).toEqual([LIVE.text]);
    expect(missingVerdicts([BEFORE, LIVE], "Health check returns 200 pass", "before")).toEqual([]);
    expect(unreportedAfterMerge([BEFORE, LIVE], `Health check returns 200 pass. ${LIVE.text} pass.`)).toEqual([]);
    expect(unreportedAfterMerge([BEFORE, LIVE], "Health check returns 200 pass")).toEqual([LIVE.text]);
  });

  it("warns, without refusing, when a criterion reads like a live check but isn't marked after merge", () => {
    const warned = afterMergeLint([BEFORE, "The owner confirms it on a real host"]);
    expect(warned).toContain("on a real host");
    expect(warned).toMatch(/warning only/i);
    expect(afterMergeLint([BEFORE, "The owner confirms it on a real host", { text: "Checked after this merge", after: "merge" }])).toBe(warned);
    expect(afterMergeLint([BEFORE])).toBe("");
    // The marked one itself is not warned about.
    expect(afterMergeLint([{ text: "The owner confirms it on a real host", after: "merge" }])).toBe("");
  });

  it("a criterion still at fail when the work merges is carried over as an after-merge check, and a later pass settles it", () => {
    expect(carryFailedOver(SLOTS, "1 pass; 2 pass; 3 pass; 4 pass; 5 pass")).toBeNull();
    const carry = carryFailedOver(SLOTS, SLOTS_NOTE)!;
    expect(carry.carried).toEqual([SLOTS[2]]);
    expect(carry.criteria[2]).toEqual({ text: SLOTS[2], after: "merge" });
    expect(carry.criteria.filter(isAfterMerge)).toHaveLength(1);
    // Before the fix the merged ticket had nothing left to show (a fail is a verdict), so it closed.
    expect(unreportedAfterMerge(SLOTS, SLOTS_NOTE)).toEqual([]);
    expect(unreportedAfterMerge(carry.criteria, carry.note)).toEqual([SLOTS[2]]);
    // The passes are kept, and the stale fail is gone, so the measurement's pass isn't outvoted.
    expect(readVerdicts(carry.criteria, carry.note).map((r) => r.verdict)).toEqual(["pass", "pass", null, "pass", "pass"]);
    const done = `${carry.note}\n3 pass: two checks side by side took 41 and 44 minutes`;
    expect(unreportedAfterMerge(carry.criteria, done)).toEqual([]);
    expect(failedAfterMerge(carry.criteria, done)).toEqual([]);
    expect(failedAfterMerge(carry.criteria, `${carry.note}\n3 fail: 71 minutes, over the limit`)).toEqual([SLOTS[2]]);
  });

  it("works out which after-merge criteria a card is about from its question and options (BOS-963)", () => {
    const SHOT = { text: "Screenshot of the conflict message at the owner's 1667px width on the ticket page", after: "merge" as const };
    const other = { text: "Answers from the owner's Tailscale name on a real host", after: "merge" as const };
    const list = [BEFORE, SHOT, other];
    // A card whose question and options are worded differently but name the check still matches it.
    expect(criteriaForCard(list, "The screenshot at 1667px is ready: does the ticket page look right?", [])).toEqual([1]);
    // The options count too.
    expect(criteriaForCard(list, "Did it work?", ["Yes, the real host answers from the Tailscale name", "No"])).toEqual([2]);
    // A card that names nothing settles nothing by itself.
    expect(criteriaForCard(list, "How did the whole thing feel to use?", ["Fine", "Not fine"])).toEqual([]);
    // A before-merge criterion is never picked up, whatever the card says.
    expect(criteriaForCard([BEFORE, { text: "Health check returns 200", after: "merge" as const }], "Does the health check return 200?", [])).toEqual([1]);
    expect(mentionsCriterion(SHOT.text, "the 1667px screenshot on the ticket page")).toBe(true);
    expect(mentionsCriterion(SHOT.text, "did it work")).toBe(false);
  });

  it("a merge with only before-merge criteria closes the ticket as it always did", async () => {
    expect(landingText({ outcome: "merged" }, { branch: "main", assignee: "Dev" })).toBe("Merged into main.");
  });
});

describe("after-merge criteria", () => {
  beforeAll(async () => {
    server = await boot();
  });
  afterAll(async () => {
    await server.built.app.close();
    await server.close();
  });
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.done();
  });

  it("create_ticket takes both kinds and returns the warn-lint, never refusing", async () => {
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", title: "With a live check", acceptanceCriteria: [BEFORE, "Works from the owner's Tailscale name on a real host"] } });
    const t = textOf(r);
    expect(t).toMatch(/Created ticket/);
    expect(t).toContain("on a real host");
    expect(t).toContain("warning only");
    const [created] = await ctx.db.select().from(tickets).where(eq(tickets.title, "With a live check"));
    expect(created!.acceptanceCriteria).toEqual([BEFORE, "Works from the owner's Tailscale name on a real host"]);
  });

  it("the owner's API takes the after-merge shape and gives it back unchanged", async () => {
    const made = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Owner made", acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string; acceptanceCriteria: unknown };
    expect(made.acceptanceCriteria).toEqual([BEFORE, LIVE]);
  });

  it("review can be entered with the after-merge criterion unreported, and its wake note marks it skippable", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE] });
    const c = await ctx.agent(ctx.dev.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Health check returns 200 pass; tests pass." } });
    expect((await ctx.row(t.id)).systemState).toBe("review");
    const note = (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.co.ceo.id && w.reason === "review requested").at(-1)?.note ?? "";
    expect(note).toContain("[not reported]");
    expect(note).toContain("checked after merge");
    expect(note).toMatch(/approve with the after-merge ones still unreported/);
  });

  it("still refuses review while a before-merge criterion is unreported", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE] });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Tests pass." } });
    expect(textOf(r)).toContain("Health check returns 200");
    expect(textOf(r)).not.toContain(LIVE.text);
    expect((await ctx.row(t.id)).systemState).toBe("in_progress");
  });

  it("won't close a merged ticket until the after-merge criterion is reported", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE], systemState: "review", mergeCommit: "d".repeat(40), stateNote: "Health check returns 200 pass" });
    const c = await ctx.agent(ctx.dev.id);
    const refused = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Merged; all good." } });
    expect(textOf(refused)).toContain(LIVE.text);
    expect((await ctx.row(t.id)).systemState).toBe("review");
    const good = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: `Merged. ${LIVE.text} pass.` } });
    expect(textOf(good)).toContain("is now done");
    expect((await ctx.row(t.id)).systemState).toBe("done");
  });

  it("a merge with an after-merge criterion sends the ticket back to show it, and plain words say why", { timeout: 120_000 }, async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    const refused = standInRunner(ctx.runners, reg.runnerId,mergeReplies("c".repeat(40)));
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Live check", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, stateNote: "Health check returns 200 pass" }).where(eq(tickets.id, t.id));
    await db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    const r = await ctx.review.landVisible(t.id, "the owner");
    expect(r.outcome).toBe("merged");
    expect(refused).toEqual([]);
    expect((r.detail as { afterMerge?: string[] }).afterMerge).toEqual([LIVE.text]);
    const after = await ctx.row(t.id);
    // Back with its assignee, with its working copy kept so the live check can be shown where it was.
    expect(after.systemState).toBe("in_progress");
    expect(after.mergeCommit).toBe("c".repeat(40));
    expect(after.noCode).toBe(true);
    const note = (await db.select().from(wakes)).filter((w) => w.agentId === dev.id && w.reason === "after merge").at(-1)?.note ?? "";
    expect(note).toContain(LIVE.text);
    // The page's plain words tell the owner the ticket stays open for the live check.
    const words = landingText(r, { branch: "main", assignee: "Dev" });
    expect(words).toContain("stays open");
    expect(words).toContain(LIVE.text);
  });

  it("the owner's answer on the linked card records the after-merge criterion, so the ticket can close", { timeout: 120_000 }, async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    const refused = standInRunner(ctx.runners, reg.runnerId,mergeReplies("e".repeat(40)));
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Owner checks the host", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, stateNote: "Health check returns 200 pass" }).where(eq(tickets.id, t.id));
    await db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    expect((await ctx.review.landVisible(t.id, "the owner")).outcome).toBe("merged");
    expect(refused).toEqual([]);
    expect((await ctx.row(t.id)).systemState).toBe("in_progress");

    // The assignee puts the live check in front of the owner; the owner answers the card.
    const c = await ctx.agent(dev.id);
    const asked = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Does it answer from your Tailscale name on your machine?", options: ["Yes, it works", "No, it does not"], recommended: "Yes, it works", triedFirst: "Deployed it and checked from my own shell; only the owner's host can reach it.", blocksTicketId: t.id } }));
    expect(asked).toMatch(/decision/i);
    const [card] = await db.select().from(decisions).where(eq(decisions.question, "Does it answer from your Tailscale name on your machine?"));
    expect((await req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Yes, it works" })).statusCode).toBe(200);

    const recorded = await ctx.row(t.id);
    expect(recorded.stateNote).toContain(LIVE.text);
    expect(recorded.stateNote).toMatch(/\bpass\b/i);
    expect(unreportedAfterMerge(readCriteria(recorded.acceptanceCriteria), recorded.stateNote)).toEqual([]);
    // And the ticket closes on the owner's answer, with no verdict of the agent's own.
    const done = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Closed on the owner's answer." } });
    expect(textOf(done)).toContain("is now done");
    expect((await ctx.row(t.id)).systemState).toBe("done");
  });

  // BOS-963: on BOS-905 the owner answered "Pass" on a card three times and the after-merge criterion never
  // recorded. Two faults: the note's wording came from the card, not the criterion, so the plain-text match
  // missed it; and a card answered after an earlier answer had already written the criterion out of the
  // "unreported" set wrote nothing at all, so a fresh card could never settle it.
  const SHOT = { text: "Screenshot of the conflict message on the ticket page at the owner's Brave 1667px width", after: "merge" as const };
  const SHOT_Q = "The screenshot is ready: does it show the conflict message at 1667px?";
  const raiseFor = async (ticketId: string, question: string, options: string[], criterion?: number | string) => {
    const c = await ctx.agent(ctx.dev.id);
    const asked = textOf(await c.callTool({ name: "raise_decision", arguments: { question, options, recommended: options[0]!, triedFirst: "Took the screenshot myself; only the owner's own screen shows their true width.", blocksTicketId: ticketId, ...(criterion !== undefined ? { criterion } : {}) } }));
    expect(asked).toMatch(/decision/i);
    return (await ctx.db.select().from(decisions).where(and(eq(decisions.question, question), eq(decisions.companyId, ctx.co.company.id))))[0]!;
  };

  it("the owner's answer records the criterion in the card's own words, not the criterion's", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, SHOT], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const card = await raiseFor(t.id, SHOT_Q, ["Pass - the screenshot meets the criterion", "Fail - it doesn't"]);
    expect((await ctx.req("POST", `/api/decisions/${card.id}/answer`, { answer: "Pass - the screenshot meets the criterion" })).statusCode).toBe(200);
    const recorded = await ctx.row(t.id);
    expect(unreportedAfterMerge(readCriteria(recorded.acceptanceCriteria), recorded.stateNote)).toEqual([]);
    expect(readVerdicts(readCriteria(recorded.acceptanceCriteria), recorded.stateNote).find((r) => r.criterion === SHOT.text)?.verdict).toBe("pass");
    // And the ticket closes on that answer alone.
    const c = await ctx.agent(ctx.dev.id);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Closed on the owner's answer." } }))).toContain("is now done");
  });

  it("a later card's answer still records when an earlier answer already wrote the criterion", async () => {
    // The BOS-905 shape: two answers land, and the second must not be silently dropped.
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, SHOT], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const first = await raiseFor(t.id, SHOT_Q, ["Pass - the screenshot meets the criterion", "Fail - it doesn't"]);
    expect((await ctx.req("POST", `/api/decisions/${first.id}/answer`, { answer: "Pass - the screenshot meets the criterion" })).statusCode).toBe(200);
    const noted = (await ctx.row(t.id)).stateNote;
    const second = await raiseFor(t.id, "One more look at the 1667px screenshot: does it meet the criterion now?", ["Pass - the screenshot meets the criterion", "Fail - it doesn't"], 2);
    expect((await ctx.req("POST", `/api/decisions/${second.id}/answer`, { answer: "Pass - the screenshot meets the criterion" })).statusCode).toBe(200);
    const recorded = await ctx.row(t.id);
    // The second answer added its own line, so the ticket shows both times it was answered.
    expect((recorded.stateNote ?? "").length).toBeGreaterThan((noted ?? "").length);
    expect(recorded.stateNote).toContain("One more look at the 1667px screenshot");
    expect(unreportedAfterMerge(readCriteria(recorded.acceptanceCriteria), recorded.stateNote)).toEqual([]);
  });

  it("raise_decision says when a card on a merged ticket can't be tied to an after-merge criterion", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, SHOT], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "raise_decision", arguments: { question: "How did the whole ticket go for you?", options: ["Fine", "Not fine"], recommended: "Fine", triedFirst: "Ran the checks and the app myself; only the owner can say how it felt to use.", blocksTicketId: t.id } });
    const said = textOf(r);
    // The card is still raised (it may be a real question), but the raiser is told the answer won't record a criterion.
    expect(said).toMatch(/decision/i);
    expect(said).toMatch(/won't record|cannot record|can't record|not record/i);
    expect(said).toContain("Screenshot of the conflict message");
    // And a card that does name the criterion gets no such warning.
    const ok = textOf(await c.callTool({ name: "raise_decision", arguments: { question: SHOT.text + ": does it pass?", options: ["Pass - the screenshot meets the criterion", "Fail - it doesn't"], recommended: "Pass - the screenshot meets the criterion", triedFirst: "Took the screenshot myself; only the owner's own screen shows their true width.", blocksTicketId: t.id } }));
    expect(ok).not.toMatch(/won't record|cannot record|can't record|not record/i);
    // Naming the criterion by its number also avoids the warning, and refuses one that isn't an after-merge check.
    const byNumber = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "All good now?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Ran the checks and the app myself; only the owner can say how it looked on their screen.", blocksTicketId: t.id, criterion: 2 } }));
    expect(byNumber).not.toMatch(/won't record|cannot record|can't record|not record/i);
    const beforeMerge = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Does the health check still pass?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Ran the checks myself; the host only answers to the owner.", blocksTicketId: t.id, criterion: 1 } }));
    expect(beforeMerge).toMatch(/checked before merge/i);
    const notThere = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Anything else?", options: ["Yes", "No"], recommended: "No", triedFirst: "Ran the checks and the app myself; only the owner can say how it felt.", blocksTicketId: t.id, criterion: 9 } }));
    expect(notThere).toMatch(/No criterion/i);
  });

  it("a card's explicit criterion records that check even when its wording names nothing", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, SHOT], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    // The question and options say nothing about the screenshot; the criterion number links it.
    const card = await raiseFor(t.id, "All good now?", ["Yes, all good", "No, something is off"], 2);
    expect((await ctx.req("POST", `/api/decisions/${card.id}/answer`, { answer: "Yes, all good" })).statusCode).toBe(200);
    const recorded = await ctx.row(t.id);
    expect(readVerdicts(readCriteria(recorded.acceptanceCriteria), recorded.stateNote).find((r) => r.criterion === SHOT.text)?.verdict).toBe("pass");
    expect(unreportedAfterMerge(readCriteria(recorded.acceptanceCriteria), recorded.stateNote)).toEqual([]);
  });

  // BOS-1012: Claude Code sends a number as the string "6" (its JSON schema is anyOf [integer, string]),
  // so the handler's typeof-number branch never ran and a card naming a criterion by number was refused.
  it("a criterion number sent as a string, as Claude Code sends it, links the card", async () => {
    const SIX = [...SLOTS.slice(0, 4), LIVE, { text: "Claude Max 2 shows the 2 line on the Funding page", after: "merge" as const }];
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: SIX, systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "1 pass; 2 pass; 3 pass; 4 pass" });
    const c = await ctx.agent(ctx.dev.id);
    const asked = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Does the Funding page show the 2 line?", options: ["Pass - it shows the 2 line", "Fail - it doesn't"], recommended: "Pass - it shows the 2 line", triedFirst: "Ran the checks; only the owner's live plan shows their own allowance.", blocksTicketId: t.id, criterion: "6" } }));
    expect(asked).toMatch(/decision/i);
    expect(asked).not.toMatch(/No criterion/);
    const card = (await ctx.db.select().from(decisions).where(and(eq(decisions.question, "Does the Funding page show the 2 line?"), eq(decisions.companyId, ctx.co.company.id))))[0]!;
    expect((card.context as { criterionIndexes?: number[] }).criterionIndexes).toEqual([5]);
    // The refusals still stand for a string number: out of range, and pointing at a before-merge check.
    const past = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Anything else?", options: ["Yes", "No"], recommended: "No", triedFirst: "Ran the checks and the app myself; only the owner can say how it felt.", blocksTicketId: t.id, criterion: "9" } }));
    expect(past).toMatch(/No criterion 9 on this ticket/i);
    const before = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Does the health check still pass?", options: ["Yes", "No"], recommended: "Yes", triedFirst: "Ran the checks myself; the host only answers to the owner.", blocksTicketId: t.id, criterion: "1" } }));
    expect(before).toMatch(/checked before merge/i);
  });

  it("a criterion copied with the after-merge note Boss Man shows still matches its text", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const c = await ctx.agent(ctx.dev.id);
    // Exactly what `tickets read` shows on the criterion line, suffix and all.
    const shown = `${LIVE.text} (checked after merge; don't fail the review on it)`;
    const asked = textOf(await c.callTool({ name: "raise_decision", arguments: { question: "Is BOS-373 answered on the real host?", options: ["Pass - the host answers", "Fail - it doesn't"], recommended: "Pass - the host answers", triedFirst: "Asked the host myself and it refused; only the owner's tailnet reaches it here.", blocksTicketId: t.id, criterion: shown } }));
    expect(asked).toMatch(/decision/i);
    expect(asked).not.toMatch(/No criterion/);
    const [card] = await ctx.db.select().from(decisions).where(and(eq(decisions.question, "Is BOS-373 answered on the real host?"), eq(decisions.companyId, ctx.co.company.id)));
    expect((card!.context as { criterionIndexes?: number[] }).criterionIndexes).toEqual([1]);
  });

  it("the owner's answer records a fail, which keeps the ticket open", async () => {
    const t = await ctx.ticket({ acceptanceCriteria: [BEFORE, LIVE], systemState: "in_progress", mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.co.company.id, kind: "question", question: "Does the host answer?", options: ["Yes, it works", "No, it does not"], recommendedOption: "Yes, it works", context: { type: "question" }, raisedByAgentId: ctx.dev.id }).returning();
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    await ctx.decisions.answer(d!.id, "No, it does not");
    const recorded = await ctx.row(t.id);
    expect(recorded.stateNote).toContain(LIVE.text);
    // The owner's answer is read as a fail for that criterion, so it is reported (with a fail), and the
    // ticket's own assignee has to fix it before it can close.
    expect(readVerdicts(readCriteria(recorded.acceptanceCriteria), recorded.stateNote).find((r) => r.criterion === LIVE.text)?.verdict).toBe("fail");
    expect(recorded.systemState).toBe("in_progress");
  });

  it("reopening a merged ticket for code clears its no-code mark, so review and done ask for a diff again", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE], systemState: "in_progress", branch: null, mergeCommit: "a".repeat(40), noCode: true, stateNote: `${LIVE.text} pass` });
    // The owner reopens it to do real work: from then on it is a code ticket again.
    expect((await ctx.req("POST", `/api/tickets/${t.id}/state`, { state: "ready" })).statusCode).toBe(200);
    let now = await ctx.row(t.id);
    expect(now.systemState).toBe("ready");
    expect(now.noCode).toBe(false);
    // Its assignee moving it into work keeps it code; with nothing changed it can't reach review.
    const c = await ctx.agent(ctx.dev.id);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Back to it." } });
    now = await ctx.row(t.id);
    expect(now.systemState).toBe("in_progress");
    expect(now.noCode).toBe(false);
  });

  it("a plain no-code ticket keeps its no-code mark through ready, in_progress and review, and closes on an empty diff", async () => {
    // Never merged: a research or wiki ticket is no-code for its whole life. Moving it between states
    // must not clear the flag, or review would send it back for a diff it never has.
    const t = await ctx.ticket({ title: "Wiki only", assigneeAgentId: ctx.dev.id, systemState: "backlog", noCode: true });
    const c = await ctx.agent(ctx.dev.id);
    await ctx.req("POST", `/api/tickets/${t.id}/state`, { state: "ready" });
    expect((await ctx.row(t.id)).noCode).toBe(true);
    await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "in_progress", summary: "Writing the page." } });
    expect((await ctx.row(t.id)).noCode).toBe(true);
    const moved = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Page written." } });
    expect(textOf(moved)).not.toContain("Nothing in the repository changed");
    expect((await ctx.row(t.id)).noCode).toBe(true);
    // The owner moving it between code states keeps it no-code too.
    await ctx.req("POST", `/api/tickets/${t.id}/state`, { state: "in_progress" });
    await ctx.req("POST", `/api/tickets/${t.id}/state`, { state: "ready" });
    expect((await ctx.row(t.id)).noCode).toBe(true);
  });

  it("a merged no-code ticket whose live check is reported closes as done on the empty diff", { timeout: 120_000 }, async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    // The branch still stands at the merge, as it does after the after-merge step: no new commits.
    const refused = standInRunner(ctx.runners, reg.runnerId, {
      "workspace.diff": { baseCommit: "b".repeat(40), head: "c".repeat(40), commits: [], files: [], diff: "", truncated: false },
      "workspace.carried": { carried: [] },
    });
    const t = await ctx.ticket({ title: "Live check reported", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE], systemState: "review", mergeCommit: "c".repeat(40), noCode: true, stateNote: `${LIVE.text} pass` });
    await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    const r = await ctx.review.landVisible(t.id, "the owner");
    // The live check is done: this is the after-merge step, so it closes rather than looping back.
    expect(r.outcome).toBe("done");
    expect(refused).toEqual([]);
    expect((await ctx.row(t.id)).systemState).toBe("done");
  });

  it("a merge with a criterion still at fail keeps the ticket with its assignee and tells the CEO", { timeout: 120_000 }, async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    const refused = standInRunner(ctx.runners, reg.runnerId,mergeReplies("a".repeat(40)));
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Two check slots", assigneeAgentId: dev.id, acceptanceCriteria: SLOTS })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, stateNote: SLOTS_NOTE, systemState: "review" }).where(eq(tickets.id, t.id));
    const r = await ctx.review.landVisible(t.id, "the owner");
    expect(r.outcome).toBe("merged");
    expect(refused).toEqual([]);
    expect((r.detail as { afterMerge?: string[] }).afterMerge).toEqual([SLOTS[2]]);
    const after = await ctx.row(t.id);
    expect(after.systemState).toBe("in_progress");
    expect(after.assigneeAgentId).toBe(dev.id);
    expect(readCriteria(after.acceptanceCriteria)[2]).toEqual({ text: SLOTS[2], after: "merge" });
    const all = await db.select().from(wakes);
    const devNote = all.filter((w) => w.agentId === dev.id && w.reason === "after merge").at(-1)?.note ?? "";
    expect(devNote).toContain("still at fail when it merged");
    expect(devNote).toContain("don't make one by hand");
    const ceoNote = all.filter((w) => w.agentId === co.ceo.id && w.reason === "after merge carried").at(-1)?.note ?? "";
    expect(ceoNote).toContain("Two check slots");
    // The measurement, reported as a pass, closes it with no follow-up ticket.
    const c = await ctx.agent(dev.id);
    expect(textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done" } }))).toContain(SLOTS[2]);
    const closed = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "3 pass: two checks side by side took 41 and 44 minutes" } }));
    expect(closed).toContain("is now done");
    expect(closed).not.toMatch(/follow-up/i);
    expect(await db.select().from(tickets).where(eq(tickets.projectId, project.id))).toHaveLength(1);
  });

  it("an after-merge check reported fail closes the ticket and Boss Man opens an owned, described follow-up", async () => {
    const t = await ctx.ticket({ title: "Tailscale name", assigneeAgentId: ctx.dev.id, risk: "low", acceptanceCriteria: [BEFORE, LIVE], mergeCommit: "b".repeat(40), stateNote: "Health check returns 200 pass" });
    const c = await ctx.agent(ctx.dev.id);
    const r = textOf(await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: `${LIVE.text} fail: the name doesn't resolve from the owner's phone` } }));
    expect(r).toContain("is now done");
    expect(r).toMatch(/opened the follow-up/);
    const made = (await ctx.db.select().from(tickets).where(eq(tickets.projectId, ctx.project.id))).find((x) => x.id !== t.id)!;
    expect(made.title).toContain("Follow-up to");
    expect(made.title).toContain(LIVE.text);
    expect(made.body).toContain(LIVE.text);
    expect(made.body).toContain("doesn't resolve from the owner's phone");
    expect(made.body).toContain("b".repeat(12));
    expect(made.body).toContain(`#/tickets/${t.id}`);
    expect(made.risk).toBe("low");
    expect(made.assigneeAgentId).toBe(ctx.dev.id);
    expect(made.systemState).toBe("ready");
    expect(made.acceptanceCriteria).toEqual([{ text: LIVE.text, after: "merge" }]);
    const closed = await ctx.row(t.id);
    expect(closed.systemState).toBe("done");
    expect(closed.stateNote).toContain(`#/tickets/${made.id}`);
    const ceoNote = (await ctx.db.select().from(wakes)).filter((w) => w.agentId === ctx.co.ceo.id && w.reason === "follow-up created").at(-1)?.note ?? "";
    expect(ceoNote).toContain("Tailscale name");
  });

  it("a cancel makes no follow-up, and a follow-up for an unassigned ticket goes to the CEO, never to nobody", async () => {
    const t = await ctx.ticket({ assigneeAgentId: ctx.dev.id, acceptanceCriteria: [BEFORE, LIVE], mergeCommit: "c".repeat(40), stateNote: "Health check returns 200 pass" });
    // Cancelling is a manager's call; the CEO drops the check.
    const ceo = await ctx.agent(ctx.co.ceo.id);
    const cancelled = textOf(await ceo.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", outcome: "cancelled", summary: `${LIVE.text} fail: dropped, the owner no longer uses it` } }));
    expect(cancelled).toContain("is now done");
    expect(cancelled).not.toMatch(/follow-up/i);
    expect(await ctx.db.select().from(tickets).where(eq(tickets.projectId, ctx.project.id))).toHaveLength(1);

    const orphan = await ctx.ticket({ title: "Nobody's", acceptanceCriteria: [LIVE], mergeCommit: "d".repeat(40) });
    const f = await ctx.review.followUpFailedChecks(orphan.id, [LIVE.text], `${LIVE.text} fail`, null);
    expect(f).not.toBeNull();
    expect((await ctx.row(f!.id)).assigneeAgentId).toBe(ctx.co.ceo.id);
    expect(await ctx.review.followUpFailedChecks(orphan.id, [], "", null)).toBeNull();
  });

  it("the diff checklist a reviewer reads separates the two kinds", async () => {
    const { db, req, co, dev, project } = ctx;
    await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
    const reg = (await req("POST", `/api/companies/${co.company.id}/runner`)).json() as { runnerId: string };
    standInRunner(ctx.runners, reg.runnerId,{ "workspace.diff": { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [], files: [], diff: "", truncated: false } });
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Live check 2", assigneeAgentId: dev.id, acceptanceCriteria: [BEFORE, LIVE] })).json() as { id: string };
    // The CEO reviews its own company's work unless the policy names another; give it the review.
    await db.update(tickets).set({ stateNote: "Health check returns 200 pass" }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, round: 1, kind: "code", reviewerAgentId: co.ceo.id, status: "pending" });
    const ceoC = await ctx.agent(co.ceo.id);
    const seen = textOf(await ceoC.callTool({ name: "review", arguments: { ticketId: t.id, action: "diff" } }));
    expect(seen).toContain("checked after merge");
    expect(seen).toMatch(/before-merge/);
    expect(DEFAULT_REVIEW_POLICY.medium.reviewer).toBeTruthy();
  });
});
