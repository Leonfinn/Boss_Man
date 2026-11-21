// BOS-769: the merge line's timeline. Each approved ticket's pass through the line (approved, every merge check
// queued/started/ended, each hold with its reason, merged or left) is written as activity rows of kind
// "merge_line", so a jam's length can be measured afterwards. These tests drive real landings against a fake runner.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";

vi.hoisted(() => { process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20"; });
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, checkJobs, settings, tickets } from "../src/db/schema.js";
import { clashWords, lineEvent, MERGE_LINE_KIND, type MergeLineEvent } from "../src/services/merge-line.js";
import { buildBrief } from "../src/services/brief.js";
import { approveAndWait } from "./helpers.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});
afterAll(async () => {
  await (await app)?.app.close();
  await shared.close();
});

const DIFF: WorkspaceDiff = {
  baseCommit: "a".repeat(40),
  head: "b".repeat(40),
  commits: [{ sha: "b".repeat(40), subject: "Add rate limiting" }],
  files: [{ path: "src/limit.ts", added: 1, removed: 0 }],
  diff: "diff --git a/src/limit.ts b/src/limit.ts",
  truncated: false,
};
const PASS = { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 };
const FAIL = { ok: false, exitCode: 1, timedOut: false, output: "FAIL src/limit.test.ts: expected 1 got 2", ms: 5 };

type Answers = { verify?: unknown; merge?: unknown; carried?: unknown };

async function setup(answers: Answers = {}) {
  const a: Answers = { verify: PASS, merge: { status: "merged", commit: "c".repeat(40) }, carried: { carried: [] }, ...answers };
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "pnpm test" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.verify") reply(a.verify);
    if (c.type === "workspace.merge") reply(typeof a.merge === "function" ? (a.merge as (c: unknown) => unknown)(c) : a.merge);
    if (c.type === "workspace.carried") reply(a.carried);
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    return true;
  }, ["carried-check"]);
  const newTicket = async (title: string) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
    return t;
  };
  const ticket = await newTicket("Add rate limiting");
  const line = async (ticketId = ticket.id) =>
    (await db.select({ at: activity.at, detail: activity.detail, summary: activity.summary, agentId: activity.agentId }).from(activity).where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND))).orderBy(asc(activity.at))).map((r) => ({ ...r, detail: r.detail as unknown as MergeLineEvent }));
  return { ...built, db, req, company, worker, project, ticket, newTicket, sent, answers: a, line };
}

const events = (rows: Array<{ detail: MergeLineEvent }>) => rows.map((r) => r.detail.event);

