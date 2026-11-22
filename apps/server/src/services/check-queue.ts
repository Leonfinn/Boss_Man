// The server-owned check queue (DR-003, BOS-316). Pure database logic: which check runs next, what can be reused,
// and what happened to every job. The runner runs the jobs; nothing here touches a lock file or a process.
//
// Rules the tests pin down:
//  - serving order (DR-056, see `serving`): jobs fixing main first, then the merge holding the landing turn, then seated merge
//    train members (on machines with two or more slots), then the "with the merges" group (every merge job, and any pre-review
//    job, quick or full, that has waited QUICK_AGE_MS, is urgent or was moved to front), then the other pre-review jobs; inside
//    a group, moved to front first, then tier (urgent, ordinary, background lane until it ages), then oldest. A merge does not
//    simply go before every quick check, and a slot is kept for a waiting quick check (`admits`);
//  - while a project's main is red only jobs fixing main run (merge jobs of other tickets wait, they don't fail); pre-review jobs keep running;
//  - a passed job on the same tree satisfies a request of equal or narrower scope, so the same tree is never checked twice;
//  - a job never leaves the queue without a recorded reason (stuck / cancelled / re-queued all carry one).
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, checkJobLogs, checkJobs, checkWorkers, companies, projects, settings, tickets } from "../db/schema.js";
import { BACKGROUND_LANE_AGE_KEY, checkPriority, isBackgroundLaneTitle, laneAgeMinutes, laneWords, readLaneAgeMinutes } from "./check-gate.js";
import { record } from "./activity.js";
import { checkFailureFacts, firstFailingLine, FULL_LOG_RETENTION_DAYS, prepareFullLog, ticketRef } from "@boss-man/shared";
import { stageLine } from "./check-stage-line.js";
import { softHold } from "./deploy-wait-hold.js";
import { blocksClass } from "./update-waits.js";
import { agedTier, retierWaiting, setTrainLaneAge, trainView } from "./merge-train.js";
import { landingTurns } from "./landing-turn.js";

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

/**
 * BOS-1602: which kinds of check a machine takes, set by the owner per machine (the company runner in one setting, each
 * worker on its row). "checks" means pre-review checks (quick, and the rare full one an agent is told to ask for).
 */
export const MACHINE_TAKES = ["both", "merge", "checks"] as const;
export type MachineTakes = (typeof MACHINE_TAKES)[number];
/** `mergeKept`: with takes "both", how many of the machine's slots only ever run merge checks; the rest take either kind. */
export type SlotPolicy = { takes: MachineTakes; mergeKept: number };
/** Nothing set: every slot takes either kind, and the DR-056 / BOS-1264 last-slot rule applies, exactly as before BOS-1602. */
export const DEFAULT_SLOT_POLICY: SlotPolicy = { takes: "both", mergeKept: 0 };
export const RUNNER_SLOT_POLICY_KEY = "check_runner_slot_policy";
export const isDefaultPolicy = (p: SlotPolicy) => p.takes === "both" && p.mergeKept <= 0;

/** How a machine's slots split: kept for merges (or a merges-only machine), checks only, and either kind. */
export function slotShape(limit: number, p: SlotPolicy): { mergeOnly: number; checkOnly: number; either: number } {
  if (p.takes === "merge") return { mergeOnly: limit, checkOnly: 0, either: 0 };
  if (p.takes === "checks") return { mergeOnly: 0, checkOnly: limit, either: 0 };
  // Clamped here, not only when saved: a worker can report fewer slots than the owner set.
  const kept = Math.min(Math.max(0, Math.floor(p.mergeKept)), limit);
  return { mergeOnly: kept, checkOnly: 0, either: limit - kept };
}

/** Running jobs on one machine: merge checks, pre-review checks, and how many of those are full scope. */
export type SlotUse = { merge: number; check: number; longCheck: number };

/**
 * BOS-1602: may this machine start this job now? Merges fill kept slots first, then either slots; pre-review checks use a
 * checks-only machine or an either slot. Slots have no identity, so a running merge counts as in a kept slot while one is free.
 *
 * How this combines with DR-056 / BOS-1264 (a long job may not take the last slot while a quick check waits):
 *  - default machine (both, none kept): unchanged, the rule applies to its whole limit from two slots up;
 *  - machine with kept slots: merges already have their own slots, so the rule applies to the either slots and keeps the
 *    last free one for a waiting quick check even when there is only one (that is the "either" slot's point);
 *  - checks-only machine: the rule still holds between full and quick pre-review checks;
 *  - merges-only machine: no quick check can wait for it, so no reserve.
 * A merge that fixes main is exempt from the reserve, as before. Neither kind starves: a job is refused only when every slot
 * it may use is busy, or a quick check is waiting for the last free either slot (and quick checks finish in minutes).
 *
 * `dedicatedOnly` (the dispatcher's first pass): only kept slots, merges-only and checks-only machines, so a quick check goes
 * to a checks-only machine before an either slot and a merge to a kept slot before an either slot.
 */
