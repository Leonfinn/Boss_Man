// The server-owned check queue (DR-003, BOS-316). Pure database logic: which check runs next, what can be reused,
// and what happened to every job. The runner runs the jobs; nothing here touches a lock file or a process.
//
// Rules the tests pin down:
//  - merge jobs go before pre-review jobs; inside a kind, jobs fixing main first, then urgent, then oldest;
//  - while a project's main is red only jobs fixing main run (merge jobs of other tickets wait, they don't fail); pre-review jobs keep running;
//  - a passed job on the same tree satisfies a request of equal or narrower scope, so the same tree is never checked twice;
//  - a job never leaves the queue without a recorded reason (stuck / cancelled / re-queued all carry one).
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, checkJobLogs, checkJobs, checkWorkers, companies, projects, settings, tickets } from "../db/schema.js";
import { checkPriority, isBackgroundLaneTitle } from "./check-gate.js";
import { record } from "./activity.js";
import { checkFailureFacts, FULL_LOG_RETENTION_DAYS, prepareFullLog, ticketRef } from "@boss-man/shared";

export const CHECK_SLOTS_KEY = "check_slots";
/** The merge train switch (BOS-1366): approved tickets land in order, each checked on main plus the ones ahead. Off by default. */
export const MERGE_TRAIN_KEY = "merge_train";
export const CHECK_QUEUE_MODE_KEY = "check_queue_mode";
export const DEFAULT_CHECK_SLOTS = 1;
/** Why a queued job was cancelled when a newer request of the same ticket replaced it: not a failure, the newer job is the live one. */
export const SUPERSEDED_TEXT = "A newer commit of this ticket was queued for checking, so this older request was dropped.";
/**
 * Upper bound for check_slots. The runner enforces its own slot count (BOSSMAN_CHECK_SLOTS) on every job too (BOS-805), so a
 * check_slots above it only means jobs wait in the runner's line: the effective limit is the smaller of the two. The server
 * doesn't know the runner's count, so the Settings → Checks line must say so rather than clamp.
 */
export const MAX_CHECK_SLOTS = 8;
/** A running job that prints nothing for this long is marked stuck. Waiting in the queue has no limit. */
export const DEFAULT_NO_OUTPUT_MINUTES = 20;

/** BOS-1328: how long after an earlier merge job of a ticket ended its place in line is still handed to the ticket's next merge job. */
export const PLACE_KEEP_MS = 30 * 60_000;

export type CheckKind = "merge" | "pre_review";
export type CheckScope = "quick" | "full";
export type CheckJob = typeof checkJobs.$inferSelect;
export type CheckQueueMode = "server" | "legacy";

const LIVE = ["queued", "running"] as const;
const SCOPE_RANK: Record<string, number> = { quick: 0, full: 1 };
/** A long job is a merge or a full-scope check (about 15 minutes); the rest are quick pre-review checks (2 to 5 minutes). */
const isLong = (j: Pick<CheckJob, "kind" | "scope">) => j.kind === "merge" || j.scope === "full";
/** DR-056: a quick check that has waited this long is served in queue-time order with the merges. */
export const QUICK_AGE_MS = 10 * 60_000;

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

