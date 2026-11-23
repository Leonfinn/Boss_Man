// The review service's shared state and helpers (BOS-1901, move 1 of the BOS-1886 split): what the reviewService closure
// held before, built once per service by reviewContext. review.ts destructures it, so its method bodies are unchanged; a part
// moved to its own file takes it as `ctx`. The two values reassigned after building (the wake hook and the running
// missed-merge sweep) live on `state`, because a destructured `let` can't be reassigned from another file.
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { carryFailedOver, DEFAULT_GIT_TEMPLATES, deploysNothing, goLiveWaitWords, MERGE_MISSED_AFTER_MS, parseRepoUrl, readCriteria, riskOf, ruleFor, ticketRef, touchesRunnerCode, touchesRunnerUpdate, unreportedAfterMerge, type CarriedTicket, type GitHostKind } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, deployTargets, projects, runners, settings, tickets } from "../db/schema.js";
import { addTicketDependency } from "./ticket-links.js";
import type { runnersService } from "./runners.js";
import { GIT_RETRY_CARD_NOTE, GIT_RETRY_NOTE } from "./git-transport-fault.js";
import type { workService } from "./work.js";
import type { loopGuards } from "./loop-guards.js";
import { CI_TIMING } from "./ci-publish.js";
import { GitHostError, type GitHostConfig, type gitHostService } from "./git-hosts.js";
import { effectivePolicy } from "./review-policy.js";
import { evaluate, latestRows, type ReviewRow } from "./review-kinds.js";
import { ceoFirstMergeNote, fixesLiveHeading, raiseMergeStuck } from "./decisions.js";
import { derivedSignoff, openSignoffCard } from "./signoff.js";
import { checkGate } from "./check-gate.js";
import { checkQueue } from "./check-queue.js";
import { scanListReader, type ScanListWarning } from "./scan-list.js";
import { record } from "./activity.js";
import { wakeWatchers, type WatchNotify } from "./watch-triggers.js";
import { leftLineSince, lineEvent, type HoldReason } from "./merge-line.js";
import { priorityGroup } from "./priority-group.js";
import { CHECK_WAIT_LABEL, createHold, ensureSystemHold, mergeHolds, mergeWaits, openHold } from "./review-holds.js";
import { CARRIED_NOTE_PREFIX, type TurnWait } from "./merge-queue.js";
import type { notificationsService } from "./notifications.js";
import { goLiveWaitOf } from "./go-live-wait.js";
import { cardHeld, CHECK_MERGED_KEY, highestRisk, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_DEFAULT_MIN, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, MERGE_WAIT_MS, raiseCheckStuck, ReviewError, ReviewHeldError, SignoffPendingError, WAIT_FOR_CI_KEY, type CarriedInfo, type GitTemplates, type HoldInput, type LandingStatus, type NotifyHook } from "./review-common.js";

export type ReviewDeps = {
    runners: ReturnType<typeof runnersService>;
    work: ReturnType<typeof workService>;
    loops: ReturnType<typeof loopGuards>;
    /** Pull requests on the git host (R59), with the company's GIT_TOKEN. */
    gitHosts?: ReturnType<typeof gitHostService>;
    gitToken?: (companyId: string) => Promise<string | undefined>;
    /** BOS-2285: the company's optional GIT_CI_TOKEN (a second account for the gate's bossman-ci pushes); undefined means ask the owner once. */
    gitCiToken?: (companyId: string) => Promise<string | undefined>;
    notes?: Pick<ReturnType<typeof notificationsService>, "notify">;
    /** False on a standby copy (blue/green): a merge cut off by the hand-over is left to the leader's sweep. */
    isLeader?: () => boolean;
    /** The owner's private-details list for the merge-line scan (BOS-979). A read failure is said once (BOS-1093); pass it through scanListWarning. */
    scanList?: () => Promise<string | null>;
    /** Where a set list that can't be read says so: one warning and one owner notification per failure streak (BOS-1093). */
    scanListWarning?: ScanListWarning;
    /** A ticket's merge commit is on main: frees the tickets that wait on it "until merged" (BOS-989). */
    onMerged?: (ticketId: string) => Promise<unknown>;
    /** BOS-1070: shorter CI waits for tests. */
    ciTiming?: Partial<typeof CI_TIMING>;
    /** Ends a check job with a reason and stops it on the runner if it runs (the check dispatcher's cancel). Used to drop a merge check left over from before a restart. */
    cancelCheck?: (jobId: string, reason: string) => Promise<unknown>;
    /** BOS-1435: checks the company can run at once (runner plus ready check workers); the merge train's seats. Absent: the slots setting. */
    checkCapacity?: (companyId: string) => Promise<number>;
    /** The alert ladder's raise: three failed merges with one reason in 30 minutes raise one CEO alert (BOS-1461). */
    alert?: (input: Record<string, unknown>) => Promise<unknown>;
};

