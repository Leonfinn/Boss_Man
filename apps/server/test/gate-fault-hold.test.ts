// BOS-1173: approved work waiting on a merge-check fix stays approved and waits in "Passed, held". Each test fails on
// the code before this ticket: the merge path ignored waits-on links and ran the broken check, a failed check always
// sent the ticket back, and every move into review opened a new review round whatever the head.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SENIOR_DEV_TEMPLATE, type RunnerCommand, type WorkspaceDiff } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, projects, reviewHolds, reviewRequests, runners, settings, ticketDependencies, tickets } from "../src/db/schema.js";
import { holdView } from "../src/services/review-holds.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined as never;
});

const HEAD = "b".repeat(40);
const LATER = "d".repeat(40);
const MERGE = "c".repeat(40);
const RED = { ok: false, exitCode: 1, timedOut: false, output: "FAIL test:web (browser tests skipped in the check job)", ms: 5 };

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/site.git" });
  await db.update(projects).set({ verifyCommand: "pnpm check" }).where(eq(projects.id, project.id));
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  const state = { head: HEAD, verify: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 } as typeof RED | { ok: true; exitCode: 0; timedOut: false; output: string; ms: number }, covers: false, onVerify: null as null | (() => Promise<void>), files: ["src/a.ts"] };
  const diff = (): WorkspaceDiff => ({ baseCommit: "a".repeat(40), head: state.head, commits: [{ sha: state.head, subject: "Add it" }], files: state.files.map((path) => ({ path, added: 1, removed: 0 })), diff: "diff --git a/src/a.ts b/src/a.ts\n+x", truncated: false });
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const reply = (data: unknown) => queueMicrotask(() => built.runners.resolveReply({ requestId: (c as { requestId: string }).requestId, ok: true, data }));
    if (c.type === "workspace.diff") reply(diff());
    if (c.type === "workspace.verify") void (state.onVerify?.() ?? Promise.resolve()).then(() => reply(state.verify));
    if (c.type === "workspace.merge") reply({ status: "merged", commit: MERGE });
    if (c.type === "workspace.migrations") reply({ needed: false, reason: "none" });
    if (c.type === "workspace.carried") reply({ carried: [] });
    if (c.type === "workspace.covers") reply({ covers: state.covers, reason: state.covers ? "only main merged in" : "new code", newCommits: 0, handMerges: 0 });
    return true;
  }, ["carried-check", "signoff-covers"]);
  const hire = async (name: string, set: Partial<typeof agents.$inferInsert> = {}) => {
    const a = (await req("POST", `/api/companies/${company.id}/agents`, { name })).json() as { id: string };
    if (Object.keys(set).length) await db.update(agents).set(set).where(eq(agents.id, a.id));
    return a;
  };
  const worker = await hire("Engineer");
  const reviewer = await hire("Reviewer", { template: SENIOR_DEV_TEMPLATE });
  const ticket = async (title: string, set: Partial<typeof tickets.$inferInsert> = {}) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
    await db.update(tickets).set({ assigneeAgentId: worker.id, systemState: "review", branch: `bossman/${t.id}`, ...set }).where(eq(tickets.id, t.id));
    return t.id;
  };
  const slot = async (ticketId: string, round = 1) => (await db.insert(reviewRequests).values({ ticketId, kind: "code", reviewerAgentId: reviewer.id, round }).returning())[0]!;
  const approve = (ticketId: string) => built.review.submit(ticketId, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: reviewer.id });
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const rounds = async (id: string) => db.select().from(reviewRequests).where(eq(reviewRequests.ticketId, id));
  const verifies = () => sent.filter((c) => c.type === "workspace.verify").length;
  const merges = () => sent.filter((c) => c.type === "workspace.merge").length;
  return { ...built, db, close, req, company, project, worker, reviewer, ticket, slot, approve, row, rounds, verifies, merges, state };
}

/** Waits for the background merge to finish (the landing marker says when), with a deadline rather than a fixed sleep. */
async function settled(id: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const l = await ctx.review.landing(id);
    if (l?.state === "finished") return l;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the merge never finished");
}

/** The owner moves a ticket on the board (one real move: a review round only if Boss Man opens one). */
const move = (id: string, state: string) => ctx.req("POST", `/api/tickets/${id}/state`, { state });

