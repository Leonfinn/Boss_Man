// The review service's merge status and upkeep (BOS-1904, move 4 of the BOS-1886 split): where a merge stands, the
// host's checks on a branch, the merges a runner swap waits on, merges found on main without a record, branch clashes,
// pull request upkeep, the bossman-ci branch sweep and the merge settings' setters. Each is a review service method moved
// out whole: it takes the service as `this` (so calls to other methods go through the assembled object, where tests spy
// on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { branchCommitFor, imagesJobLines as imagesJobLines_ } from "./images-job.js";
import { PREFLIGHT_KIND, PREFLIGHT_STARTED_KIND } from "./ci-preflight.js";
import { isGateMergeOf, MAIN_LOG_MAX, mergeMessageTicket, wakeCeoIfLiveUnplaced } from "./missed-merges.js";
import { mergeFacts, recordedMergeKeys, recordTicketMerge } from "./ticket-merges.js";
import { MERGE_MISSED_AFTER_MS, parseRepoUrl, renderTemplate, ticketRef, type GitHostKind, type MainLogResult, type MergeLineConflictsResult } from "@boss-man/shared";
import { agents, checkResults, companies, projects, runners, settings, ticketMerges, tickets } from "../db/schema.js";
import { CI_BRANCH_PREFIX, GitHostError, type CommitChecks, type WorkflowRun } from "./git-hosts.js";
import { clearMergeCards } from "./decisions.js";
import { record } from "./activity.js";
import { mergeLineApproved } from "./merge-line-conflicts.js";
import { CHECK_MERGED_KEY, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, ReviewError, WAIT_FOR_CI_KEY, type GitTemplates, type LandingView } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";
import { LANDING_END_MS, landingsThatCount } from "./update-waits.js";
import { landingTurns } from "./landing-turn.js";
import { endedMergeAt, runningCheckJobs, turnWaitWords, type TurnWait } from "./merge-queue.js";

/** BOS-2479: when the landing's push call began (merge-rounds.ts whilePushing); undefined when it isn't pushing. */
function pushStartMs(ctx: Pick<ReviewCtx, "landings" | "pushing">, id: string): number | undefined {
  return ctx.landings.get(id)?.state === "running" ? ctx.pushing.get(id) : undefined;
}

/**
 * BOS-1951: the tickets whose merge a runner swap waits on, so the banner can name them (see landingMergesByCompany).
 * BOS-2479: only a merge whose push to main is going (landingsThatCount). The "merging" phase is set at the start of every
 * merge round, long before the push, so counting it held the swap for merges waiting on a train seat, a check or GitHub CI,
 * which the swap's own hold stalls (history in landingsThatCount). A landing whose ticket stopped beating is dropped as well
 * (BOS-2058): DR-014, a restart fails an in-flight merge at once and the gate retries it.
 */
export async function landingMergeIds(this: ReviewSelf, ctx: Pick<ReviewCtx, "landings" | "pushing" | "landingStale">): Promise<string[]> {
  const { landings, landingStale } = ctx;
  const running = [...landings.entries()].filter(([, l]) => l.state === "running").map(([id]) => id);
  const live: string[] = [];
  for (const id of landingsThatCount(running, { pushingSince: (id) => pushStartMs(ctx, id), now: Date.now() })) {
    if (await landingStale(id)) continue;
    live.push(id);
  }
  return live;
}

/**
 * BOS-2058: the live landings the swap waits on with when the oldest push began, for the one list of waits (update-waits.ts).
 * BOS-2479: named by ticket reference (BOS-2408), not by id, so server_status reads like the banner.
 */
export async function landingWaitFacts(this: ReviewSelf, ctx: ReviewCtx): Promise<{ since: string | null; ids: string[]; names: string[]; endsAt: string | null }> {
  const ids = await this.landingMergeIds();
  const starts = ids.map((id) => pushStartMs(ctx, id)).filter((n): n is number => n !== undefined);
  const named = ids.length ? await ctx.namedTickets(ids) : [];
  const names = ids.map((id) => named.find((n) => n.ticketId === id)?.ref ?? id.slice(0, 8));
  // When the last counted push stops holding the swap at the latest (landingsThatCount's cap), for the banner's go-ahead time.
  const endsAt = starts.length ? new Date(Math.max(...starts) + LANDING_END_MS).toISOString() : null;
  return { since: starts.length ? new Date(Math.min(...starts)).toISOString() : null, ids, names, endsAt };
}