export function admits(limit: number, p: SlotPolicy, use: SlotUse, j: Pick<CheckJob, "kind" | "scope" | "fixesMain">, opts: { quickWaits: boolean; dedicatedOnly?: boolean }): boolean {
  if (use.merge + use.check >= limit) return false;
  const s = slotShape(limit, p);
  const long = isLong(j);
  if (j.kind === "merge") {
    if (use.merge < s.mergeOnly) return true;
  } else if (s.checkOnly > 0) {
    // A checks-only machine: DR-056 between full and quick pre-review checks.
    return !(long && opts.quickWaits && limit >= 2 && use.longCheck >= limit - 1);
  }
  if (opts.dedicatedOnly || s.either === 0) return false;
  const mergeInEither = Math.max(0, use.merge - s.mergeOnly);
  if (mergeInEither + use.check >= s.either) return false;
  if (long && opts.quickWaits && !j.fixesMain && s.either >= (s.mergeOnly > 0 ? 1 : 2) && mergeInEither + use.longCheck >= s.either - 1) return false;
  return true;
}

/** Normalise a stored or posted policy; anything unknown reads as the default. */
export function readPolicy(v: unknown): SlotPolicy {
  const o = (v && typeof v === "object" ? v : {}) as { takes?: unknown; mergeKept?: unknown };
  const takes = MACHINE_TAKES.includes(o.takes as MachineTakes) ? (o.takes as MachineTakes) : "both";
  const kept = Number(o.mergeKept);
  return { takes, mergeKept: takes === "both" && Number.isInteger(kept) && kept > 0 ? Math.min(kept, MAX_CHECK_SLOTS) : 0 };
}

/** R46 (BOS-1814): why a machine with a free slot did not take a queued job it could take. `expected`: the owner already sees this reason elsewhere (a server-update pause, their own machine setting), so no alarm. */
export type CheckDecline = { jobId: string; ticketId: string; kind: CheckJob["kind"]; scope: CheckJob["scope"]; code: "update_hold" | "machine_policy" | "reserve" | "slot_rules" | "no_code"; text: string; expected: boolean };
export type ClaimResult = { jobs: CheckJob[]; declined: CheckDecline | null };
const declineOf = (j: CheckJob, code: CheckDecline["code"], text: string, expected: boolean): CheckDecline => ({ jobId: j.id, ticketId: j.ticketId, kind: j.kind, scope: j.scope, code, text, expected });