describe("the merge line's timeline (BOS-769)", () => {
  it("records approved, the check's queue, start and end, and the merge, in time order", async () => {
    const c = await setup();
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    const rows = await c.line();
    expect(events(rows)).toEqual(["approved", "attempt", "check_queued", "check_started", "check_ended", "merged"]);
    expect(rows[0]!.detail).toMatchObject({ event: "approved", by: "the owner" });
    expect(rows.find((r) => r.detail.event === "check_ended")!.detail).toMatchObject({ check: "pnpm test", way: "gate", passed: true });
    expect(rows.at(-1)!.detail).toMatchObject({ event: "merged", commit: "c".repeat(40) });
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.at.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.at.getTime());
    // No agent on the rows, so "what did this run do" readers never count them as an agent's work.
    expect(rows.every((r) => r.agentId === null)).toBe(true);
  });

  it("records a failed check as passed: false, then the ticket leaving the line", async () => {
    const c = await setup({ verify: FAIL });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "verify_failed" });
    const rows = await c.line();
    expect(events(rows)).toEqual(["approved", "attempt", "check_queued", "check_started", "check_ended", "left", "attempt_failed"]);
    expect(rows[4]!.detail).toMatchObject({ passed: false });
    expect(rows[5]!.detail).toMatchObject({ event: "left", to: "in_progress" });
    expect(rows[6]!.detail).toMatchObject({ event: "attempt_failed", reason: "check_failed" });
  });

  it("records a carried-work hold with the tickets it waits on, once, and ends it when the merge goes ahead", async () => {
    const c = await setup();
    const other = await c.newTicket("Permission gate");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: `bossman/${other.id}` }] };
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "carried" });
    // A retry that is held for the same reason does not open a second hold.
    expect(await c.review.land(c.ticket.id, "Boss Man (retry)")).toMatchObject({ outcome: "carried" });
    let rows = await c.line();
    expect(events(rows)).toEqual(["approved", "attempt", "hold_started", "attempt"]);
    expect(rows[2]!.detail).toMatchObject({ event: "hold_started", hold: "carried", carried: [{ ticketId: other.id, title: "Permission gate" }] });
    // The other ticket merges, so the next attempt goes through: the hold ends when its check is queued.
    c.answers.carried = { carried: [] };
    expect(await c.review.land(c.ticket.id, "Boss Man (the ticket it waited for has merged)")).toMatchObject({ outcome: "merged" });
    rows = await c.line();
    expect(events(rows)).toEqual(["approved", "attempt", "hold_started", "attempt", "attempt", "hold_ended", "check_queued", "check_started", "check_ended", "merged"]);
    expect(rows[5]!.detail).toMatchObject({ hold: "carried", since: rows[2]!.at.toISOString() });
  });

  it("closes an open hold before the next event, with how long it lasted", async () => {
    const c = await setup();
    const t = { id: c.ticket.id, companyId: c.company.id };
    await lineEvent(c.db, t, { event: "approved", by: "Geoffrey" }, new Date("2026-11-07T08:00:00Z"));
    await lineEvent(c.db, t, { event: "hold_started", hold: "carried", carried: [{ ticketId: "x", title: "X" }] }, new Date("2026-11-07T08:01:00Z"));
    // The same hold again is not a new hold.
    await lineEvent(c.db, t, { event: "hold_started", hold: "carried", carried: [{ ticketId: "x", title: "X" }] }, new Date("2026-11-07T09:00:00Z"));
    // A retry in between that is held again doesn't end it: one jam is one hold.
    await lineEvent(c.db, t, { event: "attempt", by: "Boss Man" }, new Date("2026-11-07T12:00:00Z"));
    await lineEvent(c.db, t, { event: "check_queued", check: "pnpm test", way: "gate" }, new Date("2026-11-07T17:01:00Z"));
    const rows = await c.line();
    expect(events(rows)).toEqual(["approved", "hold_started", "attempt", "hold_ended", "check_queued"]);
    expect(rows[3]!.detail).toMatchObject({ event: "hold_ended", hold: "carried", since: "2026-11-07T08:01:00.000Z", heldMs: 9 * 3_600_000 });
    expect(rows[3]!.at.toISOString()).toBe("2026-11-07T17:01:00.000Z");
    expect(rows[4]!.at.getTime()).toBeGreaterThan(rows[3]!.at.getTime());
  });

  it("ends a hold when the ticket is sent back, and writes nothing for a ticket that was never approved", async () => {
    const c = await setup();
    const other = await c.newTicket("Permission gate");
    c.answers.carried = { carried: [{ ticketId: other.id, branch: `bossman/${other.id}` }] };
    await approveAndWait(c.req, c.ticket.id);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "in_progress" });
    expect(events(await c.line())).toEqual(["approved", "attempt", "hold_started", "hold_ended", "left"]);
    // "Permission gate" was in review but never approved: moving it out leaves no row.
    await c.req("PATCH", `/api/tickets/${other.id}`, { state: "in_progress" });
    expect(await c.line(other.id)).toEqual([]);
  });

  it("takes a queued check's wait, start and end from its job in the server check queue", async () => {
    const prepared = { status: "prepared", commit: "f".repeat(40), tree: "9".repeat(40), targetSha: "1".repeat(40), branchSha: "b".repeat(40) };
    const c = await setup({ merge: (x: { phase?: string }) => (x.phase === "prepare" ? prepared : { status: "merged", commit: prepared.commit }) });
    await c.db.insert(settings).values({ key: "check_queue_mode", value: "server" });
    const res = approveAndWait(c.req, c.ticket.id);
    let job: typeof checkJobs.$inferSelect | undefined;
    for (let i = 0; i < 100 && !job; i++) {
      [job] = await c.db.select().from(checkJobs).where(eq(checkJobs.ticketId, c.ticket.id));
      if (!job) await new Promise((r) => setTimeout(r, 20));
    }
    // Plays the dispatcher; the poll notices each change a little later, but the rows carry the job's own times.
    const startedAt = new Date();
    await c.db.update(checkJobs).set({ state: "running", startedAt }).where(eq(checkJobs.id, job!.id));
    await new Promise((r) => setTimeout(r, 100));
    const endedAt = new Date();
    await c.db.update(checkJobs).set({ state: "passed", exitCode: 0, endedAt }).where(eq(checkJobs.id, job!.id));
    expect((await res).json()).toMatchObject({ outcome: "merged" });
    const rows = await c.line();
    expect(events(rows)).toEqual(["approved", "attempt", "check_queued", "check_started", "check_ended", "merged"]);
    expect(rows[3]!.detail).toMatchObject({ way: "queue", jobId: job!.id });
    expect(rows[3]!.at.toISOString()).toBe(startedAt.toISOString());
    expect(rows[4]!.detail).toMatchObject({ passed: true });
    expect(rows[4]!.at.toISOString()).toBe(endedAt.toISOString());
  });

  // Nothing in the server deletes activity or check_jobs rows (no retention job); this guards against one
  // being added that would cut Moony's history short. A full pass through the line runs in between.
  it("keeps records and merge-check results older than 30 days readable", async () => {
    const c = await setup();
    const old = await c.newTicket("Old work");
    const day = 24 * 60 * 60 * 1000;
    const at = (days: number) => new Date(Date.now() - days * day);
    await lineEvent(c.db, { id: old.id, companyId: c.company.id }, { event: "check_ended", check: "pnpm test", way: "gate", passed: true }, at(41));
    await lineEvent(c.db, { id: old.id, companyId: c.company.id }, { event: "merged", commit: "d".repeat(40) }, at(40));
    const [job] = await c.db.insert(checkJobs).values({ companyId: c.company.id, projectId: c.project.id, ticketId: old.id, kind: "merge", scope: "full", commit: "e".repeat(40), tree: "8".repeat(40), state: "passed", exitCode: 0, queuedAt: at(41), startedAt: at(41), endedAt: at(40) }).returning();
    await approveAndWait(c.req, c.ticket.id);
    expect(events(await c.line(old.id))).toEqual(["check_ended", "merged"]);
    expect((await c.line(old.id))[0]!.detail).toMatchObject({ passed: true });
    expect(await c.db.select().from(checkJobs).where(eq(checkJobs.id, job!.id))).toHaveLength(1);
  });

  it("keeps the rows out of the agents' brief", async () => {
    const c = await setup();
    await approveAndWait(c.req, c.ticket.id);
    expect((await c.line()).length).toBeGreaterThan(0);
    const brief = await buildBrief(c.db, { companyId: c.company.id, agentId: c.worker.id, role: "worker", since: null, now: new Date() });
    expect(brief).not.toContain("Merge line:");
  });

  // The worker brief above only lists open tickets, so it would pass even with no filter. The CEO brief lists every
  // company change, so this one fails if the merge_line filter in the brief is removed (checked in a scratch copy).
  it("keeps the rows out of the CEO's 'Changes since the last brief' list, while ordinary changes still show", async () => {
    const c = await setup();
    await approveAndWait(c.req, c.ticket.id);
    expect((await c.line()).length).toBeGreaterThan(0);
    await lineEvent(c.db, { id: c.ticket.id, companyId: c.company.id }, { event: "left", to: "in_progress" }, new Date());
    await c.db.insert(activity).values({ companyId: c.company.id, ticketId: c.ticket.id, kind: "state", summary: "Moved to in_progress by the owner", at: new Date() });
    const brief = await buildBrief(c.db, { companyId: c.company.id, agentId: c.worker.id, role: "ceo", since: null, now: new Date() });
    expect(brief).toContain("Moved to in_progress by the owner");
    expect(brief).not.toContain("Merge line:");
  });
});