/** BOS-2479: when each counted push began, for the Merges tab's "Running now" and the banner's go-ahead time. */
export function pushingSince(ctx: Pick<ReviewCtx, "landings" | "pushing">, ticketId: string): string | null {
  const ms = pushStartMs(ctx, ticketId);
  return ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * The landing the page should show. A running marker whose ticket has gone quiet for longer
 * than a merge can take is a leftover: it is marked stale so the owner can try again.
 */
export async function landing(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<LandingView> {
  const { landings, phases, landingStale } = ctx;
  const status = landings.get(ticketId);
  if (!status) return null;
  if (status.state === "finished") return status;
  return { ...status, stale: await landingStale(ticketId), phase: phases.get(ticketId) ?? "checking" };
}

/** BOS-2605: the one wording of the GitHub CI wait: the Merges tab's tag line, mergeState, server_status's holder and seats. */
export function ciPhaseWords(sinceMs: number, checkPassedMs?: number): string {
  const passed = checkPassedMs === undefined ? "" : ` (its check passed at ${new Date(checkPassedMs).toISOString().slice(11, 16)})`;
  return `waiting for GitHub CI since ${new Date(sinceMs).toISOString().slice(11, 16)} UTC${passed}`;
}

/** BOS-2605: does the ticket's merge check hold a check slot now? Without the server queue (or on an error) it doesn't. */
async function holdsCheckSlot(ctx: Pick<ReviewCtx, "db">, ticketId: string): Promise<boolean> {
  try {
    const [t] = await ctx.db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
    if (!t) return false;
    return (await runningCheckJobs(ctx.db, t.companyId)).some((j) => j.kind === "merge" && j.ticketId === ticketId);
  } catch {
    return false;
  }
}

/**
 * One plain line on where a ticket's merge stands, for every list of sign-off and merge cards (DR-014), built on the
 * server so agents copy it: queued / checking / merging / waiting to retry / looks stuck / finished (with why).
 * Null when no merge has run since the server started.
 */
export async function mergeState(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<string | null> {
  const l = await this.landing(ticketId);
  if (!l) return null;
  const at = (iso: string) => new Date(iso).toISOString().slice(11, 16) + " UTC";
  if (l.state === "finished") return `merge finished: ${l.text}`;
  if (l.stale) return `merge looks stuck since ${at(l.startedAt)}; nothing is running now`;
  // BOS-2119 (R43): waiting for another ticket's landing turn: the Merges tab's words, not a bare "merging".
  // BOS-2605 (F1): holderPhase's order, CI wait first. A landing whose check still holds a slot is "checking": GitHub runs
  // beside it, and the wait only counts once the check is over (the Merges tab's rule).
  const ci = ctx.ciWaits.get(ticketId);
  if (ci && !(await holdsCheckSlot(ctx, ticketId))) return `merge ${ciPhaseWords(ci.since, (await endedMergeAt(ctx.db, [ticketId])).get(ticketId))}`;
  const turn = ctx.turnWaits.get(ticketId);
  if (turn) return `merge ${await turnWaitWords(ctx.db, turn)} (since ${at(new Date(turn.since).toISOString())})`;
  const word = { queued: "queued for a check slot", checking: "checking", merging: "merging", waiting_to_retry: "waiting to try again after the runner restarted", retrying_git: "retrying after a push/fetch failure to the git host" }[l.phase ?? "checking"];
  return `merge ${word} (since ${at(l.startedAt)})`;
}

/** The host's checks on the ticket's branch head as data, for the ticket page (BOS-1418). Null whenever there's nothing to show, including any host error. */
export async function branchChecks(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string): Promise<(CommitChecks & { sha: string }) | null> {
  try {
    return await this.branchChecksOrThrow(ticketId, companyId);
  } catch {
    return null;
  }
}

export async function branchChecksOrThrow(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string): Promise<(CommitChecks & { sha: string }) | null> {
  const { deps, ticketWithRepo } = ctx;
  const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId, companyId);
  if (!t.branch || t.mergeCommit || t.systemState === "done" || !deps.gitHosts) return null;
  const a = repoUrl ? parseRepoUrl(repoUrl) : null;
  const token = await deps.gitToken?.(t.companyId);
  if (!a || (gitHost !== "github" && gitHost !== "gitea") || !gitApiBase || !token) return null;
  const cfg = { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo };
  const sha = await deps.gitHosts.branchHead(cfg, token, t.branch);
  return { ...(await deps.gitHosts.checks(cfg, token, sha)), sha };
}

/**
 * One line for `tickets read` (DR-024 #2): the host's checks on the head of the ticket's branch.
 * Null when there's nothing to say (no branch, already merged, no known host or token). A host
 * that refuses the token is said plainly, never shown as "no checks".
 */
export async function branchChecksLine(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string): Promise<string | null> {
  try {
    const r = await this.branchChecksOrThrow(ticketId, companyId);
    if (!r) return null;
    const c = r;
    const sha = r.sha;
    const at = sha.slice(0, 8);
    const names = c.failing.join(", ");
    if (c.state === "none") return `CI on branch head ${at}: no checks reported (yet).`;
    if (c.state === "failed") return `CI on branch head ${at}: FAILED${names ? ` (${names})` : ""}.`;
    if (c.state === "pending") return `CI on branch head ${at}: still running.`;
    return `CI on branch head ${at}: passed${c.total ? ` (${c.total} check${c.total === 1 ? "" : "s"})` : ""}.`;
  } catch (err) {
    if (err instanceof GitHostError) {
      return `CI on branch head: not available (${err.message}).`;
    }
    return null;
  }
}

/**
 * BOS-2907: lines for `tickets read` on GitHub's images job for the ticket (images-job.ts): each architecture's result and
 * how far install-images.test.sh's real install got. Null when there is nothing to show or anything fails unexpectedly;
 * the same conditions as the CI line (a branch, not merged, not done, a GitHub project with a token).
 */
export async function imagesJobLines(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string): Promise<string[] | null> {
  try {
    const { deps, ticketWithRepo, db } = ctx;
    const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId, companyId);
    if (!t.branch || t.mergeCommit || t.systemState === "done" || !deps.gitHosts || gitHost !== "github" || !gitApiBase) return null;
    const a = repoUrl ? parseRepoUrl(repoUrl) : null;
    const token = await deps.gitToken?.(t.companyId);
    if (!a || !token) return null;
    const cfg = { kind: "github" as const, apiBase: gitApiBase, owner: a.owner, repo: a.repo };
    const kinds = { started: PREFLIGHT_STARTED_KIND, result: PREFLIGHT_KIND };
    const commit = async (run: WorkflowRun) => {
      const rows = await db.select({ kind: checkResults.kind, sha: checkResults.sha, at: checkResults.at }).from(checkResults).where(and(eq(checkResults.ticketId, t.id), inArray(checkResults.kind, [kinds.started, kinds.result]))).orderBy(desc(checkResults.at)).limit(40);
      return branchCommitFor(run.createdAt, rows, kinds);
    };
    return await imagesJobLines_(deps.gitHosts, cfg, token, t.id, commit);
  } catch {
    return null;
  }
}

/** Every merge this process has running, with its phase, for the merge queue screen (BOS-587). */
export function runningMerges(this: ReviewSelf, ctx: ReviewCtx): Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git"; ci?: { since: string; waiting: string[] }; turn?: TurnWait; pushingSince?: string }> {
  const { landings, phases, ciWaits, turnWaits } = ctx;
  return [...landings.entries()].flatMap(([ticketId, l]) => {
    if (l.state !== "running") return [];
    const ci = ciWaits.get(ticketId);
    const turn = turnWaits.get(ticketId);
    // BOS-2479: a push to main under way, the one merge state a runner swap waits for; the Merges tab shows it in Running now.
    const push = pushingSince(ctx, ticketId);
    return [{ ticketId, startedAt: l.startedAt, startedBy: l.startedBy, phase: phases.get(ticketId) ?? ("checking" as const), ...(ci ? { ci: { since: new Date(ci.since).toISOString(), waiting: ci.waiting } } : {}), ...(turn ? { turn } : {}), ...(push ? { pushingSince: push } : {}) }];
  });
}

