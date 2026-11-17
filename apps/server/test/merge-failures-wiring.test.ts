// BOS-1461: every reason code is written by the real merge path (review.land) and not only by recordFailedAttempt, and
// the repeated-failure card closes by itself through the sweep. Landings run against a fake runner.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";

vi.hoisted(() => { process.env.BOSSMAN_CHECK_JOB_POLL_MS = "20"; });
import type { RunnerCommand, WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { sharedDatabase } from "./helpers/shared-server.js";
import { activity, decisions, tickets } from "../src/db/schema.js";
import { MERGE_LINE_KIND, type MergeLineEvent } from "../src/services/merge-line.js";
import { LOCK_RETRY_ATTEMPTS, setInfraRetryBase, setLockRetryBase } from "../src/services/review.js";
import { recordFailedAttempt } from "../src/services/merge-failures.js";
import { approveAndWait } from "./helpers.js";

let shared: Awaited<ReturnType<typeof sharedDatabase>>;
let app: ReturnType<typeof buildApp> | undefined;
beforeAll(async () => {
  shared = await sharedDatabase();
  setLockRetryBase(1);
  setInfraRetryBase(1);
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
const GAVE_UP = { ok: false, exitCode: 75, timedOut: false, output: "check-all: gave up waiting for the heavy-phase lock /tmp/x.lock", ms: 600_000 };
const MERGED = { status: "merged", commit: "c".repeat(40) };

type Answers = { verify?: unknown; merge?: unknown; carried?: unknown };

async function setup(answers: Answers = {}) {
  const a: Answers = { verify: PASS, merge: MERGED, carried: { carried: [] }, ...answers };
  await shared.reset();
  const { db } = shared;
  const built = await (app ??= buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git", verifyCommand: "scripts/check-all.sh" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  let offline = false;
  built.runners.connect(reg.runnerId, (c) => {
    // A merge that finds the runner gone is what a runner restart looks like to the server (RunnerGone).
    if (offline && c.type === "workspace.merge") return false;
    sent.push(c);
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(DIFF);
    if (c.type === "workspace.verify") reply(typeof a.verify === "function" ? (a.verify as (c: unknown) => unknown)(c) : a.verify);
    if (c.type === "workspace.merge") reply(typeof a.merge === "function" ? (a.merge as (c: unknown) => unknown)(c) : a.merge);
    if (c.type === "workspace.carried") {
      if (a.carried === "error") queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: false, error: "runner busy" }));
      else reply(a.carried);
    }
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "Nothing taken." });
    return true;
  }, ["carried-check"]);
  const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.update(tickets).set({ branch: `bossman/${t.id}` }).where(eq(tickets.id, t.id));
  const failed = async () =>
    (await db.select({ detail: activity.detail }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, MERGE_LINE_KIND))).orderBy(asc(activity.at)))
      .map((r) => r.detail as unknown as MergeLineEvent)
      .filter((e): e is Extract<MergeLineEvent, { event: "attempt_failed" }> => e.event === "attempt_failed");
  return { ...built, db, req, company, project, ticket: t, sent, failed, goOffline: () => (offline = true), answers: a };
}

