// The review service's merge status and upkeep (BOS-1904, move 4 of the BOS-1886 split): where a merge stands, the
// host's checks on a branch, the merges a runner swap waits on, merges found on main without a record, branch clashes,
// pull request upkeep, the bossman-ci branch sweep and the merge settings' setters. Each is a review service method moved
// out whole: it takes the service as `this` (so calls to other methods go through the assembled object, where tests spy
// on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isGateMergeOf, MAIN_LOG_MAX, mergeMessageTicket, wakeCeoIfLiveUnplaced } from "./missed-merges.js";
import { deploysNothing, touchesRunnerCode, touchesRunnerUpdate } from "@boss-man/shared";
import { MERGE_MISSED_AFTER_MS, parseRepoUrl, renderTemplate, ticketRef, type GitHostKind, type MainLogResult, type MergeLineConflictsResult } from "@boss-man/shared";
import { agents, checkJobs, checkResults, companies, projects, runners, settings, tickets } from "../db/schema.js";
import { CI_BRANCH_PREFIX, GitHostError, type CommitChecks } from "./git-hosts.js";
import { clearMergeCards } from "./decisions.js";
import { record } from "./activity.js";
import { mergeLineApproved } from "./merge-line-conflicts.js";
import { CHECK_MERGED_KEY, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, ReviewError, WAIT_FOR_CI_KEY, type GitTemplates, type LandingView } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";
import { landingsThatCount } from "./update-waits.js";

function landingStartMs(ctx: ReviewCtx, id: string): number {
  const l = ctx.landings.get(id);
  return l?.state === "running" ? Date.parse(l.startedAt) : NaN;
}

/** BOS-1951: the tickets whose merge a runner swap waits on, so the banner can name them (see landingMergesByCompany). */
export async function landingMergeIds(this: ReviewSelf, ctx: ReviewCtx): Promise<string[]> {
  const { db, landings, phases, ciWaits, landingStale } = ctx;
  let ids = [...landings.entries()].filter(([id, l]) => l.state === "running" && phases.get(id) === "merging").map(([id]) => id);
  if (!ids.length) return [];
  // BOS-2058: a wait counts live work only (landingsThatCount). The 20 Nov 11:44 hold was BOS-1991 waiting for GitHub CI
  // on its merge copy: it had pushed nothing to main, and ciPublishAndWait keeps the beat fresh while it polls, so only
  // the ciWaits test catches it (its check passed 11:47:23, the CI wait ended 11:53:10, the runner swapped 11:53:19).
  // ciWaits is cleared (ci-publish.ts `finally`) before the push, so the push itself is still waited for. A landing past
  // its own end, or whose ticket stopped beating, no longer holds the swap either: DR-014, a restart fails an in-flight
  // merge at once and the gate retries it.
  const live: string[] = [];
  for (const id of landingsThatCount(ids, { ciWaiting: (id) => ciWaits.has(id), startedMs: (id) => landingStartMs(ctx, id), now: Date.now() })) {
    if (await landingStale(id)) continue;
    live.push(id);
  }
  ids = live;
  if (!ids.length) return [];
  // BOS-1954: a merge whose check job is still queued has not pushed anything: the phase is "merging" from before its
  // prepare, but its check can't start while the update holds new checks, so counting it made the swap wait for a merge
  // that waited for the swap (a deadlock only a server restart cleared). Once the job runs it counts as a running check
  // (runner-busy.ts); once it has passed, the push is what is counted here.
  const waitingOnCheck = new Set((await db.select({ ticketId: checkJobs.ticketId }).from(checkJobs).where(and(inArray(checkJobs.ticketId, ids), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "queued")))).map((r) => r.ticketId));
  return ids.filter((id) => !waitingOnCheck.has(id));
}