/**
 * BOS-2361: what the turn holder's merge is doing now, in words: waiting for GitHub CI since HH:MM (UTC), running its check,
 * building the merge copy or pushing ("merging" covers both: one phase marks the start of a landing and its push), waiting
 * for another ticket's turn, or "no merge running" when it has none on this server (it will start again, DR-026).
 */
export function holderPhase(ctx: Pick<ReviewCtx, "landings" | "phases" | "ciWaits" | "turnWaits">, ticketId: string, checkPassedMs?: number): string {
  const ci = ctx.ciWaits.get(ticketId);
  if (ci) return ciPhaseWords(ci.since, checkPassedMs);
  if (ctx.turnWaits.has(ticketId)) return "waiting for another ticket's landing turn";
  if (ctx.landings.get(ticketId)?.state !== "running") return "no merge running";
  const phase = ctx.phases.get(ticketId) ?? "checking";
  const words: Record<string, string> = {
    queued: "waiting for a check slot",
    checking: "merge check",
    merging: "building the merge copy or pushing",
    waiting_to_retry: "trying again after the runner restarted",
    retrying_git: "retrying a push or fetch to the git host",
  };
  return words[phase] ?? phase;
}

/**
 * BOS-2605 (F3): a merge train seat's phase for server_status mergeTrain: holderPhase's words (the same function), when the
 * GitHub wait began and the GitHub jobs still running. The train runs no landing turn, so landingTurns is empty then.
 */