/** One machine as the queue view sees it, for "why it waits" (BOS-1602). */
export type MachineView = { workerId: string | null; limit: number; policy: SlotPolicy };

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

  /** The owner's switch (Settings → Server and runner → Limits and checks, BOS-798). Owner-only routes call these; no agent tool does. */
  async function setMode(value: CheckQueueMode): Promise<void> {
    await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  async function setSlots(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHECK_SLOTS) throw new Error(`Check slots must be a whole number from 1 to ${MAX_CHECK_SLOTS}.`);
    await db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: n }).onConflictDoUpdate({ target: settings.key, set: { value: n } });
  }

  /** BOS-1602: the company runner's split (one setting for every company's runner, like check_slots). */
  async function runnerPolicy(): Promise<SlotPolicy> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, RUNNER_SLOT_POLICY_KEY));
    return readPolicy(row?.value);
  }

  async function setRunnerPolicy(p: SlotPolicy): Promise<void> {
    const value = readPolicy(p);
    await db.insert(settings).values({ key: RUNNER_SLOT_POLICY_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
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
    // BOS-1516: a Priority 1 ticket (the owner's urgent switch) keeps its place after a send-back: its earlier merge jobs count
    // whatever their end (failed, stuck, cancelled) and however long ago, so it returns where it was, not at the back of the line.
    const [mark] = await db.select({ p1: tickets.urgentByOwner, urgent: tickets.urgent }).from(tickets).where(eq(tickets.id, ticketId));
    const keepAll = !!mark?.p1 && !!mark.urgent;
    const states = keepAll ? ["queued", "running", "passed", "cancelled", "failed", "stuck"] : ["queued", "running", "passed", "cancelled"];
    const earlier = (await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, states as Array<CheckJob["state"]>)))).filter(
      // A cancel lends its place only when it was the "newer commit" drop (main moved or a restart); a deliberate cancel does not.
      (j) => keepAll || j.state === "queued" || j.state === "running" || (j.endedAt && j.endedAt.getTime() >= since && (j.state === "passed" || j.reason === SUPERSEDED_TEXT)),
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

  /**
   * BOS-1384: urgency is read from the ticket now, not from the priority stored when the job was queued, so marking a ticket urgent
   * while it waits moves it up at once and clearing it puts it back by its join time (queuedAt is never touched).
   * BOS-1403: a ticket whose assignee holds a background-lane job title gets tier 2, after the ordinary ones.
   */
  async function tiers(ids: string[]): Promise<Map<string, number>> {
    const rows = ids.length
      ? await db.select({ id: tickets.id, urgent: tickets.urgent, fixesMergeCheck: tickets.fixesMergeCheck, title: tickets.title, agentTitle: agents.title }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(inArray(tickets.id, ids))
      : [];
    return new Map(rows.map((t) => [t.id, checkPriority({ urgent: t.urgent, fixesMergeCheck: t.fixesMergeCheck, title: t.title, background: isBackgroundLaneTitle(t.agentTitle) })]));
  }

  /** The queued jobs in serving order, leaving out those a red main holds back. */
  async function servable(now = new Date(), trainFirst = true): Promise<CheckJob[]> {
    return (await serving(now, trainFirst)).order;
  }

  /** Why a queued job of a ticket waiting for its train seat is not in the serving order (BOS-1504). */
  const TRAIN_HELD = "waiting for a seat in the merge train";

  /** The serving order, and the queued jobs the merge train holds back (BOS-1504); the rest left out are a red main's. */
  async function serving(now = new Date(), trainFirst = true): Promise<{ order: CheckJob[]; trainHeld: Set<string> }> {
    const queued = await db.select().from(checkJobs).where(eq(checkJobs.state, "queued"));
    const red = new Set((await db.select({ id: projects.id }).from(projects).where(eq(projects.mainState, "red"))).map((p) => p.id));
    // DR-056: a quick pre-review job that has waited QUICK_AGE_MS sorts with the merges, by queue time, so a long line of quick checks drains.
    // BOS-1519: an urgent (top-tier) or moved-to-front quick check sorts there from the moment it is queued. Otherwise it sorted
    // below every aged quick check for its first QUICK_AGE_MS, so urgency and Move to front did nothing in a long line.
    // BOS-2105: a full pre-review check (request_check scope full) follows the same rule. It used to be left out, so it sat in
    // the last group for good, even when urgent, and started only once every merge and aged quick check had gone. Slot use is
    // unchanged: `admits` still counts it as a long job, so it can't take the slot kept for a waiting quick check.
    const withMerges = (j: CheckJob) => j.kind === "merge" || now.getTime() - j.queuedAt.getTime() >= QUICK_AGE_MS || !!j.frontAt || prio(j) === 0;
    // BOS-1504, merge train on: the train decides which landing goes next, so the queue follows it. A merge job of a ticket still
    // waiting for a seat is held back (it keeps its place: it stays queued, and its landing's own job replaces it once seated). The
    // seated members' merge jobs are served as one block in seat order, at the block's best place: the latest Move to front and
    // the earliest queue time among their queued jobs, and the best tier of every seated ticket (the head's job is usually
    // running already). So a seated background-lane ticket no longer stalls the train. fixesMain jobs keep their own place
    // above everything. With no train in this process (a standby, or no landing since a restart), nothing changes; an old job
    // may then be claimed, and its landing cancels it as a leftover when it re-enqueues.
    // BOS-1511 (no restart needed): a member's job is queued when it is seated, so quick checks that had already aged past
    // QUICK_AGE_MS sorted ahead of it by queue time and the train waited behind a long line of them. With `trainFirst` the
    // seated members rank above the aged-quick group. Quick checks still get a slot: claimOn passes trainFirst only for a
    // machine with two or more slots, where the slots−1 long-job reserve keeps one for them. On a one-slot machine the
    // train would otherwise take the only slot for as long as it has members, so there the DR-056 order stands.
    const views = new Map<string, ReturnType<typeof trainView>>();
    if (queued.some((j) => j.kind === "merge" && !j.fixesMain) && (await train())) for (const j of queued) if (j.kind === "merge" && !views.has(j.projectId)) views.set(j.projectId, trainView(j.projectId));
    const marks = await tiers([...new Set([...queued.map((j) => j.ticketId), ...[...views.values()].flatMap((v) => v?.seated ?? [])])]);
    const prio = (j: CheckJob) => marks.get(j.ticketId) ?? j.priority;
    // BOS-1803: a background-lane job that has waited the lane age ranks as ordinary, by its queue time (so it can't starve).
    const ageMs = (await laneAgeMinutes(db)) * 60_000;
    const ranked = (j: CheckJob) => agedTier(prio(j), now.getTime() - j.queuedAt.getTime(), ageMs);
    const trainHeld = new Set<string>();
    const seatOf = new Map<string, number>();
    const block = new Map<string, { front: number; tier: number; at: number }>();
    if (views.size) {
      const view = (projectId: string) => views.get(projectId) ?? null;
      for (const j of queued) {
        if (j.kind !== "merge" || j.fixesMain) continue;
        const v = view(j.projectId);
        if (!v) continue;
        if (v.withheld(j.ticketId)) {
          trainHeld.add(j.id);
          continue;
        }
        const seat = v.seated.indexOf(j.ticketId);
        if (seat < 0) continue;
        seatOf.set(j.id, seat);
        const b = block.get(j.projectId);
        const front = j.frontAt?.getTime() ?? 0;
        const at = j.queuedAt.getTime();
        // A seated ticket missing from `marks` (deleted meanwhile) counts as ordinary.
        const tier = b?.tier ?? Math.min(...v.seated.map((id) => marks.get(id) ?? 1));
        block.set(j.projectId, b ? { front: Math.max(b.front, front), tier, at: Math.min(b.at, at) } : { front, tier, at });
      }
    }
    // One key per job (a plain tuple, so the sort stays consistent): a seated member takes its block's key, then its seat.
    const key = (j: CheckJob) => {
      const seat = seatOf.get(j.id);
      const b = seat === undefined ? undefined : block.get(j.projectId);
      return b ? { front: b.front, tier: b.tier, at: b.at, seat: seat! } : { front: j.frontAt?.getTime() ?? 0, tier: ranked(j), at: j.queuedAt.getTime(), seat: 0 };
    };
    const keys = new Map(queued.map((j) => [j.id, key(j)]));
    // BOS-1822: while a ticket holds its project's landing turn (BOS-1762) every other passed merge of that project waits to
    // push until it lands, so its re-check starts next, below only a fix for a red main. It used to queue at the ticket's
    // own tier and place, and spent up to 14 of the turn's 25 minutes waiting for a slot (18 Nov). The turn is in memory
    // in this process, the one that runs the landings and serves the queue.
    const turn = (j: CheckJob) => j.kind === "merge" && landingTurns.holds(j.projectId, j.ticketId);
    const order = queued
      .filter((j) => !(red.has(j.projectId) && j.kind === "merge" && !j.fixesMain) && !trainHeld.has(j.id))
      .sort((a, b) => {
        const ka = keys.get(a.id)!;
        const kb = keys.get(b.id)!;
        return (
          Number(b.fixesMain) - Number(a.fixesMain) ||
          Number(turn(b)) - Number(turn(a)) ||
          (trainFirst ? Number(seatOf.has(b.id)) - Number(seatOf.has(a.id)) : 0) ||
          Number(withMerges(b)) - Number(withMerges(a)) ||
          kb.front - ka.front ||
          ka.tier - kb.tier ||
          ka.at - kb.at ||
          ka.seat - kb.seat ||
          a.id.localeCompare(b.id)
        );
      });
    return { order, trainHeld };
  }

  /**
   * BOS-1504: the order to re-seat the merge train in after a restart, the way the train admits: tickets with a live merge job
   * of this project, by tier (0 when a live job was moved to the front, else the ticket's check priority), then place (its
   * earliest live merge job), then id. Queue time alone seated background-lane tickets right behind the head.
   */
  async function liveMergeOrder(projectId: string, now = new Date()): Promise<string[]> {
    const live = await db.select().from(checkJobs).where(and(eq(checkJobs.projectId, projectId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, [...LIVE])));
    const marks = await tiers([...new Set(live.map((j) => j.ticketId))]);
    const ageMs = (await laneAgeMinutes(db)) * 60_000;
    const by = new Map<string, { tier: number; place: number }>();
    for (const j of live) {
      // BOS-1803: an aged background-lane merge re-seats as ordinary, the way the train's own queue ranks it.
      const tier = j.frontAt ? 0 : agedTier(marks.get(j.ticketId) ?? j.priority, now.getTime() - j.queuedAt.getTime(), ageMs);
      const cur = by.get(j.ticketId);
      by.set(j.ticketId, cur ? { tier: Math.min(cur.tier, tier), place: Math.min(cur.place, j.queuedAt.getTime()) } : { tier, place: j.queuedAt.getTime() });
    }
    return [...by.entries()].sort(([ia, a], [ib, b]) => a.tier - b.tier || a.place - b.place || ia.localeCompare(ib)).map(([id]) => id);
  }

  /**
   * BOS-1384: put a waiting merge next in line (below a fix for a red main). Only a merge job still queued can move; a running one is
   * never touched, and nothing here skips a check: the job runs in full when it is served. Returns the job, or null if none waits.
   * BOS-1519: a queued quick pre-review check moves too (it then sorts with the merges at once, see `serving`). A full pre-review
   * check does not: the ticket asked for quick ones, and a full one holds a long-job slot for 15 minutes or more.
   */
  async function moveToFront(companyId: string, ticketId: string, by: string, reason?: string, now = new Date()): Promise<CheckJob | null> {
    const rows = await db
      .update(checkJobs)
      .set({ frontAt: now, frontBy: by })
      .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.ticketId, ticketId), or(eq(checkJobs.kind, "merge"), eq(checkJobs.scope, "quick")), eq(checkJobs.state, "queued")))
      .returning();
    for (const row of rows) {
      const what = row.kind === "merge" ? "merge" : "quick check";
      await record(db, { companyId, ticketId, kind: "reorganised", summary: `${by} moved this ${what} to the front of the line${reason ? `: ${reason}` : ""}`, detail: { jobId: row.id, kind: row.kind, by, reason: reason ?? null }, at: now });
    }
    return rows.find((r) => r.kind === "merge") ?? rows[0] ?? null;
  }

  /**
   * BOS-1516: "Move to front" for a ticket still waiting for a merge train seat. It has no check job to mark yet, so the move is
   * made on the train: the ticket is seated ahead of every other waiting ticket (below a merge-line fix). True when it moved,
   * false when it isn't waiting for a seat (not joined yet, already seated, or already first in tier). Nothing is skipped: it
   * still runs its whole check once seated.
   */
  async function moveSeatWaiter(companyId: string, ticketId: string, by: string, reason?: string, now = new Date()): Promise<boolean> {
    const [t] = await db.select({ projectId: tickets.projectId }).from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
    if (!t || !retierWaiting(t.projectId, ticketId, 0)) return false;
    await record(db, { companyId, ticketId, kind: "reorganised", summary: `${by} moved this merge to the front of the merge train${reason ? `: ${reason}` : ""}`, detail: { by, reason: reason ?? null, where: "train" }, at: now });
    return true;
  }

  /** Give the free slots (per company: one runner each) to the next jobs, marking them running on this runner. Returns what to start. */
  async function claimNext(runnerId: string | null, now = new Date(), companyId?: string, runnerSlots?: number, opts: { dedicatedOnly?: boolean } = {}): Promise<CheckJob[]> {
    return (await claimNextWhy(runnerId, now, companyId, runnerSlots, opts)).jobs;
  }

  /** `claimNext` with the reason a free runner slot took nothing (R46). */
  async function claimNextWhy(runnerId: string | null, now = new Date(), companyId?: string, runnerSlots?: number, opts: { dedicatedOnly?: boolean } = {}): Promise<ClaimResult> {
    // BOS-1471: never more than the runner says it runs at once, or the extra jobs show as running while they wait for its slot lock.
    return claimOnWhy(runnerId, Math.min(await slots(), runnerSlots ?? Infinity), now, companyId, undefined, { policy: await runnerPolicy(), dedicatedOnly: opts.dedicatedOnly });
  }

  /** Running jobs on one machine by kind (see `admits`). */
  async function useOn(d: Db, onMachine: ReturnType<typeof and>): Promise<SlotUse> {
    const [u] = (await d
      .select({
        merge: sql<number>`count(*) filter (where ${checkJobs.kind} = 'merge')::int`,
        check: sql<number>`count(*) filter (where ${checkJobs.kind} <> 'merge')::int`,
        longCheck: sql<number>`count(*) filter (where ${checkJobs.kind} <> 'merge' and ${checkJobs.scope} = 'full')::int`,
      })
      .from(checkJobs)
      .where(and(eq(checkJobs.state, "running"), onMachine))) as [SlotUse];
    return u;
  }
  const machineCond = (worker: string | null, companyId?: string) => (worker ? eq(checkJobs.workerId, worker) : and(isNull(checkJobs.workerId), companyId ? eq(checkJobs.companyId, companyId) : undefined));

  /**
   * BOS-1435: claim for one machine with its own slot limit. A company runner's running jobs are counted per company (worker
   * jobs left out), exactly as before; a check worker's are counted across every company, since its slots are shared.
   */
  async function claimOn(
    machine: Machine,
    limit: number,
    now = new Date(),
    companyId?: string,
    skip?: (jobId: string) => boolean,
    opts: { policy?: SlotPolicy; dedicatedOnly?: boolean } = {},
  ): Promise<CheckJob[]> {
    return (await claimOnWhy(machine, limit, now, companyId, skip, opts)).jobs;
  }

  /**
   * R46 (BOS-1814): `claimOn` with the reason. When it starts nothing although a queued job exists that this machine could
   * take, `declined` says which job and why, in words from the deciding rule (never a bare empty list). `expected` marks a
   * reason the owner already sees elsewhere (the server-update pause), so the alarm leaves it alone.
   */
  async function claimOnWhy(
    machine: Machine,
    limit: number,
    now = new Date(),
    companyId?: string,
    skip?: (jobId: string) => boolean,
    opts: { policy?: SlotPolicy; dedicatedOnly?: boolean; quickOnly?: boolean } = {},
  ): Promise<ClaimResult> {
    // A server update waiting for a quiet machine (BOS-420): running jobs finish, queued ones wait (they don't fail).
    // BOS-1748: the hold parks the company runner and every merge check, but a separate check worker still takes quick
    // pre-review checks. The update waits only on merge checks and agent runs (deploy-wait counts nothing on a worker), a
    // worker holds no secrets and does no merges, and a quick check cut off by the restart goes back in line (requeueWorker
    // when its socket drops) and costs 2 to 5 minutes. Holding them back gained nothing and left the worker idle for up to 3 hours.
    const held = (await softHold(db, now)).on;
    const worker = isWorker(machine) ? machine.workerId : null;
    const policy = opts.policy ?? DEFAULT_SLOT_POLICY;
    const no = (declined: CheckDecline | null): ClaimResult => ({ jobs: [], declined: opts.dedicatedOnly ? null : declined });
    const ofCompany = (await servable(now, limit >= 2)).filter((j) => !companyId || j.companyId === companyId);
    // BOS-2058: what the hold stops is the table's `blocks` for the server wait, the same list its quiet test counts.
    if (held && (!worker || blocksClass("server-quiet", "quick-check-worker"))) return no(ofCompany[0] ? declineOf(ofCompany[0], "update_hold", "new checks are paused for a server update", true) : null);
    // BOS-1436: `skip` leaves out jobs this machine couldn't get the code for, so they go elsewhere instead of looping.
    // BOS-2108: `quickOnly` is the runner drain's rule for a worker (the dispatcher reads it from WAIT_RULES): quick checks only.
    const longHeld = held || !!opts.quickOnly;
    const candidates = ofCompany.filter((j) => !skip?.(j.id)).filter((j) => !longHeld || !isLong(j));
    if (candidates.length === 0) {
      const heldLong = longHeld ? ofCompany.find((j) => isLong(j) && !skip?.(j.id)) : undefined;
      if (heldLong) return no(declineOf(heldLong, "update_hold", `merge and full checks are paused for a ${held ? "server" : "runner"} update`, true));
      const skipped = ofCompany.find((j) => skip?.(j.id));
      return no(skipped ? declineOf(skipped, "no_code", "this machine could not get the code for it, so it goes to another machine", false) : null);
    }
    const onMachine = machineCond(worker, companyId);
    // Count and claim under one lock so two concurrent pumps can't both see a free slot.
    return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"check_jobs_claim"}))`);
    // BOS-1264: with two or more slots, merge checks (15 minutes) may not take the last slot while a quick pre-review check
    // (2 to 5 minutes) waits, or a full line of merges keeps every developer waiting 30 to 60 minutes. Merges that fix main are exempt.
    // DR-056: long jobs (merge or full scope) count against the reserve; only a quick-scope job may use the reserved slot.
    // BOS-1435: the reserve is per machine, with that machine's own limit. BOS-1602: `admits` holds both rules, and the
    // owner's per-machine split (what it takes, slots kept for merges); with nothing set it is the rule above, unchanged.
    const use = await useOn(tx as unknown as Db, onMachine);
    if (use.merge + use.check >= limit) return { jobs: [], declined: null };
    const quickWaits = candidates.some((j) => !isLong(j));
    const claimed: CheckJob[] = [];
    for (const j of candidates) {
      if (use.merge + use.check >= limit) break;
      if (!admits(limit, policy, use, j, { quickWaits, dedicatedOnly: opts.dedicatedOnly })) continue;
      // Guarded on state so two callers can't both start the same job.
      const [row] = await tx
        .update(checkJobs)
        .set({ state: "running", runnerId: worker ? null : (machine as string | null), workerId: worker, startedAt: now, lastOutputAt: now, reason: null, busyAtStart: use.merge + use.check })
        .where(and(eq(checkJobs.id, j.id), eq(checkJobs.state, "queued")))
        .returning();
      if (!row) continue;
      claimed.push(row);
      if (row.kind === "merge") use.merge++;
      else {
        use.check++;
        if (row.scope === "full") use.longCheck++;
      }
    }
    if (claimed.length || opts.dedicatedOnly) return { jobs: claimed, declined: null };
    // A free slot, a job it may take, and nothing started: say which job and which rule.
    const j0 = candidates[0]!;
    const mergesOnly = policy.takes === "merge" && j0.kind !== "merge";
    const checksOnly = policy.takes === "checks" && j0.kind === "merge";
    const declined = mergesOnly
      ? declineOf(j0, "machine_policy", "this machine is set to take merge checks only", true)
      : checksOnly
        ? declineOf(j0, "machine_policy", "this machine is set to take pre-review checks only", true)
        : isLong(j0) && quickWaits
          ? declineOf(j0, "reserve", "the last free slot is kept for a quick check that is waiting", false)
          : declineOf(j0, "slot_rules", "this machine's slot rules (slots kept for merges) do not allow it yet", false);
    return { jobs: [], declined };
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
  async function complete(jobId: string, result: { runnerId: Machine; commit: string; exitCode: number | null; logTail: string; timedOut?: boolean; fullLog?: string; stages?: Array<{ name: string; seconds: number }>; ranFull?: boolean }, now = new Date()): Promise<CheckJob | null> {
    const ok = result.exitCode === 0 && !result.timedOut;
    const facts = ok ? "" : checkFailureFacts(result.logTail);
    const [row] = await db
      .update(checkJobs)
      .set({
        state: ok ? "passed" : "failed",
        exitCode: result.exitCode,
        logTail: result.logTail.slice(-8192),
        ...(result.stages ? { stages: JSON.stringify(result.stages.slice(0, 60).map((s) => ({ name: s.name.slice(0, 60), seconds: s.seconds }))), ranFull: result.ranFull ?? null } : {}),
        reason: ok ? null : result.timedOut ? "The check ran past its time limit and was stopped." : typeof result.exitCode === "number" ? `The check failed with exit code ${result.exitCode}${facts ? ` (${facts})` : ""}.` : `The check was stopped before it reported${facts ? ` (${facts})` : ""}.`,
        endedAt: now,
      })
      .where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), eq(checkJobs.commit, result.commit), sentTo(result.runnerId)))
      .returning();
    // BOS-1228: a failed job keeps its whole log. The runner already cut and redacted it; the server does both again, because it
    // does not trust what arrives (a runner older than this change sends none, and then only the tail exists).
    // BOS-1723: a check that failed before its first step (the copy of the code couldn't be made, the runner couldn't
    // start it) sends no whole log, and those were the checks nobody could read afterwards. The tail is then all
    // there is, and it is short: keep it as the log, saying so, so check_log can still show what went wrong.
    const kept = result.fullLog || (result.logTail.trim() ? `[Only the end of the log reached the server; this is all of it that was kept.]\n${result.logTail}` : "");
    if (row && !ok && kept) {
      const { log } = prepareFullLog(kept);
      await db.insert(checkJobLogs).values({ jobId, log, chars: log.length, createdAt: now }).onConflictDoNothing();
    }
    return row ?? null;
  }

  /**
   * BOS-1723: the ticket's failed check jobs, newest first, for check_log without a jobId: which job, what kind, when, the
   * first failing line and whether its log is kept. Failed and stuck jobs both count (a stuck one never reported).
   */
  async function failedJobs(companyId: string, ticketId: string, limit = 20): Promise<Array<{ jobId: string; kind: string; scope: string; commit: string; state: string; endedAt: Date | null; firstLine: string | null; logChars: number | null }>> {
    const rows = await db
      .select({ jobId: checkJobs.id, kind: checkJobs.kind, scope: checkJobs.scope, commit: checkJobs.commit, state: checkJobs.state, endedAt: checkJobs.endedAt, queuedAt: checkJobs.queuedAt, reason: checkJobs.reason, logTail: checkJobs.logTail, logChars: checkJobLogs.chars })
      .from(checkJobs)
      .leftJoin(checkJobLogs, eq(checkJobLogs.jobId, checkJobs.id))
      .where(and(eq(checkJobs.companyId, companyId), eq(checkJobs.ticketId, ticketId), inArray(checkJobs.state, ["failed", "stuck"])))
      .orderBy(desc(sql`coalesce(${checkJobs.endedAt}, ${checkJobs.queuedAt})`))
      .limit(limit);
    return rows.map((r) => ({ jobId: r.jobId, kind: r.kind, scope: r.scope, commit: r.commit, state: r.state, endedAt: r.endedAt, firstLine: firstFailingLine(r.logTail ?? "") ?? r.reason ?? null, logChars: r.logChars ?? null }));
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
    // BOS-1923: the step times are kept as long as a failed log.
    await db.update(checkJobs).set({ stages: null }).where(and(isNotNull(checkJobs.stages), lt(checkJobs.endedAt, new Date(now.getTime() - days * 86_400_000))));
    return gone.length;
  }

  async function end(jobId: string, state: "stuck" | "cancelled", reason: string, now = new Date()): Promise<CheckJob | null> {
    if (!reason.trim()) throw new Error("A check job can't be ended without a reason.");
    const [row] = await db.update(checkJobs).set({ state, reason, endedAt: now }).where(and(eq(checkJobs.id, jobId), inArray(checkJobs.state, [...LIVE]))).returning();
    if (row && state === "stuck") await keepStuckTail(row, now).catch(() => {});
    return row ?? null;
  }

  /**
   * BOS-2219: a stuck job never reports, so before this it kept no log and a hang could not be told from a slow run. Its last
   * output (the tail progress kept, up to 8 KB) becomes its kept log, redacted and pruned like a failed job's, so check_log shows it.
   */
  async function keepStuckTail(job: CheckJob, now: Date): Promise<void> {
    const tail = job.logTail ?? "";
    if (!tail.trim()) return;
    const at = job.lastOutputAt ? ` (its last output, at ${job.lastOutputAt.toISOString()})` : "";
    const { log } = prepareFullLog(`[${job.reason ?? "The check was marked stuck."} This is the end of the log that reached the server${at}.]\n${tail}`);
    await db.insert(checkJobLogs).values({ jobId: job.id, log, chars: log.length, createdAt: now }).onConflictDoNothing();
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
    const stuck = await db
      .update(checkJobs)
      .set({ state: "stuck", reason: `No output for ${minutes} minutes while running, so the check was marked stuck.`, endedAt: now })
      .where(and(eq(checkJobs.state, "running"), lt(checkJobs.lastOutputAt, cutoff)))
      .returning();
    for (const job of stuck) await keepStuckTail(job, now).catch(() => {}); // a lost log must not stop the stuck jobs being stopped
    return stuck;
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
    const served = await serving(now, (await slots()) >= 2);
    const order = served.order.filter((j) => j.companyId === companyId);
    const queued = order.map((j, i) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, scope: j.scope, place: i + 1, fixesMain: j.fixesMain }));
    const held = rows.filter((j) => j.state === "queued" && !order.some((o) => o.id === j.id)).map((j) => ({ id: j.id, ticketId: j.ticketId, kind: j.kind, heldBy: served.trainHeld.has(j.id) ? TRAIN_HELD : "main is red" }));
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
  async function list(companyId: string, now = new Date(), capacity?: number, machines?: MachineView[]) {
    // BOS-1435: with check workers the caller passes the company's whole capacity (runner plus ready workers).
    const limit = capacity ?? (await slots());
    // BOS-1602: once any machine has a split, a waiting check says which kind of slot it waits for and how busy those are.
    const waitWhy = machines?.some((m) => !isDefaultPolicy(m.policy)) ? await kindWaits(companyId, machines) : null;
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
    const served = await serving(now, limit >= 2);
    const order = served.order.filter((j) => j.companyId === companyId && info.has(j.id));
    const orderIds = new Set(order.map((j) => j.id));
    const held = live.filter((r) => r.job.state === "queued" && !orderIds.has(r.job.id)).map((r) => r.job);
    // "Slots busy" is per company: only this company's running jobs count against `limit`, since each company has its own runner slots.
    const full = runningJobs.length >= limit;
    // BOS-1803: each waiting job's lane in words, and a seat waiter's place among the tickets waiting for a train seat.
    const marks = await tiers([...new Set(live.map((r) => r.job.ticketId))]);
    const ageMs = (await laneAgeMinutes(db)) * 60_000;
    const seatQueues = new Map<string, string[]>();
    const seatPlace = (j: CheckJob): number | null => {
      if (!served.trainHeld.has(j.id)) return null;
      if (!seatQueues.has(j.projectId)) seatQueues.set(j.projectId, trainView(j.projectId)?.waiting ?? []);
      const i = seatQueues.get(j.projectId)!.indexOf(j.ticketId);
      return i < 0 ? null : i + 1;
    };
    const row = (j: CheckJob, position: number | null, heldBy: string | null) => {
      const r = info.get(j.id)!;
      const waitedMs = now.getTime() - j.queuedAt.getTime();
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
        why: j.state !== "queued" ? null : j.fixesMain ? "fixes main" : j.kind === "merge" && landingTurns.holds(j.projectId, j.ticketId) ? "holds the landing turn" : j.frontAt ? `moved to front by ${j.frontBy ?? "the owner"}` : r.urgent ? "urgent" : null,
        heldBy,
        // BOS-1517: held because the ticket has no merge-train seat yet (its check isn't waiting for a slot at all).
        heldBySeat: j.state === "queued" && served.trainHeld.has(j.id),
        // BOS-1803: place among the tickets waiting for a train seat (1 = seated next); null when not waiting for one.
        seatPlace: j.state === "queued" ? seatPlace(j) : null,
        // BOS-1803: "background lane: …" while it waits (null for ordinary work, an urgent one, or a moved-to-front one).
        lane: j.state !== "queued" || j.frontAt || j.fixesMain ? null : laneWords(marks.get(j.ticketId) ?? j.priority, waitedMs, ageMs),
        // True only for checks a red main holds back; "all slots are busy" fills heldBy too but is plain queueing (BOS-1262).
        heldByMain: heldBy !== null && heldBy.startsWith("main is red"),
        // BOS-1435: where a running check runs: the company's runner, or a check worker by name.
        ranOn: j.state !== "running" ? null : j.workerId ? (r.worker ?? "a check worker") : "company runner",
      };
    };
    const rows = [
      ...runningJobs.map((r) => row(r.job, null, null)),
      ...order.map((j, i) => row(j, i + 1, waitWhy ? waitWhy(j) : full ? `all ${limit} check ${limit === 1 ? "slot is" : "slots are"} busy` : null)),
      ...held.map((j) => row(j, null, served.trainHeld.has(j.id) ? `${TRAIN_HELD}, so this merge check waits until the ticket is seated` : "main is red, so this merge check waits until main is fixed")),
    ];
    // BOS-1938: the last few finished checks that are not merge checks (the Merges tab lists those), with their stage line.
    const doneRows = await db
      .select({ job: checkJobs, number: tickets.number, title: tickets.title })
      .from(checkJobs)
      .innerJoin(tickets, eq(tickets.id, checkJobs.ticketId))
      .where(and(eq(checkJobs.companyId, companyId), sql`${checkJobs.kind} <> 'merge'`, inArray(checkJobs.state, ["passed", "failed"]), isNotNull(checkJobs.endedAt)))
      .orderBy(desc(checkJobs.endedAt))
      .limit(10);
    const finished = doneRows.map((r) => ({
      id: r.job.id,
      ticketId: r.job.ticketId,
      ref: ticketRef(prefix, r.number),
      title: r.title,
      passed: r.job.state === "passed",
      at: r.job.endedAt!.toISOString(),
      stageLine: stageLine(r.job, limit),
    }));
    return { mode: await mode(), slots: limit, running: runningJobs.length, rows, finished };
  }

  /**
   * BOS-1602: per kind, how many slots on the given machines can run it and how many of those are busy, as the owner's
   * reason for a waiting check ("waiting for a merge slot: 2 of 2 busy"). Null while a slot it may use is free.
   */
  async function kindWaits(companyId: string, machines: MachineView[]): Promise<(j: CheckJob) => string | null> {
    const seen = { merge: { busy: 0, slots: 0 }, check: { busy: 0, slots: 0 } };
    for (const m of machines) {
      const use = await useOn(db, machineCond(m.workerId, companyId));
      const s = slotShape(m.limit, m.policy);
      const total = use.merge + use.check;
      const forMerge = s.mergeOnly + s.either;
      const forCheck = s.checkOnly + s.either;
      seen.merge.slots += forMerge;
      seen.merge.busy += Math.min(forMerge, total);
      seen.check.slots += forCheck;
      // On a machine with kept slots, a check can only use the either slots: those hold every check plus the merges past the kept ones.
      seen.check.busy += s.checkOnly ? Math.min(forCheck, total) : Math.min(forCheck, use.check + Math.max(0, use.merge - s.mergeOnly));
    }
    return (j) => {
      const merge = j.kind === "merge";
      const k = merge ? seen.merge : seen.check;
      const what = merge ? "merge" : "check";
      if (!k.slots) return merge ? "no machine that takes merge checks is ready" : "no machine that takes pre-review checks is ready";
      return k.busy >= k.slots ? `waiting for a ${what} slot: ${k.busy} of the ${k.slots} slots that take ${merge ? "merge" : "pre-review"} checks busy` : null;
    };
  }

  /** The owner's merge train switch (BOS-1366, DR-059): off unless set to true. */
  async function train(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_TRAIN_KEY));
    return row?.value === true || row?.value === "true";
  }

  async function setTrain(on: boolean): Promise<void> {
    await db.insert(settings).values({ key: MERGE_TRAIN_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  }

  /** BOS-1803: minutes a background-lane wait yields to newer ordinary work (0 = always yields). */
  const laneAge = () => laneAgeMinutes(db);
  async function setLaneAge(minutes: number): Promise<void> {
    const value = readLaneAgeMinutes(minutes);
    if (value !== minutes) throw new Error("The background lane wait must be a whole number of minutes from 0 to 1440.");
    await db.insert(settings).values({ key: BACKGROUND_LANE_AGE_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    setTrainLaneAge(value * 60_000);
  }

  const place = (ticketId: string) => mergePlace(db, ticketId);

  return { list, mode, slots, setMode, setSlots, runnerPolicy, setRunnerPolicy, train, setTrain, laneAge, setLaneAge, place, liveMergeOrder, queuedIds, enqueue, retarget, moveToFront, moveSeatWaiter, claimNext, claimNextWhy, claimOn, claimOnWhy, progress, complete, readLog, failedJobs, logChars, pruneLogs, cancel, markStuck, requeue, requeueRunning, requeueWorker, sweepStuck, setMainState, status };
}
