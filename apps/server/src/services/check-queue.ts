// The server-owned check queue (DR-003, BOS-316). Pure database logic: which check runs next, what can be reused,
// and what happened to every job. The runner runs the jobs; nothing here touches a lock file or a process.
//
// Rules the tests pin down:
//  - merge jobs go before pre-review jobs; inside a kind, jobs fixing main first, then urgent, then oldest;
//  - while a project's main is red only jobs fixing main run (merge jobs of other tickets wait, they don't fail); pre-review jobs keep running;
//  - a passed job on the same tree satisfies a request of equal or narrower scope, so the same tree is never checked twice;
//  - a job never leaves the queue without a recorded reason (stuck / cancelled / re-queued all carry one).
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkJobs, projects, settings } from "../db/schema.js";

export const CHECK_SLOTS_KEY = "check_slots";
export const CHECK_QUEUE_MODE_KEY = "check_queue_mode";
export const DEFAULT_CHECK_SLOTS = 1;
/**
 * Upper bound for check_slots. The runner enforces its own slot count (BOSSMAN_CHECK_SLOTS) on every job too (BOS-805), so a
 * check_slots above it only means jobs wait in the runner's line: the effective limit is the smaller of the two. The server
 * doesn't know the runner's count, so the Settings → Checks line must say so rather than clamp.
 */
export const MAX_CHECK_SLOTS = 8;
/** A running job that prints nothing for this long is marked stuck. Waiting in the queue has no limit. */
export const DEFAULT_NO_OUTPUT_MINUTES = 20;

export type CheckKind = "merge" | "pre_review";
export type CheckScope = "quick" | "full";
export type CheckJob = typeof checkJobs.$inferSelect;
export type CheckQueueMode = "server" | "legacy";

const LIVE = ["queued", "running"] as const;
const SCOPE_RANK: Record<string, number> = { quick: 0, full: 1 };

export type EnqueueInput = {
  companyId: string;
  projectId: string;
  ticketId: string;
  kind: CheckKind;
  scope?: CheckScope;
  commit: string;
  tree: string;
  command?: string | null;
  priority?: number;
  fixesMain?: boolean;
  requestedBy?: string | null;
};

export type EnqueueResult = { job: CheckJob; reused: "passed" | "live" | null };