export async function seatPhase(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<{ phase: string; ciSince: string | null; ciRunning: string[] }> {
  const ci = ctx.ciWaits.get(ticketId);
  const passed = ci ? (await endedMergeAt(ctx.db, [ticketId])).get(ticketId) : undefined;
  return { phase: holderPhase(ctx, ticketId, passed), ciSince: ci ? new Date(ci.since).toISOString() : null, ciRunning: ci?.waiting ?? [] };
}

/**
 * BOS-2119: server_status landingTurns. Per project of the company with a landing turn held or a line for it: the holder,
 * since when, its cap and when the cap ends, and the line in order. Each ticket waiting for the turn carries the same words
 * the Merges tab and its ticket's merge line show (turnWaitWords). Read only; empty on a server whose merges aren't running here.
 */
export async function landingTurnStatus(this: ReviewSelf, ctx: ReviewCtx, companyId: string) {
  const { db, turnWaits } = ctx;
  const snap = landingTurns.snapshot();
  if (!snap.length) return [];
  const mine = new Set((await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, snap.map((s) => s.projectId))))).map((p) => p.id));
  const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  const out = [];
  for (const s of snap) {
    if (!mine.has(s.projectId)) continue;
    const ids = [...(s.holder ? [s.holder.ticketId] : []), ...s.line, ...[...turnWaits].filter(([, w]) => w.holderId === s.holder?.ticketId).map(([id]) => id)];
    const named = new Map((await db.select({ id: tickets.id, number: tickets.number, title: tickets.title }).from(tickets).where(inArray(tickets.id, [...new Set(ids)]))).map((r) => [r.id, r]));
    const who = (id: string) => ({ ticketId: id, ref: ticketRef(co?.prefix ?? null, named.get(id)?.number), title: named.get(id)?.title ?? null });
    const waiting = async (id: string) => {
      const w = turnWaits.get(id);
      return w ? { ...who(id), since: new Date(w.since).toISOString(), then: w.then, label: await turnWaitWords(db, w) } : null;
    };
    out.push({
      projectId: s.projectId,
      holder: s.holder ? { ...who(s.holder.ticketId), phase: holderPhase(ctx, s.holder.ticketId), since: new Date(s.holder.since).toISOString(), capMin: Math.round(s.holder.capMs / 60_000), capEndsAt: new Date(s.holder.since + s.holder.capMs).toISOString() } : null,
      line: await Promise.all(s.line.map(async (id) => (await waiting(id)) ?? { ...who(id), label: null })),
      // Merges whose check passed and whose push waits for this holder (not in the line: they earned no turn).
      pushWaiting: (await Promise.all([...turnWaits].filter(([id, w]) => w.then === "push" && w.holderId === s.holder?.ticketId && !s.line.includes(id)).map(([id]) => waiting(id)))).filter((x) => x !== null),
    });
  }
  return out;
}

/**
 * BOS-1645: merges in their "merging" phase (past the check: pushing, then recording), per company. A runner swap waits
 * for these: cutting the runner off between push and record leaves main with a merge its ticket doesn't know about.
 */
export async function landingMergesByCompany(this: ReviewSelf, ctx: ReviewCtx): Promise<Map<string, number>> {
  const { db } = ctx;
  const ids = await this.landingMergeIds();
  const out = new Map<string, number>(); // not state: local to this call
  if (!ids.length) return out;
  const rows = await db.select({ companyId: tickets.companyId }).from(tickets).where(inArray(tickets.id, ids));
  for (const r of rows) out.set(r.companyId, (out.get(r.companyId) ?? 0) + 1);
  return out;
}

/**
 * BOS-2654: true when a reopened ticket (in review or in progress) that already has a merge recorded has a newer gate
 * merge on main than that one, i.e. the gate's answer to its second merge was lost. `merges` is newest first. "Newer": the
 * recorded merge is further down main's log, or, when it is older than the log read, the newest one is later than mergedAt.
 * Never for a done ticket (closed by hand or already recorded: nothing to close) or one with no merge recorded.
 */
export function newerMerge(t: { mergeCommit: string | null; mergedAt: Date | null; systemState: string; merges: ReadonlyArray<{ sha: string; at: string }> }): boolean {
  if (!t.mergeCommit || (t.systemState !== "review" && t.systemState !== "in_progress")) return false;
  const newest = t.merges[0];
  const recorded = t.mergeCommit.toLowerCase();
  if (!newest || newest.sha.toLowerCase() === recorded) return false;
  if (t.merges.some((c) => c.sha.toLowerCase() === recorded)) return true;
  const at = Date.parse(newest.at);
  return !t.mergedAt || (!Number.isNaN(at) && at > t.mergedAt.getTime());
}

/**
 * BOS-1645 (R27): records the merges on main the gate never recorded (its answer was lost, e.g. to a runner swap between
 * push and record). For each project with a repo whose runner answers workspace.mainLog, it reads main's newest first-parent
 * commits, and every `Merge "..." (<ticket id>)` naming one of the project's tickets that has no mergeCommit is recorded as
 * the gate would have (recordMissedMerge). A ticket's other gate merges on main that aren't kept yet (an earlier merge of a
 * ticket merged twice) are added to its merges only (BOS-2653), so merge order can place them. Then, per company read, a live commit that still can't be placed wakes the CEO
 * once. `projectId` limits it to one project (after a landing). Runs on the leader only, one pass at a time; never throws.
 */
