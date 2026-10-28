// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  ruleFor,
  rankDecision,
  ticketRef,
  recommendedVerdict,
  TEMP_CLEANUP_RULE,
  WORKING_COPY_RULE,
  cleanupScope,
  type BlockedTicket,
  alwaysChoices,
  explainPermission,
  type AlwaysChoice,
  type PermissionExplanation,
  type PermissionInfo,
  type PolicyMatch,
  type PolicyOutcome,
  type PolicyRuleSpec,
  type RunnerCommand,
  type RunnerEvent,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import type { Ladder } from "./alert-ladder.js";
import { recordGoalAnswer } from "./goal-check.js";
import { APPLY_CHANGE, REVERT_CHANGE } from "./retro.js";
import { ADD_RULE, policyRulesService } from "./policy-rules.js";
import { effectivePolicy, resolveActor } from "./review-policy.js";
import { LESSONS_CAP, LESSON_DONT_ADD, LESSON_EDIT, LESSON_DROP, LESSON_MAX, lessonsFrom, lessonsPageRow, normalizeLesson, writeLesson } from "./project-brief.js";
import { agents, budgetPolicies, companies, decisions, deploys, engagementMessages, engagements, keyResults, milestones, objectives, policyRules, projects, runnerEvents, runners, runs, ticketArtifacts, ticketDependencies, tickets, wakes, watchdogActions, wikiPages } from "../db/schema.js";

type PermissionEvent = Extract<RunnerEvent, { type: "run.permission_request" }>;
type Sender = (runnerId: string, command: RunnerCommand) => boolean;

/** The words on a card that can name a ticket: the question and, for an agent's question, what it tried and its steps. */
function cardText(d: typeof decisions.$inferSelect): string {
  const c = d.context as { triedFirst?: unknown; steps?: unknown };
  return [d.question, typeof c.triedFirst === "string" ? c.triedFirst : "", ...(Array.isArray(c.steps) ? c.steps.filter((x): x is string => typeof x === "string") : [])].join("\n");
}

/**
 * Ticket references (BOS-70) written in each card's text, resolved to tickets in the card's own company only.
 * A reference that matches nothing there is left out, so it stays plain text.
 */
async function resolveRefs(db: Db, cards: Array<{ id: string; companyId: string; text: string }>) {
  const wanted = cards.map((c) => ({ ...c, found: [...new Set([...c.text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})\b/g)].map((m) => `${m[1]!.toUpperCase()}-${m[2]}`))] }));
  const numbers = [...new Set(wanted.flatMap((w) => w.found.map((r) => Number(r.slice(r.lastIndexOf("-") + 1)))))];
  // lost on restart, harmless because it only lives for this one call
  const byCompany = new Map<string, Map<string, { ticketId: string; title: string; ref: string }>>();
  if (numbers.length) {
    const rows = await db
      .select({ id: tickets.id, title: tickets.title, number: tickets.number, companyId: tickets.companyId, prefix: companies.ticketPrefix })
      .from(tickets)
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(inArray(tickets.number, numbers), inArray(tickets.companyId, [...new Set(cards.map((c) => c.companyId))])));
    for (const r of rows) {
      const ref = ticketRef(r.prefix, r.number);
      if (!ref) continue;
      const m = byCompany.get(r.companyId) ?? new Map();
      m.set(ref.toUpperCase(), { ticketId: r.id, title: r.title, ref });
      byCompany.set(r.companyId, m);
    }
  }
  return new Map(
    wanted.map((w) => [
      w.id,
      Object.fromEntries(w.found.flatMap((r) => { const t = byCompany.get(w.companyId)?.get(r); return t ? [[r, t]] : []; })) as Record<string, { ticketId: string; title: string; ref: string }>,
    ]),
  );
}

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string; plan?: boolean; ticketId?: string | null; explain?: PermissionExplanation; always?: AlwaysChoice[]; /** Temp-file cleanup, sent to the CEO first (BOS-111). */ tempCleanup?: boolean; /** Deletes in the agent's working copy, sent to the CEO first (BOS-120). */ workingCopy?: WorkingCopy; /** Who on the team settled it, and why (BOS-111 audit). */ settled?: Settled }
  | { type: "engagement"; engagementId: string }
  | { type: "question"; /** What the agent tried first, and why only the owner can do this. */ triedFirst?: string; /** Numbered steps when the owner must do something. */ steps?: string[] }
  | { type: "stale_blocker"; dependencyId: string; blockedTicketId: string; blockerTicketId: string | null; blockerEngagementId: string | null }
  | { type: "stalled_run"; runnerId: string; runId: string }
  | { type: "deploy"; deployId: string }
  /** The follow-up after a feature ships: did it move its key result? */
  | { type: "goal_check"; featureId: string }
  /**
   * An approved decision whose next step is the owner's own (BOS-122): a deploy whose target has to be
   * applied by hand. It stays open as a to-do on the owner's queue until they mark it done or the live
   * commit is confirmed to have changed. `ofDecisionId` names the approval it came from; `steps`, `check`
   * and `rollback` are shown on the card. `fromCommit` is what ran when it was approved: once the live
   * commit differs, the hand-apply reached the host (BOS-122). `lastFailure` keeps the owner's note from
   * "A step failed" on the card.
   */
  | { type: "owner_todo"; ofDecisionId: string; steps: string[]; check?: string; rollback?: string; /** What the to-do applies: a self-deploy's target and commit, or a deploy target's deploy id. */ target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string; lastFailure?: { note: string; at: string } }
  /** Boss Man updating itself through the host deployer; `infra` ones are only an alert (the owner deploys those by hand on the host). */
  | { type: "self_deploy"; target: "server" | "runner"; commit: string; fromCommit: string; runnerChanged?: boolean; infra?: boolean; /** Commit subjects, so the "updated" note says what changed. */ changes?: string[]; /** For an infra change the owner applies by hand: numbered steps, how to check it worked, and how to roll back. */ handSteps?: string[]; check?: string; rollback?: string; result?: { result: string; message: string; at: string } }
  /** The runner update's deadline question (services/maintenance.ts): stop the rest, wait more, or cancel. */
  | { type: "maintenance"; since: string }
  | { type: "review_loop"; ticketId: string; message: string; reviewer: string }
  | { type: "ticket_cap"; ticketId: string }
  | { type: "project_cap"; projectId: string }
  | { type: "budget_limit"; policyId: string }
  | { type: "risk_review"; ticketId: string; reviewer: string }
  /** The merge check was killed or timed out: the owner's call, not the agent's. */
  | { type: "check_stuck"; ticketId: string; command: string; output: string }
  /** A lesson learned from a sent-back review (R-review-lessons), awaiting the owner's call. */
  | { type: "lesson"; ticketId: string; projectId: string; projectName: string; lesson: string }
  /** The lesson is approved but the project's Lessons section is full: pick which line it replaces. */
  | { type: "lesson_replace"; projectId: string; projectName: string; lesson: string }
  /** The CEO's proposals for the team (R62), applied when the owner approves. */
  | { type: "hire"; proposal: { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; reason?: string; forTickets?: string[] }; byAgentId: string }
  | { type: "instructions"; agentId: string; instructions: string; byAgentId: string }
  | { type: "team_plan"; projectId: string | null; covered: string; hires: TeamHire[]; byAgentId: string }
  /** A permission rule the CEO drafted from the owner's plain request; added when they answer ADD_RULE. A "question" kind, so the owner can also answer in their own words. */
  | { type: "rule_proposal"; rule: { name: string; match: PolicyMatch; outcome: PolicyOutcome } }
  /** A change a workflow retro proposed (workflow_changes); Apply carries it out, Skip leaves things as they are. */
  | { type: "workflow_change"; changeId: string }
  /** The check on an applied change (part 4): Keep it or Revert it, with the measured result. */
  | { type: "workflow_check"; changeId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHASE = "Chase";
export const REASSIGN = "Reassign";
export const DROP = "Drop dependency";
const BOSSMAN_TOOL = /^(mcp__bossman__|mcp\.bossman\.)/;
export const KEEP_WAITING = "Keep waiting";
export const CANCEL_RUN = "Cancel run";
export const RAISE_BUDGET = "Raise it by half";
export const HARD_STOP = "Make it a hard stop";
export const LEAVE_BUDGET = "Leave it";
export const APPROVE_PLAN = "Approve plan";
export const KEEP_PLANNING = "Keep planning";
export const APPROVE_MERGE = "Approve and merge";
export const SEND_IT_BACK = "Send it back";
export const CHECK_AGAIN = "Run the check again";
export const CHECK_SEND_BACK = "Send it back to the agent";
export const CHECK_SKIP = "Merge without the check";
/** An owner to-do (BOS-122): the approved deploy still needs the owner's own hand. */
export const TODO_DONE = "Done, it's applied";
export const TODO_FAILED = "A step failed";
/** The approval for a change that has to be applied by hand: approving it leaves a to-do rather than deploying. */
export const APPROVE_HAND_APPLY = "Approve";

/**
 * An approved ticket whose merge didn't finish: the merge failed (runner gone, a reply timed out) or the
 * server stopped mid-way. The owner tries again or sends it back; "Run the check again" re-runs the whole merge.
 */
export async function raiseMergeStuck(db: Db, t: { id: string; title: string; companyId: string }, why: string) {
  // GitHub's own words when the token can't change .github/workflows/.
  const fix = /without [`']?workflows?[`']? (scope|permission)/i.test(why)
    ? " To fix it: on GitHub, edit the company's git token and set Repository permissions → Workflows to Read and write (a classic token needs the workflow scope), then Run the check again. The token itself doesn't change."
    : "";
  return db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `"${t.title}" was approved, but its merge didn't finish (${why}). This isn't a problem with the agent's work.${fix}`,
      options: [CHECK_AGAIN, CHECK_SEND_BACK],
      recommendedOption: CHECK_AGAIN,
      tier: "owner",
      dedupeKey: `merge-stuck:${t.id}`,
      context: { type: "check_stuck", ticketId: t.id, command: "", output: why },
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id });
}
/**
 * An approved decision whose next step is the owner's own (BOS-122) leaves this to-do open on their
 * queue instead of clearing the approval and leaving nothing. `key` collapses repeats (one per deploy or
 * commit); answering it as "Done" or a confirmed commit change closes it. Returns the row, or null when
 * one is already open for this key.
 */
export async function raiseOwnerTodo(
  db: Db,
  t: { companyId: string; question: string; key: string; steps: string[]; check?: string; rollback?: string; ofDecisionId: string; raisedByAgentId?: string | null; target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string },
) {
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: t.question,
      options: [TODO_DONE, TODO_FAILED],
      recommendedOption: TODO_DONE,
      tier: "owner",
      raisedByAgentId: t.raisedByAgentId ?? null,
      dedupeKey: t.key,
      context: { type: "owner_todo", ofDecisionId: t.ofDecisionId, steps: t.steps, ...(t.check ? { check: t.check } : {}), ...(t.rollback ? { rollback: t.rollback } : {}), ...(t.target ? { target: t.target } : {}), ...(t.commit ? { commit: t.commit } : {}), ...(t.fromCommit ? { fromCommit: t.fromCommit } : {}), ...(t.deployId ? { deployId: t.deployId } : {}) } satisfies DecisionContext,
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id });
  return row ?? null;
}