export function checkQueue(db: Db) {
  async function mode(): Promise<CheckQueueMode> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CHECK_QUEUE_MODE_KEY));
    return row?.value === "server" ? "server" : "legacy";
  }

  async function slots(): Promise<number> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CHECK_SLOTS_KEY));
    const n = Number(row?.value);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CHECK_SLOTS) : DEFAULT_CHECK_SLOTS;
  }

  /** Queue a check, or hand back the job that already answers the request. */
  async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    // One enqueue at a time (the lock is held to the end of the transaction), so a pre-review and a merge request for the same
    // tree cannot both see "nothing queued" and both insert.
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"check_jobs_enqueue"}))`);
      return enqueueIn(tx as unknown as Db, input);
    });
  }

  async function enqueueIn(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
    const scope = input.scope ?? "full";
    // A pass on the same tree with an equal or wider scope answers the request, whatever kind asked for it.
    const sameTree = await db
      .select()
      .from(checkJobs)
      .where(and(eq(checkJobs.projectId, input.projectId), eq(checkJobs.tree, input.tree), inArray(checkJobs.state, ["passed", "queued", "running"])))
      .orderBy(asc(checkJobs.queuedAt));
    // The same command must have passed: a quick script, or the first of several merge commands, never stands in for another.
    const wide = (j: CheckJob) => (SCOPE_RANK[j.scope] ?? 0) >= SCOPE_RANK[scope]! && (j.command ?? null) === (input.command ?? null);
    const passed = sameTree.find((j) => j.state === "passed" && wide(j));
    if (passed) return { job: passed, reused: "passed" };
    // The same ticket already has a live job on this tree that is wide enough: it is the answer.
    const live = sameTree.find((j) => j.ticketId === input.ticketId && j.state !== "passed" && wide(j));
    if (live) {
      // A merge request lifts a live pre-review job on the same tree to merge, so the gate's wait is not spent behind quick checks.
      if (input.kind === "merge" && live.kind !== "merge" && live.state === "queued") {
        const [lifted] = await db.update(checkJobs).set({ kind: "merge", fixesMain: live.fixesMain || !!input.fixesMain }).where(eq(checkJobs.id, live.id)).returning();
        return { job: lifted ?? live, reused: "live" };
      }
      return { job: live, reused: "live" };
    }
    // A newer commit of the same ticket replaces its queued job of the same command whose scope is no wider than the new one
    // (never a running one: that one is the runner's to finish or fail). A queued full check is never dropped by a later quick
    // request, so nobody is left waiting for a result that was cancelled without anyone asking.
    const stale = (await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, input.ticketId), eq(checkJobs.kind, input.kind), eq(checkJobs.state, "queued")))).filter(
      (j) => (SCOPE_RANK[j.scope] ?? 0) <= SCOPE_RANK[scope]! && (j.command ?? null) === (input.command ?? null),
    );
    if (stale.length)
      await db
        .update(checkJobs)
        .set({ state: "cancelled", reason: "A newer commit of this ticket was queued for checking, so this older request was dropped.", endedAt: new Date() })
        .where(inArray(checkJobs.id, stale.map((j) => j.id)));
    const [job] = await db
      .insert(checkJobs)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        kind: input.kind,
        scope,
        commit: input.commit,
        tree: input.tree,
        command: input.command ?? null,
        priority: input.priority ?? 1,
        fixesMain: input.fixesMain ?? false,
        requestedBy: input.requestedBy ?? null,
      })
      .returning();
    return { job: job!, reused: null };
  }

  /** The queued jobs in serving order, leaving out those a red main holds back. */
  async function servable(): Promise<CheckJob[]> {
    const queued = await db.select().from(checkJobs).where(eq(checkJobs.state, "queued"));
    const red = new Set((await db.select({ id: projects.id }).from(projects).where(eq(projects.mainState, "red"))).map((p) => p.id));
    return queued
      .filter((j) => !(red.has(j.projectId) && j.kind === "merge" && !j.fixesMain))
      .sort(
        (a, b) =>
          Number(b.fixesMain) - Number(a.fixesMain) ||
          Number(b.kind === "merge") - Number(a.kind === "merge") ||
          a.priority - b.priority ||
          a.queuedAt.getTime() - b.queuedAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }

  /** Give the free slots (per company: one runner each) to the next jobs, marking them running on this runner. Returns what to start. */
  async function claimNext(runnerId: string | null, now = new Date(), companyId?: string): Promise<CheckJob[]> {
    const limit = await slots();
    const candidates = (await servable()).filter((j) => !companyId || j.companyId === companyId);
    // Count and claim under one lock so two concurrent pumps can't both see a free slot.
    return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"check_jobs_claim"}))`);
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(checkJobs).where(companyId ? and(eq(checkJobs.state, "running"), eq(checkJobs.companyId, companyId)) : eq(checkJobs.state, "running"))) as [{ n: number }];
    const free = limit - n;
    if (free <= 0) return [];
    const claimed: CheckJob[] = [];
    for (const j of candidates.slice(0, free)) {
      // Guarded on state so two callers can't both start the same job.
      const [row] = await tx
        .update(checkJobs)
        .set({ state: "running", runnerId, startedAt: now, lastOutputAt: now, reason: null })
        .where(and(eq(checkJobs.id, j.id), eq(checkJobs.state, "queued")))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
    });
  }

  /** Note output from a running job (for the no-output limit) and keep its log tail. */
  async function progress(jobId: string, runnerId: string | null, logTail: string, now = new Date()): Promise<void> {
    await db.update(checkJobs).set({ lastOutputAt: now, logTail: logTail.slice(-8192) }).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), sentTo(runnerId)));
  }

  /** Only the runner a job was sent to may answer for it (a job claimed with no runner id matches null). */
  const sentTo = (runnerId: string | null) => (runnerId === null ? isNull(checkJobs.runnerId) : eq(checkJobs.runnerId, runnerId));

  /**
   * The runner's answer. Accepted only for a job that is still running and only for the commit that was checked,
   * so a late answer for a job that was re-queued or replaced is ignored. Returns the finished job, or null if ignored.
   */
  async function complete(jobId: string, result: { runnerId: string | null; commit: string; exitCode: number | null; logTail: string; timedOut?: boolean }, now = new Date()): Promise<CheckJob | null> {
    const ok = result.exitCode === 0 && !result.timedOut;
    const [row] = await db
      .update(checkJobs)
      .set({
        state: ok ? "passed" : "failed",
        exitCode: result.exitCode,
        logTail: result.logTail.slice(-8192),
        reason: ok ? null : result.timedOut ? "The check ran past its time limit and was stopped." : `The check failed with exit code ${result.exitCode ?? "none"}.`,
        endedAt: now,
      })
      .where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), eq(checkJobs.commit, result.commit), sentTo(result.runnerId)))
      .returning();
    return row ?? null;
  }

  async function end(jobId: string, state: "stuck" | "cancelled", reason: string, now = new Date()): Promise<CheckJob | null> {
    if (!reason.trim()) throw new Error("A check job can't be ended without a reason.");
    const [row] = await db.update(checkJobs).set({ state, reason, endedAt: now }).where(and(eq(checkJobs.id, jobId), inArray(checkJobs.state, [...LIVE]))).returning();
    return row ?? null;
  }
  const cancel = (jobId: string, reason: string) => end(jobId, "cancelled", reason);
  const markStuck = (jobId: string, reason: string) => end(jobId, "stuck", reason);

  /** A runner went away (or the server restarted): its running jobs go back in line, with the reason recorded. */
  async function requeueRunning(runnerId: string | null, why: string): Promise<CheckJob[]> {
    const cond = runnerId ? and(eq(checkJobs.state, "running"), eq(checkJobs.runnerId, runnerId)) : eq(checkJobs.state, "running");
    return db.update(checkJobs).set({ state: "queued", runnerId: null, startedAt: null, reason: why }).where(cond).returning();
  }

  /** One running job goes back in line, with the reason recorded. */
  async function requeue(jobId: string, why: string): Promise<CheckJob | null> {
    const [row] = await db.update(checkJobs).set({ state: "queued", runnerId: null, startedAt: null, reason: why }).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"))).returning();
    return row ?? null;
  }

  /** Running jobs that printed nothing for too long become stuck, each with its reason. */
  async function sweepStuck(now = new Date(), minutes = DEFAULT_NO_OUTPUT_MINUTES): Promise<CheckJob[]> {
    const cutoff = new Date(now.getTime() - minutes * 60_000);
    return db
      .update(checkJobs)
      .set({ state: "stuck", reason: `No output for ${minutes} minutes while running, so the check was marked stuck.`, endedAt: now })
      .where(and(eq(checkJobs.state, "running"), lt(checkJobs.lastOutputAt, cutoff)))
      .returning();
  }

  /** Main's state for a project, set by the merge gate: red when a check of main's own tip fails, green on its first pass. */
  async function setMainState(projectId: string, state: "green" | "red" | "unknown", commit: string | null, now = new Date()): Promise<{ changed: boolean }> {
    const [cur] = await db.select({ s: projects.mainState }).from(projects).where(eq(projects.id, projectId));
    if (!cur) return { changed: false };
    await db.update(projects).set({ mainState: state, mainStateSince: cur.s === state ? undefined : now, mainStateCommit: commit }).where(eq(projects.id, projectId));
    return { changed: cur.s !== state };
  }

  /** The queue as server_status shows it. */
  async function status(companyId: string, now = new Date()) {
    const rows = await db.select().from(checkJobs).where(eq(checkJobs.companyId, companyId)).orderBy(asc(checkJobs.queuedAt));
    const running = rows.filter((j) => j.state === "running").map((j) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, scope: j.scope, ageMinutes: j.startedAt ? Math.round((now.getTime() - j.startedAt.getTime()) / 60_000) : 0 }));
    const order = (await servable()).filter((j) => j.companyId === companyId);
    const queued = order.map((j, i) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, scope: j.scope, place: i + 1, fixesMain: j.fixesMain }));
    const held = rows.filter((j) => j.state === "queued" && !order.some((o) => o.id === j.id)).map((j) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, heldBy: "main is red" }));
    const recent = rows
      .filter((j) => !LIVE.includes(j.state as never))
      .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0))
      .slice(0, 5)
      .map((j) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, state: j.state, reason: j.reason }));
    const mains = await db.select({ id: projects.id, name: projects.name, state: projects.mainState, since: projects.mainStateSince, commit: projects.mainStateCommit }).from(projects).where(eq(projects.companyId, companyId));
    return { mode: await mode(), slots: await slots(), running, queued, held, recent, main: mains.map((m) => ({ projectId: m.id, project: m.name, state: m.state, since: m.since, commit: m.commit })) };
  }

  return { mode, slots, enqueue, claimNext, progress, complete, cancel, markStuck, requeue, requeueRunning, sweepStuck, setMainState, status };
}