export async function recordMissedMerges(this: ReviewSelf, ctx: ReviewCtx, projectId?: string): Promise<{ recorded: string[] }> {
  const { db, deps, state: reviewState } = ctx;
  const recorded: string[] = [];
  if (deps.isLeader && !deps.isLeader()) return { recorded };
  if (reviewState.missedSweep) return reviewState.missedSweep.then(() => ({ recorded }));
  const pass = (async () => {
    const rows = await db
      .select({ id: projects.id, companyId: projects.companyId, repoUrl: projects.repoUrl, target: projects.defaultBranch })
      .from(projects)
      .where(projectId ? eq(projects.id, projectId) : isNotNull(projects.repoUrl));
    const read = new Map<string, Array<{ sha: string; subject: string; message: string }>>();
    for (const p of rows) {
      if (!p.repoUrl) continue;
      try {
        const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, p.companyId));
        if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "main-log")) continue;
        const ask = (filesFor?: string[]) =>
          deps.runners.request<MainLogResult>(runner.id, (requestId) => ({ type: "workspace.mainLog", requestId, projectId: p.id, target: p.target, max: MAIN_LOG_MAX, ...(filesFor?.length ? { filesFor } : {}) }), 60_000);
        const log = (await ask())?.commits ?? [];
        read.set(p.companyId, [...(read.get(p.companyId) ?? []), ...log]);
        // Every gate merge of each ticket, newest first (BOS-2653: a ticket merged twice keeps both, not just its newest).
        const named = new Map<string, Array<(typeof log)[number]>>();
        for (const c of log) {
          const id = typeof c.message === "string" ? mergeMessageTicket(c.message) : null;
          if (id) named.set(id, [...(named.get(id) ?? []), c]);
        }
        if (!named.size) continue;
        // Only a commit whose whole message is exactly this ticket's gate merge message counts (Jane, BOS-1645): a
        // ticket title is agent-written, so a message merely naming an id must never close another ticket.
        const found = (
          await db
            .select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId, mergeCommit: tickets.mergeCommit, mergedAt: tickets.mergedAt, systemState: tickets.systemState })
            .from(tickets)
            .where(and(inArray(tickets.id, [...named.keys()]), eq(tickets.projectId, p.id)))
        ).map((t) => ({ ...t, merges: named.get(t.id)!.filter((c) => isGateMergeOf(c.message, t)) }));
        const kept = await recordedMergeKeys(db, found.map((t) => t.id));
        // A ticket with no merge recorded is closed by its newest merge (recordMissedMerge), and so is a reopened one (in
        // review or in progress) whose newest gate merge is newer than the one recorded (BOS-2654: the gate's answer to its
        // second merge was lost). Any other merge of it not yet kept is only added to its merges, so merge order can place it.
        const missing = found.filter((t) => t.merges.length && (!t.mergeCommit || newerMerge(t)));
        // The ticket's latest merge already places through tickets.mergeCommit (companyMerges), so it is never "extra".
        const latest = (t: (typeof found)[number]) => (t.mergeCommit && !newerMerge(t) ? t.mergeCommit.toLowerCase() : t.merges[0]?.sha.toLowerCase());
        const extra = found.flatMap((t) => t.merges.filter((c) => c.sha.toLowerCase() !== latest(t) && !kept.has(`${t.id}:${c.sha.toLowerCase()}`)).map((c) => ({ t, c })));
        if (!missing.length && !extra.length) continue;
        // A second read for the changed files of just these, so touchesRunner is known (BOS-1021) rather than assumed.
        const shas = [...missing.map((m) => m.merges[0]!.sha), ...extra.map((e) => e.c.sha)].slice(0, 20);
        const files = new Map(((await ask(shas).catch(() => null))?.commits ?? []).filter((c) => c.files).map((c) => [c.sha, c.files!]));
        for (const m of missing) {
          const c = m.merges[0]!;
          const replaces = m.mergeCommit ?? undefined;
          if (await this.recordMissedMerge(m.id, c.sha, { at: c.at, files: files.get(c.sha), replaces }).catch(() => false)) recorded.push(m.id);
        }
        for (const { t, c } of extra) {
          const at = c.at && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at) : new Date();
          await recordTicketMerge(db, { companyId: t.companyId, ticketId: t.id, commit: c.sha, at, files: files.get(c.sha) }).catch(() => false);
        }
      } catch {
        // A runner away or too slow: the next pass tries again.
      }
    }
    for (const [companyId, onMain] of read) await wakeCeoIfLiveUnplaced(db, companyId, onMain, reviewState.wake).catch(() => false);
  })();
  reviewState.missedSweep = pass;
  try {
    await pass;
  } finally {
    reviewState.missedSweep = null;
  }
  return { recorded };
}

/**
 * Records one merge found on main without a record (BOS-1645): mergeCommit and mergedAt (the commit's own time, so merge
 * order stays right), the ticket moved on as after a merge (done, or back to its assignee for after-merge checks), and the
 * assignee told. The claim (`mergeCommit is null`) makes it once only, whatever runs beside it; a ticket whose own merge is
 * running here is left to that merge. A ticket already done (closed by hand) only gets the merge facts.
 * `replaces` (BOS-2654): a reopened ticket's recorded merge that this newer one supersedes; the claim is then
 * `mergeCommit = replaces`, and the earlier merge is kept among the ticket's merges with its own facts.
 */