describe("an approved ticket that waits on another ticket is held, not checked or sent back (criterion 1)", () => {
  it("holds on its waits-on link: no check runs, it stays in review, Passed, held shows the link, no loop failure", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix the merge check", { systemState: "in_progress" });
    const id = await ctx.ticket("Approved work");
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: id, blockerTicketId: fix, until: "merged" });
    await ctx.slot(id);
    const out = await ctx.approve(id);
    expect(out).toMatchObject({ verdict: "approved", outcome: "held" });
    expect(ctx.verifies()).toBe(0);
    expect(ctx.merges()).toBe(0);
    expect((await ctx.row(id)).systemState).toBe("review");
    const view = await holdView(ctx.db, id);
    expect(view).toMatchObject({ system: true, reviewer: null, ready: false });
    expect(view!.label).toMatch(/^waits on /);
    expect((await ctx.rounds(id))[0]!.status).toBe("approved");
    expect(await ctx.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "merge_failed")))).toHaveLength(0);
    // The board puts it in the held lane.
    const board = (await ctx.req("GET", `/api/projects/${ctx.project.id}/board`)).json() as { columns: Array<{ tickets: Array<{ id: string; reviewStage?: string }> }> };
    expect(board.columns.flatMap((c) => c.tickets).find((t) => t.id === id)?.reviewStage).toBe("held");
  });

  it("a plain ordering link releases at the blocker's merge, with no wait for a deploy", async () => {
    ctx = await setup();
    const first = await ctx.ticket("Lands first", { systemState: "in_progress" });
    const id = await ctx.ticket("Approved work");
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: id, blockerTicketId: first, until: "merged" });
    await ctx.slot(id);
    expect(await ctx.approve(id)).toMatchObject({ outcome: "held" });
    await ctx.db.update(tickets).set({ mergeCommit: "e".repeat(40), mergedAt: new Date(), touchesRunner: true }).where(eq(tickets.id, first));
    await ctx.db.insert(settings).values({ key: `live_release:${ctx.company.id}`, value: { new: "9".repeat(40) } });
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
  });

  it("waiting on the merge-check fix: merges by itself once the fix is merged and live, keeping the reviews; not before", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix the merge check", { systemState: "in_progress", fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.db.insert(ticketDependencies).values({ blockedTicketId: id, blockerTicketId: fix, until: "merged" });
    await ctx.slot(id);
    await ctx.approve(id);
    // Not merged yet: nothing is released.
    expect(await ctx.review.releaseHolds()).toEqual([]);
    // Merged runner code, live on the server, but the runners still run an older image: not in force yet.
    const fixMerge = "e".repeat(40);
    await ctx.db.update(tickets).set({ mergeCommit: fixMerge, mergedAt: new Date(), touchesRunner: true, systemState: "in_progress" }).where(eq(tickets.id, fix));
    await ctx.db.insert(settings).values({ key: `live_release:${ctx.company.id}`, value: { new: fixMerge } });
    await ctx.db.update(runners).set({ imageCommit: "f".repeat(40) }).where(eq(runners.companyId, ctx.company.id));
    expect(await ctx.review.releaseHolds()).toEqual([]);
    expect(await holdView(ctx.db, id)).not.toBeNull();
    // The owner rebuilds the runners from the fix: now it is in force, and the held merge starts by itself.
    await ctx.db.update(runners).set({ imageCommit: fixMerge }).where(eq(runners.companyId, ctx.company.id));
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
    expect(await holdView(ctx.db, id)).toBeNull();
    expect(ctx.verifies()).toBe(1);
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
    // One round, still approved: nobody reviewed it again.
    expect((await ctx.rounds(id)).map((r) => [r.round, r.status])).toEqual([[1, "approved"]]);
  });
});