/** BOS-1435: the machine a job runs on. A runner id (or null, as before), or a check worker. */
export type Machine = string | null | { workerId: string };
const isWorker = (m: Machine): m is { workerId: string } => typeof m === "object" && m !== null;

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

  /** The owner's switch (Settings → Server and runner → Checks, BOS-798). Owner-only routes call these; no agent tool does. */
  async function setMode(value: CheckQueueMode): Promise<void> {
    await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  async function setSlots(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHECK_SLOTS) throw new Error(`Check slots must be a whole number from 1 to ${MAX_CHECK_SLOTS}.`);
    await db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: n }).onConflictDoUpdate({ target: settings.key, set: { value: n } });
  }

  /** Jobs still waiting to start, in every company: switching back to legacy cancels them, since nothing would start them. */
  async function queuedIds(): Promise<string[]> {
    return (await db.select({ id: checkJobs.id }).from(checkJobs).where(eq(checkJobs.state, "queued"))).map((r) => r.id);
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

  /**
   * BOS-1328: a ticket's place in the merge line: the earliest queue time of its merge jobs still live or ended in the last
   * PLACE_KEEP_MS (failed or stuck ones never count, so a fixed branch queues as new), plus its "move to front" (BOS-1384).
   * The merge train (BOS-1366) seats tickets by the same place.
   */
  async function mergePlace(db: Db, ticketId: string): Promise<{ at: Date | null; front: { at: Date; by: string | null } | null }> {
    const since = Date.now() - PLACE_KEEP_MS;
    const earlier = (await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, ["queued", "running", "passed", "cancelled"])))).filter(
      // A cancel lends its place only when it was the "newer commit" drop (main moved or a restart); a deliberate cancel does not.
      (j) => j.state === "queued" || j.state === "running" || (j.endedAt && j.endedAt.getTime() >= since && (j.state === "passed" || j.reason === SUPERSEDED_TEXT)),
    );
    let at: Date | null = null;
    let front: { at: Date; by: string | null } | null = null;
    for (const j of earlier) if (!at || j.queuedAt < at) at = j.queuedAt;
    for (const j of earlier) if (j.frontAt && (!front || j.frontAt > front.at)) front = { at: j.frontAt, by: j.frontBy };
    return { at, front };
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
    // BOS-1043: only merge jobs are dispatched with the owner's private-details list, so a merge request is answered only by a
    // merge-kind job. A pass or running job of another kind was scanned without the list and must not stand in for the gate.
    // (A queued job lifted to merge below is dispatched as merge, so it does get the list.)
    const listScanned = (j: CheckJob) => input.kind !== "merge" || j.kind === "merge";
    const passed = sameTree.find((j) => j.state === "passed" && wide(j) && listScanned(j));
    if (passed) return { job: passed, reused: "passed" };
    // The same ticket already has a live job on this tree that can answer: it is the answer (BOS-1412). Asking again
    // for code that is already waiting must never cancel or re-queue it: the agent re-reading its own position used to
    // send the job to the back of a long line. It must be wide enough and, for a merge request, list-scanned unless it is
    // still queued (it gets lifted to merge below, so it does get the list).
    const live = sameTree.find((j) => j.ticketId === input.ticketId && j.state !== "passed" && wide(j) && (listScanned(j) || j.state === "queued"));
    if (live) {
      // A merge request lifts a live pre-review job on the same tree to merge, so the gate's wait is not spent behind quick checks.
      // BOS-1390: the lift is guarded on state = 'queued' too. A pump holds a different lock (check_jobs_claim), so it can claim
      // the job between the read above and this UPDATE; without the guard that running job would become a merge-kind job the
      // merge reuses as "live", never having been scanned with the owner's list. No row means it was claimed: fall through and
      // queue a fresh merge job, which the gate dispatches with the list.
      if (input.kind === "merge" && live.kind !== "merge" && live.state === "queued") {
        const [lifted] = await db
          .update(checkJobs)
          .set({ kind: "merge", fixesMain: live.fixesMain || !!input.fixesMain })
          .where(and(eq(checkJobs.id, live.id), eq(checkJobs.state, "queued")))
          .returning();
        if (lifted) return { job: lifted, reused: "live" };
      } else {
        return { job: live, reused: "live" };
      }
    }
    // A newer commit of the same ticket replaces its queued job of the same command whose scope is no wider than the new one
    // (never a running one: that one is the runner's to finish or fail). A queued full check is never dropped by a later quick
    // request, so nobody is left waiting for a result that was cancelled without anyone asking.
    const stale = (await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, input.ticketId), eq(checkJobs.kind, input.kind), eq(checkJobs.state, "queued")))).filter(
      (j) => (SCOPE_RANK[j.scope] ?? 0) <= SCOPE_RANK[scope]! && (j.command ?? null) === (input.command ?? null),
    );
    // BOS-1328: a merge job that replaces an earlier merge job of the same ticket (main moved, so the tree changed; or a restart
    // started the landing again) keeps the earlier job's place in line. Only jobs still live or ended in the last PLACE_KEEP_MS
    // count, and failed or stuck ones never do, so a fixed branch queues as new.
    let inheritedAt: Date | null = null;
    let inheritedFront: { at: Date; by: string | null } | null = null;
    if (input.kind === "merge") ({ at: inheritedAt, front: inheritedFront } = await mergePlace(db, input.ticketId));
    if (stale.length)
      await db
        .update(checkJobs)
        .set({ state: "cancelled", reason: SUPERSEDED_TEXT, endedAt: new Date() })
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
        ...(inheritedAt ? { queuedAt: inheritedAt } : {}),
        ...(inheritedFront ? { frontAt: inheritedFront.at, frontBy: inheritedFront.by } : {}),
      })
      .returning();
    return { job: job!, reused: null };
  }

  /**
   * BOS-1344: main moved while a merge job waited, so the job takes the new merged commit and tree before it starts. One UPDATE
   * guarded on state = 'queued': a job a runner has claimed is never changed under it (null then). The place in line (queuedAt)
   * stays. Nothing here pushes; "finish" still needs the tree to equal the checked one.
   */
  async function retarget(jobId: string, to: { commit: string; tree: string }): Promise<CheckJob | null> {
    const [row] = await db.update(checkJobs).set({ commit: to.commit, tree: to.tree }).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "queued"), eq(checkJobs.kind, "merge"))).returning();
    return row ?? null;
  }

  /** The queued jobs in serving order, leaving out those a red main holds back. */
  async function servable(now = new Date()): Promise<CheckJob[]> {
    const queued = await db.select().from(checkJobs).where(eq(checkJobs.state, "queued"));
    const red = new Set((await db.select({ id: projects.id }).from(projects).where(eq(projects.mainState, "red"))).map((p) => p.id));
    // DR-056: a quick pre-review job that has waited QUICK_AGE_MS sorts with the merges, by queue time, so a long line of quick checks drains.
    const withMerges = (j: CheckJob) => j.kind === "merge" || (!isLong(j) && now.getTime() - j.queuedAt.getTime() >= QUICK_AGE_MS);
    // BOS-1384: urgency is read from the ticket now, not from the priority stored when the job was queued, so marking a ticket urgent
    // while it waits moves it up at once and clearing it puts it back by its join time (queuedAt is never touched).
    const ids = [...new Set(queued.map((j) => j.ticketId))];
    // BOS-1403: a ticket whose assignee holds a background-lane job title sorts after the ordinary ones (never above Move to front).
    const rows = ids.length
      ? await db.select({ id: tickets.id, urgent: tickets.urgent, fixesMergeCheck: tickets.fixesMergeCheck, title: tickets.title, agentTitle: agents.title }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(inArray(tickets.id, ids))
      : [];
    const marks = new Map(rows.map((t) => [t.id, checkPriority({ urgent: t.urgent, fixesMergeCheck: t.fixesMergeCheck, title: t.title, background: isBackgroundLaneTitle(t.agentTitle) })]));
    const prio = (j: CheckJob) => marks.get(j.ticketId) ?? j.priority;
    return queued
      .filter((j) => !(red.has(j.projectId) && j.kind === "merge" && !j.fixesMain))
      .sort(
        (a, b) =>
          Number(b.fixesMain) - Number(a.fixesMain) ||
          Number(withMerges(b)) - Number(withMerges(a)) ||
          (b.frontAt?.getTime() ?? 0) - (a.frontAt?.getTime() ?? 0) ||
          prio(a) - prio(b) ||
          a.queuedAt.getTime() - b.queuedAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }

  /**
   * BOS-1384: put a waiting merge next in line (below a fix for a red main). Only a merge job still queued can move; a running one is
   * never touched, and nothing here skips a check: the job runs in full when it is served. Returns the job, or null if none waits.
   */
  async function moveToFront(companyId: string, ticketId: string, by: string, reason?: string, now = new Date()): Promise<CheckJob | null> {
    const [row] = await db
      .update(checkJobs)
      .set({ frontAt: now, frontBy: by })
      .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "queued")))
      .returning();
    if (row) await record(db, { companyId, ticketId, kind: "reorganised", summary: `${by} moved this merge to the front of the line${reason ? `: ${reason}` : ""}`, detail: { jobId: row.id, by, reason: reason ?? null }, at: now });
    return row ?? null;
  }

  /** Give the free slots (per company: one runner each) to the next jobs, marking them running on this runner. Returns what to start. */
  async function claimNext(runnerId: string | null, now = new Date(), companyId?: string): Promise<CheckJob[]> {
    return claimOn(runnerId, await slots(), now, companyId);
  }

  /**
   * BOS-1435: claim for one machine with its own slot limit. A company runner's running jobs are counted per company (worker
   * jobs left out), exactly as before; a check worker's are counted across every company, since its slots are shared.
   */
  async function claimOn(machine: Machine, limit: number, now = new Date(), companyId?: string, skip?: (jobId: string) => boolean): Promise<CheckJob[]> {
    const worker = isWorker(machine) ? machine.workerId : null;
    // BOS-1436: `skip` leaves out jobs this machine couldn't get the code for, so they go elsewhere instead of looping.
    const candidates = (await servable(now)).filter((j) => (!companyId || j.companyId === companyId) && !skip?.(j.id));
    const onMachine = worker ? eq(checkJobs.workerId, worker) : and(isNull(checkJobs.workerId), companyId ? eq(checkJobs.companyId, companyId) : undefined);
    // Count and claim under one lock so two concurrent pumps can't both see a free slot.
    return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"check_jobs_claim"}))`);
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(checkJobs).where(and(eq(checkJobs.state, "running"), onMachine))) as [{ n: number }];
    const free = limit - n;
    if (free <= 0) return [];
    // BOS-1264: with two or more slots, merge checks (15 minutes) may not take the last slot while a quick pre-review check
    // (2 to 5 minutes) waits, or a full line of merges keeps every developer waiting 30 to 60 minutes. Merges that fix main are exempt.
    // DR-056: long jobs (merge or full scope) count against the reserve; only a quick-scope job may use the reserved slot.
    // BOS-1435: the reserve is per machine, with that machine's own limit.
    const [{ m }] = (await tx.select({ m: sql<number>`count(*)::int` }).from(checkJobs).where(and(eq(checkJobs.state, "running"), or(eq(checkJobs.kind, "merge"), eq(checkJobs.scope, "full")), onMachine))) as [{ m: number }];
    let longRoom = limit >= 2 && candidates.some((j) => !isLong(j)) ? Math.max(0, limit - 1 - m) : Infinity;
    const claimed: CheckJob[] = [];
    for (const j of candidates) {
      if (claimed.length >= free) break;
      if (isLong(j)) {
        if (longRoom <= 0 && !j.fixesMain) continue;
        longRoom--;
      }
      // Guarded on state so two callers can't both start the same job.
      const [row] = await tx
        .update(checkJobs)
        .set({ state: "running", runnerId: worker ? null : (machine as string | null), workerId: worker, startedAt: now, lastOutputAt: now, reason: null })
        .where(and(eq(checkJobs.id, j.id), eq(checkJobs.state, "queued")))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
    });
  }

  /** Note output from a running job (for the no-output limit) and keep its log tail. */
  async function progress(jobId: string, runnerId: Machine, logTail: string, now = new Date()): Promise<void> {
    await db.update(checkJobs).set({ lastOutputAt: now, logTail: logTail.slice(-8192) }).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), sentTo(runnerId)));
  }

  /**
   * Only the machine a job was sent to may answer for it (a job claimed with no runner id matches null). BOS-1435: a runner
   * never answers for a worker's job (worker_id must be null), nor a worker for a runner's.
   */
  const sentTo = (m: Machine) => (isWorker(m) ? eq(checkJobs.workerId, m.workerId) : and(isNull(checkJobs.workerId), m === null ? isNull(checkJobs.runnerId) : eq(checkJobs.runnerId, m)));

  /**
   * The runner's answer. Accepted only for a job that is still running and only for the commit that was checked,
   * so a late answer for a job that was re-queued or replaced is ignored. Returns the finished job, or null if ignored.
   */
  async function complete(jobId: string, result: { runnerId: Machine; commit: string; exitCode: number | null; logTail: string; timedOut?: boolean; fullLog?: string }, now = new Date()): Promise<CheckJob | null> {
    const ok = result.exitCode === 0 && !result.timedOut;
    const facts = ok ? "" : checkFailureFacts(result.logTail);
    const [row] = await db
      .update(checkJobs)
      .set({
        state: ok ? "passed" : "failed",
        exitCode: result.exitCode,
        logTail: result.logTail.slice(-8192),
        reason: ok ? null : result.timedOut ? "The check ran past its time limit and was stopped." : typeof result.exitCode === "number" ? `The check failed with exit code ${result.exitCode}${facts ? ` (${facts})` : ""}.` : `The check was stopped before it reported${facts ? ` (${facts})` : ""}.`,
        endedAt: now,
      })
      .where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), eq(checkJobs.commit, result.commit), sentTo(result.runnerId)))
      .returning();
    // BOS-1228: a failed job keeps its whole log. The runner already cut and redacted it; the server does both again, because it
    // does not trust what arrives (a runner older than this change sends none, and then only the tail exists).
    if (row && !ok && result.fullLog) {
      const { log } = prepareFullLog(result.fullLog);
      await db.insert(checkJobLogs).values({ jobId, log, chars: log.length, createdAt: now }).onConflictDoNothing();
    }
    return row ?? null;
  }

  /** A kept log, if it belongs to a job of this company's ticket. */
  async function readLog(companyId: string, ticketId: string, jobId: string | null): Promise<{ jobId: string; log: string; chars: number; endedAt: Date | null; scope: string } | null> {
    const [row] = await db
      .select({ jobId: checkJobLogs.jobId, log: checkJobLogs.log, chars: checkJobLogs.chars, endedAt: checkJobs.endedAt, scope: checkJobs.scope })
      .from(checkJobLogs)
      .innerJoin(checkJobs, eq(checkJobs.id, checkJobLogs.jobId))
      .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.ticketId, ticketId), jobId ? eq(checkJobLogs.jobId, jobId) : undefined))
      .orderBy(desc(checkJobLogs.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Whether a job has a kept log, and how long it is. */
  async function logChars(jobId: string): Promise<number | null> {
    const [row] = await db.select({ chars: checkJobLogs.chars }).from(checkJobLogs).where(eq(checkJobLogs.jobId, jobId));
    return row?.chars ?? null;
  }

  /** Kept logs older than the retention period are deleted. Returns how many. */
  async function pruneLogs(now = new Date(), days = FULL_LOG_RETENTION_DAYS): Promise<number> {
    const gone = await db.delete(checkJobLogs).where(lt(checkJobLogs.createdAt, new Date(now.getTime() - days * 86_400_000))).returning({ id: checkJobLogs.jobId });
    return gone.length;
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
    return db.update(checkJobs).set({ state: "queued", runnerId: null, workerId: null, startedAt: null, reason: why }).where(cond).returning();
  }

  /** BOS-1435: a check worker went away (or was turned off or removed): its running jobs go back in line. */
  async function requeueWorker(workerId: string, why: string): Promise<CheckJob[]> {
    return db.update(checkJobs).set({ state: "queued", runnerId: null, workerId: null, startedAt: null, reason: why }).where(and(eq(checkJobs.state, "running"), eq(checkJobs.workerId, workerId))).returning();
  }

  /** One running job goes back in line, with the reason recorded. */
  /** Back in line. With `on` (BOS-1436), only while it still runs on that machine, so a late call can't move a job given elsewhere. */
  async function requeue(jobId: string, why: string, on?: Machine): Promise<CheckJob | null> {
    const [row] = await db.update(checkJobs).set({ state: "queued", runnerId: null, workerId: null, startedAt: null, reason: why }).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), on === undefined ? undefined : sentTo(on))).returning();
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

  /**
   * Every live check of a company for the Merge queue's "Queued checks" tab (BOS-1174): running first, then waiting in
   * serving order, then those a red main holds back. Read-only. `position` counts the waiting ones only.
   */
  async function list(companyId: string, now = new Date(), capacity?: number) {
    // BOS-1435: with check workers the caller passes the company's whole capacity (runner plus ready workers).
    const limit = capacity ?? (await slots());
    const prefix = (await db.select({ p: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId)))[0]?.p ?? null;
    const live = await db
      .select({ job: checkJobs, number: tickets.number, title: tickets.title, urgent: tickets.urgent, requester: agents.name, worker: checkWorkers.name })
      .from(checkJobs)
      .innerJoin(tickets, eq(tickets.id, checkJobs.ticketId))
      .leftJoin(agents, eq(agents.id, checkJobs.requestedBy))
      .leftJoin(checkWorkers, eq(checkWorkers.id, checkJobs.workerId))
      .where(and(eq(checkJobs.companyId, companyId), inArray(checkJobs.state, [...LIVE])));
    const info = new Map(live.map((r) => [r.job.id, r]));
    const minutes = (d: Date | null) => (d ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000)) : 0);
    const runningJobs = live.filter((r) => r.job.state === "running").sort((a, b) => (a.job.startedAt?.getTime() ?? 0) - (b.job.startedAt?.getTime() ?? 0));
    // A check queued after the live read above is not in `info`: leave it out (it shows on the next refresh) instead of throwing in row().
    const order = (await servable()).filter((j) => j.companyId === companyId && info.has(j.id));
    const orderIds = new Set(order.map((j) => j.id));
    const held = live.filter((r) => r.job.state === "queued" && !orderIds.has(r.job.id)).map((r) => r.job);
    // "Slots busy" is per company: only this company's running jobs count against `limit`, since each company has its own runner slots.
    const full = runningJobs.length >= limit;
    const row = (j: CheckJob, position: number | null, heldBy: string | null) => {
      const r = info.get(j.id)!;
      return {
        id: j.id,
        ticketId: j.ticketId,
        ref: ticketRef(prefix, r.number),
        title: r.title,
        kind: j.kind === "merge" ? ("merge" as const) : j.scope === "full" ? ("full" as const) : ("quick" as const),
        requestedBy: j.kind === "merge" ? "the merge gate" : r.requester,
        state: j.state === "running" ? ("running" as const) : ("waiting" as const),
        position,
        minutes: minutes(j.state === "running" ? j.startedAt : j.queuedAt),
        fixesMain: j.fixesMain,
        // BOS-1384: why this one is ahead of the others, in the owner's words (null for an ordinary place).
        why: j.state !== "queued" ? null : j.fixesMain ? "fixes main" : j.frontAt ? `moved to front by ${j.frontBy ?? "the owner"}` : r.urgent ? "urgent" : null,
        heldBy,
        // True only for checks a red main holds back; "all slots are busy" fills heldBy too but is plain queueing (BOS-1262).
        heldByMain: heldBy !== null && heldBy.startsWith("main is red"),
        // BOS-1435: where a running check runs: the company's runner, or a check worker by name.
        ranOn: j.state !== "running" ? null : j.workerId ? (r.worker ?? "a check worker") : "company runner",
      };
    };
    const rows = [
      ...runningJobs.map((r) => row(r.job, null, null)),
      ...order.map((j, i) => row(j, i + 1, full ? `all ${limit} check ${limit === 1 ? "slot is" : "slots are"} busy` : null)),
      ...held.map((j) => row(j, null, "main is red, so this merge check waits until main is fixed")),
    ];
    return { mode: await mode(), slots: limit, running: runningJobs.length, rows };
  }

  /** The owner's merge train switch (BOS-1366, DR-059): off unless set to true. */
  async function train(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_TRAIN_KEY));
    return row?.value === true || row?.value === "true";
  }

  async function setTrain(on: boolean): Promise<void> {
    await db.insert(settings).values({ key: MERGE_TRAIN_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  }

  const place = (ticketId: string) => mergePlace(db, ticketId);

  return { list, mode, slots, setMode, setSlots, train, setTrain, place, queuedIds, enqueue, retarget, moveToFront, claimNext, claimOn, progress, complete, readLog, logChars, pruneLogs, cancel, markStuck, requeue, requeueRunning, requeueWorker, sweepStuck, setMainState, status };
}