export async function recordMissedMerge(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, commit: string, opts: { at?: string; files?: string[]; replaces?: string } = {}): Promise<boolean> {
  const { db, landings, closeAfterMerge, tellAgent } = ctx;
  if (landings.get(ticketId)?.state === "running") return false;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t || (t.mergeCommit ?? undefined) !== opts.replaces) return false;
  if (opts.replaces && opts.replaces.toLowerCase() === commit.toLowerCase()) return false;
  const at = opts.at && !Number.isNaN(Date.parse(opts.at)) ? new Date(opts.at) : new Date();
  const files = opts.files;
  const runnerFacts = mergeFacts(files);
  const [claimed] = await db
    .update(tickets)
    .set({ mergeCommit: commit, mergedAt: at, ...runnerFacts })
    .where(and(eq(tickets.id, ticketId), opts.replaces ? eq(tickets.mergeCommit, opts.replaces) : isNull(tickets.mergeCommit)))
    .returning({ id: tickets.id });
  if (!claimed) return false;
  if (opts.replaces)
    await db
      .insert(ticketMerges)
      .values({ companyId: t.companyId, ticketId, commit: opts.replaces.toLowerCase(), mergedAt: t.mergedAt ?? t.stateChangedAt, touchesRunner: t.touchesRunner, touchesRunnerUpdate: t.touchesRunnerUpdate, deploysNothing: t.deploysNothing })
      .onConflictDoNothing({ target: [ticketMerges.ticketId, ticketMerges.commit] });
  // BOS-2653: kept among the ticket's merges here too, as a ticket already done never reaches finishMerged below.
  await recordTicketMerge(db, { companyId: t.companyId, ticketId, commit, at, files });
  const short = commit.slice(0, 12);
  await record(db, { companyId: t.companyId, ticketId, kind: "merge_recorded_late", summary: `Merged as ${short} at ${at.toISOString()}, but Boss Man never got the answer (the runner was cut off between push and record). Found on main and recorded now.` });
  if (t.systemState === "done") return true;
  await clearMergeCards(db, ticketId, { by: "system", note: `The merge is on main as ${short}; recorded late.`, at: new Date().toISOString() }).catch(() => undefined);
  const r = await closeAfterMerge(t, commit, null, files, at);
  // closeAfterMerge already told the assignee when after-merge checks are due now; otherwise say what happened.
  const told = !!(r.detail as { afterMerge?: unknown }).afterMerge && !(r.detail as { goLiveWait?: unknown }).goLiveWait;
  if (!told && t.assigneeAgentId)
    await tellAgent(
      t,
      `Your merge is on main as ${short}, but Boss Man never recorded it (the runner was cut off between the push and the record), so the ticket kept showing "not merged". It is recorded now${(r.detail as { goLiveWait?: unknown }).goLiveWait ? "; the after-merge checks start when it is live" : " and the ticket is done"}. Nothing to redo: don't merge or push it again.`,
      "merge recorded late",
    ).catch(() => null);
  return true;
}

/** True while a merge for this ticket has said it is alive within the merge window (a check or lock wait under way). */
export function landingActive(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): boolean {
  const { landingBeat } = ctx;
  return Date.now() - (landingBeat.get(ticketId) ?? 0) <= MERGE_MISSED_AFTER_MS;
}

/**
 * The files this ticket's branch would clash with on the default branch. Null when it merges cleanly
 * or when that can't be told (no repo, no connected runner, an older runner, or a failed check): null
 * means "carry on as if it merges", so a check that can't answer never holds a reviewer back (BOS-426).
 * A real clash whose file list is unknown is an empty array, which callers must read as a clash.
 * A clean merge must never come back as [] (BOS-1074: [] is truthy, so every idle review woke its
 * author with "no longer merges").
 */
export async function branchClash(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<string[] | null> {
  const { ticketWithRepo, clashOnMain } = ctx;
  try {
    const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
    if (!repoUrl || !t.branch) return null;
    return await clashOnMain(t, defaultBranch);
  } catch {
    return null;
  }
}

/**
 * Which approved branches ahead in the merge line really conflict with this ticket's (BOS-1411). A read-only
 * merge-tree on the runner; [] when there is nothing to tell (the only approved work is this ticket, the runner
 * is away or too old, or nothing clashes). A warning only: it never holds a card or changes a merge, so every
 * answer that isn't a real conflict reads as "no warning". Refs are resolved for the note.
 */
export async function mergeLineClashes(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<Array<{ ticketId: string; ref: string | null; title: string; files: string[] }>> {
  const { db, deps, ticketWithRepo } = ctx;
  try {
    const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
    if (!repoUrl || !t.branch) return [];
    const others = await mergeLineApproved(db, t.projectId, t.id);
    if (!others.length) return [];
    const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
    if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "merge-conflicts")) return [];
    const r = await deps.runners.request<MergeLineConflictsResult>(
      runner.id,
      (requestId) => ({ type: "workspace.mergeLine", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch, branches: others.map((o) => ({ ticketId: o.id, branch: o.branch })) }),
      60_000,
    );
    const byId = new Map(others.map((o) => [o.id, o]));
    const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number }).from(tickets).where(inArray(tickets.id, (r?.conflicts ?? []).map((x) => x.ticketId)));
    const info = new Map(rows.map((x) => [x.id, { title: x.title, ref: ticketRef(c?.prefix, x.number) }]));
    return (r?.conflicts ?? [])
      .filter((x) => x.clashes && byId.has(x.ticketId))
      .map((x) => ({ ticketId: x.ticketId, ref: info.get(x.ticketId)?.ref ?? null, title: info.get(x.ticketId)?.title ?? byId.get(x.ticketId)!.branch, files: x.files.slice(0, 20) }));
  } catch {
    return [];
  }
}