describe("a ticket marked as fixing the merge check holds other approved work (criterion 2)", () => {
  it("holds other merges before the check runs; the fix itself still runs its check", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix the merge check", { fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    expect(await ctx.approve(id)).toMatchObject({ outcome: "held" });
    expect(ctx.verifies()).toBe(0);
    expect((await holdView(ctx.db, id))!.system).toBe(true);
    // The fix ticket is not held by its own mark.
    await ctx.slot(fix);
    await ctx.approve(fix);
    expect(ctx.verifies()).toBe(1);
    expect((await ctx.row(fix)).mergeCommit).toBe(MERGE);
  });

  it("a check that fails after the fix was marked mid-check holds the ticket instead of sending it back", async () => {
    ctx = await setup();
    ctx.state.verify = RED;
    const fix = await ctx.ticket("Fix the merge check", { systemState: "in_progress" });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    // The CEO marks the fix while this ticket's check is running.
    ctx.state.onVerify = () => ctx.db.update(tickets).set({ fixesMergeCheck: true }).where(eq(tickets.id, fix)).then(() => undefined);
    expect(await ctx.approve(id)).toMatchObject({ outcome: "held" });
    expect(ctx.verifies()).toBe(1);
    expect((await ctx.row(id)).systemState).toBe("review");
    expect((await holdView(ctx.db, id))!.system).toBe(true);
    // Not counted against the author, and no failure trail.
    expect(await ctx.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "merge_failed")))).toHaveLength(0);
    expect((await ctx.rounds(id))[0]!.status).toBe("approved");
  });

  it("without a mark or link, a failed check still sends the ticket back (unchanged)", async () => {
    ctx = await setup();
    ctx.state.verify = RED;
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    await ctx.approve(id);
    expect((await ctx.row(id)).systemState).toBe("in_progress");
    expect(await holdView(ctx.db, id)).toBeNull();
  });
});

describe("back in review on the head its reviews passed keeps the approvals (criterion 3)", () => {
  const roundTrip = async (move: (id: string) => Promise<unknown>) => {
    const id = await ctx.ticket("Approved work", { risk: "low" });
    await ctx.slot(id);
    ctx.state.verify = RED;
    await ctx.approve(id);
    expect((await ctx.row(id)).systemState).toBe("in_progress");
    ctx.state.verify = { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 5 };
    await move(id);
    return id;
  };

  it("same head: no new round, the pass stands and the merge goes on", async () => {
    ctx = await setup();
    const id = await roundTrip((id) => move(id, "review"));
    await settled(id);
    const rows = await ctx.rounds(id);
    expect(rows.map((r) => [r.round, r.status])).toEqual([[1, "approved"]]);
    expect(rows[0]!.head).toBe(HEAD);
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
    expect(await ctx.db.select().from(activity).where(and(eq(activity.ticketId, id), eq(activity.kind, "review_kept")))).toHaveLength(1);
  });

  it("new code on the branch: a new round, as before", async () => {
    ctx = await setup();
    const id = await roundTrip(async (id) => {
      ctx.state.head = LATER;
      return move(id, "review");
    });
    const rows = await ctx.rounds(id);
    expect(rows.filter((r) => r.round === 2 && r.status === "pending")).toHaveLength(1);
  });

  it("only clean main merges since: the pass stands (DR-038)", async () => {
    ctx = await setup();
    const id = await roundTrip(async (id) => {
      ctx.state.head = LATER;
      ctx.state.covers = true;
      return move(id, "review");
    });
    await settled(id);
    expect((await ctx.rounds(id)).map((r) => r.round)).toEqual([1]);
  });

  it("a runner that can't say the head opens a new round (the safe way)", async () => {
    ctx = await setup();
    const id = await roundTrip(async (id) => {
      ctx.state.head = "";
      return move(id, "review");
    });
    expect((await ctx.rounds(id)).some((r) => r.round === 2)).toBe(true);
  });

  it("a review round opened on unchanged code with no verdict yet is withdrawn by the sweep step; one with a verdict is left", async () => {
    ctx = await setup();
    const id = await ctx.ticket("Re-reviewed work");
    const first = await ctx.slot(id);
    await ctx.db.update(reviewRequests).set({ status: "approved", decidedAt: new Date(), head: HEAD }).where(eq(reviewRequests.id, first.id));
    await ctx.slot(id, 2);
    const other = await ctx.ticket("Half re-reviewed");
    const o1 = await ctx.slot(other);
    await ctx.db.update(reviewRequests).set({ status: "approved", decidedAt: new Date(), head: HEAD }).where(eq(reviewRequests.id, o1.id));
    await ctx.db.insert(reviewRequests).values({ ticketId: other, kind: "code", reviewerAgentId: ctx.reviewer.id, round: 2, status: "approved", decidedAt: new Date() });
    await ctx.db.insert(reviewRequests).values({ ticketId: other, kind: "security", reviewerAgentId: ctx.reviewer.id, round: 2 });
    expect(await ctx.review.withdrawRepeatRounds(new Set())).toEqual([id]);
    expect((await ctx.rounds(id)).map((r) => r.round)).toEqual([1]);
    expect((await ctx.rounds(other)).filter((r) => r.round === 2)).toHaveLength(2);
  });
});