describe("each reason is written by the real merge path (BOS-1461)", () => {
  it("conflict: the branch conflicts with main", async () => {
    const c = await setup({ merge: { status: "conflicts", files: ["src/limit.ts"] } });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "conflicts" });
    expect(await c.failed()).toMatchObject([{ reason: "conflict" }]);
    // And the real server_status service carries it (the wiring in app.ts).
    expect(await c.serverStatus.status(c.company.id)).toMatchObject({ mergeFailures: { lastHour: 1, byReason: { conflict: 1 } } });
  });

  it("landing_refused: uncommitted work", async () => {
    const c = await setup({ merge: { status: "uncommitted", files: ["draft.ts"] } });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "uncommitted" });
    expect(await c.failed()).toMatchObject([{ reason: "landing_refused", note: "uncommitted" }]);
  });

  it("landing_refused: a migration journal problem", async () => {
    const c = await setup({ merge: { status: "migration_journal", problems: ["entry 12 is older than 11"] } });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "migration_journal" });
    expect(await c.failed()).toMatchObject([{ reason: "landing_refused", note: "migration_journal" }]);
  });

  it("main_moved: one row each time main moved under a try, then the merge goes through", async () => {
    let calls = 0;
    const c = await setup({ merge: () => (++calls <= 2 ? { status: "main_moved" } : MERGED) });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect((await c.failed()).map((e) => e.reason)).toEqual(["main_moved", "main_moved"]);
  });

  it("main moving on every try gives up with a card for the CEO, not a crash (BOS-1604)", async () => {
    // A main_moved lock wait has no command or output; on 15 Nov the give-up read output.slice and threw.
    const c = await setup({ merge: { status: "main_moved" } });
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "check_stuck" });
    expect((await c.failed()).map((e) => e.reason)).toEqual(Array(LOCK_RETRY_ATTEMPTS).fill("main_moved"));
    const cards = await c.db.select({ question: decisions.question }).from(decisions).where(eq(decisions.companyId, c.company.id));
    expect(cards.filter((d) => d.question.includes("kept finding that main had moved before it could land"))).toHaveLength(1);
  }, 30_000);

  it("lock_timeout: no row on the retries, one when the tries have run out", async () => {
    const c = await setup({ verify: GAVE_UP });
    await approveAndWait(c.req, c.ticket.id);
    expect(c.sent.filter((x) => x.type === "workspace.verify")).toHaveLength(LOCK_RETRY_ATTEMPTS);
    expect(await c.failed()).toMatchObject([{ reason: "lock_timeout" }]);
  }, 30_000);

  it("restart: the runner went away under the merge", async () => {
    const c = await setup();
    c.goOffline();
    await approveAndWait(c.req, c.ticket.id);
    const rows = await c.failed();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((e) => e.reason === "restart")).toBe(true);
  }, 30_000);

  it("gate_fault: the merge could not run at all", async () => {
    const c = await setup({ carried: "error" });
    // A carried-work check that errors needs another approved ticket on the line to be asked at all; the error path is the same.
    const other = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Other", state: "review" })).json() as { id: string };
    await c.db.update(tickets).set({ branch: `bossman/${other.id}` }).where(eq(tickets.id, other.id));
    await approveAndWait(c.req, c.ticket.id);
    const rows = await c.failed();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)).toMatchObject({ reason: "gate_fault" });
  }, 30_000);

  it("writes nothing when the ticket merges cleanly", async () => {
    const c = await setup();
    expect((await approveAndWait(c.req, c.ticket.id)).json()).toMatchObject({ outcome: "merged" });
    expect(await c.failed()).toEqual([]);
  });
});

describe("the repeated-failure card (BOS-1461)", () => {
  let ctx: Awaited<ReturnType<typeof setupClock>> | undefined;
  afterEach(async () => {
    await ctx?.built.app.close();
    await ctx?.close();
    ctx = undefined;
  });

  async function setupClock() {
    const { db, close } = await openPglite();
    let offset = 0;
    const clock = () => new Date(Date.now() + offset);
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
    const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "T" })).json() as { id: string };
    const fail = (reason: "conflict" | "restart") =>
      recordFailedAttempt(db, { alert: (i) => built.alerts.raise(i as Parameters<typeof built.alerts.raise>[0]), now: clock }, { id: ticket.id, companyId: company.id }, reason);
    const open = async () => (await db.select().from(decisions)).filter((d) => d.dedupeKey?.startsWith("merge-failures:") && d.status === "open");
    const sweep = () => req("POST", "/api/sweep");
    return { built, db, close, company, fail, open, sweep, advance: (ms: number) => (offset += ms) };
  }

  it("is one card however many failures follow, and closes only after 30 quiet minutes", async () => {
    ctx = await setupClock();
    const m = 60_000;
    for (let i = 0; i < 3; i++) await ctx.fail("conflict");
    expect(await ctx.open()).toHaveLength(1);
    // Young card, failures inside the window: stays open.
    await ctx.sweep();
    expect(await ctx.open()).toHaveLength(1);
    // A 4th failure while the card is open folds into the same card.
    ctx.advance(20 * m);
    await ctx.fail("conflict");
    expect(await ctx.open()).toHaveLength(1);
    // 25 minutes after the last failure: still inside the window.
    ctx.advance(25 * m);
    await ctx.sweep();
    expect(await ctx.open()).toHaveLength(1);
    // 35 minutes after the last failure and the card well past 30 minutes old: calm, so it closes.
    ctx.advance(10 * m);
    await ctx.sweep();
    expect(await ctx.open()).toHaveLength(0);
  }, 30_000);

  it("stays open while a failure of its own reason is inside the window, whatever the card's age", async () => {
    ctx = await setupClock();
    const m = 60_000;
    for (let i = 0; i < 3; i++) await ctx.fail("conflict");
    ctx.advance(40 * m);
    await ctx.fail("conflict");
    await ctx.sweep();
    expect(await ctx.open()).toHaveLength(1);
    // Another reason's failures don't count for this card.
    ctx.advance(31 * m);
    await ctx.fail("restart");
    await ctx.sweep();
    expect(await ctx.open()).toHaveLength(0);
  }, 30_000);
});
