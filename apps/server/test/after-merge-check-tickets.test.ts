// BOS-1794: a check ticket split out of a merged ticket's after-merge criterion reports back when it closes.
// Before: BOS-1622 passed and BOS-1600 sat Blocked with that criterion "not reported" for two days, since nothing
// linked the two. On the old code create_ticket has no checksCriterion and closing the check writes and wakes nothing.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkTicketLine, readVerdicts, unreportedAfterMerge } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, features, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { workflowService } from "../src/services/workflow.js";
import { issueRunToken } from "../src/mcp.js";
import { appendLine, CHECK_REPORTED_REASON, checkTicketDoneRefusal, checkTicketVerdict, LONG_WATCH_FROM, openLongWatchChecks } from "../src/services/after-merge-check-tickets.js";
import { openBlockers } from "../src/services/ticket-links.js";
import { wakeClass } from "../src/services/wake-classes.js";
import { wakeWatchers } from "../src/services/watch-triggers.js";
import { blockedSplit } from "../src/services/go-live-note.js";

const BEFORE = "Health check returns 200";
const LIVE = { text: "The update banner waits for a running merge check on the live server", after: "merge" as const };

describe("check ticket results: the rules", () => {
  it("the check line is read by its number, and a later verdict by the ticket's own author replaces it", () => {
    const line = checkTicketLine("BOS-12", 2, "pass", LIVE.text, "Check: banner waits, 1 pass");
    // One segment: no . ; or , that would split it, whatever the criterion or title held.
    expect(line).not.toMatch(/[.;,]/);
    expect(readVerdicts([BEFORE, LIVE], `1 pass. ${line}`).map((r) => r.verdict)).toEqual(["pass", "pass"]);
    expect(unreportedAfterMerge([BEFORE, LIVE], `1 pass. ${line}`)).toEqual([]);
    expect(readVerdicts([BEFORE, LIVE], `1 pass. ${line}. 2 fail: it showed the old wording`).map((r) => r.verdict)).toEqual(["pass", "fail"]);
    const failed = checkTicketLine("BOS-12", 2, "fail", LIVE.text, "Check");
    expect(readVerdicts([BEFORE, LIVE], `1 pass. ${failed}`).map((r) => r.verdict)).toEqual(["pass", "fail"]);
    // Its title's words don't count as a verdict for criterion 1.
    expect(readVerdicts([BEFORE, LIVE], checkTicketLine("BOS-12", 2, "pass", LIVE.text, "Health check returns 200 fail")).map((r) => r.verdict)).toEqual([null, "pass"]);
  });

  it("the check ticket's verdict: any fail fails, all pass passes, cancelled or unreported says nothing", () => {
    const crit = ["Banner waits", "Wording matches"];
    expect(checkTicketVerdict({ outcome: "completed", acceptanceCriteria: crit, stateNote: "1 pass; 2 pass" })).toBe("pass");
    expect(checkTicketVerdict({ outcome: "completed", acceptanceCriteria: crit, stateNote: "1 pass; 2 fail: old text" })).toBe("fail");
    expect(checkTicketVerdict({ outcome: "completed", acceptanceCriteria: crit, stateNote: "1 pass" })).toBeNull();
    expect(checkTicketVerdict({ outcome: "cancelled", acceptanceCriteria: crit, stateNote: "1 pass; 2 pass" })).toBeNull();
    expect(checkTicketVerdict({ outcome: "completed", acceptanceCriteria: [], stateNote: "all pass" })).toBeNull();
  });

  it("BOS-1867: a done close needs a numbered verdict for each of the check's own criteria, and the refusal shows the form", () => {
    const crit = ["Banner waits", "Wording matches"];
    // What QA wrote on BOS-1862: no numbered verdict, so nothing would reach the parent.
    const bare = checkTicketDoneRefusal(crit, "Pass: 79 GitHub runs, none failed", 2);
    expect(bare).toContain('"1 pass: <what you saw>; 2 pass: <what you saw>"');
    expect(bare).toContain('Not reported: "Banner waits", "Wording matches"');
    expect(bare).toContain("criterion 2 of another ticket");
    expect(bare).toContain("outcome cancelled");
    expect(checkTicketDoneRefusal(crit, "1 pass: 79 runs", 2)).toContain('Not reported: "Wording matches"');
    expect(checkTicketDoneRefusal(crit, "1 pass: 79 runs; 2 fail: old text", 2)).toBeNull();
    expect(checkTicketDoneRefusal(["Banner waits"], "1 pass: 79 GitHub runs", 1)).toBeNull();
    // No criteria: checkTicketVerdict can never pass, so the close is refused too.
    expect(checkTicketDoneRefusal([], "1 pass", 1)).toContain("no criteria of its own");
  });

  it("a long note gives way from the front, so the recorded line is never cut", () => {
    const line = checkTicketLine("BOS-12", 2, "pass", LIVE.text, "Check");
    const out = appendLine("x".repeat(3990), line);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith(line)).toBe(true);
    expect(appendLine(null, line)).toBe(line);
  });

  it("the wake is never dropped", () => {
    expect(wakeClass(CHECK_REPORTED_REASON)).toBe("waiting");
  });
});