describe("clashWords", () => {
  it("says who clashed and nothing about files when there is no clash", () => {
    expect(clashWords([], [])).toBe("the tickets ahead");
    expect(clashWords([], [], 0)).toBe("the tickets ahead");
  });

  it("counts one file in the singular, naming the file", () => {
    expect(clashWords(["BOS-1471"], ["src/limit.ts"])).toBe("BOS-1471 in 1 file (src/limit.ts)");
  });

  it("names several clashing tickets and files, counting and listing them", () => {
    expect(clashWords(["BOS-1", "BOS-2"], ["a.ts", "b.ts"])).toBe("BOS-1, BOS-2 in 2 files (a.ts, b.ts)");
  });

  it("falls back to 'the tickets ahead' when no ticket is named, still counting the files", () => {
    expect(clashWords([], ["a.ts", "b.ts", "c.ts"])).toBe("the tickets ahead in 3 files (a.ts, b.ts, c.ts)");
  });

  it("shows at most three files and marks the rest with an ellipsis", () => {
    expect(clashWords(["main"], ["a.ts", "b.ts", "c.ts", "d.ts"])).toBe("main in 4 files (a.ts, b.ts, c.ts, …)");
  });

  it("uses the explicit total when only some files were kept, and counts even with none kept", () => {
    expect(clashWords(["main"], ["a.ts", "b.ts"], 30)).toBe("main in 30 files (a.ts, b.ts, …)");
    expect(clashWords(["main"], [], 7)).toBe("main in 7 files");
  });
});