/**
 * Tells someone when a waiting pull request's checks change (R86): a failure goes to the
 * assignee, who is sent back to fix it; a pass goes to the CEO, who can see why it hasn't
 * merged. Each head commit and result is told once.
 */
export async function notifyChecks(this: ReviewSelf, ctx: ReviewCtx, ticketId: string) {
  const { db, deps, state: reviewState, ticketWithRepo, prTarget, tellAgent } = ctx;
  const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
  if (!t.pullRequestHead || !t.pullRequestNumber || t.systemState !== "review") return;
  const { cfg, token } = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase);
  const c = await deps.gitHosts!.checks(cfg, token, t.pullRequestHead);
  const key = `${t.pullRequestHead}:${c.state}`;
  if ((c.state !== "failed" && c.state !== "passed") || key === t.pullRequestCi) return;
  await db.update(tickets).set({ pullRequestCi: key }).where(eq(tickets.id, ticketId));
  await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: "ci", passed: c.state === "passed", detail: c.state === "failed" ? c.failing.join(", ") || null : null });
  if (c.state === "failed" && t.assigneeAgentId) {
    await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
    await tellAgent({ ...t, systemState: "in_progress" }, `The checks on your pull request ${t.pullRequestUrl ?? ""} failed: ${c.failing.join(", ") || "see the host"}. Fix them, push, then move the ticket back to review.`, "ci failed");
  }
  if (c.state === "passed") {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
    if (ceo) await reviewState.wake?.(ceo.id, { ticketId, reason: "ci passed", note: `The checks passed on the pull request for "${t.title}", but it hasn't merged: ${t.pullRequestNote ?? "the host hasn't said why"}. Move it forward.` });
  }
}

/**
 * DR-009 #5 (BOS-575): a merged ticket closed with an after-merge check at fail, so the live work doesn't
 * do what it should. Boss Man opens the follow-up itself, so it is never a bare title nobody owns (BOS-542):
 * what failed and what was reported, the merged ticket's project, risk and feature, its assignee (the CEO
 * when it has none), the failed checks as its criteria, and a link each way. The CEO is told. Returns the
 * new ticket, or null when nothing failed. BOS-2682: the feature is NOT inherited: a delivered feature is
 * baselined, and a fix to live work is filed with no feature so the feature can close.
 */
export async function followUpFailedChecks(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, failed: string[], reported: string, byAgentId: string | null) {
  const { db, deps, tellCeo } = ctx;
  if (!failed.length) return null;
  const [row] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, ticketId));
  if (!row) return null;
  const { t, prefix } = row;
  const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
  const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
  const assigneeAgentId = t.assigneeAgentId ?? ceo?.id ?? null;
  // This path never makes an unowned ticket: with nobody to give it to, the caller says so instead.
  if (!assigneeAgentId) return null;
  const many = failed.length > 1;
  const title = (many ? `Follow-up to ${ref}: ${failed.length} after-merge checks failed on the live work` : `Follow-up to ${ref}: ${failed[0]}`).slice(0, 200);
  const body = [
    `**Why:** ${ref} ("${t.title}") merged${t.mergeCommit ? ` as ${t.mergeCommit.slice(0, 12)}` : ""}, and ${many ? "these checks" : "this check"} failed once the work was live:`,
    ...failed.map((c) => `- ${c}`),
    "",
    `**What was reported:** ${reported.replace(/\s+/g, " ").trim().slice(0, 1500) || "(nothing)"}`,
    "",
    `**Do:** find why ${many ? "they fail" : "it fails"} on the live work, fix it on this ticket's branch, and show ${many ? "them" : "it"} passing once merged. The merged ticket, with its description and conversation: [${ref}](#/tickets/${t.id}).`,
    "",
    "Opened by Boss Man when the merged ticket closed with this check at fail (DR-009 #5, BOS-575).",
  ].join("\n");
  const made = await deps.work.createTicket(t.projectId, {
    title,
    body,
    risk: t.risk ?? "medium",
    state: "ready",
    overLimit: true,
    assigneeAgentId,
    featureId: null,
    milestoneId: t.milestoneId,
    urgent: t.urgent,
    acceptanceCriteria: failed.map((text) => ({ text, after: "merge" as const })),
    createdByAgentId: byAgentId,
  });
  // The number is set by a database trigger; read it back rather than trust the insert's row.
  const [numbered] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, made.id));
  const newRef = ticketRef(prefix, numbered?.number) ?? `"${made.title}"`;
  const link = `Follow-up: ${newRef} (#/tickets/${made.id}), for ${many ? "the failed after-merge checks" : "the failed after-merge check"}.`;
  const [now] = await db.select({ note: tickets.stateNote }).from(tickets).where(eq(tickets.id, t.id));
  await db
    .update(tickets)
    .set({ stateNote: `${(now?.note ?? "").trim()}${now?.note?.trim() ? " " : ""}${link}`.slice(0, 4000) })
    .where(eq(tickets.id, t.id));
  await record(db, { companyId: t.companyId, ticketId: t.id, agentId: byAgentId, kind: "follow_up", summary: link, detail: { followUpTicketId: made.id, failed } });
  const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeAgentId));
  await tellCeo(made, "follow-up created", `${ref} ("${t.title}") closed with ${many ? "after-merge checks" : "an after-merge check"} at fail, so Boss Man opened ${newRef} "${made.title}" for ${who?.name ?? "nobody"}, risk ${made.risk ?? "medium"}, with the failed ${many ? "checks" : "check"} as its criteria. Re-assign or re-rate it if that's wrong; otherwise nothing to do.`).catch(() => undefined);
  return { id: made.id, ref: newRef, title: made.title, assignee: who?.name ?? null };
}