export function reviewContext(db: Db, deps: ReviewDeps) {
  const state: { wake: NotifyHook | null; missedSweep: Promise<void> | null } = {
    wake: null,
    // shortcut: the missed-merge sweep running now (BOS-1645), so passes never overlap; lost on restart, harmless because a fresh process runs none.
    missedSweep: null,
  };
  // shortcut: in memory, so a server restart mid-landing forgets the status (the ticket itself is unaffected); upgrade to a column if owners need it to survive restarts.
  const landings = new Map<string, LandingStatus>();
  // At most N merge checks at once, quick or full (BOS-446); the rest wait in order, urgent and arch fixes first.
  const gate = checkGate(db);
  const queue = checkQueue(db);
  // A set list that can't be read says so; an unset one reads as null, silently.
  const scanListWarning = scanListReader({ read: deps.scanList ?? (async () => null), ...deps.scanListWarning });
  // When each ticket's merge last said it was alive (BOS-362). The merge sweep reads this, not the ticket's
  // activity, which chat and chases also bump: talk must not hold a merge retry back, and a running merge must.
  // shortcut: in memory like `landings`; a restart ends every merge, so forgetting it is correct.
  const landingBeat = new Map<string, number>();
  // Where a running merge is: waiting its turn for a check slot, running the check, or merging (DR-014). In memory like `landings`.
  const phases = new Map<string, "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git">();
  // BOS-1070: a merge waiting for the git host's CI, beside its own check (so not a phase): since when, and the jobs still running.
  // shortcut: in memory like `landings`, lost on restart, harmless because a restart ends the wait it describes.
  const ciWaits = new Map<string, { since: number; waiting: string[] }>();
  // BOS-2119 (R43): a merge waiting for another ticket's landing turn, before it re-prepares ("rebuild") or before it pushes
  // a passed check ("push"). It holds no check slot then, so the Merges tab, mergeState and server_status read this one
  // marker for their words. shortcut: in memory like `landings`; the turns it describes are in memory too (DR-026).
  const turnWaits = new Map<string, TurnWait>();
  // Merged trees the git host's CI passed. A merge rebuilt on a moved main with the same tree keeps the pass, as a
  // check-all pass is kept (P11a), so it isn't pushed and waited for again. shortcut: in memory, so a restart waits again.
  const ciPassedTrees = new Set<string>();
  // Tickets held by another ticket's open CI access or billing card in the same project: started again once CI reads work.
  // shortcut: lost on restart, harmless because the unmerged-approvals sweep starts the held tickets again and they rejoin the open card.
  const ciCardWaiting = new Map<string, Set<string>>();
  const ciTiming = { ...CI_TIMING, ...deps.ciTiming };
  const beatNow = (ticketId: string) => {
    landingBeat.set(ticketId, Date.now());
    return db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId));
  };

  async function ticketWithRepo(ticketId: string, companyId?: string) {
    const [row] = await db
      .select({
        t: tickets,
        repoUrl: projects.repoUrl,
        projectName: projects.name,
        defaultBranch: projects.defaultBranch,
        verifyCommand: projects.verifyCommand,
        deepVerifyCommand: projects.deepVerifyCommand,
        landing: projects.landing,
        gitHost: projects.gitHost,
        gitApiBase: projects.gitApiBase,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!row || (companyId && row.t.companyId !== companyId)) throw new ReviewError(404, "No such ticket.");
    return row;
  }

  /**
   * A read-only trial merge of the ticket's branch on the default branch (the runner's `workspace.clash`: tryMerge on origin's
   * tip, with the gate's BOS-690 migration renumbering, writing nothing). The clashing files (a real clash with no list is []),
   * or null when it merges cleanly or can't be told (no runner, an older runner, a timeout, an error). Null must always read as
   * "carry on": branchClash (BOS-426) and the merge train's waiting trial (BOS-1515) both rely on that.
   */
  async function clashOnMain(t: { id: string; companyId: string; projectId: string }, defaultBranch: string): Promise<string[] | null> {
    try {
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "clash-check")) return null;
      const r = await deps.runners.request<{ clashes?: boolean; files?: string[] }>(runner.id, (requestId) => ({ type: "workspace.clash", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch }), 15_000);
      if (typeof r?.clashes !== "boolean") return null;
      return r.clashes ? (Array.isArray(r.files) ? r.files : []) : null;
    } catch {
      return null;
    }
  }

  /** Tickets by id with their refs (BOS-1515: who a train clash was with), in the order given; unknown ids are left out. */
  async function namedTickets(ids: string[]): Promise<Array<{ ticketId: string; ref: string | null; title: string }>> {
    if (!ids.length) return [];
    const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ ticketId: id, ref: ticketRef(r.prefix, r.number), title: r.title }] : [];
    });
  }

  /**
   * True when a running landing's ticket has gone quiet for longer than a merge can take. The ticket's
   * last activity is the heartbeat every landing keeps, so this uses the same sign of life as the sweep.
   */
  async function landingStale(ticketId: string): Promise<boolean> {
    const [row] = await db.select({ state: tickets.systemState, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(eq(tickets.id, ticketId));
    if (!row || row.state !== "review") return true;
    // BOS-1769: a landing whose ticket left review after it started is over, even when the ticket is back in review and the
    // old landing still beats the heartbeat: otherwise its marker refuses every retry and the back-in-review restart.
    const marker = landings.get(ticketId);
    if (marker?.state === "running" && (await leftLineSince(db, ticketId, new Date(marker.startedAt)))) return true;
    return Date.now() - row.lastActivityAt.getTime() > MERGE_MISSED_AFTER_MS;
  }

  /** The host and token for a pull request; without either, approval stops with what to set (R59). */
  async function prTarget(companyId: string, repoUrl: string | null, gitHost: string | null, gitApiBase: string | null): Promise<{ cfg: GitHostConfig; token: string }> {
    const a = repoUrl ? parseRepoUrl(repoUrl) : null;
    if (!deps.gitHosts || !a || (gitHost !== "gitea" && gitHost !== "github") || !gitApiBase)
      throw new ReviewError(409, "Boss Man doesn't know this project's git host, so it can't open a pull request. Set the host in the project's settings, or land work by merging.");
    const token = await deps.gitToken?.(companyId);
    if (!token) throw new ReviewError(409, "Grant the company a GIT_TOKEN secret that can push and open pull requests, then approve again.");
    return { cfg: { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo }, token };
  }

  /** The project's open tickets that have a branch of their own, other than this one: candidates to be carried (BOS-130). */
  async function otherOpenBranches(t: typeof tickets.$inferSelect) {
    return db
      .select({ ticketId: tickets.id, branch: tickets.branch, title: tickets.title, risk: tickets.risk })
      .from(tickets)
      .where(and(eq(tickets.projectId, t.projectId), ne(tickets.id, t.id), ne(tickets.systemState, "done"), isNotNull(tickets.branch)));
  }

  /**
   * The unmerged commits of other open tickets' branches that this branch carries (BOS-130): the
   * runner works it out from git. This is a safety gate, so it refuses rather than merges when it
   * can't answer: the runner failing or timing out is an error, and a runner too old to do the
   * check falls back to the host's own answer, which refuses when it can't give one either.
   */
  async function carriedBetween(runnerId: string, t: typeof tickets.$inferSelect, defaultBranch: string, gitHost: string | null, gitApiBase: string | null): Promise<CarriedInfo[]> {
    const others = (await otherOpenBranches(t)).filter((o): o is typeof o & { branch: string } => !!o.branch && o.branch !== t.branch);
    if (!others.length) return [];
    let ids: string[];
    let contained = new Set<string>();
    if (deps.runners.can(runnerId, "carried-check")) {
      let r: { carried?: CarriedTicket[] };
      try {
        // The same wait as a merge: the check queues behind other git jobs for the same repo lock.
        r = await deps.runners.request<{ carried?: CarriedTicket[] }>(runnerId, (requestId) => ({
          type: "workspace.carried",
          requestId,
          projectId: t.projectId,
          ticketId: t.id,
          target: defaultBranch,
          branches: others.map((o) => ({ ticketId: o.ticketId, branch: o.branch })),
        }), MERGE_WAIT_MS);
      } catch (err) {
        throw new ReviewError(409, `Couldn't check whether this branch carries other tickets' unmerged work, so it wasn't merged: ${(err as Error).message} Try approving it again.`, true);
      }
      if (!Array.isArray(r.carried)) throw new ReviewError(409, "Couldn't check whether this branch carries other tickets' unmerged work, so it wasn't merged. Try approving it again.", true);
      ids = r.carried.map((c) => c.ticketId);
      contained = new Set(r.carried.filter((c) => c.contained).map((c) => c.ticketId));
    } else {
      // An older runner: the host's pull requests are the only other answer, and they must give one.
      ids = await carriedOnHost(t, gitHost, gitApiBase, others);
    }
    return others.filter((o) => ids.includes(o.ticketId)).map((o) => ({ ticketId: o.ticketId, branch: o.branch, title: o.title, risk: o.risk, contained: contained.has(o.ticketId) }));
  }

  /**
   * Whether a carried ticket is already fully approved and only waiting to merge (BOS-372): in review, every
   * review passed, and no owner sign-off open. Its work is then reviewed, so a branch holding all of it may
   * land it too. Anything less (still in review rounds, sent back, awaiting the owner) stays a refusal.
   */
  async function approvedAndWaiting(ticketId: string): Promise<boolean> {
    const [c] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!c || c.systemState !== "review") return false;
    // Owed the owner's sign-off, card or not: not approved yet (BOS-503, DR-021). A missing card never means "not needed".
    const so = (await derivedSignoff(db, c)).state;
    if (so !== "not_needed" && so !== "signed_off") return false;
    const rows = await latestRows(db, ticketId);
    if (!rows.length || evaluate(rows) !== "passed") return false;
    // The one "held at the merge gate" answer (DR-061 Q2b): the sign-off card, a hold, a card marked as holding the
    // merge (BOS-1078) and waits on tickets not yet in force (BOS-1173).
    return (await mergeHolds(db, ticketId)).length === 0;
  }

  /**
   * The host's own answer, for a runner too old to compare branches (BOS-130): a ticket is carried
   * when the commit its pull request was reviewed at is one of the commits this ticket's pull
   * request is made of, up to the commit that was reviewed. An open pull request carries that too,
   * since its head is the reviewed commit and this branch already has it. Anything the host can't
   * answer is an error, never an empty list, so nothing merges on a guess.
   */
  async function carriedOnHost(t: typeof tickets.$inferSelect, gitHost: string | null, gitApiBase: string | null, others: Array<{ ticketId: string; branch: string; title: string }>): Promise<string[]> {
    if (!deps.gitHosts || !deps.gitToken || (gitHost !== "github" && gitHost !== "gitea") || !gitApiBase)
      throw new ReviewError(409, "Couldn't check whether this branch carries other tickets' unmerged work: Boss Man doesn't know this project's git host or has no git token. Nothing was merged.");
    const { t: fresh, defaultBranch, repoUrl } = await ticketWithRepo(t.id);
    const { cfg, token } = await prTarget(fresh.companyId, repoUrl, gitHost, gitApiBase);
    const viaHost = deps.gitHosts;
    // The commit the host reviewed each other open ticket's pull request at.
    const theirs: Array<{ ticketId: string; head: string }> = [];
    for (const o of others) {
      const [row] = await db.select({ number: tickets.pullRequestNumber, head: tickets.pullRequestHead, branch: tickets.branch }).from(tickets).where(eq(tickets.id, o.ticketId));
      if (!row?.branch) continue;
      // No pull request yet: the branch's own head at the host is what is waiting to land.
      const head = row.head ?? (await viaHost.branchHead(cfg, token, row.branch).catch((err) => {
        // A branch the host has never seen carries nothing onto the target, so it can't be
        // carried by this one either (BOS-577). Any other failure still refuses: the gate can't
        // answer for a branch that does exist.
        if (err instanceof GitHostError && err.status === 404) return null;
        throw new ReviewError(409, `Couldn't read the branch of "${o.title}" on the host, so it wasn't merged: ${(err as Error).message}`);
      }));
      if (head) theirs.push({ ticketId: o.ticketId, head });
    }
    if (!theirs.length) return [];
    let mine: string[];
    try {
      if (fresh.pullRequestNumber) mine = (await viaHost.getWithCommits(cfg, token, fresh.pullRequestNumber, fresh.pullRequestHead)).commits;
      // No pull request yet: the commits on the branch since the target, from the host's compare.
      else mine = fresh.branch ? await viaHost.compare(cfg, token, defaultBranch, fresh.branch) : [];
    } catch (err) {
      throw new ReviewError(409, `Couldn't read this branch's commits on the host, so it wasn't merged: ${(err as Error).message}`);
    }
    return theirs.filter((x) => mine.includes(x.head)).map((x) => x.ticketId);
  }

  /**
   * What to do when the check can't say whether the branch carries other open tickets' work
   * (BOS-130): a safety gate refuses when it can't answer. Nothing merges, the ticket stays in
   * review with the reason on it, the owner hears, and the assignee is asked to move it back.
   */
  async function refuseUnchecked(t: typeof tickets.$inferSelect, err: ReviewError) {
    await wait(t, `Not merged: Boss Man couldn't check whether this branch carries other tickets' unmerged work (${err.message}). Nothing was merged.`, "unchecked");
    const text = `The review of "${t.title}" was approved, but Boss Man couldn't check whether its branch carries other tickets' unmerged work (${err.message}), so it didn't merge. Move the ticket back to review to try again.`;
    const delivered = await tellAgent({ ...t, systemState: "in_progress" }, text, "carried check failed").catch(() => null);
    return { outcome: "carried" as const, delivered, detail: { unchecked: err.message } };
  }

  /**
   * What to do when the branch carries other open tickets' work (BOS-130): nothing merges. When one
   * of them would need the owner's sign-off at its risk, they're told, so its review, deeper check
   * and staging aren't skipped by riding on this ticket. There is never a merge to approve here:
   * the carried ticket has to merge first.
   */
  async function refuseCarried(t: typeof tickets.$inferSelect, carried: CarriedInfo[], o: { reviewerAgentId: string | null }) {
    const names = carried.map((c) => `"${c.title}"`).join(", ");
    const theirRisk = riskOf(highestRisk(carried.map((c) => c.risk)));
    const detail = { carried: carried.map((c) => ({ ticketId: c.ticketId, title: c.title, risk: c.risk })) };
    // The ticket stays in review, with the reason on it, until the carried ticket has merged. The sentence
    // is what the owner reads; the carried tickets' titles sit on their own last line as JSON, so a title
    // holding a quote or an apostrophe is never cut out of the prose (BOS-819).
    const note = `${CARRIED_NOTE_PREFIX} unapproved work from ${names} (${theirRisk} risk), which must merge first.\n${JSON.stringify(carried.map((c) => c.title))}`;
    await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, t.id));
    await lineEvent(db, t, { event: "hold_started", hold: "carried", carried: carried.map((c) => ({ ticketId: c.ticketId, title: c.title })) });
    const policy = await effectivePolicy(db, t);
    if (carried.some((c) => ruleFor(policy, c.risk).ownerSignoff)) {
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: t.companyId,
          kind: "question",
          question: `${names} (${theirRisk} risk) must be reviewed and merged before "${t.title}" can land: its branch carries that unmerged work. Merge ${names} first, then approve this ticket again.`,
          options: ["Got it"],
          recommendedOption: "Got it",
          raisedByAgentId: o.reviewerAgentId,
          tier: "owner",
          dedupeKey: `carried:${t.id}:${carried.map((c) => c.ticketId).sort().join(",")}`,
          context: { type: "carried", ticketId: t.id, carried: carried.map((c) => c.ticketId), risk: theirRisk },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      if (d) await addTicketDependency(db, { companyId: t.companyId, blockedTicketId: t.id, blockerDecisionId: d.id, actor: { type: "system" } });
    }
    const text = `The review of "${t.title}" was approved, but its branch also carries unmerged work from ${names}. Nothing was merged: ${names} must merge first. Once ${carried.length > 1 ? "those tickets have" : "it has"}, Boss Man starts this merge again by itself (BOS-733); the ticket stays in review, so don't move it.`;
    const delivered = await tellAgent(t, text, "carried work").catch(() => null);
    return { outcome: "carried" as const, delivered, detail };
  }

  /**
   * The work landed: done, unless a criterion can only be checked now that it is live (DR-024 #5). Then
   * the ticket goes back to its assignee to show those before it can close.
   */
  async function announceMerged(ticketId: string) {
    // The merge has landed; a failure to free a waiting ticket must not undo it. The release sweep catches it later.
    await deps.onMerged?.(ticketId).catch(() => undefined);
  }

  /** `at`: when the merge landed, for one recorded late (BOS-1645); mergedAt places it in merge order, so it must not be "now". */
  async function finishMerged(t: typeof tickets.$inferSelect, commit: string | null, files?: string[], at?: Date) {
    // A criterion still at fail when the work lands was put off, not failed (BOS-575): it stays on this
    // ticket, with its assignee, as an after-merge check, instead of the ticket closing on it.
    const carry = carryFailedOver(readCriteria(t.acceptanceCriteria), t.stateNote);
    await db
      .update(tickets)
      // mergedAt and touchesRunner (BOS-1021) place the merge and say whether the runners need a rebuild for it.
      .set({ mergeCommit: commit, pullRequestNote: null, ...(commit ? { mergedAt: at ?? new Date() } : {}), ...(commit ? { touchesRunner: files ? touchesRunnerCode(files) : true, touchesRunnerUpdate: files ? touchesRunnerUpdate(files) : null, deploysNothing: files ? deploysNothing(files) : null } : {}), ...(carry ? { acceptanceCriteria: carry.criteria, stateNote: carry.note, stateNoteAt: new Date() } : {}) })
      .where(eq(tickets.id, t.id));
    await announceMerged(t.id);
    if (carry) t = { ...t, acceptanceCriteria: carry.criteria, stateNote: carry.note };
    await lineEvent(db, t, { event: "merged", commit });
    if (commit) await tellCeoLiveFix(t, commit).catch(() => undefined);
    if (commit) await pagePriorityMerge(t).catch(() => undefined);
    const left = afterMergeLeft(t);
    // With a live check still to show, the ticket isn't finished: go straight to the assignee without a
    // brief done state in between, so done hooks (worktree release, notifications) never fire for it.
    if (!left) await deps.work.updateTicket(t.id, { state: "done", outcome: "completed", overLimit: true });
    return { outcome: "merged" as const, delivered: null, detail: { commit, ...(left ? { afterMerge: left } : {}), ...(carry ? { carried: carry.carried } : {}) } };
  }

  /** Checks the merged ticket now has to show: its after-merge criteria still without a pass or fail. */
  function afterMergeLeft(t: typeof tickets.$inferSelect): string[] | null {
    const left = unreportedAfterMerge(t.acceptanceCriteria, t.stateNote);
    return left.length ? left : null;
  }

  /**
   * Ends one ticket's go-live wait (BOS-1021) and wakes its assignee with the after-merge checks. `marked` is the
   * CEO's evidence when the company marked it live itself (BOS-1345), null when Boss Man saw the server run it.
   * True when the assignee was told.
   */
  async function releaseGoLive(t: typeof tickets.$inferSelect, marked: string | null): Promise<boolean> {
    // Claim it first: a second pass (the server update and a runner hello can land together) must not wake twice.
    const [claimed] = await db.update(tickets).set({ goLiveWait: null, goLiveWaitSince: null, liveAt: new Date() }).where(and(eq(tickets.id, t.id), isNotNull(tickets.goLiveWait))).returning({ id: tickets.id });
    if (!claimed) return false;
    const left = unreportedAfterMerge(t.acceptanceCriteria, t.stateNote);
    const quoted = left.map((c) => `"${c}"`).join(", ");
    if (!left.length || t.systemState === "done") return false;
    // A marked ticket says nothing about our runners: its company's code never runs on them.
    const runners = !marked && t.touchesRunner;
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: "go_live", summary: marked ? `The CEO marked the merge live (${marked}): the after-merge checks can be made now.` : `The merge is live${runners ? " and the runners have it" : ""}: the after-merge checks can be made now.` });
    const text = `${t.mergeCommit ? `Merged as ${t.mergeCommit.slice(0, 12)}, and it is live now` : "It is live now"}${marked ? ` (the CEO marked it live: ${marked})` : runners ? ", with the runners rebuilt" : ""}. These checks can only be made now: ${quoted}. Report pass or fail for each and move the ticket to done. If only the owner can check one, put a card in front of them (raise_decision with blocksTicketId): answering it records their answer as that check's pass or fail, so you can close the ticket once they have. If a check fails on the live work, report it as fail and move the ticket to done: Boss Man opens the follow-up ticket for it, assigned to you, so don't make one by hand.`;
    // BOS-1907: the ticket stays in Blocked, in the "Merged, watching" lane, where it counts toward no limit: the agent is
    // woken to report what it can now see, and records a watch for a check that needs a later event (BOS-1171 used to move it to In progress).
    const watch = " For a check that needs a later event (a week of real use, a scheduled job), call set_ticket_state with state blocked, watching_for (one line: what you wait to see) and watch_until (an end date; 14 days from now if you give none): the ticket stays in the Merged, watching lane and nothing alerts before that date.";
    return !!(await tellAgent({ ...t, systemState: "in_progress" }, text + watch, "after merge").catch(() => null));
  }

  /** After a real merge: close the ticket, or send it back to show the checks only a live host can settle. */
  async function closeAfterMerge(t: typeof tickets.$inferSelect, commit: string | null, causedByRunId?: string | null, files?: string[], at?: Date) {
    const r = await finishMerged(t, commit, files, at);
    if (!r.detail.afterMerge) return { outcome: "merged" as const, delivered: null, detail: r.detail };
    const merged = commit ? `Merged as ${commit.slice(0, 12)}. ` : "Merged. ";
    // The branch is merged, so its working copy would be released (and checking on it would need a fresh
    // clone): it's kept for this pass so the agent can show the live result where it was.
    const [repoUrl] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, t.id));
    // BOS-1021: the merge is not running yet (server not updated, or runner code the runners lack): the checks
    // can't pass, so nobody is woken and no owner card is asked for. Boss Man wakes the assignee at go-live.
    const waitsFor = commit ? await goLiveWaitOf(db, { companyId: t.companyId, mergeCommit: commit, touchesRunner: files ? touchesRunnerCode(files) : true, liveMarkedAt: null, deploysNothing: files ? deploysNothing(files) : null }) : null;
    // BOS-1171: while the checks only wait for go-live the ticket sits in Blocked, so it holds no in-progress slot;
    // at go-live (releaseGoLive) it stays there and the assignee is woken (BOS-1907).
    if (repoUrl?.repoUrl) await deps.work.updateTicket(t.id, { state: waitsFor ? "blocked" : "in_progress", overLimit: true, internal: true, noCode: true });
    const carried = r.detail.carried ?? [];
    const quoted = (list: string[]) => list.map((c) => `"${c}"`).join(", ");
    if (waitsFor) {
      // A mark from an earlier merge of this ticket (BOS-1345) doesn't cover this one: this merge is judged as new.
      await db.update(tickets).set({ goLiveWait: waitsFor, goLiveWaitSince: new Date(), liveMarkedAt: null, liveEvidence: null }).where(eq(tickets.id, t.id));
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "go_live_wait", summary: `Merged as ${commit!.slice(0, 12)}; ${goLiveWaitWords(waitsFor)}. The after-merge checks (${quoted(r.detail.afterMerge!)}) start when it is live; the assignee is woken then.` });
      if (carried.length) await tellCeo(t, "after merge carried", `"${t.title}" merged with ${quoted(carried)} still at fail. It stays open as after-merge ${carried.length > 1 ? "checks" : "check"} and starts when the change is live (${goLiveWaitWords(waitsFor)}). Nothing to do unless it stalls.`).catch(() => undefined);
      return { outcome: "merged" as const, delivered: null, detail: { ...r.detail, commit, goLiveWait: waitsFor } };
    }
    const carriedWhy = carried.length ? ` ${quoted(carried)} ${carried.length > 1 ? "were" : "was"} still at fail when it merged, so ${carried.length > 1 ? "they stay" : "it stays"} on this ticket as after-merge ${carried.length > 1 ? "checks" : "check"}, not a separate ticket.` : "";
    const delivered = await tellAgent(
      { ...t, systemState: "in_progress" },
      `${merged}The work is live, so these checks can only be made now: ${quoted(r.detail.afterMerge!)}.${carriedWhy} Report pass or fail for each and move the ticket to done. If only the owner can check one, put a card in front of them (raise_decision with blocksTicketId): answering it records their answer as that check's pass or fail, so you can close the ticket once they have. If a check fails on the live work, report it as fail and move the ticket to done: Boss Man opens the follow-up ticket for it, assigned to you, so don't make one by hand.`,
      "after merge",
      causedByRunId,
    ).catch(() => null);
    // The CEO hears when a merge leaves a put-off check on its ticket (BOS-575): that is the moment BOS-542 was lost.
    if (carried.length) await tellCeo(t, "after merge carried", `"${t.title}" merged with ${quoted(carried)} still at fail. Boss Man kept it open with its assignee as after-merge ${carried.length > 1 ? "checks" : "check"} until ${carried.length > 1 ? "they are" : "it is"} reported; no follow-up ticket is needed. Nothing to do unless it stalls.`).catch(() => undefined);
    return { outcome: "merged" as const, delivered, detail: { ...r.detail, commit } };
  }

  /**
   * A merged ticket that fixes a live problem (BOS-639) wakes the CEO with the same words the deploy card will
   * lead with, so the chat says it too. Only a hand-set "fixes live" marker counts, never priority. Nothing is
   * deployed: the owner still approves the deploy card, which the host deployer raises once it sees the merge.
   */
  async function tellCeoLiveFix(t: { id: string; companyId: string; number: number | null; fixesLive: string | null }, commit: string) {
    const symptom = t.fixesLive?.trim();
    if (!symptom) return;
    const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const ref = ticketRef(c?.prefix ?? null, t.number) ?? "this ticket";
    const heading = fixesLiveHeading([{ symptom, ref }]);
    await tellCeo(
      t,
      "fixes live merged",
      `${heading}. It merged as ${commit.slice(0, 12)}. The live server still runs the old code until the owner approves the deploy card, which Boss Man raises headed with these words and sorted first in Decisions. Make sure the owner knows; Boss Man never deploys by itself.`,
    );
  }

  /**
   * BOS-1516: the owner's Priority 1 work merged. A company with a card that puts work live pages through that card (Boss Man's
   * own update card: "Ready to put live", see self-deploy urgentFor; a deploy target: the deploy card, see deploys.ts). A company
   * with neither has no card, so it is paged here, once, when the last ticket of the group merges: "Priority 1 work merged" and
   * the next step if the ticket names one.
   */
  async function pagePriorityMerge(t: { id: string; companyId: string; title: string; number: number | null; urgent: boolean; ownerSetup: string | null }) {
    const [mark] = await db.select({ byOwner: tickets.urgentByOwner }).from(tickets).where(eq(tickets.id, t.id));
    if (!t.urgent || !mark?.byOwner) return;
    const [target] = await db.select({ id: deployTargets.id }).from(deployTargets).where(eq(deployTargets.companyId, t.companyId)).limit(1);
    if (target) return;
    const [card] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.companyId, t.companyId), sql`${decisions.context}->>'type' = 'self_deploy'`)).limit(1);
    if (card) return;
    if (!(await priorityGroup(db, t.id)).every((m) => m.finished)) return;
    const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const ref = ticketRef(c?.prefix ?? null, t.number);
    const next = t.ownerSetup?.trim().split("\n")[0]?.slice(0, 200);
    await deps.notes?.notify({
      companyId: t.companyId,
      agentId: null,
      level: "page",
      urgentReason: "Work you marked Priority 1 has merged",
      title: `Priority 1 work merged: ${t.title}${ref ? ` (${ref})` : ""}`,
      body: next ? `Next step: ${next}` : "Nothing more is needed from you for it to be in place.",
      link: `#/tickets/${t.id}`,
    });
  }

  /** BOS-2288: wakes the tickets watching for "a gate CI wait failed" (any ticket's). Never stops the merge. */
  async function wakeCiWatchers(t: { id: string; title: string }, outcome: string) {
    if (!state.wake) return;
    await wakeWatchers(db, state.wake as WatchNotify, "gate_ci_failed", `${t.title}: GitHub CI wait ended as ${outcome}`, { exceptTicketId: t.id }).catch(() => undefined);
  }

  /** Wakes the company's CEO about a ticket, with a note; nothing when the company has no CEO. */
  async function tellCeo(t: { id: string; companyId: string }, reason: string, note: string) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
    if (ceo) await state.wake?.(ceo.id, { ticketId: t.id, reason, note });
    return ceo?.id ?? null;
  }

  /**
   * BOS-1873: raises a merge or check card and, when it went to the CEO first, wakes the CEO about it. The ladder's
   * handover clock only starts with a CEO run that can see the card, so an unwoken CEO would leave it waiting for the outer cap.
   */
  async function mergeStuck(t: { id: string; title: string; companyId: string }, why: string) {
    const [card] = await raiseMergeStuck(db, t, why);
    if (card?.ceoFirst) await tellCeo(t, "decision", ceoFirstMergeNote(t.title, card.id, `its merge didn't finish (${why.slice(0, 300)})`)).catch(() => undefined);
    return card ?? null;
  }
  async function checkStuck(t: { companyId: string; id: string; title: string }, command: string, reason: string, output: string, own?: Parameters<typeof raiseCheckStuck>[5]) {
    const card = await raiseCheckStuck(db, t, command, reason, output, own);
    if (card?.ceoFirst) await tellCeo(t, "decision", ceoFirstMergeNote(t.title, card.id, `the merge check \`${command}\` couldn't finish (it ${reason.slice(0, 300)})`)).catch(() => undefined);
    return card;
  }

  /**
   * BOS-1860: flags the ticket's state note with Boss Man's own line (shown as "after this was written, <reason>") while a merge
   * retries after a push/fetch failure, or clears it (reason null). `only`: change it only while the flag is one of these
   * reasons. Setting one only replaces no flag or our own, so an owner-acted flag (stale-requests.ts) is never overwritten
   * or cleared here. A ticket with no note is left alone.
   */
  async function setGitNote(ticketId: string, reason: string | null, only?: string[]) {
    const ours = [GIT_RETRY_NOTE, GIT_RETRY_CARD_NOTE];
    await db
      .update(tickets)
      .set({ stateNoteStaleAt: reason ? new Date() : null, stateNoteStaleReason: reason })
      .where(
        and(
          eq(tickets.id, ticketId),
          isNotNull(tickets.stateNote),
          only ? inArray(tickets.stateNoteStaleReason, only) : sql`(${tickets.stateNoteStaleAt} is null or ${inArray(tickets.stateNoteStaleReason, ours)})`,
        ),
      );
  }

  /** The ticket stays in review with the host's reason; the owner hears once per new reason. */
  async function wait(t: typeof tickets.$inferSelect, note: string, hold: HoldReason = "host") {
    const changed = note !== t.pullRequestNote;
    await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, t.id));
    await lineEvent(db, t, { event: "hold_started", hold, note: note.slice(0, 200) });
    if (changed)
      await deps.notes?.notify({
        companyId: t.companyId,
        agentId: null,
        level: "note",
        title: `Pull request waiting: ${t.title}`,
        body: `${note}${t.pullRequestUrl ? `\n${t.pullRequestUrl}` : ""}`,
        link: `#/tickets/${t.id}`,
      });
    return { outcome: "pull_request" as const, delivered: null, detail: { note, url: t.pullRequestUrl } };
  }

  /** Tells the ticket's assignee: into its live run if it has one, otherwise by waking it (notify decides). */
  async function tellAgent(ticket: typeof tickets.$inferSelect, text: string, reason: string, causedByRunId?: string | null) {
    if (!ticket.assigneeAgentId || !state.wake) throw new ReviewError(409, "The ticket has no assignee to send this to.");
    const w = (await state.wake(ticket.assigneeAgentId, { ticketId: ticket.id, reason, priority: 3, note: text, causedByRunId })) as { status: string };
    return w.status === "steered" ? "sent to the running agent" : "the assignee will be woken with it";
  }

  /** BOS-313: whether the merge gate checks the merged result it pushes. Off until the owner turns it on; off keeps the old path. */
  async function checkMergedResult(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CHECK_MERGED_KEY));
    return row?.value === true;
  }

  /** BOS-1070: whether the merge gate waits for the git host's CI on the merge commit. Off until the owner turns it on; off keeps today's path. */
  async function waitForCi(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, WAIT_FOR_CI_KEY));
    return row?.value === true;
  }

  /** BOS-1762: whether finish may carry a passed merge across a file-disjoint main move. On unless the owner turned it off. */
  async function mergeCarry(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_CARRY_KEY));
    return row?.value !== false && row?.value !== "false";
  }

  /** BOS-1344/1820/1821: whether a waiting merge is rebuilt on a moved main while it waits. On unless the owner turned it off. */
  async function mergeRetarget(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_RETARGET_KEY));
    return row?.value !== false && row?.value !== "false";
  }

  /** BOS-1762: the landing turn's cap in minutes; 0 means no turns. */
  async function mergeTurnMinutes(): Promise<number> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_TURN_KEY));
    const n = Number(row?.value);
    return row && Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MERGE_TURN_MAX_MIN) : MERGE_TURN_DEFAULT_MIN;
  }

  async function templates(companyId: string): Promise<GitTemplates> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `git_templates:${companyId}`));
    return { ...DEFAULT_GIT_TEMPLATES, ...((row?.value as Partial<GitTemplates> | undefined) ?? {}) };
  }

  /** Checks a "Passed, hold merge" before anything is recorded (BOS-808): a reason, something it waits for, and nothing already held. */
  async function checkHoldInput(t: typeof tickets.$inferSelect, hold: HoldInput, reviewerAgentId: string | null | undefined) {
    if (!reviewerAgentId) throw new ReviewError(422, "Only a reviewer holds a merge; the owner can simply not approve it yet.");
    if (t.systemState !== "review") throw new ReviewError(409, "A merge can only be held while the ticket is in review.");
    if (!hold.reason.trim()) throw new ReviewError(422, "Say why the merge is held (holdReason).");
    if (!hold.waitsOn.length && !hold.releaseAt) throw new ReviewError(422, "A hold needs something to end it: the tickets or decisions it waits on (waitsOn), a date (holdUntil), or both.");
    if (hold.releaseAt && hold.releaseAt.getTime() <= Date.now()) throw new ReviewError(422, "The hold date is already past (holdUntil).");
    if (await openHold(db, t.id)) throw new ReviewError(409, "This ticket already has a hold. Release or cancel it first.");
    for (const w of hold.waitsOn) {
      if ("ticketId" in w) {
        const [o] = await db.select({ companyId: tickets.companyId, state: tickets.systemState }).from(tickets).where(eq(tickets.id, w.ticketId));
        if (!o || o.companyId !== t.companyId) throw new ReviewError(422, "A ticket the hold waits on was not found in this company.");
        if (w.ticketId === t.id) throw new ReviewError(422, "A ticket can't wait on itself.");
        if (o.state === "done") throw new ReviewError(422, "A ticket the hold waits on is already closed.");
      } else {
        const [o] = await db.select({ companyId: decisions.companyId, status: decisions.status }).from(decisions).where(eq(decisions.id, w.decisionId));
        if (!o || o.companyId !== t.companyId) throw new ReviewError(422, "A decision the hold waits on was not found in this company.");
        if (o.status !== "open") throw new ReviewError(422, "A decision the hold waits on is already answered.");
      }
    }
  }

  /** Records the hold and the activity line for it (BOS-808). */
  async function startHold(t: typeof tickets.$inferSelect, row: ReviewRow, hold: HoldInput, reviewer: string) {
    const h = await createHold(db, { ticketId: t.id, reviewRequestId: row.id, reviewerAgentId: row.reviewerAgentId, reason: hold.reason.trim(), releaseAt: hold.releaseAt, waits: hold.waitsOn });
    await record(db, { companyId: t.companyId, agentId: row.reviewerAgentId, ticketId: t.id, kind: "review_hold_started", summary: `${reviewer} passed the review but is holding the merge: ${hold.reason.trim()}` });
    return h;
  }

  /** "BOS-1095, BOS-1100" for these tickets, by reference (title when a ticket has no number). */
  async function refsOf(ticketIds: string[]): Promise<string> {
    if (!ticketIds.length) return "";
    const rows = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ticketIds));
    return rows.map((r) => ticketRef(r.prefix, r.number) ?? `"${r.title}"`).join(", ");
  }

  /**
   * The wait before any check runs (BOS-1173, DR-053): an approved ticket whose merge waits on another ticket (its
   * own waits-on link, or an open ticket marked as fixing the merge check) goes into "Passed, held" on it. Nothing
   * is checked, nothing goes back to the author, no loop failure is counted and no card is raised; the hold is
   * released by itself once that ticket is merged and live. Null when nothing holds it.
   */
  async function holdForWaits(ticketId: string): Promise<ReviewHeldError | null> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t) return null;
    const waits = await mergeWaits(db, t);
    if (!waits.length) return null;
    const refs = await refsOf(waits);
    const { added } = await ensureSystemHold(db, t.id, waits, `Waits on ${refs}: it merges by itself once ${waits.length > 1 ? "they are" : "that is"} merged and live.`);
    if (added) {
      await lineEvent(db, t, { event: "hold_started", hold: "waits_on", note: `waits on ${refs}`.slice(0, 200) });
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_hold_started", summary: `Approved and held: the merge waits on ${refs}, so the check didn't run and nothing was sent back. It merges by itself once ${refs} is merged and live; the reviews and any sign-off stand. Nothing to do.` });
    }
    return new ReviewHeldError(`This ticket's merge waits on ${refs}, so nothing was checked or merged. It stays approved in "Passed, held" and merges by itself once ${refs} is merged and live; leave it in review.`);
  }

  /**
   * BOS-2303: approved (or overruled) while its own quick check is queued or running, with no pass on that commit yet.
   * Boss Man's own hold, with no waits, puts it in "Passed, held" with the approvals kept; the check's end starts the
   * merge again (checkHold.onEnded, or the release sweep after a restart), and a failure there sends it back.
   */
  async function holdForCheck(ticketId: string, commit: string): Promise<ReviewHeldError> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    const text = `Its quick check of ${commit.slice(0, 8)} hasn't finished, so nothing was merged and no merge copy went to GitHub. It stays approved in "Passed, held": a pass starts the merge by itself, and a failure sends it back to its agent. Leave it in review.`;
    if (!t) return new ReviewHeldError(text);
    const { added } = await ensureSystemHold(db, t.id, [], `Approved while its quick check of ${commit.slice(0, 8)} was running: it merges by itself once that check passes.`);
    if (added) {
      await lineEvent(db, t, { event: "hold_started", hold: "quick_check", note: `${CHECK_WAIT_LABEL} (${commit.slice(0, 8)})` });
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_hold_started", summary: `Approved and held: its quick check of ${commit.slice(0, 8)} is still running, so nothing was merged yet. A pass starts the merge by itself; a failure sends it back to its agent. The reviews and any sign-off stand.` });
    }
    return new ReviewHeldError(text);
  }

  /** True while the owner's "Merge it, or send it back?" sign-off card for this ticket is open (BOS-471). */
  async function ownerSignoffOpen(ticketId: string): Promise<boolean> {
    return !!(await openSignoffCard(db, ticketId));
  }

  /**
   * Throws the refusal for whatever holds this ticket's merge (DR-061 Q2b, mergeHolds): the owner's sign-off card,
   * then a hold, then a holding card, then a wait on another ticket (which also puts it in "Passed, held").
   */
  async function refuseIfHeld(ticketId: string): Promise<void> {
    const holds = await mergeHolds(db, ticketId);
    const [first] = holds;
    if (!first) return;
    if (first.kind === "signoff") throw new SignoffPendingError();
    // BOS-2303: Boss Man's own hold placed for the quick check says so, not the reviewer's wording.
    const check = holds.find((h): h is Extract<typeof h, { kind: "check" }> => h.kind === "check");
    if (first.kind === "hold" && check) {
      const h = await openHold(db, ticketId);
      if (h && !h.reviewerAgentId && !h.reviewRequestId) throw await holdForCheck(ticketId, check.commit);
    }
    if (first.kind === "hold") throw new ReviewHeldError();
    if (first.kind === "card") throw cardHeld(first.id);
    if (first.kind === "check") throw await holdForCheck(ticketId, first.commit);
    const waiting = await holdForWaits(ticketId);
    if (waiting) throw waiting;
  }

  return {
    db,
    deps,
    state,
    landings,
    gate,
    queue,
    scanListWarning,
    landingBeat,
    phases,
    ciWaits,
    turnWaits,
    ciPassedTrees,
    ciCardWaiting,
    ciTiming,
    beatNow,
    ticketWithRepo,
    clashOnMain,
    namedTickets,
    landingStale,
    prTarget,
    otherOpenBranches,
    carriedBetween,
    approvedAndWaiting,
    carriedOnHost,
    refuseUnchecked,
    refuseCarried,
    announceMerged,
    finishMerged,
    afterMergeLeft,
    releaseGoLive,
    closeAfterMerge,
    tellCeoLiveFix,
    pagePriorityMerge,
    tellCeo,
    wakeCiWatchers,
    mergeStuck,
    checkStuck,
    setGitNote,
    wait,
    tellAgent,
    checkMergedResult,
    waitForCi,
    mergeCarry,
    mergeRetarget,
    mergeTurnMinutes,
    templates,
    checkHoldInput,
    startHold,
    refsOf,
    holdForWaits,
    ownerSignoffOpen,
    refuseIfHeld,
  };
}

/** The shared state and helpers a moved part takes as its `ctx` (BOS-1886 plan, section 2). */
export type ReviewCtx = ReturnType<typeof reviewContext>;

/**
 * A moved part's arguments after `ctx`: what its delegate line in review.ts takes. The `any` return is on purpose: matched
 * against `any`, TypeScript doesn't resolve the part's own return type, which (through `this.approve` and the like) depends
 * on the review service's type, so `unknown` here would make that type circular. Parameters<> does the same.
 */
export type Rest<F> = F extends (ctx: ReviewCtx, ...a: infer A) => any ? A : never;
