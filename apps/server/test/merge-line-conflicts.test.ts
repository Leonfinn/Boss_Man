// BOS-1411: two read-only warnings about work on the same code. A real conflict with a branch ahead in the merge
// line names the other ticket on the owner's sign-off card and in the CEO's brief; two branches touching different
// parts of one file give no warning; a plan sharing a file with an urgent in-review ticket gets an overlap note when
// it is approved; and nothing is ever linked automatically (no dependency rows) and no merge behaviour changes.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, decisions, reviewRequests, runners, runs, ticketDependencies, ticketMessages, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { buildBrief } from "../src/services/brief.js";
import { conflictNote, planFiles, planOverlapNote } from "../src/services/merge-line-conflicts.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/app.ts", added: 1, removed: 0 }], diff: "diff --git a/src/app.ts b/src/app.ts", truncated: false };
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const [senior] = await db.insert(agents).values({ companyId: company.id, name: "Sam", role: "worker", agentKind: "claude", title: "Senior Developer", template: "senior-dev" }).returning();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const sent: RunnerCommand[] = [];
  /** What the runner says about the merge line: by default a real clash with every approved branch it is asked about. */
  const conflictsWith = new Set<string>();
  const clash = () => conflictsWith.size > 0;
  built.runners.connect(
    reg.runnerId,
    (c) => {
      sent.push(c);
      const ok = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
      if (c.type === "workspace.diff") ok(DIFF);
      if (c.type === "workspace.verify") ok({ ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 });
      if (c.type === "workspace.merge") ok({ status: "merged", commit: "c".repeat(40) });
      if (c.type === "workspace.carried") ok({ carried: [] });
      if (c.type === "workspace.migrations") ok({ needed: false, reason: "free" });
      if (c.type === "workspace.mergeLine") ok({ conflicts: (c.branches as Array<{ ticketId: string; branch: string }>).filter((b) => conflictsWith.has(b.ticketId)).map((b) => ({ ticketId: b.ticketId, branch: b.branch, ahead: true, clashes: true, files: ["src/app.ts"] })) });
      return true;
    },
    ["carried-check", "clash-check", "merge-conflicts", "signoff-covers"],
  );
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const mcp = async (agentId: string) => {
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId });
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  /** A ticket in review, approved and sitting in the merge line (a merge_line "approved" row and no later row). */
  const approvedInLine = async (title: string, o: { risk?: "high" | "medium" } = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id, ...(o.risk ? { risk: o.risk } : {}) })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review" }).where(eq(tickets.id, t.id));
    await db.insert(activity).values({ companyId: company.id, ticketId: t.id, kind: "merge_line", summary: "Merge line: approved by Sam", detail: { event: "approved", by: "Sam" } });
    return t;
  };
  const cards = (ticketId: string, status?: "open" | "answered" | "withdrawn") =>
    db.select().from(decisions).where(and(sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`, ...(status ? [eq(decisions.status, status)] : [])));
  const briefMarkdown = () => buildBrief(db, { companyId: company.id, agentId: null, role: "ceo", since: null, now: new Date(), plain: true });
  return { ...built, db, req, company, ceo, senior: senior!, worker, project, row, mcp, approvedInLine, cards, sent, conflictsWith, clash, briefMarkdown };
}

describe("plan files (BOS-1411)", () => {
  it("reads the Files list from the shapes plans use, and ignores chatter", () => {
    expect(planFiles("## Files\n- `apps/server/src/services/review.ts`\n- packages/shared/src/protocol.ts\n\n## Steps\n1. do it")).toEqual(["apps/server/src/services/review.ts", "packages/shared/src/protocol.ts"]);
    expect(planFiles("Files: a.ts, b/c.ts")).toEqual(["a.ts", "b/c.ts"]);
    expect(planFiles("**Files:**\n- one.ts")).toEqual(["one.ts"]);
    expect(planFiles("No file list here.")).toEqual([]);
  });
});

describe("the conflict line's words (BOS-1411)", () => {
  it("names the ticket ahead and says a sign-off now will likely need signing again", () => {
    expect(conflictNote([{ ref: "BOS-1365", title: "x" }])).toBe("Conflicts with BOS-1365, which is ahead in the merge line. If you sign now, it'll likely need signing again after BOS-1365 lands.");
    expect(conflictNote([{ ref: "BOS-1", title: "a" }, { ref: "BOS-2", title: "b" }])).toContain("Conflicts with BOS-1 and BOS-2, which are ahead");
  });
  it("plan overlap note names the tickets and suggests a waits-on link", () => {
    const note = planOverlapNote([{ ticketId: "x", ref: "BOS-9", title: "Urgent fix", state: "review", urgent: true, files: ["src/a.ts"] }]);
    expect(note).toContain("BOS-9");
    expect(note).toContain("update_ticket waitsOn");
    expect(note).toContain("Nothing has been linked");
  });
});

describe("a real conflict on the sign-off card (BOS-1411)", () => {
  it("two branches editing the same lines: the card names the other ticket, and the CEO's brief does too", async () => {
    const c = await setup();
    const ahead = await c.approvedInLine("The urgent fix", { risk: "high" });
    const mine = await c.approvedInLine("The other change", { risk: "high" });
    c.conflictsWith.add(ahead.id);
    const r = await c.review.submit(mine.id, { verdict: "approved", reviewer: "Sam", reviewerAgentId: c.senior.id });
    expect(r.outcome).toBe("owner_review");
    const [card] = await c.cards(mine.id, "open");
    expect(card).toBeTruthy();
    expect(card!.question).toContain("Conflicts with");
    expect(card!.question).toContain("ahead in the merge line");
    expect(card!.question).toMatch(/APP-\d+|BOS-\d+|"The urgent fix"/);
    expect((card!.context as { conflictsBecause?: string }).conflictsBecause).toContain("If you sign now, it'll likely need signing again");
    // The brief the CEO gets carries the same line.
    const brief = await c.briefMarkdown();
    expect(brief).toContain("Merge-line conflicts");
    expect(brief).toContain("ahead in the merge line");
    // Nothing was linked automatically: no dependency between the two tickets (the sign-off card itself is a
    // dependency on a decision, never on the ticket ahead).
    expect(await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, mine.id), eq(ticketDependencies.blockerTicketId, ahead.id)))).toHaveLength(0);
    expect(await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, ahead.id), eq(ticketDependencies.blockerTicketId, mine.id)))).toHaveLength(0);
  });
});

describe("approved work still waiting to merge is probed too (BOS-1411)", () => {
  it("train members, seat-waiters and approved work blocked on a waits-on link are asked about; merged work is not", async () => {
    const c = await setup();
    const line = (id: string, detail: Record<string, unknown>, summary: string) => c.db.insert(activity).values({ companyId: c.company.id, ticketId: id, kind: "merge_line", summary, detail });
    const member = await c.approvedInLine("In the train", { risk: "high" });
    await line(member.id, { event: "check_queued", check: "x", way: "queue", train: { place: 1, ahead: 0 } }, "Merge line: check waiting for a slot");
    const waiter = await c.approvedInLine("Waiting for a seat", { risk: "high" });
    await line(waiter.id, { event: "hold_started", hold: "train" }, "Merge line: held, waiting for a train seat");
    const blocked = await c.approvedInLine("Approved but blocked", { risk: "high" });
    await c.db.update(tickets).set({ systemState: "blocked" }).where(eq(tickets.id, blocked.id));
    const merged = await c.approvedInLine("Already merged", { risk: "high" });
    await line(merged.id, { event: "merged", commit: null }, "Merge line: merged");
    const mine = await c.approvedInLine("Mine", { risk: "high" });
    for (const t of [member, waiter, blocked, merged]) c.conflictsWith.add(t.id);
    const found = await c.review.mergeLineClashes(mine.id);
    expect(found.map((f) => f.ticketId).sort()).toEqual([member.id, waiter.id, blocked.id].sort());
    const asked = c.sent.filter((s) => s.type === "workspace.mergeLine").flatMap((s) => (s as unknown as { branches: Array<{ ticketId: string }> }).branches.map((b) => b.ticketId));
    expect(asked).not.toContain(merged.id);
    expect(asked).not.toContain(mine.id);
  });
});

describe("different parts of one file: no warning (BOS-1411)", () => {
  it("the runner says the branches merge cleanly, so the card carries no conflict line and the CEO's brief has none", async () => {
    const c = await setup();
    await c.approvedInLine("One change", { risk: "high" });
    const mine = await c.approvedInLine("Another change", { risk: "high" });
    // conflictsWith stays empty: the runner answers with no conflicts.
    const r = await c.review.submit(mine.id, { verdict: "approved", reviewer: "Sam", reviewerAgentId: c.senior.id });
    expect(r.outcome).toBe("owner_review");
    const [card] = await c.cards(mine.id, "open");
    expect(card!.question).not.toContain("Conflicts with");
    expect((card!.context as { conflictsBecause?: string }).conflictsBecause).toBeUndefined();
    expect(await c.briefMarkdown()).not.toContain("Merge-line conflicts");
  });
});

describe("marking urgent warns too (BOS-1411)", () => {
  it("update_ticket urgent says the same line, and links nothing", async () => {
    const c = await setup();
    const ahead = await c.approvedInLine("Ahead", { risk: "high" });
    const mine = await c.approvedInLine("Mine", { risk: "high" });
    c.conflictsWith.add(ahead.id);
    expect(await c.review.mergeLineClashes(mine.id)).toHaveLength(1);
    const client = await c.mcp(c.ceo.id);
    const res = textOf(await client.callTool({ name: "update_ticket", arguments: { ticketId: mine.id, urgent: true, reason: "It fixes a live problem and should go first" } }));
    expect(res).toContain("updated");
    expect(res).toContain("Conflicts with");
    expect(res).toContain("ahead in the merge line");
    expect(await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, mine.id), eq(ticketDependencies.blockerTicketId, ahead.id)))).toHaveLength(0);
  });
});

describe("two open branches changing the same file (BOS-2179)", () => {
  it("a move to review records the branch's files; both tickets get one note and the page names the other ticket", async () => {
    const c = await setup();
    // Another open ticket whose branch already recorded src/app.ts (the runner's diff below changes it too).
    const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Other work on the app", assigneeAgentId: c.senior.id })).json() as { id: string };
    await c.db.update(tickets).set({ systemState: "in_progress", branch: `bossman/${other.id}`, diffFiles: ["src/app.ts", "pnpm-lock.yaml"] }).where(eq(tickets.id, other.id));
    const mine = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "My change", assigneeAgentId: c.worker.id })).json() as { id: string; version: number };
    await c.db.update(tickets).set({ systemState: "in_progress", branch: `bossman/${mine.id}` }).where(eq(tickets.id, mine.id));
    expect((await c.row(mine.id)).diffFiles).toEqual([]);
    const worker = await c.mcp(c.worker.id);
    const moved = textOf(await worker.callTool({ name: "set_ticket_state", arguments: { ticketId: mine.id, state: "review", summary: "Changed the app" } }));
    expect(moved).toContain("review");
    // Recorded after the move, without holding it up: wait for the note, with a deadline.
    const systemNotes = async (id: string) => (await c.db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, id), eq(ticketMessages.author, "system")))).map((m) => m.text).filter((t) => t.startsWith("Changes the same files"));
    const deadline = Date.now() + 10_000;
    while ((await systemNotes(other.id)).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect((await c.row(mine.id)).diffFiles).toEqual(["src/app.ts"]);
    expect(await systemNotes(mine.id)).toHaveLength(1);
    expect((await systemNotes(mine.id))[0]).toContain('"Other work on the app" (in progress): src/app.ts.');
    expect(await systemNotes(other.id)).toHaveLength(1);
    expect((await systemNotes(other.id))[0]).toContain('"My change" (in review): src/app.ts.');
    // The ticket page shows it on both sides.
    const page = (await c.req("GET", `/api/tickets/${mine.id}`)).json() as { branchOverlaps: Array<{ ticketId: string; files: string[]; more: number }> };
    expect(page.branchOverlaps).toEqual([expect.objectContaining({ ticketId: other.id, files: ["src/app.ts"], more: 0 })]);
    const otherPage = (await c.req("GET", `/api/tickets/${other.id}`)).json() as { branchOverlaps: Array<{ ticketId: string }> };
    expect(otherPage.branchOverlaps.map((o) => o.ticketId)).toEqual([mine.id]);
    // Advisory: nothing linked either way, and the move went through.
    expect((await c.row(mine.id)).systemState).toBe("review");
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, mine.id))).toHaveLength(0);
    expect(await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, other.id))).toHaveLength(0);
    // The review and the merge go ahead as before: an approval with the overlap still open merges the ticket.
    const r = await c.review.submit(mine.id, { verdict: "approved", reviewer: "Sam", reviewerAgentId: c.senior.id });
    expect(r.verdict).toBe("approved");
    const mergeDeadline = Date.now() + 20_000;
    while ((await c.row(mine.id)).systemState !== "done" && Date.now() < mergeDeadline) await new Promise((res) => setTimeout(res, 50));
    expect((await c.row(mine.id)).systemState).toBe("done");
    expect((await c.row(mine.id)).mergeCommit).toBe("c".repeat(40));
  });
});

describe("a plan sharing a file with an urgent in-review ticket (BOS-1411)", () => {
  it("gets the overlap note when approved, and never links anything", async () => {
    const c = await setup();
    const other = await c.approvedInLine("An urgent in-review ticket", { risk: "high" });
    await c.db.update(tickets).set({ urgent: true, diffFiles: ["src/review.ts"] }).where(eq(tickets.id, other.id));
    const mine = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Plan ticket", assigneeAgentId: c.worker.id, planFirst: true })).json() as { id: string };
    const plan = "## Plan\n\n## Files\n- `src/review.ts`\n- `src/other.ts`\n\n## Steps\n1. do it";
    const worker = await c.mcp(c.worker.id);
    const asked = textOf(await worker.callTool({ name: "submit_plan", arguments: { ticketId: mine.id, plan } }));
    const cardId = /Plan card ([0-9a-f-]{36})/.exec(asked)?.[1];
    expect(cardId).toBeTruthy();
    // The owner (or CEO, when the ladder is up) approves; the asker is woken with the answer and the overlap note.
    const answered = await c.req("POST", `/api/decisions/${cardId}/answer`, { answer: "Approve plan", note: "Go ahead" });
    expect(answered.statusCode).toBe(200);
    const allWakes = await c.db.select().from(wakes).where(eq(wakes.agentId, c.worker.id));
    const [woken] = allWakes.filter((w) => w.reason === "decision answered");
    expect(woken).toBeTruthy();
    expect(woken!.note).toContain("Plan overlap");
    expect(woken!.note).toMatch(/APP-\d+|BOS-\d+/);
    expect(woken!.note).toContain("Nothing has been linked");
    // Nothing linked: the plan ticket does not depend on the other, whichever way round.
    const deps = await c.db.select().from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, mine.id), eq(ticketDependencies.blockerTicketId, other.id)));
    expect(deps).toHaveLength(0);
  });
});