/** Checks every ticket waiting on a pull request: merged on the host, or mergeable now. */
export async function syncPullRequests(this: ReviewSelf, ctx: ReviewCtx) {
  const { db } = ctx;
  const waiting = await db.select({ id: tickets.id }).from(tickets).where(and(isNotNull(tickets.pullRequestNumber), eq(tickets.systemState, "review")));
  let merged = 0;
  for (const w of waiting) {
    const r = await this.mergePullRequest(w.id).catch(() => null);
    if (r?.outcome === "merged") merged++;
    else if (r) await this.notifyChecks(w.id).catch(() => undefined);
  }
  return { checked: waiting.length, merged };
}

export async function setCheckMergedResult(this: ReviewSelf, ctx: ReviewCtx, on: boolean) {
  const { db } = ctx;
  await db.insert(settings).values({ key: CHECK_MERGED_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  return on;
}

/**
 * BOS-1749: deletes bossman-ci/* branches on each GitHub project's repo whose commit is older than `maxAgeMs` and whose ticket
 * has no CI wait running here. Catches what the gate's own cleanup missed (a restart mid-check, a refused delete). Only
 * branches named bossman-ci/ are ever listed or deleted (git-hosts.ts). Repos and tokens come from the projects themselves.
 */
export async function sweepCiBranches(this: ReviewSelf, ctx: ReviewCtx, maxAgeMs = 6 * 3_600_000): Promise<{ repos: number; deleted: string[]; failed: number }> {
  const { db, deps, ciWaits, prTarget } = ctx;
  const out = { repos: 0, deleted: [] as string[], failed: 0 };
  if (!deps.gitHosts) return out;
  const rows = await db.select({ companyId: projects.companyId, repoUrl: projects.repoUrl, gitHost: projects.gitHost, gitApiBase: projects.gitApiBase }).from(projects).where(eq(projects.gitHost, "github"));
  const seen = new Set<string>(); // not state: local to this call
  for (const p of rows) {
    const target = await prTarget(p.companyId, p.repoUrl, p.gitHost, p.gitApiBase).catch(() => null);
    if (!target) continue;
    const key = `${target.cfg.apiBase}/${target.cfg.owner}/${target.cfg.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.repos++;
    try {
      for (const b of await deps.gitHosts.ciBranches(target.cfg, target.token)) {
        if (Date.now() - b.committedAt < maxAgeMs || ciWaits.has(b.branch.slice(CI_BRANCH_PREFIX.length))) continue;
        if (await deps.gitHosts.deleteCiBranch(target.cfg, target.token, b.branch)) out.deleted.push(b.branch);
        else out.failed++;
      }
    } catch {
      out.failed++;
    }
  }
  return out;
}

export async function setWaitForCi(this: ReviewSelf, ctx: ReviewCtx, on: boolean) {
  const { db } = ctx;
  await db.insert(settings).values({ key: WAIT_FOR_CI_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  return on;
}

export async function setMergeCarry(this: ReviewSelf, ctx: ReviewCtx, on: boolean) {
  const { db } = ctx;
  await db.insert(settings).values({ key: MERGE_CARRY_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  return on;
}

export async function setMergeRetarget(this: ReviewSelf, ctx: ReviewCtx, on: boolean) {
  const { db } = ctx;
  await db.insert(settings).values({ key: MERGE_RETARGET_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
  return on;
}

export async function setMergeTurnMinutes(this: ReviewSelf, ctx: ReviewCtx, minutes: number) {
  const { db } = ctx;
  const value = Math.max(0, Math.min(Math.floor(minutes), MERGE_TURN_MAX_MIN));
  await db.insert(settings).values({ key: MERGE_TURN_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}

export async function setTemplates(this: ReviewSelf, ctx: ReviewCtx, companyId: string, patch: Partial<GitTemplates>) {
  const { db, templates } = ctx;
  const next = { ...(await templates(companyId)), ...patch };
  await db.insert(settings).values({ key: `git_templates:${companyId}`, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
  return next;
}

/** Asks the agent to commit, or to push and open a PR, using the company's templates. */
export async function gitAction(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, action: "commit" | "pr") {
  const { ticketWithRepo, templates, tellAgent } = ctx;
  const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
  if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
  const tpl = (await templates(t.companyId))[action];
  const text = renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title });
  return { delivered: await tellAgent(t, text, action === "pr" ? "open pr" : "commit"), message: text };
}