/** BOS-2058: the live landings the swap waits on with when the oldest began, for the one list of waits (update-waits.ts). */
export async function landingWaitFacts(this: ReviewSelf, ctx: ReviewCtx): Promise<{ since: string | null; ids: string[] }> {
  const ids = await this.landingMergeIds();
  const starts = ids.map((id) => landingStartMs(ctx, id)).filter((n) => Number.isFinite(n));
  return { since: starts.length ? new Date(Math.min(...starts)).toISOString() : null, ids };
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

/** Every merge this process has running, with its phase, for the merge queue screen (BOS-587). */
export function runningMerges(this: ReviewSelf, ctx: ReviewCtx): Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git"; ci?: { since: string; waiting: string[] } }> {
  const { landings, phases, ciWaits } = ctx;
  return [...landings.entries()].flatMap(([ticketId, l]) => {
    if (l.state !== "running") return [];
    const ci = ciWaits.get(ticketId);
    return [{ ticketId, startedAt: l.startedAt, startedBy: l.startedBy, phase: phases.get(ticketId) ?? ("checking" as const), ...(ci ? { ci: { since: new Date(ci.since).toISOString(), waiting: ci.waiting } } : {}) }];
  });
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
 * BOS-1645 (R27): records the merges on main the gate never recorded (its answer was lost, e.g. to a runner swap between
 * push and record). For each project with a repo whose runner answers workspace.mainLog, it reads main's newest first-parent
 * commits, and every `Merge "..." (<ticket id>)` naming one of the project's tickets that has no mergeCommit is recorded as
 * the gate would have (recordMissedMerge). Then, per company read, a live commit that still can't be placed wakes the CEO
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
        // Newest first, so a ticket merged twice keeps its newest merge.
        const named = new Map<string, (typeof log)[number]>();
        for (const c of log) {
          const id = typeof c.message === "string" ? mergeMessageTicket(c.message) : null;
          if (id && !named.has(id)) named.set(id, c);
        }
        if (!named.size) continue;
        // Only a commit whose whole message is exactly this ticket's gate merge message counts (Jane, BOS-1645): a
        // ticket title is agent-written, so a message merely naming an id must never close another ticket.
        const missing = (
          await db
            .select({ id: tickets.id, title: tickets.title })
            .from(tickets)
            .where(and(inArray(tickets.id, [...named.keys()]), eq(tickets.projectId, p.id), isNull(tickets.mergeCommit)))
        ).filter((t) => isGateMergeOf(named.get(t.id)!.message, t));
        if (!missing.length) continue;
        // A second read for the changed files of just these, so touchesRunner is known (BOS-1021) rather than assumed.
        const shas = missing.slice(0, 20).map((m) => named.get(m.id)!.sha);
        const files = new Map(((await ask(shas).catch(() => null))?.commits ?? []).filter((c) => c.files).map((c) => [c.sha, c.files!]));
        for (const m of missing) {
          const c = named.get(m.id)!;
          if (await this.recordMissedMerge(m.id, c.sha, { at: c.at, files: files.get(c.sha) }).catch(() => false)) recorded.push(m.id);
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
 */
export async function recordMissedMerge(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, commit: string, opts: { at?: string; files?: string[] } = {}): Promise<boolean> {
  const { db, landings, closeAfterMerge, tellAgent } = ctx;
  if (landings.get(ticketId)?.state === "running") return false;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t || t.mergeCommit) return false;
  const at = opts.at && !Number.isNaN(Date.parse(opts.at)) ? new Date(opts.at) : new Date();
  const files = opts.files;
  const runnerFacts = { touchesRunner: files ? touchesRunnerCode(files) : true, touchesRunnerUpdate: files ? touchesRunnerUpdate(files) : null, deploysNothing: files ? deploysNothing(files) : null };
  const [claimed] = await db
    .update(tickets)
    .set({ mergeCommit: commit, mergedAt: at, ...runnerFacts })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.mergeCommit)))
    .returning({ id: tickets.id });
  if (!claimed) return false;
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
 * new ticket, or null when nothing failed.
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
    featureId: t.featureId,
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