// BOS-1609: BOS-1607 fixed main's red test with a test-only change, and every merge held on it stayed held until the
// next server update, because "in force" meant "merged and live" and a test file never goes live. These fail on the
// code before it: the hold waited for the server to run the fix's merge.
describe("a merge-check fix that needs no deploy releases at merge (BOS-1609)", () => {
  const FIX_MERGE = "e".repeat(40);
  /** The fix merges with these facts while the server still runs an older commit, as on 15 Nov. */
  const mergeFix = async (fix: string, deploysNothing: boolean | null) => {
    await ctx.db.update(tickets).set({ mergeCommit: FIX_MERGE, mergedAt: new Date(), touchesRunner: false, deploysNothing, systemState: "done" }).where(eq(tickets.id, fix));
    await ctx.db.insert(settings).values({ key: `live_release:${ctx.company.id}`, value: { new: "9".repeat(40) } });
  };

  it("Boss Man's own hold on a marked fix: a test-only fix releases it while the server still runs the old code", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix main's red test", { systemState: "in_progress", fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    expect(await ctx.approve(id)).toMatchObject({ outcome: "held" });
    await mergeFix(fix, true);
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
    // The whole gate ran on the released merge: nothing was skipped.
    expect(ctx.verifies()).toBe(1);
  });

  it("a reviewer's hold that waits only on the fix releases the same way", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix main's red test", { systemState: "in_progress", fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    await ctx.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: ctx.reviewer.id, hold: { reason: "Wait for the merge-check fix", waitsOn: [{ ticketId: fix }], releaseAt: null } });
    await mergeFix(fix, true);
    expect((await holdView(ctx.db, id))!.ready).toBe(true);
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
  });

  it.each([
    ["changed app code", false],
    ["merged with an unknown file list", null],
  ] as const)("a fix that %s still waits until it is live", async (_label, deploysNothing) => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix the merge check", { systemState: "in_progress", fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    expect(await ctx.approve(id)).toMatchObject({ outcome: "held" });
    await mergeFix(fix, deploysNothing);
    expect(await ctx.review.releaseHolds()).toEqual([]);
    expect((await holdView(ctx.db, id))!.ready).toBe(false);
    // Live now: released as before.
    await ctx.db.update(settings).set({ value: { new: FIX_MERGE } }).where(eq(settings.key, `live_release:${ctx.company.id}`));
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
  });

  it("the merge records whether its files need a deploy", async () => {
    ctx = await setup();
    const testOnly = await ctx.ticket("Fix a test", { fixesMergeCheck: true });
    ctx.state.files = ["apps/server/test/compose-memory-limits.test.ts", "docs/10-migrations.md"];
    await ctx.slot(testOnly);
    // A direct approval runs the merge before it returns (as for the fix in criterion 2).
    await ctx.approve(testOnly);
    expect((await ctx.row(testOnly))).toMatchObject({ mergeCommit: MERGE, deploysNothing: true });
    const code = await ctx.ticket("Fix the gate");
    ctx.state.files = ["apps/server/test/x.test.ts", "apps/server/src/services/review.ts"];
    await ctx.slot(code);
    await ctx.approve(code);
    expect((await ctx.row(code))).toMatchObject({ mergeCommit: MERGE, deploysNothing: false });
  });
});

describe("a reviewer's hold placed only for a gate fault ends by itself (criterion 5)", () => {
  it("releases with no re-check once the marked fix is merged and live; any other reviewer hold still wakes the reviewer", async () => {
    ctx = await setup();
    const fix = await ctx.ticket("Fix the merge check", { systemState: "in_progress", fixesMergeCheck: true });
    const id = await ctx.ticket("Approved work");
    await ctx.slot(id);
    await ctx.review.submit(id, { verdict: "approved", reviewer: "Reviewer", reviewerAgentId: ctx.reviewer.id, hold: { reason: "Wait for the merge-check fix", waitsOn: [{ ticketId: fix }], releaseAt: null } });
    expect((await holdView(ctx.db, id))!.system).toBe(false);
    expect(await ctx.review.releaseHolds()).toEqual([]);
    await ctx.db.update(tickets).set({ mergeCommit: "e".repeat(40), mergedAt: new Date(), touchesRunner: false, systemState: "done" }).where(eq(tickets.id, fix));
    expect(await ctx.review.releaseHolds()).toEqual([id]);
    await settled(id);
    expect((await ctx.db.select().from(reviewHolds).where(eq(reviewHolds.ticketId, id)))[0]!.status).toBe("released");
    expect((await ctx.row(id)).mergeCommit).toBe(MERGE);
  });
});