let server: Awaited<ReturnType<typeof boot>>;
async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0, clients: [] as Client[] };
}
beforeAll(async () => {
  server = await boot();
});
afterAll(async () => {
  await Promise.all(server.clients.map((c) => c.close()));
  await server.built.app.close();
  await server.close();
});

/** A company with a merged ticket, Blocked on its one after-merge criterion, assigned to Dev. */
async function setup() {
  const { built, db, base, cookie } = server;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const co = (await req("POST", "/api/companies", { name: `Check Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const other = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Other" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const [parent] = await db
    .insert(tickets)
    .values({ companyId: co.company.id, projectId: project.id, title: "Runner update banner", systemState: "blocked", assigneeAgentId: dev.id, mergeCommit: "a".repeat(40), acceptanceCriteria: [BEFORE, LIVE], stateNote: "1 pass. Waiting for a merge check to run on the live server" })
    .returning();
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    server.clients.push(c);
    return c;
  };
  const create = async (as: string, args: Record<string, unknown>) => {
    const r = (await (await agent(as)).callTool({ name: "create_ticket", arguments: { title: "Check: banner waits for a merge", size: 1, noCode: true, project: "Customer app", ...args } })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError, id: /Created ticket ([0-9a-f-]{36})/.exec(r.content[0]!.text)?.[1] ?? null };
  };
  const setState = async (as: string, args: Record<string, unknown>) => {
    const r = (await (await agent(as)).callTool({ name: "set_ticket_state", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const reportWakes = async () => db.select().from(wakes).where(and(eq(wakes.agentId, dev.id), eq(wakes.reason, CHECK_REPORTED_REASON)));
  const call = async (as: string, name: string, args: Record<string, unknown>) => {
    const r = (await (await agent(as)).callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { db, work: built.work, scheduler: built.scheduler, co, dev, other, project, parent: parent!, create, setState, call, row, reportWakes };
}

describe("check tickets: split out, then report back", () => {
  it("the parent's assignee splits out a check with no CEO step; the parent waits on it and it carries the criterion", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toContain("check for criterion 2");
    const check = await c.row(made.id!);
    expect(check.checksTicketId).toBe(c.parent.id);
    expect(check.checksCriterion).toBe(2);
    expect(check.acceptanceCriteria).toEqual([LIVE.text]);
    const deps = await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, c.parent.id));
    expect(deps.map((d) => [d.blockerTicketId, d.until])).toEqual([[check.id, "done"]]);
  });

  it("BOS-2563: a check made without saying noCode is no-code, so its assignee can close it; noCode false keeps it a code ticket", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { noCode: undefined, checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    expect(made.isError, made.text).toBe(false);
    expect((await c.row(made.id!)).noCode).toBe(true);
    const code = await c.create(c.dev.id, { title: "Check that needs code", noCode: false, checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    expect(code.isError, code.text).toBe(false);
    expect((await c.row(code.id!)).noCode).toBe(false);
    const plain = await c.create(c.dev.id, { title: "A plain ticket", noCode: undefined });
    expect((await c.row(plain.id!)).noCode).toBe(false);
  });

  it("refuses someone else's ticket, a before-merge criterion and a criterion that isn't there", async () => {
    const c = await setup();
    const notMine = await c.create(c.other.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    expect(notMine.isError).toBe(true);
    expect(notMine.text).toMatch(/assignee, the CEO or a manager/);
    // The CEO may, for a ticket it doesn't hold.
    expect((await c.create(c.co.ceo.id, { title: "CEO split", checksCriterion: { ticket: c.parent.id, criterion: 2 } })).isError).toBe(false);
    const before = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 1 } });
    expect(before.isError).toBe(true);
    expect(before.text).toMatch(/only an after-merge criterion/);
    expect((await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 3 } })).text).toMatch(/no criterion 3/);
  });

  it("a pass is recorded on the parent's criterion with the check's ref, and the wake says it can close now, once", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ stateNote: "1 pass: the merge records show the update waited" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    const check = await c.row(made.id!);
    const parent = await c.row(c.parent.id);
    expect(parent.stateNote).toMatch(new RegExp(`Check ticket [A-Z]+-${check.number} reported: 2 pass`));
    // The earlier note is kept, and the done gate now has nothing unreported.
    expect(parent.stateNote).toContain("1 pass");
    expect(unreportedAfterMerge(parent.acceptanceCriteria, parent.stateNote)).toEqual([]);
    const woke = await c.reportWakes();
    expect(woke).toHaveLength(1);
    expect(woke[0]!.ticketId).toBe(c.parent.id);
    expect(woke[0]!.note).toContain("reported pass");
    expect(woke[0]!.note).toContain("you can close it now");
    // A second done hook for the same close writes and wakes nothing more.
    await c.scheduler.onTicketDone(made.id!);
    expect(await c.reportWakes()).toHaveLength(1);
    expect((await c.row(c.parent.id)).stateNote).toBe(parent.stateNote);
    const acts = await c.db.select().from(activity).where(and(eq(activity.ticketId, c.parent.id), eq(activity.kind, "after_merge_check")));
    expect(acts).toHaveLength(1);
  });

  it("a fail is recorded as a fail, and the wake names the follow-up", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ stateNote: "1 fail: the update started while a merge check ran" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    const parent = await c.row(c.parent.id);
    expect(readVerdicts(parent.acceptanceCriteria, parent.stateNote).map((r) => r.verdict)).toEqual(["pass", "fail"]);
    const [woke] = await c.reportWakes();
    expect(woke!.note).toContain("reported fail");
    expect(woke!.note).toContain("follow-up");
  });

  it("a cancelled check records nothing, and the wake says the criterion is still not reported", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.work.updateTicket(made.id!, { state: "done", outcome: "cancelled", overLimit: true });
    const parent = await c.row(c.parent.id);
    expect(parent.stateNote).toBe(c.parent.stateNote);
    expect(unreportedAfterMerge(parent.acceptanceCriteria, parent.stateNote)).toEqual([LIVE.text]);
    const [woke] = await c.reportWakes();
    expect(woke!.note).toContain("cancelled");
    expect(woke!.note).toContain("still not reported");
  });

  it("with another after-merge criterion still open, the wake lists it instead of saying close", async () => {
    const c = await setup();
    const third = { text: "Owner sees the new wording on their phone", after: "merge" as const };
    await c.db.update(tickets).set({ acceptanceCriteria: [BEFORE, LIVE, third] }).where(eq(tickets.id, c.parent.id));
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ stateNote: "1 pass" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    const [woke] = await c.reportWakes();
    expect(woke!.note).toContain(`Still not reported: "${third.text}"`);
    expect(woke!.note).not.toContain("close it now");
  });

  it("a check ticket made the old way, with no tie to a parent, closes as before and changes no parent", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, {});
    expect(made.isError, made.text).toBe(false);
    const check = await c.row(made.id!);
    expect(check.checksTicketId).toBeNull();
    await c.db.update(tickets).set({ stateNote: "1 pass" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    expect((await c.row(made.id!)).systemState).toBe("done");
    const parent = await c.row(c.parent.id);
    expect(parent.stateNote).toBe(c.parent.stateNote);
    expect(parent.systemState).toBe("blocked");
    expect(await c.reportWakes()).toEqual([]);
    const acts = await c.db.select().from(activity).where(and(eq(activity.ticketId, c.parent.id), eq(activity.kind, "after_merge_check")));
    expect(acts).toEqual([]);
  });

  it("BOS-1867: set_ticket_state refuses a bare \"Pass: …\" close of a linked check, then a numbered one closes and reports", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ assigneeAgentId: c.dev.id, systemState: "in_progress" }).where(eq(tickets.id, made.id!));
    const bare = await c.setState(c.dev.id, { ticketId: made.id!, state: "done", outcome: "completed", summary: "Pass: 79 GitHub runs, none failed" });
    expect(bare.isError, bare.text).toBe(true);
    expect(bare.text).toContain('"1 pass: <what you saw>"');
    expect(bare.text).toContain(`Not reported: "${LIVE.text}"`);
    expect((await c.row(made.id!)).systemState).toBe("in_progress");
    expect((await c.row(c.parent.id)).stateNote).toBe(c.parent.stateNote);
    const numbered = await c.setState(c.dev.id, { ticketId: made.id!, state: "done", outcome: "completed", summary: "1 pass: 79 GitHub runs, none failed" });
    expect(numbered.isError, numbered.text).toBe(false);
    expect((await c.row(made.id!)).systemState).toBe("done");
    expect((await c.row(c.parent.id)).stateNote).toMatch(/reported: 2 pass/);
  });

  it("BOS-2417: a merged parent whose only unreported criterion is tied to an open check closes, and its watch moves to the check", async () => {
    const c = await setup();
    const [feat] = await c.db.insert(features).values({ companyId: c.co.company.id, title: "Board shows where work stands", status: "in_progress" }).returning();
    await c.db.update(tickets).set({ featureId: feat!.id, watchingFor: "a week of merge checks with no banner shown early", watchTrigger: "gate_ci_failed", liveAt: new Date() }).where(eq(tickets.id, c.parent.id));
    const featureRow = async () => (await workflowService(c.db).scorecard(c.co.company.id, 14)).features.find((f) => f.id === feat!.id);
    expect(await featureRow()).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
    // Before the split the close is refused (BOS-1794's behaviour), and the refusal names the way out.
    const early = await c.setState(c.dev.id, { ticketId: c.parent.id, state: "done", summary: "1 pass; live since this morning" });
    expect(early.isError, early.text).toBe(true);
    expect(early.text).toContain(`Not reported: "${LIVE.text}"`);
    expect(early.text).toContain("checksCriterion");
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ assigneeAgentId: c.other.id, systemState: "blocked" }).where(eq(tickets.id, made.id!));
    const closed = await c.setState(c.dev.id, { ticketId: c.parent.id, state: "done", summary: "1 pass; live since this morning" });
    expect(closed.isError, closed.text).toBe(false);
    const check = await c.row(made.id!);
    expect(closed.text).toMatch(new RegExp(`criterion 2 left to [A-Z]+-${check.number}`));
    expect(closed.text).toContain("watch moved to");
    const parent = await c.row(c.parent.id);
    expect(parent.systemState).toBe("done");
    expect(parent.outcome).toBe("completed");
    expect(parent.watchTrigger).toBeNull();
    // The feature no longer counts it as an open task.
    expect(await featureRow()).toMatchObject({ tasksDone: 1, tasksTotal: 1, tail: [] });
    expect([check.watchTrigger, check.watchingFor]).toEqual(["gate_ci_failed", "a week of merge checks with no banner shown early"]);
    // No follow-up for an unreported (not failed) criterion, and the check stays open with its tie.
    expect(check.systemState).toBe("blocked");
    expect(check.checksTicketId).toBe(c.parent.id);
    // The trigger now wakes the check's assignee on the check, and not the finished parent's.
    const woken: Array<{ agentId: string; ticketId: string }> = [];
    const n = await wakeWatchers(c.db, async (agentId, input) => (woken.push({ agentId, ticketId: input.ticketId }), { status: "queued" }), "gate_ci_failed", "test run");
    expect(n).toBe(woken.length);
    expect(woken.filter((w) => w.ticketId === made.id || w.ticketId === c.parent.id)).toEqual([{ agentId: c.other.id, ticketId: made.id }]);
    // The board still shows the open check in "Merged, watching", not as stuck in Blocked.
    expect((await blockedSplit(c.db, c.co.company.id)).liveCheck).toBe(1);
    // The check's pass is still written on the done parent; nobody is woken for a run with nothing to do.
    await c.db.update(tickets).set({ stateNote: "1 pass: a week of checks, no banner early" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    const after = await c.row(c.parent.id);
    expect(after.systemState).toBe("done");
    expect(after.stateNote).toMatch(/reported: 2 pass/);
    expect(await c.reportWakes()).toEqual([]);
    expect(await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.co.ceo.id), eq(wakes.reason, CHECK_REPORTED_REASON)))).toEqual([]);
  });

  it("BOS-2417: a fail reported on a parent already closed at go-live wakes the CEO, not the parent's assignee", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    const closed = await c.setState(c.dev.id, { ticketId: c.parent.id, state: "done", summary: "1 pass; live since this morning" });
    expect(closed.isError, closed.text).toBe(false);
    // Unassigned check: the reply says nobody is woken for it.
    expect(closed.text).toContain("has no assignee");
    await c.db.update(tickets).set({ stateNote: "1 fail: the banner showed while a merge check ran" }).where(eq(tickets.id, made.id!));
    await c.work.updateTicket(made.id!, { state: "done", outcome: "completed", overLimit: true });
    const parent = await c.row(c.parent.id);
    expect(readVerdicts(parent.acceptanceCriteria, parent.stateNote).map((r) => r.verdict)).toEqual(["pass", "fail"]);
    expect(await c.reportWakes()).toEqual([]);
    const ceo = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.co.ceo.id), eq(wakes.reason, CHECK_REPORTED_REASON)));
    expect(ceo).toHaveLength(1);
    expect(ceo[0]!.ticketId).toBe(c.parent.id);
    expect(ceo[0]!.note).toContain("reported fail");
    expect(ceo[0]!.note).toContain("follow-up");
  });

  it("BOS-2417: an existing parent waiting on its check, with a watch, is left as it is until its assignee closes it", async () => {
    const c = await setup();
    const made = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    await c.db.update(tickets).set({ assigneeAgentId: c.other.id, systemState: "blocked" }).where(eq(tickets.id, made.id!));
    await c.db.update(tickets).set({ watchingFor: "a week of merge checks", watchTrigger: "gate_ci_failed" }).where(eq(tickets.id, c.parent.id));
    // Nothing closes it or moves its watch by itself: the trigger still wakes the parent's assignee on the parent.
    const woken: Array<{ agentId: string; ticketId: string }> = [];
    await wakeWatchers(c.db, async (agentId, input) => (woken.push({ agentId, ticketId: input.ticketId }), { status: "queued" }), "gate_ci_failed", "test run");
    expect(woken.filter((w) => w.ticketId === made.id || w.ticketId === c.parent.id)).toEqual([{ agentId: c.dev.id, ticketId: c.parent.id }]);
    const parent = await c.row(c.parent.id);
    expect([parent.systemState, parent.watchTrigger]).toEqual(["blocked", "gate_ci_failed"]);
    expect((await c.row(made.id!)).watchTrigger).toBeNull();
    // Both are in "Merged, watching", as before.
    expect((await blockedSplit(c.db, c.co.company.id)).liveCheck).toBe(2);
  });

  it("BOS-2417: the tie lets only merged work close, and a criterion with no check ticket still holds it", async () => {
    const c = await setup();
    const third = { text: "Owner sees the new wording on their phone", after: "merge" as const };
    await c.db.update(tickets).set({ acceptanceCriteria: [BEFORE, LIVE, third] }).where(eq(tickets.id, c.parent.id));
    await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    const held = await c.setState(c.dev.id, { ticketId: c.parent.id, state: "done", summary: "1 pass; live since this morning" });
    expect(held.isError).toBe(true);
    expect(held.text).toContain(`Not reported: "${third.text}"`);
    expect(held.text).not.toContain(LIVE.text);
    // Not merged: the tie doesn't count.
    await c.db.update(tickets).set({ acceptanceCriteria: [BEFORE, LIVE], mergeCommit: null }).where(eq(tickets.id, c.parent.id));
    const unmerged = await c.setState(c.dev.id, { ticketId: c.parent.id, state: "done", summary: "1 pass" });
    expect(unmerged.isError).toBe(true);
    expect(unmerged.text).toContain(`Not reported: "${LIVE.text}"`);
    expect((await c.row(c.parent.id)).systemState).toBe("blocked");
  });

  it("BOS-1867: a linked check can still be cancelled with no verdict, and an unlinked ticket isn't held to the numbered form", async () => {
    const c = await setup();
    const linked = await c.create(c.dev.id, { checksCriterion: { ticket: c.parent.id, criterion: 2 } });
    const plain = await c.create(c.dev.id, {});
    await c.db.update(tickets).set({ assigneeAgentId: c.dev.id, systemState: "in_progress" }).where(eq(tickets.id, linked.id!));
    await c.db.update(tickets).set({ assigneeAgentId: c.dev.id, systemState: "in_progress" }).where(eq(tickets.id, plain.id!));
    // Cancelling is the CEO's step.
    const cancelled = await c.setState(c.co.ceo.id, { ticketId: linked.id!, state: "done", outcome: "cancelled", summary: "Not needed: the parent was rescoped" });
    expect(cancelled.isError, cancelled.text).toBe(false);
    expect((await c.row(linked.id!)).systemState).toBe("done");
    const unlinked = await c.setState(c.dev.id, { ticketId: plain.id!, state: "done", outcome: "completed", summary: "Pass: 79 GitHub runs, none failed" });
    expect(unlinked.text).not.toContain("is the check for criterion");
  });
});

// BOS-2643: BOS-2302 and BOS-2298 merged within hours, then sat open 3 days on a "(checked after merge)" watch: the
// watchdog flagged them and the CEO cleared urgent marks. Boss Man now opens such a watch as its own check ticket when
// the build ticket is opened (or its criteria are set), so the build closes at go-live (BOS-2417) and the check reports.
describe("BOS-2643: a watch of a day or more is opened as its own check ticket", () => {
  const WATCH = { text: "Over 3 days live, no main CI run is cancelled for a higher priority waiting request", after: "merge" as const };
  const ONCE = { text: "One go-live reading shows the new comment", after: "merge" as const };
  const checksOf = async (c: Awaited<ReturnType<typeof setup>>, id: string) => c.db.select().from(tickets).where(eq(tickets.checksTicketId, id));

  it("create_ticket opens the check with the build's assignee; the build closes at go-live and the check's pass lands on it", async () => {
    const c = await setup();
    const made = await c.create(c.co.ceo.id, { title: "Give each main commit its own CI group", noCode: false, assignee: "Dev", acceptanceCriteria: [BEFORE, WATCH, ONCE] });
    expect(made.isError, made.text).toBe(false);
    expect(made.text).toContain('Criterion 2 needs a watch ("Over 3 days live")');
    const [check, ...more] = await checksOf(c, made.id!);
    expect(more).toEqual([]);
    expect([check!.checksCriterion, check!.assigneeAgentId, check!.systemState, check!.noCode]).toEqual([2, c.dev.id, "blocked", true]);
    expect(check!.acceptanceCriteria).toEqual([WATCH.text]);
    expect(check!.title).toMatch(/^Watch for [A-Z]+-\d+ criterion 2: Over 3 days live/);
    // One way only: the check waits on the build's merge, and the build waits on nothing, so it can start and merge.
    const deps = await c.db.select().from(ticketDependencies);
    expect(deps.filter((d) => d.blockedTicketId === check!.id).map((d) => [d.blockerTicketId, d.until])).toEqual([[made.id, "merged"]]);
    expect(deps.filter((d) => d.blockedTicketId === made.id)).toEqual([]);
    expect(await openBlockers(c.db, made.id!)).toEqual([]);
    expect((await openBlockers(c.db, check!.id)).map((b) => b.kind)).toEqual(["ticket"]);
    // The build merges: the check is free to start.
    await c.db.update(tickets).set({ mergeCommit: "b".repeat(40), systemState: "blocked", liveAt: new Date(), stateNote: "1 pass; 3 pass: the comment reads as merged" }).where(eq(tickets.id, made.id!));
    expect(await openBlockers(c.db, check!.id)).toEqual([]);
    // Once live, the build closes with only the tied watch left (BOS-2417), instead of sitting open for 3 days.
    const closed = await c.setState(c.dev.id, { ticketId: made.id!, state: "done", summary: "1 pass; 3 pass: the comment reads as merged" });
    expect(closed.isError, closed.text).toBe(false);
    expect((await c.row(made.id!)).systemState).toBe("done");
    // The watch ends: the check's pass is written on the build's criterion 2.
    await c.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, check!.id));
    const reported = await c.setState(c.dev.id, { ticketId: check!.id, state: "done", summary: "1 pass: no main run cancelled in 3 days" });
    expect(reported.isError, reported.text).toBe(false);
    expect((await c.row(made.id!)).stateNote).toMatch(/reported: 2 pass/);
  });

  it("update_ticket setting the criteria opens it too, once; a short after-merge check stays on the build", async () => {
    const c = await setup();
    const made = await c.create(c.co.ceo.id, { title: "Make the workflow comment honest", noCode: false, assignee: "Dev" });
    expect(await checksOf(c, made.id!)).toEqual([]);
    const set = await c.call(c.co.ceo.id, "update_ticket", { ticketId: made.id, acceptanceCriteria: [BEFORE, ONCE, { text: "A week on, every skipped publish is followed by a published one", after: "merge" }], reason: "criteria at assignment" });
    expect(set.isError, set.text).toBe(false);
    expect(set.text).toContain('Criterion 3 needs a watch ("A week on")');
    // Setting them again doesn't open a second check for the same criterion.
    await c.call(c.co.ceo.id, "update_ticket", { ticketId: made.id, acceptanceCriteria: [BEFORE, ONCE, { text: "A week on, every skipped publish is followed by a published one", after: "merge" }], reason: "same again" });
    const checks = await checksOf(c, made.id!);
    expect(checks.map((x) => [x.checksCriterion, x.assigneeAgentId])).toEqual([[3, c.dev.id]]);
  });

  it("an open ticket from before the change is left as it is: no sweep, and edits, moves and new criteria open nothing", async () => {
    const c = await setup();
    // A row as an older server left it: a code ticket with a 3-day watch and no check ticket, created before the change.
    const before = new Date(LONG_WATCH_FROM.getTime() - 3_600_000);
    const [old] = await c.db.insert(tickets).values({ companyId: c.co.company.id, projectId: c.project.id, title: "Old build with a watch", systemState: "ready", assigneeAgentId: c.dev.id, acceptanceCriteria: [BEFORE, WATCH], createdAt: before }).returning();
    const edited = await c.call(c.co.ceo.id, "update_ticket", { ticketId: old!.id, title: "Old build with a watch (renamed)", body: "More detail", reason: "tidy" });
    expect(edited.isError, edited.text).toBe(false);
    const moved = await c.setState(c.dev.id, { ticketId: old!.id, state: "in_progress" });
    expect(moved.isError, moved.text).toBe(false);
    // The CEO's approval condition: even setting its criteria again changes nothing on a ticket from before.
    const reset = await c.call(c.co.ceo.id, "update_ticket", { ticketId: old!.id, acceptanceCriteria: [BEFORE, WATCH], reason: "criteria again" });
    expect(reset.isError, reset.text).toBe(false);
    expect(reset.text).not.toContain("needs a watch");
    expect(await checksOf(c, old!.id)).toEqual([]);
    expect((await c.row(old!.id)).acceptanceCriteria).toEqual([BEFORE, WATCH]);
  });

  it("nothing is opened for a no-code ticket, a merged one, a check ticket, or a watch checked before merge", async () => {
    const c = await setup();
    const base = { companyId: c.co.company.id, projectId: c.project.id, systemState: "ready" as const, assigneeAgentId: c.dev.id };
    const [noCode] = await c.db.insert(tickets).values({ ...base, title: "Research", noCode: true, acceptanceCriteria: [WATCH] }).returning();
    const [merged] = await c.db.insert(tickets).values({ ...base, title: "Merged", mergeCommit: "c".repeat(40), acceptanceCriteria: [WATCH] }).returning();
    const [aCheck] = await c.db.insert(tickets).values({ ...base, title: "A check", checksTicketId: c.parent.id, checksCriterion: 2, acceptanceCriteria: [WATCH] }).returning();
    const [inReview] = await c.db.insert(tickets).values({ ...base, title: "Review-time", acceptanceCriteria: [WATCH.text] }).returning();
    for (const t of [noCode!, merged!, aCheck!, inReview!]) expect(await openLongWatchChecks(c.db, c.work, t.id, { byAgentId: null })).toEqual([]);
    // The same call on a code ticket opens one, and a second call opens nothing more.
    const [build] = await c.db.insert(tickets).values({ ...base, title: "Build", acceptanceCriteria: [WATCH] }).returning();
    expect(await openLongWatchChecks(c.db, c.work, build!.id, { byAgentId: null })).toHaveLength(1);
    expect(await openLongWatchChecks(c.db, c.work, build!.id, { byAgentId: null })).toEqual([]);
    expect(await checksOf(c, build!.id)).toHaveLength(1);
  });
});