/** Closes the open owner to-do for a key once the owner's step is confirmed done (BOS-122), e.g. by the live commit changing. */
export async function clearOwnerTodo(db: Db, key: string, summary: string) {
  const [row] = await db
    .update(decisions)
    .set({ status: "answered", answer: summary, answeredAt: new Date(), dedupeKey: null })
    .where(and(eq(decisions.dedupeKey, key), eq(decisions.status, "open")))
    .returning({ id: decisions.id, companyId: decisions.companyId });
  if (row) await record(db, { companyId: row.companyId, kind: "decision_answered", summary, at: new Date() });
  return row ?? null;
}

export const DEPLOY = "Deploy";
export const UPDATE_RUNNERS = "Update runners";
export const NOT_NOW = "Not now";
export const STOP_AND_UPDATE = "Stop the remaining runs and update now";
export const KEEP_WAITING_MORE = (minutes: number) => `Keep waiting another ${minutes} min`;
export const CANCEL_UPDATE = "Cancel the update";

export class AnswerError extends Error {}

/** The option for dropping a line: numbered, so a long lesson can be chosen by its number. */
const replaceOption = (i: number, lesson: string) => `Replace #${i + 1}: ${lesson}`;
/** The lesson a drop answer names, in the numbered or the older "Replace: " form. */
const replacedLesson = (answer: string) => /^Replace(?: #\d+)?: ([\s\S]*)$/.exec(answer)?.[1];

/** Why an agent's ask is refused, or null: it must say what was tried first, and give steps when the owner has to act. */
export function checkAsk(a: { triedFirst: string; ownerMustDo?: boolean; steps?: string[] }): string | null {
  const t = a.triedFirst.trim();
  if (t.length < 20 || t.split(/\s+/).length < 4 || /^(n\/?a|none|nothing|no|nil|-+)\W*$/i.test(t)) {
    return "triedFirst is too thin. Say what you tried yourself and why an agent can't do this (no host access, a secret only the owner can grant, owner sign-off). Try again once you have, or do it yourself.";
  }
  if (a.ownerMustDo && !a.steps?.length) {
    return "The owner has to do something, so give steps: a short numbered list in plain words, with exact paths in the app (for example Settings → Server and runner → Updates → Build and update runners) and how to undo it. Prefer an in-app button over host commands.";
  }
  return null;
}

/** One proposed hire in a team plan (docs/13). */
export type TeamHire = { name: string; template?: string; title?: string | null; model?: string | null; skills?: string[]; reason: string; serves?: string | null };
export const TEAM_HIRE = "Hire the ticked ones";
export const TEAM_NOT_NOW = "Not now";

export type AnswerExtra = {
  /** A team plan: which proposed hires (by position) the owner ticked; all of them when absent. */
  picks?: number[];
  assigneeAgentId?: string;
  /** What to tell the agent, e.g. why a plan or a review went back. */
  note?: string;
  /** The owner wrote their own answer to an agent's question instead of picking an option. */
  custom?: boolean;
  /** The CEO settled it ("handled" advice), so the record and the wake say so instead of "the owner". */
  by?: "ceo";
  /** With by "ceo": the advice summary, stored in the same conditional update that closes the decision. */
  handled?: { summary: string; at: string };
  /** The CEO answered with the decisions tool: recorded as theirs, with its note as the reason (BOS-111). */
  settledBy?: { agentId: string };
};

/** Which checkout a working-copy cleanup deletes in, and what (BOS-120). */
export type WorkingCopy = { ticketId: string; ref: string | null; branch: string; files: string[] };
/** The keys of Claude Code's Bash tool input. None of them moves the shell to another folder. */
const SHELL_INPUT_KEYS = new Set(["command", "description", "timeout", "run_in_background", "dangerouslyDisableSandbox"]);
/** Files for a card, cut at whole names with a count of the rest, so a long list never looks complete. */
function fileList(files: string[], max: number): string {
  let out = "";
  let shown = 0;
  for (const f of files) {
    const next = out ? `${out}, ${f}` : f;
    if (next.length > max) break;
    out = next;
    shown++;
  }
  return shown < files.length ? `${out}${out ? ", " : ""}…and ${files.length - shown} more` : out;
}

export type Settled = { agentId: string; name: string; note: string | null; at: string };

/** How long a permission or plan request waits with the CEO before it moves to the owner: the runner gives up at 10 minutes (BOS-111, BOS-119). */
export const CEO_HANDOVER_MINUTES = 5;

/**
 * "Ask the CEO for advice": where a decision stands with the CEO. Kept in the decision's context so the
 * decision stays open and answerable by the owner the whole time.
 */
export type Advice = {
  state: "asking" | "reissued" | "clarified" | "handled" | "timed_out" | "replacement";
  /** The owner's one-line "what's unclear". */
  note?: string;
  askedAt?: string;
  /** When the CEO acted or the time ran out. */
  at?: string;
  /** reissued: the decision that took its place. */
  replacedBy?: string;
  /** replacement: the decision it took the place of. */
  replaces?: string;
  /** handled: what the CEO did. */
  summary?: string;
  /** clarified: the first wording, before the CEO rewrote it. */
  originalQuestion?: string;
};
export const adviceOf = (context: unknown): Advice | undefined => (context as { advice?: Advice } | null)?.advice;
export const ADVICE_DEFAULT_MINUTES = 120;

/**
 * An allow-list: the CEO may settle only an agent's plain question (no steps for the owner) that another agent raised.
 * Everything else (approvals, permissions, budgets, engagements, every special context type, the CEO's own request) can only be reissued.
 */
function ceoCanHandle(d: { kind: string; context: unknown; raisedByAgentId: string | null }, raisedByCeo: boolean) {
  const ctx = d.context as DecisionContext;
  return d.kind === "question" && ctx.type === "question" && !ctx.steps?.length && !!d.raisedByAgentId && !raisedByCeo;
}

const ALLOW = "Allow once";
const DENY = "Deny";

type WakeHook = (input: { agentId: string; reason: string; ticketId?: string | null; note?: string | null; priority?: number }) => Promise<unknown>;

type EngagementHook = (engagementId: string, approved: boolean) => Promise<unknown>;
type DeployHook = (deployId: string, approved: boolean) => Promise<unknown>;
export type LoopHooks = {
  sendBack(ticketId: string, text: string, reviewer: string): Promise<unknown>;
  stopTicket(ticketId: string): Promise<unknown>;
  raiseCap(ticketId: string): Promise<unknown>;
  /** Merges an approved ticket once the owner has signed off on it (R48). */
  land(ticketId: string, reviewer: string): Promise<unknown>;
  /** Lands again in the background after a check that couldn't finish; `skipChecks` merges without it. */
  landAgain(ticketId: string, skipChecks: boolean): Promise<unknown>;
};

export type MaintenanceHook = { answered(answer: string): Promise<unknown> };
export type SelfDeployHook = { check(ctx: Extract<DecisionContext, { type: "self_deploy" }>): Promise<void>; send(ctx: Extract<DecisionContext, { type: "self_deploy" }>, decisionId: string): Promise<unknown> };

type TeamPlanHook = (ctx: Extract<DecisionContext, { type: "team_plan" }>, companyId: string, picks: number[]) => Promise<unknown>;
/** The workflow retro's side of its decisions (services/retro.ts): a check before Apply, and what to do once answered. */
export type RetroHook = {
  problemApplying(changeId: string): Promise<string | null>;
  answered(changeId: string, answer: string): Promise<unknown>;
  /** Why Revert can't go ahead now (the value was changed again since), or null. */
  problemReverting(changeId: string): Promise<string | null>;
  checked(changeId: string, answer: string): Promise<unknown>;
  lessonAnswered(decisionId: string, answer: string, note?: string): Promise<unknown>;
};
type AgentDecisionHook = (ctx: Extract<DecisionContext, { type: "hire" | "instructions" }>, companyId: string, approved: boolean) => Promise<unknown>;

/**
 * What the blockers that just resolved produced, for the "unblocked" wake (R85). An answered
 * decision's dependency row is already gone by then, so its question and answer come in as `answered`.
 */
export async function unblockedNote(db: Db, ticketId: string, answered?: { question: string; answer: string }) {
  const blockers = await db
    .select({ id: tickets.id, title: tickets.title, note: tickets.stateNote, question: decisions.question, answer: decisions.answer })
    .from(ticketDependencies)
    .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
    .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
    .where(eq(ticketDependencies.blockedTicketId, ticketId));
  const ids = blockers.flatMap((b) => (b.id ? [b.id] : []));
  const made = ids.length
    ? await db
        .select({ ticketId: ticketArtifacts.ticketId, title: ticketArtifacts.title, slug: wikiPages.slug })
        .from(ticketArtifacts)
        .leftJoin(wikiPages, eq(wikiPages.id, ticketArtifacts.wikiPageId))
        .where(inArray(ticketArtifacts.ticketId, ids))
    : [];
  const lines = blockers.flatMap((b) => {
    if (b.id) {
      const outs = made.filter((m) => m.ticketId === b.id).map((m) => m.slug ?? m.title);
      return [`- "${b.title}" is done.${b.note ? ` Its note: ${b.note}` : ""}${outs.length ? ` It produced: ${outs.join(", ")}.` : ""}`];
    }
    return b.question && b.answer ? [`- You asked "${b.question}"; the answer was: ${b.answer}`] : [];
  });
  if (answered) lines.push(`- You asked "${answered.question}"; the answer was: ${answered.answer}`);
  return lines.length ? `What you were waiting on:\n${lines.join("\n")}`.slice(0, 800) : undefined;
}

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date(), isConnected: (runnerId: string) => boolean = () => false) {
  let wake: WakeHook | null = null;
  let cancelRun: ((runId: string) => Promise<{ endedHere?: boolean }>) | null = null;
  let onEngagement: EngagementHook | null = null;
  let onDeploy: DeployHook | null = null;
  let onAgentDecision: AgentDecisionHook | null = null;
  let retroHook: RetroHook | null = null;
  let onTeamPlan: TeamPlanHook | null = null;
  let loopHooks: LoopHooks | null = null;
  let selfDeploy: SelfDeployHook | null = null;
  let maintenance: MaintenanceHook | null = null;

  /** What the owner needs to judge a stalled run, worked out when asked (not stored). The last steps come from the run's own transcript. */
  async function stallEvidence(runId: string) {
    const [row] = await db
      .select({ run: runs, agent: agents.name, ticketTitle: tickets.title, runnerId: runners.id, lastSeenAt: runners.lastSeenAt })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(eq(runs.id, runId));
    if (!row) return null;
    const [last] = await db
      .select({ seq: runnerEvents.seq, type: runnerEvents.type, payload: runnerEvents.payload, at: runnerEvents.occurredAt })
      .from(runnerEvents)
      .where(and(sql`(${runnerEvents.payload}->>'runId') = ${runId}`, inArray(runnerEvents.type, ["run.started", "run.update", "run.workspace", "run.permission_request", "run.ended"])))
      .orderBy(desc(runnerEvents.seq))
      .limit(1);
    const [perm] = await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`(${decisions.context}->>'runId') = ${runId}`))
      .limit(1);
    return {
      runId,
      agent: row.agent,
      ticketId: row.run.ticketId,
      ticket: row.ticketTitle,
      startedAt: row.run.startedAt,
      lastEventAt: row.run.lastEventAt,
      lastStep: last ? { seq: last.seq, type: last.type, at: last.at, event: last.payload } : null,
      runner: { connected: !!row.runnerId && isConnected(row.runnerId), lastSeenAt: row.lastSeenAt },
      waitingOnOwner: !!perm,
    };
  }

  /** A blocked ticket whose blockers are all resolved moves to ready, and its assignee is woken. */
  async function releaseIfFree(ticketId: string, wakeAssignee = true) {
    const deps = await db
      .select({ ticketState: tickets.systemState, engagementStatus: engagements.status, decisionStatus: decisions.status })
      .from(ticketDependencies)
      .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
      .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
      .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .where(eq(ticketDependencies.blockedTicketId, ticketId));
    const open = deps.some((d) => (d.ticketState && d.ticketState !== "done") || (d.engagementStatus && d.engagementStatus !== "signed_off") || d.decisionStatus === "open");
    if (open) return null;
    const [t] = await db.update(tickets).set({ systemState: "ready", lastActivityAt: now() }).where(and(eq(tickets.id, ticketId), eq(tickets.systemState, "blocked"))).returning();
    if (wakeAssignee && t?.assigneeAgentId && wake) await wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked", note: await unblockedNote(db, t.id) });
    return t ?? null;
  }

  /** Checks an answer's extra input before anything changes. */
  async function validate(d: typeof decisions.$inferSelect, answer: string, extra: AnswerExtra) {
    const ctx = d.context as DecisionContext;
    if (ctx.type === "self_deploy" && (answer === DEPLOY || answer === UPDATE_RUNNERS)) {
      if (!selfDeploy) throw new AnswerError("Self-deploy is not set up on this install.");
      await selfDeploy.check(ctx);
    }
    if (ctx.type === "stale_blocker" && answer === REASSIGN) {
      if (!ctx.blockerTicketId) throw new AnswerError("Only a ticket can be reassigned.");
      if (!extra.assigneeAgentId) throw new AnswerError("Say who to reassign it to (assigneeAgentId).");
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, extra.assigneeAgentId), eq(agents.companyId, t?.companyId ?? "")));
      if (!a) throw new AnswerError("That agent isn't in the blocking ticket's company.");
    }
    if (ctx.type === "workflow_change" && answer === APPLY_CHANGE) {
      const problem = await retroHook?.problemApplying(ctx.changeId);
      if (problem) throw new AnswerError(problem);
    }
    if (ctx.type === "workflow_check" && answer === REVERT_CHANGE) {
      const problem = await retroHook?.problemReverting(ctx.changeId);
      if (problem) throw new AnswerError(problem);
    }
    if (ctx.type === "lesson" && answer === LESSON_EDIT && !extra.note?.trim()) throw new AnswerError("Say the lesson's corrected wording as the note.");
    if (ctx.type === "lesson_replace" && !extra.custom && answer !== LESSON_DONT_ADD && !replacedLesson(answer)) throw new AnswerError(`Answer must be one of the listed lessons, or "${LESSON_DONT_ADD}".`);
    if (ctx.type === "lesson_replace" && !extra.custom) {
      const dropped = replacedLesson(answer);
      if (dropped !== undefined) {
        const page = await lessonsPageRow(db, d.companyId, ctx.projectId);
        const current = page ? lessonsFrom(page.body) : [];
        if (!current.includes(dropped)) throw new AnswerError(`That lesson is no longer in the Lessons section (it may have been dropped by another decision). Options still valid: ${(d.options as string[]).filter((o) => { const l = replacedLesson(o); return l !== undefined && current.includes(l); }).join(" | ") || "none"}. Answer "${LESSON_DONT_ADD}" or ask for a fresh decision.`);
      }
    }
  }

  /** Tells the owner what happened to a lesson and why, in the activity feed (BOS-105). */
  async function lessonOutcome(d: typeof decisions.$inferSelect, projectName: string, what: string, note?: string) {
    const reason = note?.trim().replace(/\s+/g, " ").slice(0, 300);
    await record(db, { companyId: d.companyId, kind: "lesson_outcome", summary: `Lessons, ${projectName}: ${what}${reason ? ` Reason: ${reason}` : ""} You can edit the brief's Lessons section to undo this.`, at: now() });
  }

  /** Adds the approved lesson to the project's brief, unless the section is full and a line must go first (R-review-lessons). */
  async function answerLessons(d: typeof decisions.$inferSelect, ctx: Extract<DecisionContext, { type: "lesson" }>, answer: string, extra: AnswerExtra) {
    if (answer === LESSON_DROP) return lessonOutcome(d, ctx.projectName, `not added: "${ctx.lesson}".`, extra.note);
    const text = normalizeLesson(answer === LESSON_EDIT ? (extra.note ?? "") : ctx.lesson);
    if (text.length > LESSON_MAX) throw new AnswerError(`A lesson is one line, up to ${LESSON_MAX} characters.`);
    // An edit with no usable note adds nothing: nothing reaches the brief without words behind it.
    if (!text) return lessonOutcome(d, ctx.projectName, `not added: the edited wording was empty ("${ctx.lesson}").`);
    const page = await lessonsPageRow(db, d.companyId, ctx.projectId);
    const existing = page ? lessonsFrom(page.body) : [];
    if (existing.includes(text)) return lessonOutcome(d, ctx.projectName, `not added, it is already there: "${text}".`);
    if (existing.length >= LESSONS_CAP) {
      // The section is full: the CEO picks which line the new lesson replaces, or leaves it out.
      const unique = [...new Set(existing)];
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: d.companyId,
          kind: "question",
          question: `The Lessons section of ${ctx.projectName}'s brief is full (${LESSONS_CAP}). The new lesson is "${text}", from ticket ${ctx.ticketId}. Adding it drops one: which? Judge overlap and value, or answer "${LESSON_DONT_ADD}". Give a one-line reason as the note.`,
          options: [...unique.map((l, i) => replaceOption(i, l)), LESSON_DONT_ADD],
          recommendedOption: replaceOption(0, unique[0]!),
          tier: "ceo",
          dedupeKey: `lesson-replace:${ctx.projectId}:${text}`,
          context: { type: "lesson_replace", projectId: ctx.projectId, projectName: ctx.projectName, lesson: text } satisfies DecisionContext,
        })
        .onConflictDoNothing()
        .returning({ question: decisions.question });
      if (row) await tellCeo(d.companyId, row.question);
      return;
    }
    await writeLesson(db, { companyId: d.companyId, projectId: ctx.projectId, projectName: ctx.projectName }, text);
    await lessonOutcome(d, ctx.projectName, answer === LESSON_EDIT ? `added, as edited by the CEO: "${text}".` : `added "${text}".`, answer === LESSON_EDIT ? undefined : extra.note);
  }

  /** Finishes a replace: the chosen line goes, the new lesson takes its place. */
  async function answerLessonReplace(db: Db, d: typeof decisions.$inferSelect, ctx: Extract<DecisionContext, { type: "lesson_replace" }>, answer: string, ownWords: boolean, note?: string) {
    if (ownWords) {
      // The owner answered in their own words. The Lessons section only changes through a lesson decision, so the CEO gets a follow-up one carrying those words.
      const page = await lessonsPageRow(db, d.companyId, ctx.projectId);
      const unique = [...new Set(page ? lessonsFrom(page.body) : [])];
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: d.companyId,
          kind: "question",
          question: `The Lessons section of ${ctx.projectName}'s brief is full (${LESSONS_CAP}). The new lesson is "${ctx.lesson}". The owner was asked which line it replaces and answered in their own words: ${answer}\n\nPick the line their words point to, or "${LESSON_DONT_ADD}" if they ask for something else (then ask the owner).`,
          options: [...unique.map((l, i) => replaceOption(i, l)), LESSON_DONT_ADD],
          recommendedOption: LESSON_DONT_ADD,
          tier: "ceo",
          dedupeKey: `lesson-replace-ceo:${d.id}`,
          context: { type: "lesson_replace", projectId: ctx.projectId, projectName: ctx.projectName, lesson: ctx.lesson } satisfies DecisionContext,
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id, question: decisions.question });
      if (row) await tellCeo(d.companyId, row.question);
      return;
    }
    const dropped = replacedLesson(answer);
    if (answer === LESSON_DONT_ADD || dropped === undefined) return lessonOutcome(d, ctx.projectName, `not added, nothing dropped: "${ctx.lesson}".`, note);
    await writeLesson(db, { companyId: d.companyId, projectId: ctx.projectId, projectName: ctx.projectName }, ctx.lesson, dropped);
    await lessonOutcome(d, ctx.projectName, `added "${ctx.lesson}" and dropped "${dropped}".`, note);
    // Other open drop decisions for this project no longer offer the line that just went.
    const siblings = await db.select().from(decisions).where(and(eq(decisions.companyId, d.companyId), eq(decisions.status, "open"), ne(decisions.id, d.id)));
    for (const o of siblings) {
      const oc = o.context as DecisionContext;
      if (oc.type !== "lesson_replace" || oc.projectId !== ctx.projectId) continue;
      const options = (o.options as string[]).filter((x) => replacedLesson(x) !== dropped);
      const recommendedOption = options.includes(o.recommendedOption ?? "") ? o.recommendedOption : LESSON_DONT_ADD;
      await db.update(decisions).set({ options, recommendedOption }).where(eq(decisions.id, o.id));
    }
  }

  async function answerStaleBlocker(ctx: Extract<DecisionContext, { type: "stale_blocker" }>, answer: string, extra: AnswerExtra) {
    const [blocked] = await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, ctx.blockedTicketId));
    if (answer === DROP) {
      await db.delete(ticketDependencies).where(eq(ticketDependencies.id, ctx.dependencyId));
      await releaseIfFree(ctx.blockedTicketId);
      return;
    }
    if (ctx.blockerTicketId) {
      const assignee = answer === REASSIGN ? extra.assigneeAgentId! : undefined;
      // Chasing restarts the stale clock; so does a new owner.
      const [t] = await db
        .update(tickets)
        .set({ lastActivityAt: now(), ...(assignee ? { assigneeAgentId: assignee, assignedToOwner: false } : {}) })
        .where(eq(tickets.id, ctx.blockerTicketId))
        .returning();
      if (t?.assigneeAgentId && wake) {
        await wake({
          agentId: t.assigneeAgentId,
          ticketId: t.id,
          reason: assignee ? "assigned" : "chased",
          priority: 3,
          note: `"${blocked?.title ?? "Another ticket"}" is waiting on this ticket${assignee ? ", which has been handed to you" : ", which has had no activity for a while"}. Move it forward, or raise a decision if you're stuck.`,
        });
      }
      return;
    }
    if (ctx.blockerEngagementId) {
      const [eng] = await db.select().from(engagements).where(eq(engagements.id, ctx.blockerEngagementId));
      if (!eng) return;
      await db.insert(engagementMessages).values({ engagementId: eng.id, fromCompanyId: eng.requesterCompanyId, body: `Chasing: "${blocked?.title ?? "our work"}" is waiting on this engagement.` });
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, eng.providerCompanyId), eq(agents.role, "ceo")));
      if (ceo && wake) await wake({ agentId: ceo.id, reason: "chased", priority: 3, note: `The engagement "${eng.title}" (${eng.id}) is holding up the requesting company's work. Move it forward, or tell them what's in the way.` });
    }
  }

  async function rulesFor(companyId: string): Promise<PolicyRuleSpec[]> {
    // Company rules before global ones, each in the owner's order (R19).
    const rows = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.trigger, "permission"), or(eq(policyRules.companyId, companyId), isNull(policyRules.companyId))))
      .orderBy(asc(policyRules.position), asc(policyRules.name));
    rows.sort((a, b) => Number(b.companyId !== null) - Number(a.companyId !== null) || a.position - b.position);
    return rows.map((r) => ({ name: r.name, match: r.condition as PolicyRuleSpec["match"], outcome: r.outcome }));
  }

  /** Wakes the company's CEO, or the agent a plan was put to, to answer a decision (R19). */
  async function tellCeo(companyId: string, question: string, agentId?: string) {
    const [ceo] = agentId ? [{ id: agentId }] : await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
    if (ceo && wake) await wake({ agentId: ceo.id, reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
  }

  /** A plan from a plan-first ticket, put to the CEO, or to the owner for high-risk work (R40, R48). */
  async function planRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
    const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
    const [t] = run?.ticketId ? await db.select().from(tickets).where(eq(tickets.id, run.ticketId)) : [];
    const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
    const plan = event.detail ?? null;
    if (t && plan) await db.update(tickets).set({ plan, lastActivityAt: now() }).where(eq(tickets.id, t.id));
    // The review policy says who approves a plan: the owner, the CEO, or an agent. A CEO's own plan always goes to the owner.
    let tier: "owner" | "ceo" = "owner";
    let forAgentId: string | null = null;
    if (t && agent?.role !== "ceo") {
      const ref = ruleFor(await effectivePolicy(db, t), t.risk).planApprover;
      // shortcut: "none" on a plan-first ticket still goes to the CEO (someone must release plan mode); skip only if owners ask for auto-approval.
      if (ref === "none") tier = "ceo";
      else if (ref !== "owner") {
        tier = "ceo";
        const r = await resolveActor(db, t.companyId, ref, run?.agentId ?? null);
        if (r.note) await record(db, { companyId: t.companyId, kind: "review_fallback", summary: r.note, ticketId: t.id });
        if (ref !== "ceo" && !r.note) forAgentId = r.agent?.id ?? null;
      }
    }
    // A plan put to the CEO (not to a named approver) waits on the ladder too, so it stays off the
    // owner's queue until the CEO passes it on or the 5-minute handover runs out (BOS-119).
    let ladder: Ladder | undefined;
    let ceoId: string | undefined;
    if (tier === "ceo" && !forAgentId) {
      const [ceo] = await db.select({ id: agents.id, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, runner.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo && !ceo.paused) {
        ceoId = ceo.id;
        const since = now().toISOString();
        ladder = { rung: "ceo", since, minutes: CEO_HANDOVER_MINUTES, ticketId: t?.id ?? null, about: run?.agentId ? [run.agentId] : [], hops: [{ to: "ceo", at: since, why: "the plan is the CEO's to approve" }] };
      } else tier = "owner";
    }
    const [row] = await db
      .insert(decisions)
      .values({
        companyId: runner.companyId,
        kind: "approval",
        question: t ? `${agent?.name ?? "An agent"}'s plan for "${t.title}": approve it to start building?` : `${agent?.name ?? "An agent"} has a plan and wants to start building. Approve it?`,
        options: [APPROVE_PLAN, KEEP_PLANNING],
        recommendedOption: APPROVE_PLAN,
        raisedByAgentId: run?.agentId ?? null,
        tier,
        forAgentId,
        dedupeKey: `permission:${event.requestId}`,
        context: { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, plan: true, ticketId: t?.id ?? null, planText: plan, ...(ladder ? { ladder } : {}) },
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id, question: decisions.question });
    if (row && ladder && ceoId && wake)
      await wake({
        agentId: ceoId,
        reason: "decision",
        priority: 3,
        note: [
          `A plan is waiting for you (decision ${row.id}): ${row.question}`,
          "Approve it to let the agent start building, or send it back with what to change.",
          "Answer with the decisions tool (action answer). If only the owner can settle it, escalate it to them (action escalate).",
          `If you don't answer within ${CEO_HANDOVER_MINUTES} minutes it goes to the owner, marked as tried by you first.`,
        ].join("\n").slice(0, 4000),
      });
    else if (row && tier === "ceo") await tellCeo(runner.companyId, row.question, forAgentId ?? undefined);
    return { outcome: tier, rule: "Plans are approved before work starts", decisionId: row?.id ?? null };
  }

  return {
    /** Called for every permission request a runner reports. */
    async onPermissionRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
      // An agent asking to leave plan mode is presenting its plan for approval (R40).
      if (event.kind === "switch_mode") {
        const [r] = await db.select({ purpose: runs.purpose }).from(runs).where(eq(runs.id, event.runId));
        if (r?.purpose !== "chat") return planRequest(runner, event);
      }
      const info: PermissionInfo = { title: event.title, kind: event.kind, rawInput: event.rawInput };
      // The owner chat may use Boss Man's own (board) tools and nothing else.
      const [asking] = await db.select({ purpose: runs.purpose }).from(runs).where(eq(runs.id, event.runId));
      const { outcome, rule } =
        asking?.purpose === "chat"
          ? BOSSMAN_TOOL.test(event.title ?? "")
            ? { outcome: "allow" as const, rule: "The owner chat's board tools" }
            : { outcome: "deny" as const, rule: "The owner chat has board tools only" }
          : evaluatePermission(info, await rulesFor(runner.companyId));
      if (outcome === "allow" || outcome === "deny") {
        if (send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: outcome })) return { outcome, rule, decisionId: null };
        // The runner dropped off between sending the request and getting the verdict. The event
        // won't be applied again when it's resent, so keep the verdict as an answered row that
        // goes out when the runner reconnects, like an owner's answer would (R22).
        const [row] = await db
          .insert(decisions)
          .values({
            companyId: runner.companyId,
            kind: "permission",
            question: `Policy ${outcome === "allow" ? "allowed" : "denied"}: ${typeof (event.rawInput as { command?: unknown } | null)?.command === "string" ? (event.rawInput as { command: string }).command : (event.title ?? "a tool")}`,
            options: [ALLOW, DENY],
            recommendedOption: outcome === "allow" ? ALLOW : DENY,
            status: "answered",
            answer: outcome === "allow" ? ALLOW : DENY,
            answeredAt: now(),
            tier: "ceo",
            dedupeKey: `permission:${event.requestId}`,
            context: { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, rule, delivered: false },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        return { outcome, rule, decisionId: row?.id ?? null };
      }
      const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
      const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
      const explain = explainPermission(info, agent?.name ?? "An agent");
      // A CEO never approves its own request: those go to the owner.
      let tier = outcome === "ceo" && agent?.role === "ceo" ? "owner" : outcome;
      // Any request the rules send to the CEO waits with the CEO on the alert ladder (BOS-119), so it
      // stays off the owner's queue and notifications and moves to the owner if the CEO doesn't settle
      // it in time or escalates it. Permission requests get a short handover: the runner denies at 10 minutes.
      let ladder: Ladder | undefined;
      let ceoId: string | undefined;
      // Deletes in the working copy (BOS-120) go the same way, but only when the run has a checkout.
      // Paths are relative to where the shell starts, and the runner doesn't say where that is, so
      // two things must hold. The runner reported (run.workspace) that it started this run in its
      // ticket's own worktree, and that record gives the branch; a review copy or a run with no
      // worktree sends none. And the tool input has only Claude Code's Bash keys: an allow-list,
      // because any other key (opencode's workdir, codex's cwd, one we don't know) could point the
      // command somewhere else (BOS-120 adversarial review).
      let workingCopy: WorkingCopy | undefined;
      if (tier === "ceo" && rule === WORKING_COPY_RULE) {
        const raw = (event.rawInput ?? {}) as Record<string, unknown>;
        const files = Object.keys(raw).every((k) => SHELL_INPUT_KEYS.has(k)) ? (cleanupScope(typeof raw["command"] === "string" ? raw["command"] : "")?.workingCopy ?? []) : [];
        const [ws] = run?.ticketId && files.length
          ? await db.select({ payload: runnerEvents.payload }).from(runnerEvents).where(and(eq(runnerEvents.runnerId, runner.id), eq(runnerEvents.type, "run.workspace"), sql`(${runnerEvents.payload}->>'runId') = ${event.runId}`, sql`(${runnerEvents.payload}->>'ticketId') = ${run.ticketId}`)).orderBy(desc(runnerEvents.seq)).limit(1)
          : [];
        const branch = (ws?.payload as { branch?: unknown } | undefined)?.branch;
        const [t] = ws && typeof branch === "string"
          ? await db.select({ number: tickets.number, prefix: companies.ticketPrefix, repoUrl: projects.repoUrl }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).innerJoin(companies, eq(companies.id, tickets.companyId)).where(and(eq(tickets.id, run!.ticketId!), eq(tickets.companyId, runner.companyId)))
          : [];
        if (t?.repoUrl && typeof branch === "string") workingCopy = { ticketId: run!.ticketId!, ref: ticketRef(t.prefix, t.number), branch, files };
        else tier = "owner";
      }
      if (tier === "ceo") {
        const [ceo] = await db.select({ id: agents.id, paused: agents.paused }).from(agents).where(and(eq(agents.companyId, runner.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
        if (ceo && !ceo.paused) {
          ceoId = ceo.id;
          const since = now().toISOString();
          const why = workingCopy ? "deletes in the agent's working copy go to the CEO first" : rule === TEMP_CLEANUP_RULE ? "temp-file cleanup goes to the CEO first" : `the rule "${rule}" sends it to the CEO`;
          ladder = { rung: "ceo", since, minutes: CEO_HANDOVER_MINUTES, ticketId: run?.ticketId ?? null, about: run?.agentId ? [run.agentId] : [], hops: [{ to: "ceo", at: since, why }] };
        } else tier = "owner";
      }
      // Standing rules are the owner's call, never an agent's.
      const always = tier === "owner" ? alwaysChoices(info, explain) : [];
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, explain, ...(always.length ? { always } : {}) };
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: runner.companyId,
          kind: "permission",
          // Which checkout and which files, on every card the CEO or the owner sees (BOS-120).
          question: `${explain.title}. ${explain.summary}${workingCopy ? ` In ${agent?.name ?? "the agent"}'s working copy for ${workingCopy.ref ?? "its ticket"} (branch ${workingCopy.branch}): ${fileList(workingCopy.files, 400)}.` : ""}`,
          options: [ALLOW, ...always.map((a) => a.label), DENY],
          // The same allow-list as everywhere else: build output is Allow, source or anything else is
          // Deny, so the CEO is never handed a pre-selected Allow for rm -rf src (adversarial review).
          recommendedOption: recommendedVerdict(info) === "allow" ? ALLOW : DENY,
          raisedByAgentId: run?.agentId ?? null,
          tier,
          dedupeKey: `permission:${event.requestId}`,
          // workingCopy stays when it falls to the owner (CEO paused), so the card and the audit still say so.
          context: { ...context, rule, ...(workingCopy ? { workingCopy } : {}), ...(ladder ? { ...(rule === TEMP_CLEANUP_RULE ? { tempCleanup: true } : {}), ladder } : {}) },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id, question: decisions.question });
      if (row && ceoId && wake) {
        // High priority, like an alert: the agent is waiting, and the runner gives up at 10 minutes.
        await wake({
          agentId: ceoId,
          reason: "decision",
          priority: 3,
          note: [
            `A permission request is waiting for you (decision ${row.id}): ${row.question}`,
            `Command: ${explain.command ?? ""}`,
            ...(workingCopy
              ? [
                  `Its deletes are plain relative paths in ${agent?.name ?? "the agent"}'s working copy for ${workingCopy.ref ?? "its ticket"} (branch ${workingCopy.branch}): ${fileList(workingCopy.files, 1000)}. It has no cd. Any other deletes are of entries directly in /tmp, and everything else in it is on Boss Man's short list of commands, so it came to you rather than the owner.`,
                  "Boss Man can't see the runner's files: if a folder on one of those paths is a symlink, the delete follows it out of the checkout. It recommends Allow only for build output (dist, node_modules and the like). Allow it when the paths are the agent's own throwaway files (a probe or test file it made, build output such as dist or node_modules) and its ticket explains them.",
                  "Deny it, or escalate it to the owner (decisions tool, action escalate), if it deletes source folders or files the ticket doesn't account for, or anything you can't explain.",
                ]
              : rule === TEMP_CLEANUP_RULE
                ? [
                    "Its only deletes are of entries directly in /tmp, and everything else in it is on Boss Man's short list of commands, so it came to you rather than the owner. Any folder it writes into in /tmp is one the same command deleted first, so it can't be a shortcut link to somewhere else.",
                    "Two exceptions on that list reach outside /tmp. git worktree add writes into the project's repository (.git) and creates its -b branch there: check the branch name is the asking agent's own. pnpm or npm install runs the project's own install scripts, which can do anything: check that the folder is a checkout of the asking agent's own ticket branch.",
                    "Allow it when the rest of the command looks like the agent's own work. Deny it, or escalate it to the owner (decisions tool, action escalate), if anything in it reaches outside /tmp, pushes, or you can't account for it.",
                  ]
                : [
                    "A company rule sends it to you rather than the owner. Allow it if you can vouch for it, or deny it if not; if only the owner can settle it (a secret, host access, sign-off, an owner-only choice), escalate it to them (decisions tool, action escalate).",
                  ]),
            "Answer with the decisions tool (action answer) and give a note saying why: the owner reads it.",
            `If you don't answer within ${CEO_HANDOVER_MINUTES} minutes it goes to the owner, marked as tried by you first.`,
          ].join("\n").slice(0, 4000),
        });
      } else if (row && tier === "ceo") await tellCeo(runner.companyId, row.question);
      return { outcome, rule, decisionId: row?.id ?? null };
    },

    async raise(input: { companyId: string; agentId: string | null; question: string; options: string[]; recommended: string; blocksTicketId?: string; triedFirst?: string; steps?: string[] }) {
      const raised = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(decisions)
          .values({
            companyId: input.companyId,
            kind: "question",
            question: input.question,
            options: input.options,
            recommendedOption: input.recommended,
            raisedByAgentId: input.agentId,
            context: { type: "question", ...(input.triedFirst ? { triedFirst: input.triedFirst } : {}), ...(input.steps?.length ? { steps: input.steps } : {}) },
          })
          .returning();
        if (input.blocksTicketId) {
          await tx.insert(ticketDependencies).values({ blockedTicketId: input.blocksTicketId, blockerDecisionId: row!.id });
          await tx.update(tickets).set({ systemState: "blocked", lastActivityAt: new Date() }).where(eq(tickets.id, input.blocksTicketId));
        }
        return row!;
      });
      await record(db, { companyId: input.companyId, agentId: input.agentId, ticketId: input.blocksTicketId, kind: "decision_raised", summary: `Asked the owner: ${input.question}`, at: now() });
      return raised;
    },

    /** Re-sends permission verdicts that couldn't be delivered, once the runner is back. */
    async redeliver(runnerId: string) {
      const answered = await db.select().from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "answered")));
      let sent = 0;
      for (const d of answered) {
        const ctx = d.context as Extract<DecisionContext, { type: "permission" }> & { delivered?: boolean | "run_ended" };
        if (ctx.delivered !== false || ctx.runnerId !== runnerId) continue;
        const [run] = await db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, ctx.runId));
        const ok = !run?.endedAt && send(runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: d.answer === ALLOW || d.answer === APPROVE_PLAN ? "allow" : "deny" });
        // Delivered, or the run is gone and there's nothing left to deliver to.
        if (ok || run?.endedAt || !run) {
          await db.update(decisions).set({ context: { ...ctx, delivered: ok ? true : "run_ended" } }).where(eq(decisions.id, d.id));
          if (ok) sent++;
        }
      }
      return sent;
    },

    /**
     * Answers again the permission requests a reconnecting runner is still waiting on. A verdict
     * can be lost if the socket drops just after it is sent; the runner would then wait until
     * its timeout. Answered decisions are re-sent; requests the policy decided are decided again
     * from the stored request (the policy is deterministic). Open decisions keep waiting, and
     * requests not stored yet are decided when the runner replays them.
     */
    async resume(runner: { id: string; companyId: string }, pending: Array<{ runId: string; requestId: string }>) {
      let resent = 0;
      for (const p of pending.slice(0, 500)) {
        const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${p.requestId}`));
        if (d) {
          const ctx = d.context as Extract<DecisionContext, { type: "permission" }>;
          if (d.status !== "answered" || ctx.runnerId !== runner.id || ctx.runId !== p.runId) continue;
          if (send(runner.id, { type: "permission.decide", runId: p.runId, requestId: p.requestId, verdict: d.answer === ALLOW || d.answer === APPROVE_PLAN ? "allow" : "deny" })) resent++;
          continue;
        }
        const [ev] = await db
          .select({ payload: runnerEvents.payload })
          .from(runnerEvents)
          .where(and(eq(runnerEvents.runnerId, runner.id), eq(runnerEvents.type, "run.permission_request"), sql`${runnerEvents.payload}->>'requestId' = ${p.requestId}`, sql`${runnerEvents.payload}->>'runId' = ${p.runId}`))
          .limit(1);
        if (!ev) continue;
        const r = await this.onPermissionRequest(runner, ev.payload as PermissionEvent);
        if (r && (r.outcome === "allow" || r.outcome === "deny")) resent++;
      }
      return resent;
    },

    /** Moves a blocked ticket to ready once nothing blocks it, and wakes its assignee. */
    release: (ticketId: string) => releaseIfFree(ticketId),

    setEngagementHook(hook: EngagementHook) {
      onEngagement = hook;
    },

    setDeployHook(hook: DeployHook) {
      onDeploy = hook;
    },

    setSelfDeployHook(hook: SelfDeployHook) {
      selfDeploy = hook;
    },

    setMaintenanceHook(hook: MaintenanceHook) {
      maintenance = hook;
    },

    setRetroHook(hook: RetroHook) {
      retroHook = hook;
    },

    setAgentHook(hook: AgentDecisionHook) {
      onAgentDecision = hook;
    },

    setTeamPlanHook(hook: TeamPlanHook) {
      onTeamPlan = hook;
    },

    setLoopHooks(hooks: LoopHooks) {
      loopHooks = hooks;
    },

    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    /** How "Cancel run" stops a run: the runs service, which ends the run itself when the runner can't. */
    setCancelHook(hook: (runId: string) => Promise<{ endedHere?: boolean }>) {
      cancelRun = hook;
    },

    async listOpen() {
      return db.select().from(decisions).where(eq(decisions.status, "open")).orderBy(asc(decisions.createdAt));
    },

    /** Boss Man's alerts the team is still handling (BOS-64), for the owner's collapsed "being handled" line. */
    async withTeam() {
      const rows = await db
        .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context, holder: agents.name })
        .from(decisions)
        .leftJoin(agents, eq(agents.id, decisions.forAgentId))
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->'ladder'->>'rung' in ('scrum_master', 'ceo')`))
        .orderBy(asc(decisions.createdAt));
      return rows.map((r) => {
        const l = (r.context as { ladder: { rung: string; since: string } }).ladder;
        return { id: r.id, companyId: r.companyId, question: r.question.split("\n")[0]!.slice(0, 300), holder: l.rung === "ceo" ? "the CEO" : (r.holder ?? "the Scrum Master"), since: l.since };
      });
    },

    /**
     * The owner's queue (R20): every open decision with what it holds up, down the chain,
     * ranked by an explainable score.
     */
    async queue() {
      const t = now();
      const open = await db
        .select({ d: decisions, companyName: companies.name, agentName: agents.name })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
        // Boss Man's alerts still with the Scrum Master or the CEO aren't the owner's yet (BOS-64); withTeam lists them.
        .where(and(eq(decisions.status, "open"), sql`coalesce(${decisions.context}->'ladder'->>'rung', 'owner') = 'owner'`, sql`coalesce(${decisions.context}->>'type', '') not in ('lesson', 'lesson_replace')`));
      if (!open.length) return [];
      const forIds = [...new Set(open.map((o) => o.d.forAgentId).filter((x): x is string => !!x))];
      const forNames = new Map(forIds.length ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, forIds))).map((a) => [a.id, a.name]) : []);

      // Open work, with the most important objective it serves and its effective due date.
      const work = await db
        .select({
          id: tickets.id,
          title: tickets.title,
          number: tickets.number,
          prefix: companies.ticketPrefix,
          dueDate: tickets.dueDate,
          milestoneTarget: milestones.targetDate,
          krPriority: objectives.priority,
          milestoneObjectiveId: milestones.objectiveId,
        })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
        .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
        .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
        .where(ne(tickets.systemState, "done"));
      const msObjectives = [...new Set(work.map((w) => w.milestoneObjectiveId).filter((x): x is string => !!x))];
      const msPriority = new Map(
        msObjectives.length ? (await db.select({ id: objectives.id, p: objectives.priority }).from(objectives).where(inArray(objectives.id, msObjectives))).map((o) => [o.id, o.p]) : [],
      );
      const info = new Map(
        work.map((w) => {
          const ps = [w.krPriority, w.milestoneObjectiveId ? msPriority.get(w.milestoneObjectiveId) : undefined].filter((p): p is number => p != null);
          return [w.id, { title: w.title, ref: ticketRef(w.prefix, w.number), dueDate: effectiveDueDate(w.dueDate, w.milestoneTarget), objectivePriority: ps.length ? Math.min(...ps) : null }];
        }),
      );
      const deps = await db.select().from(ticketDependencies);
      const dependents = new Map<string, string[]>();
      for (const dep of deps) {
        if (!dep.blockerTicketId) continue;
        dependents.set(dep.blockerTicketId, [...(dependents.get(dep.blockerTicketId) ?? []), dep.blockedTicketId]);
      }

      // Tickets a decision holds up directly, by kind.
      const runIds = open.flatMap(({ d }) => {
        const c = d.context as DecisionContext;
        return c.type === "permission" || c.type === "stalled_run" ? [c.runId] : [];
      });
      const runTickets = new Map(runIds.length ? (await db.select({ id: runs.id, ticketId: runs.ticketId }).from(runs).where(inArray(runs.id, runIds))).map((r) => [r.id, r.ticketId]) : []);
      const deployIds = open.flatMap(({ d }) => ((d.context as DecisionContext).type === "deploy" ? [(d.context as { deployId: string }).deployId] : []));
      const deployTickets = new Map(
        deployIds.length ? (await db.select({ id: deploys.id, ticketId: deploys.ticketId }).from(deploys).where(inArray(deploys.id, deployIds))).map((r) => [r.id, r.ticketId]) : [],
      );
      const direct = (d: typeof decisions.$inferSelect): string[] => {
        const c = d.context as DecisionContext;
        switch (c.type) {
          case "permission":
          case "stalled_run": {
            const id = runTickets.get(c.runId);
            return id ? [id] : [];
          }
          case "stale_blocker":
            return [c.blockedTicketId];
          // An approved ticket that can't merge holds that ticket up, and whatever waits on it.
          case "check_stuck":
            return [c.ticketId];
          case "deploy": {
            const id = deployTickets.get(c.deployId);
            return id ? [id] : [];
          }
          case "engagement":
            return deps.filter((x) => x.blockerEngagementId === c.engagementId).map((x) => x.blockedTicketId);
          default:
            return deps.filter((x) => x.blockerDecisionId === d.id).map((x) => x.blockedTicketId);
        }
      };

      // The ticket a card is about: what it holds up, plus the ticket named in its context (which may be done, or hold nothing up).
      const aboutIds = (d: typeof decisions.$inferSelect): string[] => {
        const c = d.context as DecisionContext;
        const own = (c as { ticketId?: unknown }).ticketId;
        // A hire lists the tickets that wait for the new agent.
        const hireFor = c.type === "hire" ? (c.proposal.forTickets ?? []).filter((id) => UUID.test(id)) : [];
        return [...new Set([...direct(d), ...(typeof own === "string" ? [own] : []), ...hireFor])];
      };
      const wantedAbout = [...new Set(open.flatMap(({ d }) => aboutIds(d)))];
      const aboutRows = wantedAbout.length
        ? await db
            .select({ id: tickets.id, title: tickets.title, number: tickets.number, companyId: tickets.companyId, prefix: companies.ticketPrefix })
            .from(tickets)
            .innerJoin(companies, eq(companies.id, tickets.companyId))
            .where(inArray(tickets.id, wantedAbout))
        : [];
      const aboutInfo = new Map(aboutRows.map((r) => [r.id, r]));

      const rows = open.map(({ d, companyName, agentName }) => {
        // Walk down the chain, nearest first; each ticket counts once.
        const chain: Array<BlockedTicket & { ticketId: string; title: string; ref: string | null }> = [];
        const seen = new Set<string>();
        let frontier = direct(d).filter((id) => info.has(id));
        for (let depth = 1; frontier.length && depth <= 10; depth++) {
          const next: string[] = [];
          for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            const i = info.get(id);
            if (!i) continue;
            chain.push({ ticketId: id, title: i.title, ref: i.ref, depth, dueDate: i.dueDate, objectivePriority: i.objectivePriority });
            next.push(...(dependents.get(id) ?? []));
          }
          frontier = next;
        }
        const rank = rankDecision({ createdAt: d.createdAt, blocked: chain, holdsLiveRun: d.kind === "permission" }, t);
        const about = aboutIds(d).flatMap((id) => { const r = aboutInfo.get(id); return r && r.companyId === d.companyId ? [{ ticketId: id, title: r.title, ref: ticketRef(r.prefix, r.number) }] : []; });
        return { ...d, companyName, agentName, forAgentName: d.forAgentId ? (forNames.get(d.forAgentId) ?? null) : null, blocks: chain, about, ...rank };
      });
      const refs = await resolveRefs(db, open.map(({ d }) => ({ id: d.id, companyId: d.companyId, text: cardText(d) })));
      const sorted = rows.sort((a, b) => b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime());
      return Promise.all(
        sorted.map(async (r) => {
          const withRefs = { ...r, refs: refs.get(r.id) ?? {} };
          return (r.context as DecisionContext).type === "stalled_run" ? { ...withRefs, evidence: await stallEvidence((r.context as { runId: string }).runId) } : withRefs;
        }),
      );
    },

    /** The owner asks the CEO for advice on an open decision. It stays open and answerable. Returns null if it isn't open. */
    async askAdvice(id: string, note?: string) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      // Pressing twice is harmless.
      if (adviceOf(d.context)?.state === "asking") return { id, advice: adviceOf(d.context)! };
      if (d.kind === "permission") throw new AnswerError("A permission request holds a live run, so it can't be put to the CEO. Answer it, or deny it.");
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (!ceo || !wake) throw new AnswerError("This company has no CEO to ask.");
      const advice: Advice = { state: "asking", askedAt: now().toISOString(), ...(note ? { note } : {}), ...(adviceOf(d.context)?.originalQuestion ? { originalQuestion: adviceOf(d.context)!.originalQuestion } : {}) };
      const [claimed] = await db
        .update(decisions)
        .set({ context: sql`jsonb_set(${decisions.context}, '{advice}', ${JSON.stringify(advice)}::jsonb)` })
        .where(and(eq(decisions.id, id), eq(decisions.status, "open"), sql`coalesce(${decisions.context}->'advice'->>'state', '') <> 'asking'`))
        .returning({ id: decisions.id });
      if (!claimed) return null;
      const ctx = d.context as DecisionContext;
      const [held] = await db
        .select({ ticketId: tickets.id, title: tickets.title })
        .from(ticketDependencies)
        .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
        .where(eq(ticketDependencies.blockerDecisionId, id));
      const lines = [
        "The owner asked for your advice on a decision that arrived without enough detail. It stays open and the owner can still answer it.",
        `Decision ${d.id}: ${d.question}`,
        `Options: ${(d.options as string[]).join(" | ") || "none"} (recommended: ${d.recommendedOption})`,
        ...(ctx.type === "question" && ctx.triedFirst ? [`What was tried first: ${ctx.triedFirst}`] : []),
        ...(ctx.type === "question" && ctx.steps?.length ? [`Steps given: ${ctx.steps.join(" / ")}`] : []),
        ...(held ? [`It holds up the ticket "${held.title}" (${held.ticketId}).`] : []),
        note ? `What's unclear, in the owner's words: ${note}` : "The owner didn't say what is unclear.",
        "Use the decisions tool, action advise. outcome reissue: post a clearer replacement (question, options, recommended, triedFirst, and numbered steps when the owner must act). outcome handled: only if the team can settle it without a secret, host step, sign-off or owner-only choice. If it needs the owner, use reissue: a plain question is replaced by a clearer one; any other kind is rewritten in place (new question, triedFirst, steps; options stay). Do this within the time limit or it returns to the owner as it was.",
      ];
      await wake({ agentId: ceo.id, reason: "decision", note: lines.join("\n").slice(0, 4000) });
      await record(db, { companyId: d.companyId, ticketId: held?.ticketId, kind: "decision_advice_asked", summary: `Owner asked the CEO for advice on "${d.question}"${note ? `: ${note}` : ""}`, at: now() });
      return { id, advice };
    },

    /**
     * The CEO's answer to an advice request. "reissue" posts a clearer replacement, moves what the original
     * blocked onto it and closes the original without an answer; "handled" settles it (never an owner-only kind).
     * Returns null when the owner answered first.
     */
    async advise(input: { id: string; companyId: string; agentId: string | null; outcome: "reissue"; runId?: string; question: string; options: string[]; recommended: string; triedFirst: string; steps?: string[] } | { id: string; companyId: string; agentId: string | null; outcome: "handled"; runId?: string; summary: string; answer?: string }) {
      const via = input.runId ? ` (CEO run ${input.runId})` : "";
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, input.id), eq(decisions.companyId, input.companyId)));
      if (!d) throw new AnswerError("No decision with that id.");
      if (d.status !== "open") return null;
      const advice = adviceOf(d.context);
      if (advice?.state !== "asking") throw new AnswerError(advice?.state === "timed_out" ? "The time ran out and the decision went back to the owner." : "The owner hasn't asked for advice on this decision.");
      const at = now().toISOString();
      if (input.outcome === "reissue") {
        const ctx = d.context as DecisionContext;
        const asking = sql`${decisions.context}->'advice'->>'state' = 'asking'`;
        if (!(d.kind === "question" && ctx.type === "question")) {
          // An approval, plan, hire, deploy and the like keep their id, kind, options and context, so what resumes on
          // them still works: the CEO only rewrites the question and adds what was tried and the steps.
          const clarified = { ...(d.context as object), triedFirst: input.triedFirst.trim(), ...(input.steps?.length ? { steps: input.steps } : {}), advice: { ...advice, state: "clarified", at, originalQuestion: advice.originalQuestion ?? d.question } };
          const [done] = await db
            .update(decisions)
            .set({ question: input.question, context: clarified })
            .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), asking))
            .returning({ id: decisions.id });
          if (!done) return null;
          const [held] = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
          await record(db, { companyId: d.companyId, agentId: input.agentId, ticketId: held?.ticketId, kind: "decision_reissued", summary: `CEO rewrote "${d.question}" with more detail${via}`, at: now() });
          return { outcome: "reissue" as const, id: d.id, inPlace: true };
        }
        if (!input.options.includes(input.recommended)) throw new AnswerError("The recommended answer must be one of the options.");
        const newId = randomUUID();
        const made = await db.transaction(async (tx) => {
          const [claimed] = await tx
            .update(decisions)
            .set({ status: "withdrawn", answeredAt: now(), dedupeKey: null, context: { ...(d.context as object), advice: { ...advice, state: "reissued", at, replacedBy: newId } } })
            .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), asking))
            .returning({ id: decisions.id });
          if (!claimed) return false;
          await tx.insert(decisions).values({
            id: newId,
            companyId: d.companyId,
            kind: "question",
            question: input.question,
            options: input.options,
            recommendedOption: input.recommended,
            raisedByAgentId: d.raisedByAgentId,
            // The card says the CEO wrote it and points back at the original (advice.replaces).
            context: { type: "question", triedFirst: input.triedFirst.trim(), ...(input.steps?.length ? { steps: input.steps } : {}), advice: { state: "replacement", replaces: d.id, at } satisfies Advice },
          });
          await tx.update(ticketDependencies).set({ blockerDecisionId: newId }).where(eq(ticketDependencies.blockerDecisionId, d.id));
          return true;
        });
        if (!made) return null;
        const [held] = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, newId));
        await record(db, { companyId: d.companyId, agentId: input.agentId, ticketId: held?.ticketId, kind: "decision_reissued", summary: `CEO reissued "${d.question}" with more detail${via}`, at: now() });
        return { outcome: "reissue" as const, id: newId, inPlace: false };
      }
      const raiser = d.raisedByAgentId ? (await db.select({ role: agents.role }).from(agents).where(eq(agents.id, d.raisedByAgentId)))[0] : undefined;
      if (!ceoCanHandle(d, raiser?.role === "ceo" || d.raisedByAgentId === input.agentId)) throw new AnswerError("Only the owner can settle this one: only an agent's plain question can be handled by the CEO, never the CEO's own request, an approval, a permission, or anything with steps for the owner. Rewrite it with reissue instead, or leave it for the owner.");
      const summary = input.summary.trim();
      const options = d.options as string[];
      let r;
      const handled = { summary, at };
      if (!input.answer) {
        // The work settles it and no option says so: a written answer, like the owner's own words.
        r = await this.answer(d.id, `Handled by the CEO: ${summary}`.slice(0, 4000), { custom: true, by: "ceo", handled });
      } else {
        if (!options.includes(input.answer)) throw new AnswerError(`Give answer: one of ${options.join(", ")}.`);
        r = await this.answer(d.id, input.answer, { by: "ceo", handled });
      }
      if (!r) return null;
      await record(db, { companyId: d.companyId, agentId: input.agentId, kind: "decision_handled", summary: `CEO handled "${d.question}": ${summary}${via}`, at: now() });
      return { outcome: "handled" as const, id: d.id };
    },

    /** Decisions the CEO didn't act on in time go back to normal for the owner. Returns how many. */
    async expireAdvice() {
      const t = now();
      const asking = await db
        .select({ d: decisions, minutes: companies.adviceTimeoutMinutes })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->'advice'->>'state' = 'asking'`));
      let expired = 0;
      for (const { d, minutes } of asking) {
        const advice = adviceOf(d.context)!;
        if (new Date(advice.askedAt ?? 0).getTime() + (minutes ?? ADVICE_DEFAULT_MINUTES) * 60_000 > t.getTime()) continue;
        const [done] = await db
          .update(decisions)
          .set({ context: sql`jsonb_set(${decisions.context}, '{advice}', ${JSON.stringify({ ...advice, state: "timed_out", at: t.toISOString() })}::jsonb)` })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), sql`${decisions.context}->'advice'->>'state' = 'asking'`))
          .returning({ id: decisions.id });
        if (!done) continue;
        expired++;
        await record(db, { companyId: d.companyId, kind: "decision_advice_timed_out", summary: `The CEO didn't respond to the request for advice on "${d.question}"; it is back with the owner`, at: t });
      }
      return expired;
    },

    /** Decisions the CEO settled or replaced in the last day, so the owner can see where they went. */
    async recentlyAdvised() {
      const since = new Date(now().getTime() - 24 * 3_600_000);
      const rows = await db
        .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context })
        .from(decisions)
        .where(and(ne(decisions.status, "open"), sql`${decisions.context}->'advice'->>'state' in ('reissued', 'handled')`, sql`(${decisions.context}->'advice'->>'at')::timestamptz > ${since.toISOString()}::timestamptz`))
        .orderBy(desc(decisions.createdAt))
        .limit(20);
      // Anything the CEO or a plan approver settled with the decisions tool, whatever its kind (BOS-111, BOS-119).
      const permissions = await db
        .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context, answer: decisions.answer })
        .from(decisions)
        .where(and(eq(decisions.status, "answered"), sql`${decisions.context}->'settled' is not null`, sql`${decisions.answeredAt} > ${since.toISOString()}::timestamptz`))
        .orderBy(desc(decisions.answeredAt))
        .limit(50);
      // Alerts the Scrum Master settled from the watchdog tool: alert_resolved records who and why (BOS-119).
      const resolved = await db
        .select({ reason: watchdogActions.reason, actorAgentId: watchdogActions.actorAgentId, after: watchdogActions.after, createdAt: watchdogActions.createdAt })
        .from(watchdogActions)
        .where(and(eq(watchdogActions.kind, "alert_resolved"), sql`${watchdogActions.createdAt} > ${since.toISOString()}::timestamptz`))
        .orderBy(desc(watchdogActions.createdAt))
        .limit(50);
      const resolvedIds = [...new Set(resolved.map((r) => (r.after as { decisionId?: string } | null)?.decisionId).filter((x): x is string => !!x))];
      const resolvedRows = resolvedIds.length ? await db.select().from(decisions).where(inArray(decisions.id, resolvedIds)) : [];
      const resolvedById = new Map(resolvedRows.map((d) => [d.id, d]));
      const actorIds = [...new Set(resolved.map((r) => r.actorAgentId).filter((x): x is string => !!x))];
      const actorNames = new Map(actorIds.length ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, actorIds))).map((a) => [a.id, a.name]) : []);
      // The ticket each card was about: the one in its context, or else the one its run was working on.
      const runIds = [...new Set([...rows, ...permissions, ...resolvedRows].flatMap((r) => { const c = r.context as { ticketId?: unknown; runId?: unknown }; return typeof c.ticketId !== "string" && typeof c.runId === "string" ? [c.runId] : []; }))];
      const runTicket = new Map(runIds.length ? (await db.select({ id: runs.id, ticketId: runs.ticketId }).from(runs).where(inArray(runs.id, runIds))).map((r) => [r.id, r.ticketId]) : []);
      const ticketIdOf = (c: unknown) => { const x = c as { ticketId?: unknown; runId?: unknown }; return typeof x.ticketId === "string" ? x.ticketId : typeof x.runId === "string" ? (runTicket.get(x.runId) ?? null) : null; };
      const ticketIds = [...new Set([...rows, ...permissions, ...resolvedRows].flatMap((r) => ticketIdOf(r.context) ?? []))];
      const found = ticketIds.length
        ? await db.select({ id: tickets.id, title: tickets.title, number: tickets.number, companyId: tickets.companyId, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ticketIds))
        : [];
      const aboutOf = (r: { companyId: string; context: unknown }) => {
        const id = ticketIdOf(r.context);
        const t = found.find((f) => f.id === id);
        return t && t.companyId === r.companyId ? [{ ticketId: t.id, title: t.title, ref: ticketRef(t.prefix, t.number) }] : [];
      };
      const alreadyListed = new Set(permissions.map((r) => r.id));
      const fromAlerts = resolved.flatMap((r) => {
        const id = (r.after as { decisionId?: string } | null)?.decisionId;
        const d = id ? resolvedById.get(id) : undefined;
        if (!id || !d || alreadyListed.has(id)) return [];
        return [{ id, companyId: d.companyId, question: d.question.split("\n")[0]!.slice(0, 300), about: aboutOf(d), settled: { by: (r.actorAgentId && actorNames.get(r.actorAgentId)) || "the team", answer: d.answer ?? "Settled", note: r.reason, command: null, tempCleanup: false } }];
      });
      return [
        ...rows.map((r) => ({ id: r.id, companyId: r.companyId, question: r.question.split("\n")[0]!.slice(0, 300), advice: adviceOf(r.context)!, about: aboutOf(r) })),
        ...permissions.map((r) => {
          const ctx = r.context as Extract<DecisionContext, { type: "permission" }>;
          return { id: r.id, companyId: r.companyId, question: r.question.split("\n")[0]!.slice(0, 300), about: aboutOf(r), settled: { by: ctx.settled?.name ?? "the team", answer: r.answer ?? "", note: ctx.settled?.note ?? null, command: ctx.explain?.command?.slice(0, 500) ?? null, tempCleanup: ctx.tempCleanup === true, ...(ctx.workingCopy ? { workingCopy: true } : {}) } };
        }),
        ...fromAlerts,
      ];
    },

    /** Records the answer and resumes what was waiting. Returns null if not open. */
    async answer(id: string, answer: string, extra: AnswerExtra = {}) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      const options = d.options as string[];
      // A drop-one decision also takes the short form "Replace #12" for its numbered option.
      const short = /^Replace #(\d+)$/.exec(answer.trim());
      if (short && (d.context as DecisionContext).type === "lesson_replace") answer = options.find((o) => o.startsWith(`Replace #${short[1]}: `)) ?? answer;
      // An agent's question can be answered in the owner's own words; anything that acts on the
      // answer (a permission, a deploy, a budget) keeps to its options.
      const ownWords = extra.custom === true && d.kind === "question";
      if (extra.custom && !ownWords) throw new AnswerError("This decision needs one of its options; only an agent's question takes your own answer.");
      if (options.length > 0 && !ownWords && !options.includes(answer)) throw new AnswerError(`Answer must be one of: ${options.join(", ")}`);
      await validate(d, answer, extra);
      const ctx = d.context as DecisionContext;
      if (ctx.type === "team_plan" && extra.picks?.some((i) => !Number.isInteger(i) || i < 0 || i >= ctx.hires.length)) throw new AnswerError("That hire isn't in the plan.");
      // "Allow always" answers this request and adds a rule after the company's own rules, so an owner's deny still wins.
      const always = ctx.type === "permission" ? ctx.always?.find((a) => a.label === answer) : undefined;
      if (always) {
        const [last] = await db.select({ position: policyRules.position }).from(policyRules).where(and(eq(policyRules.trigger, "permission"), eq(policyRules.companyId, d.companyId))).orderBy(desc(policyRules.position)).limit(1);
        const on = now().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        await db.insert(policyRules).values({ companyId: d.companyId, name: `${always.name} (from a request on ${on})`, trigger: "permission", condition: always.match, outcome: "allow", position: (last?.position ?? -1) + 1 });
        answer = ALLOW;
      }
      if (ctx.type === "rule_proposal" && answer === ADD_RULE && !extra.custom) await policyRulesService(db).create({ companyId: d.companyId, ...ctx.rule });
      // Kept on the decision so the owner can see who settled it and why (BOS-111). ctx is the same object, so later context writes keep it.
      let settled: Settled | undefined;
      if (extra.settledBy) {
        const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, extra.settledBy.agentId));
        settled = { agentId: extra.settledBy.agentId, name: who?.name ?? "the CEO", note: extra.note?.trim().replace(/\s+/g, " ").slice(0, 500) || null, at: now().toISOString() };
        (ctx as { settled?: Settled }).settled = settled;
      }
      // Conditional on still being open (and, for the CEO, still asked), so whoever closes it first wins and the loser changes nothing.
      const [closed] = await db
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again; so does a
        // loop alert (alert-ladder.ts), whose key only stops a repeat while it is open.
        .set({
          status: "answered",
          answer,
          answeredAt: now(),
          ...(ctx.type === "stale_blocker" || ctx.type === "check_stuck" || d.dedupeKey?.startsWith("alert:") ? { dedupeKey: null } : {}),
          ...(extra.handled ? { context: { ...(d.context as object), advice: { ...adviceOf(d.context), state: "handled", ...extra.handled } } } : settled ? { context: ctx } : {}),
        })
        .where(and(eq(decisions.id, id), eq(decisions.status, "open"), ...(extra.by === "ceo" ? [sql`${decisions.context}->'advice'->>'state' = 'asking'`] : [])))
        .returning({ id: decisions.id });
      if (!closed) return null;

      let delivered: boolean | null = null;
      let endedHere = false;
      if (ctx.type === "permission") {
        const allowed = answer === ALLOW || answer === APPROVE_PLAN;
        if (ctx.plan && allowed && ctx.ticketId) await db.update(tickets).set({ planApprovedAt: now() }).where(eq(tickets.id, ctx.ticketId));
        if (ctx.plan && !allowed) {
          // Sent before the verdict, so the agent picks it up as its next turn and keeps planning.
          send(ctx.runnerId, {
            type: "run.message",
            runId: ctx.runId,
            text: `Your plan wasn't approved yet.${extra.note ? ` Feedback: ${extra.note}` : ""} Revise the plan and present it again with ExitPlanMode.`,
            interrupt: false,
          });
        }
        delivered = send(ctx.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: allowed ? "allow" : "deny" });
        if (!delivered) {
          // Never fail silently (R22): flag it, and re-send when the runner reconnects.
          await db.update(decisions).set({ context: { ...ctx, delivered: false } }).where(eq(decisions.id, id));
          await db
            .insert(decisions)
            .values({
              companyId: d.companyId,
              kind: "question",
              question: `Your answer "${answer}" to "${d.question}" couldn't reach the company's runner, which is offline. It will be sent when the runner reconnects. If the agent waits more than 10 minutes, the request is refused.`,
              options: ["Got it"],
              recommendedOption: "Got it",
              dedupeKey: `undelivered:${id}`,
              context: { type: "question" },
            })
            .onConflictDoNothing();
        }
        // The agent resumes now, so the wait for the owner doesn't count as a stall.
        await db.update(runs).set({ lastEventAt: now() }).where(eq(runs.id, ctx.runId));
      } else if (ctx.type === "engagement") {
        await onEngagement?.(ctx.engagementId, answer === "Approve");
      } else if (ctx.type === "deploy") {
        await onDeploy?.(ctx.deployId, answer === "Approve");
      } else if (ctx.type === "self_deploy") {
        if (ctx.infra && answer === APPROVE_HAND_APPLY) {
          // The change touches deployment files, so Boss Man can't deploy it. Approval doesn't clear it:
          // it leaves an owner to-do with the steps, the check and the rollback (BOS-122).
          await raiseOwnerTodo(db, {
            companyId: d.companyId,
            question: `"${d.question.split("\n\n")[0]}" was approved. It's waiting for you to apply it by hand on the machine that runs Boss Man.`,
            key: `owner-todo:self-deploy:${ctx.commit}`,
            steps: ctx.handSteps?.length ? ctx.handSteps : ["Apply the approved change by hand on the server that runs Boss Man."],
            check: ctx.check,
            rollback: ctx.rollback,
            ofDecisionId: id,
            raisedByAgentId: d.raisedByAgentId,
            target: ctx.target,
            commit: ctx.commit,
            fromCommit: ctx.fromCommit,
          });
        } else if (answer === DEPLOY || answer === UPDATE_RUNNERS) {
          try {
            await selfDeploy!.send(ctx, id);
          } catch (err) {
            // Nothing reached the host, so the question stays open for another try.
            await db.update(decisions).set({ status: "open", answer: null, answeredAt: null }).where(eq(decisions.id, id));
            throw new AnswerError(`The request could not be written for the host deployer: ${(err as Error).message}`);
          }
        }
      } else if (ctx.type === "owner_todo") {
        // The approved deploy's hand-apply to-do (BOS-122). Only "Done" clears it: "A step failed" means
        // the change isn't applied yet, so the card stays on the owner's queue. Keep what the owner said
        // so it shows on the card, and tell someone who can help: the agent that raised it is woken below;
        // a to-do raised by the system itself goes to the CEO.
        if (answer === TODO_FAILED) {
          const note = (extra.note ?? "").trim() || "No details given.";
          await db
            .update(decisions)
            .set({ status: "open", answer: null, answeredAt: null, context: { ...ctx, lastFailure: { note, at: now().toISOString() } } })
            .where(eq(decisions.id, id));
          if (!d.raisedByAgentId && wake) {
            const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo")));
            if (ceo) {
              await wake({
                agentId: ceo.id,
                reason: "decision",
                note: `The owner tried to apply an approved change by hand and a step failed: ${note} The "Waiting for you" card is still on their queue: "${d.question}". Work out what went wrong, fix what you can, and either tell the owner on the ticket or raise a decision with the next step.`,
              });
            }
          }
        }
      } else if (ctx.type === "maintenance") {
        await maintenance?.answered(answer);
      } else if (ctx.type === "team_plan") {
        if (answer === TEAM_HIRE) {
          await onTeamPlan?.(ctx, d.companyId, [...new Set(extra.picks ?? ctx.hires.map((_, i) => i))]);
        }
      } else if (ctx.type === "hire" || ctx.type === "instructions") {
        await onAgentDecision?.(ctx, d.companyId, answer === "Hire" || answer === "Apply the change");
      } else if (ctx.type === "review_loop" || ctx.type === "ticket_cap") {
        // Free the ticket from this decision first, so the action below sets its final state.
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === "Stop work on it") await loopHooks?.stopTicket(ctx.ticketId);
        else if (ctx.type === "review_loop") await loopHooks?.sendBack(ctx.ticketId, ctx.message, ctx.reviewer);
        else await loopHooks?.raiseCap(ctx.ticketId);
      } else if (ctx.type === "project_cap") {
        if (answer === "Raise the cap by half") {
          await db.update(projects).set({ monthlyCapMicros: sql`ceil(${projects.monthlyCapMicros} * 1.5)` }).where(eq(projects.id, ctx.projectId));
          // Work held for the cap can go again.
          await db
            .update(wakes)
            .set({ status: "queued", statusReason: null, notBefore: null })
            .where(and(eq(wakes.status, "deferred"), eq(wakes.statusReason, "project monthly cap reached"), inArray(wakes.ticketId, db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, ctx.projectId)))));
        }
      } else if (ctx.type === "risk_review") {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === APPROVE_MERGE) await loopHooks?.land(ctx.ticketId, "the owner");
        else await loopHooks?.sendBack(ctx.ticketId, `The owner sent this back.${extra.note ? ` ${extra.note}` : ""}`, "the owner");
      } else if (ctx.type === "check_stuck") {
        if (answer === CHECK_SEND_BACK) await loopHooks?.sendBack(ctx.ticketId, `The review was approved, but ${ctx.command ? `the check \`${ctx.command}\`` : "the merge"} couldn't finish, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${ctx.output}`, "the owner");
        else await loopHooks?.landAgain(ctx.ticketId, answer === CHECK_SKIP);
      } else if (ctx.type === "lesson") {
        await answerLessons(d, ctx, answer, extra);
        await retroHook?.lessonAnswered(id, answer, extra.note);
      } else if (ctx.type === "workflow_change") {
        await retroHook?.answered(ctx.changeId, answer);
      } else if (ctx.type === "workflow_check") {
        await retroHook?.checked(ctx.changeId, answer);
      } else if (ctx.type === "lesson_replace") {
        await answerLessonReplace(db, d, ctx, answer, ownWords, extra.note);
      } else if (ctx.type === "budget_limit") {
        const [p] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, ctx.policyId));
        if (p && answer === RAISE_BUDGET) await db.update(budgetPolicies).set({ limitMicros: Math.ceil(p.limitMicros * 1.5) }).where(eq(budgetPolicies.id, p.id));
        if (p && answer === HARD_STOP) await db.update(budgetPolicies).set({ onLimit: "pause" }).where(eq(budgetPolicies.id, p.id));
      } else if (ctx.type === "goal_check") {
        await recordGoalAnswer(db, ctx.featureId, answer, now());
      } else if (ctx.type === "stale_blocker") {
        await answerStaleBlocker(ctx, answer, extra);
      } else if (ctx.type === "stalled_run" && answer === CANCEL_RUN) {
        // A run that already ended needs no stopping.
        const r = await cancelRun?.(ctx.runId).catch(() => null);
        endedHere = !!r?.endedHere;
        delivered = !!r && !r.endedHere;
      }
      // Tickets this decision blocked can move again.
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      // The activity line is cut at 300 characters, so a long permission card is shortened here to keep the answer and reason in it.
      const asked = settled && d.question.length > 120 ? `${d.question.slice(0, 119)}…` : d.question;
      await record(db, { companyId: d.companyId, ticketId: freed[0]?.ticketId, kind: "decision_answered", summary: settled ? `${settled.name} settled "${asked}": ${answer}.${settled.note ? ` Reason: ${settled.note}` : ""}` : `${extra.by === "ceo" ? "The CEO settled" : "Owner answered"} "${d.question}": ${answer}`, at: now() });
      let unblocked: Array<typeof tickets.$inferSelect> = [];
      if (freed.length > 0) {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        for (const f of freed) {
          const t = await releaseIfFree(f.ticketId, false);
          if (t) unblocked.push(t);
        }
      }
      // The agent that asked is woken with the answer (on the ticket it blocked, if any).
      // A rule proposal answered with a button needs nothing more from the CEO.
      if (wake && d.kind === "question" && d.raisedByAgentId && (ctx.type !== "rule_proposal" || ownWords) && !(ctx.type === "lesson_replace" && ownWords)) {
        const onTicket = unblocked.find((t) => t.assigneeAgentId === d.raisedByAgentId) ?? unblocked[0];
        await wake({ agentId: d.raisedByAgentId, reason: "decision answered", ticketId: onTicket?.id ?? null, note: `${settled ? `${settled.name} settled` : extra.by === "ceo" ? "The CEO settled" : "The owner answered"} your question "${d.question}": ${answer}${extra.note ? ` — their note: ${extra.note}` : ""}` });
      }
      for (const t of unblocked) {
        if (wake && t.assigneeAgentId && t.assigneeAgentId !== d.raisedByAgentId) await wake({ agentId: t.assigneeAgentId, reason: "unblocked", ticketId: t.id, note: await unblockedNote(db, t.id, { question: d.question, answer }) });
      }
      return { id, answer, delivered, endedHere };
    },
  };
}
