// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { randomUUID } from "node:crypto";
import { createPermissionLog, type PermissionLog } from "./permission-log.js";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  isBossmanCall,
  ruleFor,
  rankDecision,
  ticketRef,
  recommendedVerdict,
  isJudgeable,
  judgePermission,
  commandOf,
  type JudgeReading,
  type PermissionJudgeMode,
  TEMP_CLEANUP_RULE,
  UNKNOWN_TOOL_RULE,
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
  untrusted,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import type { SecondOpinionCard, SecondOpinionResult } from "./second-opinion.js";
import { record } from "./activity.js";
import { REVIEW_REASON } from "./review-kinds.js";
import { addTicketDependency } from "./ticket-links.js";
import type { Ladder } from "./alert-ladder.js";
import { recordGoalAnswer } from "./goal-check.js";
import { APPLY_CHANGE, REVERT_CHANGE, checkChangeLink, checkChangeReason } from "./retro.js";
import { ADD_RULE, policyRulesService } from "./policy-rules.js";
import { effectivePolicy, resolveActor } from "./review-policy.js";
import { LESSONS_CAP, LESSON_DONT_ADD, LESSON_EDIT, LESSON_DROP, LESSON_MAX, lessonsFrom, lessonsPageRow, normalizeLesson, writeLesson } from "./project-brief.js";
import { agents, budgetPolicies, companies, decisions, deploys, engagementMessages, engagements, keyResults, milestones, objectives, policyRules, projects, runnerEvents, runners, runs, ticketArtifacts, ticketDependencies, tickets, wakes, watchdogActions, wikiPages } from "../db/schema.js";
import { decisionTicketIds, ownerActed, recentOwnerAnswer, quotedAnswer } from "./stale-requests.js";

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

/** One ticket a Boss Man update brings, as the owner sees it on a deploy card (BOS-213). */
export type DeployChange = { ticketId: string; ref: string; title: string };
/**
 * What a Boss Man update contains, in the owner's words (BOS-213): the tickets merged in the range,
 * the commits that aren't a ticket, why it needs a hand-apply, and what in it changes the risk.
 * Kept on both the approval card and the to-do it leaves behind, so both say the same thing.
 */
export type DeployUpdate = {
  from: string;
  to: string;
  /** Every commit in the range: tickets plus other commits. */
  total: number;
  /** How many files the update touches. */
  files: number;
  changes: DeployChange[];
  /** Tickets beyond the first 20. */
  more: number;
  otherCommits: string[];
  handBecause?: string;
  handFiles?: string[];
  /** What a hand-applied update changes: the deployer script, the server, or both (BOS-218). */
  handEffect?: "server" | "deployer" | "both";
  /** Plain yes/no needs for a hand-applied update (BOS-218). */
  needsDeployerCopy?: boolean;
  needsRunnerUpdate?: boolean;
  risks: string[];
};

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string; /** The tool call this was raised for and its title: a later request for the same call is covered by an Allow here. */ toolCallId?: string; toolTitle?: string | null; /** The whole tool input, normalised, so only an exact repeat matches this card (BOS-376). */ toolInput?: string; plan?: boolean; ticketId?: string | null; explain?: PermissionExplanation; /** What the rules judge made of it and the company setting at the time (BOS-337); the human's answer is logged next to it. */ judge?: JudgeNote; always?: AlwaysChoice[]; /** Temp-file cleanup, sent to the CEO first (BOS-111). */ tempCleanup?: boolean; /** Deletes in the agent's working copy, sent to the CEO first (BOS-120). */ workingCopy?: WorkingCopy; /** Who on the team settled it, and why (BOS-111 audit). */ settled?: Settled; /** A repeat of a command this run already had an Allow once for (BOS-376): the card answered at once, with sameAs. */ settledByRepeat?: { sameAs: string; at: string }; /** A repeat of the same command in the same run, settled from this card when its answer arrives (BOS-376). */ repeats?: Array<{ requestId: string; runnerId: string; at: string; settled?: "allow" | "deny" }> }
  | { type: "engagement"; engagementId: string }
  | { type: "question"; /** What the agent tried first, and why only the owner can do this. */ triedFirst?: string; /** Numbered steps when the owner must do something. */ steps?: string[]; /** Why this ask is still fresh even though the owner answered something like it before (BOS-123). */ stillNeeded?: string }
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
  | { type: "owner_todo"; ofDecisionId: string; steps: string[]; check?: string; rollback?: string; /** What the to-do applies: a self-deploy's target and commit, or a deploy target's deploy id. */ target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string; lastFailure?: { note: string; at: string }; /** What the approved update contains, so the to-do says the same as the card (BOS-213). */ update?: DeployUpdate }
  /** Boss Man updating itself through the host deployer; `infra` ones are only an alert (the owner deploys those by hand on the host). */
  | { type: "self_deploy"; target: "server" | "runner"; commit: string; fromCommit: string; runnerChanged?: boolean; infra?: boolean; /** Commit subjects, so the "updated" note says what changed. */ changes?: string[]; /** For an infra change the owner applies by hand: numbered steps, how to check it worked, and how to roll back. */ handSteps?: string[]; check?: string; rollback?: string; /** What the update contains, in plain words (BOS-213). */ update?: DeployUpdate; result?: { result: string; message: string; at: string } }
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
  | { type: "hire"; proposal: HireProposal; byAgentId: string }
  | { type: "instructions"; agentId: string; instructions: string; byAgentId: string }
  /** A display-name change for an agent (BOS-265); only the name moves, never the id. */
  | { type: "rename"; agentId: string; newName: string; before: string; byAgentId: string }
  | { type: "team_plan"; projectId: string | null; covered: string; hires: TeamHire[]; byAgentId: string }
  /** A model-setup change for an existing agent (BOS-128): the owner approves, edits or rejects it. */
  | { type: "model_change"; agentId: string; before: AgentModelConfig; proposed: AgentModelConfig; byAgentId: string; runningRunId?: string | null; applied?: { at: string; afterRunId: string | null; config?: AgentModelConfig } }
  /** A permission rule the CEO drafted from the owner's plain request; added when they answer ADD_RULE. A "question" kind, so the owner can also answer in their own words. */
  /** A skill the CEO proposed (services/skill-proposals.ts); the owner's answer installs or refuses it. */
  | { type: "skill"; proposalId: string }
  | { type: "rule_proposal"; rule: { name: string; match: PolicyMatch; outcome: PolicyOutcome } }
  /** A change a workflow retro proposed (workflow_changes); Apply carries it out, Skip leaves things as they are. */
  | { type: "workflow_change"; changeId: string }
  /** The check on an applied change (part 4): Keep it or Revert it, with the measured result. */
  | { type: "workflow_check"; changeId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHASE = "Chase";
export const REASSIGN = "Reassign";
export const DROP = "Drop dependency";
/** On a stale-blocker card: hand it to the company's CEO to settle. */
export const LET_CEO_DECIDE = "Let the CEO decide";
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

/** Who ended a card without answering it, and why (BOS-149): the CEO clears a stale or duplicate card, or the product does. */
export type Withdrawal = { by: "ceo" | "system"; agentId?: string; name?: string; note: string; at: string };

/**
 * Cards that answer an action rather than make an owner choice: a merge retry and Boss Man's own
 * "Got it" notices and alerts. The CEO may answer these even when they sit on the owner's tier.
 */
export function isSystemCard(d: { kind: string; tier: string; options: unknown; context: unknown }): boolean {
  const ctx = d.context as DecisionContext & { ladder?: unknown };
  if (ctx.type === "check_stuck") return true;
  // A card with steps asks the owner to do something, so it is never a system card (BOS-149),
  // even when its only option is "Got it": the ladder keeps the steps of what it escalated.
  const steps = (ctx as { steps?: unknown }).steps;
  if (Array.isArray(steps) && steps.length) return false;
  const options = Array.isArray(d.options) ? (d.options as string[]) : [];
  // Boss Man's alerts that only need acknowledging.
  if (ctx.ladder && options.length === 1 && options[0] === "Got it") return true;
  // Notices such as "your answer couldn't reach the runner".
  return ctx.type === "question" && options.length === 1 && options[0] === "Got it" && !ctx.steps?.length;
}

/**
 * Why the CEO may not answer this card, or null. Enforced in `answer()` itself, so it holds for every
 * caller, not just the MCP tool: owner sign-offs, deploys, hires, instruction changes, owner-only
 * permissions and the rest stay the owner's.
 */
export function ceoAnswerRefusal(d: { kind: string; tier: string; options: unknown; context: unknown }, answer?: string, opts: { ladder?: boolean } = {}): string | null {
  const ctx = d.context as DecisionContext & { ladder?: { rung?: string } };
  // An alert still with the Scrum Master is not the CEO's yet (BOS-64): settling it here would close it
  // and the owner would never see the escalation (BOS-149). The rung rule is for the CEO only, because
  // the Scrum Master settles its own alerts through the same path.
  if (opts.ladder !== false && ctx.ladder?.rung === "scrum_master") return "This alert is still with the Scrum Master, so it isn't yours to settle yet. Leave it for the ladder to hand over.";
  // An alert that has climbed to the owner has already failed the Scrum Master and the CEO, so it is
  // the owner's now: closing it here would take it off their queue without their seeing it (BOS-149).
  if (opts.ladder !== false && ctx.ladder?.rung === "owner") return "This alert is already with the owner, so it isn't yours to settle. Leave it for them.";
  if (OWNER_ONLY_ANSWER_TYPES.has(ctx.type)) return "Only the owner can answer this kind of decision. Leave it for them; if they asked for your advice, use action advise.";
  if (ctx.type === "question" && ctx.steps?.length) return "This asks the owner to do something, so only they can answer it. Leave it for them; if they asked for your advice, use action advise.";
  if (d.tier === "owner" && !isSystemCard(d)) return "This card is the owner's to answer. Leave it for them; if they asked for your advice, use action advise.";
  if (isSystemCard(d)) {
    // An allow-list, not a single refusal: anything added to a system card later stays off the CEO's list.
    // On a merge card only the retry and the send-back are safe; "Merge without the check" is the owner's.
    const allowed = ctx.type === "check_stuck" ? [CHECK_AGAIN, CHECK_SEND_BACK] : ["Got it"];
    if (!answer || !allowed.includes(answer)) {
      return ctx.type === "check_stuck"
        ? `The CEO may only choose "${CHECK_AGAIN}" or "${CHECK_SEND_BACK}" on this card. Leave "${CHECK_SKIP}" and any other choice to the owner.`
        : "The CEO may only acknowledge this card with \"Got it\".";
    }
  }
  return null;
}

/** Context types that are always the owner's call, even if a row was somehow left at the CEO's tier. */
const OWNER_ONLY_ANSWER_TYPES = new Set([
  "deploy",
  "self_deploy",
  "owner_todo",
  "maintenance",
  "hire",
  "instructions",
  "rename",
  "model_change",
  "team_plan",
  "risk_review",
  "budget_limit",
  "engagement",
  "project_cap",
  "ticket_cap",
  "rule_proposal",
  "goal_check",
]);

/**
 * Cards the CEO may withdraw only when their ticket is finished, never as a duplicate (BOS-149).
 * Two review-loop or merge cards about one ticket can be open at once, and each holds the owner's
 * choice: dropping one as a "duplicate" would take away that choice.
 */
const STALE_ONLY_WITHDRAW_TYPES = new Set(["review_loop", "check_stuck"]);

/**
 * Withdraws every open merge card for a ticket (BOS-149): one ticket never shows two, and a card for a
 * finished ticket goes away. The old dedupe key is freed so a fresh card can be raised later.
 */
export async function clearMergeCards(db: Db, ticketId: string, withdrawal: Withdrawal) {
  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'check_stuck'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`));
  let cleared = 0;
  for (const r of rows) {
    const [done] = await db
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: new Date(withdrawal.at), dedupeKey: null, context: { ...(r.context as object), withdrawn: withdrawal } })
      .where(and(eq(decisions.id, r.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) cleared++;
  }
  // An answered or withdrawn card keeps its key (the column is unique), which would swallow a fresh insert silently (BOS-362).
  await db.update(decisions).set({ dedupeKey: null }).where(and(eq(decisions.dedupeKey, `merge-stuck:${ticketId}`), ne(decisions.status, "open")));
  return cleared;
}

/**
 * One open sign-off card per ticket (BOS-446): a new review round closes the older "Merge it, or send it back?"
 * cards, and the ticket's wait on them. Returns how many were closed.
 */
export async function supersedeSignoffs(db: Db, ticketId: string, withdrawal: Withdrawal) {
  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`));
  let cleared = 0;
  for (const r of rows) {
    const [done] = await db
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: new Date(withdrawal.at), dedupeKey: null, context: { ...(r.context as object), withdrawn: withdrawal } })
      .where(and(eq(decisions.id, r.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) {
      cleared++;
      await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, r.id));
    }
  }
  return cleared;
}

/**
 * An approved ticket whose merge didn't finish: the merge failed (runner gone, a reply timed out) or the
 * server stopped mid-way. The owner tries again or sends it back; "Run the check again" re-runs the whole merge.
 */
export async function raiseMergeStuck(db: Db, t: { id: string; title: string; companyId: string }, why: string) {
  // A finished ticket needs no merge card, even if a sweep or a late failure asks for one (BOS-149).
  const [ticket] = await db.select({ systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id));
  if (ticket?.systemState === "done") return [];
  // A ticket only ever has one open merge card: a new reason replaces the older card (BOS-149).
  await clearMergeCards(db, t.id, { by: "system", note: `Replaced by a newer merge card: ${why}`, at: new Date().toISOString() });
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
      // The one closer, on any tier: a retry card goes once its ticket finishes (DR-016, BOS-470).
      context: { type: "check_stuck", ticketId: t.id, command: "", output: why, clearWhen: [{ kind: "ticketDone", ticketId: t.id }] },
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
  t: { companyId: string; question: string; key: string; steps: string[]; check?: string; rollback?: string; ofDecisionId: string; raisedByAgentId?: string | null; target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string; update?: DeployUpdate },
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
      context: { type: "owner_todo", ofDecisionId: t.ofDecisionId, steps: t.steps, ...(t.check ? { check: t.check } : {}), ...(t.rollback ? { rollback: t.rollback } : {}), ...(t.target ? { target: t.target } : {}), ...(t.commit ? { commit: t.commit } : {}), ...(t.fromCommit ? { fromCommit: t.fromCommit } : {}), ...(t.deployId ? { deployId: t.deployId } : {}), ...(t.update ? { update: t.update } : {}) } satisfies DecisionContext,
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

/** An agent's model setup as the CEO sets it and the owner sees it (BOS-128). */
export type AgentModelConfig = { harness: string; provider: string; model: string; fundingSourceId: string; fundingSourceName?: string };

/** One proposed hire in a team plan (docs/13). */
export type TeamHire = { name: string; template?: string; title?: string | null; model?: string | null; fundingSourceId?: string | null; fundingSourceName?: string; harness?: string; provider?: string; skills?: string[]; reason: string; serves?: string | null };
export type HireProposal = { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; harness?: string; provider?: string; reason?: string; /** Tickets waiting for this hire; they go to the new agent once hired. */ forTickets?: string[] };
export const TEAM_HIRE = "Hire the ticked ones";
export const TEAM_NOT_NOW = "Not now";
export const MODEL_APPROVE = "Approve";
export const MODEL_EDIT = "Edit";
export const MODEL_REJECT = "Reject";

export type AnswerExtra = {
  /** A team plan: which proposed hires (by position) the owner ticked; all of them when absent. */
  picks?: number[];
  assigneeAgentId?: string;
  /** What to tell the agent, e.g. why a plan or a review went back. */
  note?: string;
  /** A wiki page that explains a workflow change, optionally with a section: slug#Heading (BOS-216). */
  reasonLink?: string;
  /** The owner wrote their own answer to an agent's question instead of picking an option. */
  custom?: boolean;
  /** Who answered: "ceo" when the CEO settled it ("handled" advice), else the owner's username (logged with a skill override). */
  by?: string;
  /** With by "ceo": the advice summary, stored in the same conditional update that closes the decision. */
  handled?: { summary: string; at: string };
  /** The CEO answered with the decisions tool: recorded as theirs, with its note as the reason (BOS-111). */
  settledBy?: { agentId: string };
  /** A model change the owner edited before approving; checked with the same validator as the tool. */
  modelConfig?: AgentModelConfig;
  /**
   * How a sign-off answer should finish the ticket (BOS-471): the ticket page's Approve and merge wants the
   * merge done in the same press, and a ticket with nothing to merge marked done instead of left in review.
   */
  merge?: { markDone: boolean };
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

/** The rules judge's reading of a permission card, kept on it (BOS-337). In watch mode it is only recorded; in advise mode it also picked the suggested button. */
export type JudgeNote = { mode: Exclude<PermissionJudgeMode, "off">; verdict: JudgeReading["verdict"]; row: JudgeReading["row"]; reason: string; /** The model second opinion (BOS-338), asked only when the rules judge allows. Pending until it answers or fails (at most 5 s). */ second?: SecondNote };

/** What the model second opinion said (BOS-338). "failed" means the rules judge decided alone; `reason` is the model's one line, cleaned, or why it failed. */
export type SecondNote = { state: "pending" } | { state: "allow" } | { state: "deny"; reason: string } | { state: "failed"; reason: string };

/** Asks the company's model, if it has one switched on (BOS-338). */
export type SecondOpinionHook = { enabled: (companyId: string) => Promise<boolean>; ask: (companyId: string, card: SecondOpinionCard) => Promise<SecondOpinionResult> };

export type Settled = { agentId: string; name: string; note: string | null; at: string };

/** How long a permission or plan request waits with the CEO before it moves to the owner: the runner gives up at 10 minutes (BOS-111, BOS-119). */
export const CEO_HANDOVER_MINUTES = 5;

export const SKILL_ADD = "Add the skill";
export const SKILL_REJECT = "Don't add it";
export const SKILL_CONDITIONS = "Add it, accepting the reviewer's conditions";
export const SKILL_OVERRIDE = "Add it anyway, against the advice";

/**
 * "Ask the CEO for advice": where a decision stands with the CEO. Kept in the decision's context so the
 * decision stays open and answerable by the owner the whole time.
 */
export type Advice = {
  state: "asking" | "reissued" | "clarified" | "handled" | "timed_out" | "replacement" | "advised";
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
  /** advised: what the command does, in plain words. */
  what?: string;
  /** advised: whether the ticket actually needs it, in plain words. */
  needed?: string;
  /** advised: the CEO's recommendation, shown on the card. */
  recommendation?: "allow" | "deny";
  /** advised: why the CEO recommends it. */
  why?: string;
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

/**
 * How long an Allow once covers a repeat of the same command in the same run (BOS-376). A harness can
 * report one ask twice (a retry, or the command and the folder it reaches into); both should be answered
 * by the one click. Long enough for a retry or a late replay, short enough that the agent's own next,
 * deliberate run of the same command is a new question.
 */
export const REPEAT_ANSWER_MS = 5 * 60_000;

/**
 * A stable text of a tool call's whole input, so two asks are the same one only when every field matches
 * (BOS-376 security review): a fetch pointed at a public page and the same tool pointed at a home-network
 * address are different requests, even though the tool and command look alike. Keys are sorted, so the
 * order the harness wrote them in doesn't matter.
 */
function inputFingerprint(rawInput: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  try {
    return JSON.stringify(stable(rawInput ?? null));
  } catch {
    return String(rawInput);
  }
}

/**
 * Same tool ask: the same title and an identical full input, so the answer to one can cover the other
 * (BOS-376). Matching on the title and command alone let a fetch of a private address reuse an Allow once
 * given for a public one (security review), so the whole input must match.
 */
function sameAsk(a: { toolTitle?: string | null; toolInput?: string }, b: { title?: string | null; fingerprint: string }): boolean {
  return (a.toolTitle ?? null) === (b.title ?? null) && a.toolInput === b.fingerprint;
}

type WakeHook = (input: { agentId: string; reason: string; ticketId?: string | null; note?: string | null; priority?: number }) => Promise<unknown>;

type EngagementHook = (engagementId: string, approved: boolean) => Promise<unknown>;
type DeployHook = (deployId: string, approved: boolean) => Promise<unknown>;
export type LoopHooks = {
  sendBack(ticketId: string, text: string, reviewer: string): Promise<unknown>;
  stopTicket(ticketId: string): Promise<unknown>;
  raiseCap(ticketId: string): Promise<unknown>;
  /** Merges an approved ticket once the owner has signed off on it (R48); `merge.markDone` finishes a ticket with nothing to merge. */
  land(ticketId: string, reviewer: string, merge?: AnswerExtra["merge"]): Promise<unknown>;
  /** Lands again in the background after a check that couldn't finish; `skipChecks` merges without it. */
  landAgain(ticketId: string, skipChecks: boolean): Promise<unknown>;
};

export type MaintenanceHook = { answered(answer: string): Promise<unknown> };
export type SelfDeployHook = { check(ctx: Extract<DecisionContext, { type: "self_deploy" }>): Promise<void>; send(ctx: Extract<DecisionContext, { type: "self_deploy" }>, decisionId: string): Promise<unknown> };

type TeamPlanHook = (ctx: Extract<DecisionContext, { type: "team_plan" }>, companyId: string, picks: number[]) => Promise<unknown>;
type SkillHook = (ctx: Extract<DecisionContext, { type: "skill" }>, companyId: string, answer: string, by: string) => Promise<unknown>;
/** The workflow retro's side of its decisions (services/retro.ts): a check before Apply, and what to do once answered. */
export type RetroHook = {
  problemApplying(changeId: string): Promise<string | null>;
  answered(changeId: string, answer: string, info: { reason: string; reasonLink: string | null; decidedBy: "ceo" | "owner" }): Promise<unknown>;
  /** Why Revert can't go ahead now (the value was changed again since), or null. */
  problemReverting(changeId: string): Promise<string | null>;
  checked(changeId: string, answer: string): Promise<unknown>;
  lessonAnswered(decisionId: string, answer: string, note?: string): Promise<unknown>;
};
type AgentDecisionHook = (ctx: Extract<DecisionContext, { type: "hire" | "instructions" | "rename" }>, companyId: string, approved: boolean) => Promise<unknown>;
type ModelChangeHook = (ctx: Extract<DecisionContext, { type: "model_change" }>, companyId: string, config: AgentModelConfig) => Promise<{ afterRunId: string | null }>;

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

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date(), isConnected: (runnerId: string) => boolean = () => false, log: (message: string) => void = () => {}, workspaceRoot?: string) {
  // The record of permission decisions (BOS-306); app.ts swaps in one that writes log lines.
  let permLog: PermissionLog = createPermissionLog();
  let wake: WakeHook | null = null;
  let cancelRun: ((runId: string) => Promise<{ endedHere?: boolean }>) | null = null;
  let onEngagement: EngagementHook | null = null;
  let secondOpinion: SecondOpinionHook | null = null;
  // Second opinions still being asked, so a shutdown or a test can wait for them. Not kept: lost on restart, harmless because
  // expireSecondOpinions (the advice sweep) settles any card still pending past the deadline as "failed".
  const secondInFlight = new Set<Promise<void>>();
  let onDeploy: DeployHook | null = null;
  let onAgentDecision: AgentDecisionHook | null = null;
  let onModelChange: ModelChangeHook | null = null;
  let retroHook: RetroHook | null = null;
  let onTeamPlan: TeamPlanHook | null = null;
  let onSkill: SkillHook | null = null;
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
      if (!extra.assigneeAgentId) throw new AnswerError("Pick who should take this ticket.");
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, extra.assigneeAgentId), eq(agents.companyId, t?.companyId ?? "")));
      if (!a) throw new AnswerError("That person isn't on this ticket's team. Pick someone from the list.");
    }
    if (ctx.type === "stale_blocker" && answer === LET_CEO_DECIDE) {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo")));
      if (!ceo) throw new AnswerError("This company has no CEO to hand it to.");
    }
    if (ctx.type === "check_stuck" && answer !== CHECK_SEND_BACK) {
      // A retry must not merge past the owner's sign-off. Checked before the card closes, so a refused
      // retry leaves it open on the queue instead of swapping it for a new one (BOS-149).
      const [signoff] = await db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ctx.ticketId}`))
        .limit(1);
      if (signoff) throw new AnswerError("The owner's sign-off for this ticket is still open, so the check was not run again. Use Approve and merge on the ticket, which settles the sign-off and merges in one press.");
    }
    if (ctx.type === "workflow_change") {
      // Every Apply or Skip needs a reason, whether the CEO or the owner decides (BOS-216).
      try {
        checkChangeReason(extra.note);
        checkChangeLink(extra.reasonLink);
      } catch (err) {
        throw new AnswerError((err as Error).message);
      }
      if (answer === APPLY_CHANGE) {
        const problem = await retroHook?.problemApplying(ctx.changeId);
        if (problem) throw new AnswerError(problem);
      }
    }
    if (ctx.type === "workflow_check" && answer === REVERT_CHANGE) {
      const problem = await retroHook?.problemReverting(ctx.changeId);
      if (problem) throw new AnswerError(problem);
    }
    if (ctx.type === "lesson" && answer === LESSON_EDIT && !extra.note?.trim()) throw new AnswerError("Write the corrected lesson in the note box.");
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
      const [before] = assignee ? await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId)) : [];
      // Chasing restarts the stale clock; so does a new owner.
      const [t] = await db
        .update(tickets)
        .set({ lastActivityAt: now(), ...(assignee ? { assigneeAgentId: assignee, assignedToOwner: false } : {}) })
        .where(eq(tickets.id, ctx.blockerTicketId))
        .returning();
      if (assignee && before) await record(db, { companyId: before.companyId, ticketId: ctx.blockerTicketId, kind: "assigned", summary: `Reassigned from the stale-blocker card by ${extra.settledBy ? "the CEO" : "the owner"}`, at: now() });
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
  /**
   * Records the model's second opinion on a card (BOS-338). Only `judge.second` is written (jsonb_set), so an
   * answer saved meanwhile isn't overwritten. In advise mode an open card's suggestion becomes Allow when the
   * model allowed or failed (the rules judge, which allowed, decides alone), and stays Deny when it denied.
   */
  async function settleSecondOpinion(decisionId: string, r: SecondOpinionResult) {
    const note: SecondNote = "failed" in r ? { state: "failed", reason: r.failed } : r.verdict === "deny" ? { state: "deny", reason: r.reason } : { state: "allow" };
    const suggest = note.state === "deny" ? DENY : ALLOW;
    await db
      .update(decisions)
      .set({
        context: sql`jsonb_set(${decisions.context}, '{judge,second}', ${JSON.stringify(note)}::jsonb)`,
        recommendedOption: sql`CASE WHEN ${decisions.status} = 'open' AND ${decisions.context} #>> '{judge,mode}' = 'advise' THEN ${suggest} ELSE ${decisions.recommendedOption} END`,
      })
      .where(and(eq(decisions.id, decisionId), sql`${decisions.context} #>> '{judge,second,state}' = 'pending'`));
    if (note.state === "failed") log(`second opinion for decision ${decisionId} failed (${note.reason}); the rules judge decided alone`);
  }

  async function tellCeo(companyId: string, question: string, agentId?: string) {
    const [ceo] = agentId ? [{ id: agentId }] : await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
    if (ceo && wake) await wake({ agentId: ceo.id, reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
  }

  /**
   * Wakes the CEO about a card on the ladder, tied to the card's ticket so it can't hit the
   * ticketless-wake limit (BOS-159). If the wake is dropped anyway, the card goes straight to the
   * owner: a request must never sit at a rung nobody was woken for while the runner counts down.
   */
  async function wakeLadderCeo(companyId: string, row: { id: string }, ctx: { ladder: Ladder } & Record<string, unknown>, ceoId: string, note: string) {
    if (!wake) return;
    // High priority, like an alert: the agent is waiting, and the runner gives up at 10 minutes.
    const w = (await wake({ agentId: ceoId, ticketId: ctx.ladder.ticketId, reason: "decision", priority: 3, note })) as { status?: string; statusReason?: string | null } | null;
    if (w?.status !== "dropped") return;
    const at = now().toISOString();
    const why = `the CEO's wake was dropped (${w.statusReason ?? "no reason given"})`;
    const ladder: Ladder = { ...ctx.ladder, rung: "owner", since: at, hops: [...ctx.ladder.hops, { to: "owner", at, why }] };
    const moved = await db
      .update(decisions)
      .set({ tier: "owner", forAgentId: null, context: { ...(ctx as object), triedFirst: `Boss Man tried the CEO first: ${why}.`, ladder } })
      .where(and(eq(decisions.id, row.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (moved.length) await record(db, { companyId, ticketId: ctx.ladder.ticketId, kind: "watchdog", summary: `Card sent to the owner at once: the CEO's wake was dropped (${w.statusReason ?? "no reason given"}).`, at: now() });
  }

  /**
   * The owner hands a stale-blocker card to the company's CEO: it moves to the CEO's rung of the alert
   * ladder (off the owner's queue, listed under "Being handled by the team"), the CEO is woken, and it
   * climbs back to the owner if the CEO doesn't settle it in time.
   */
  async function handToCeo(d: typeof decisions.$inferSelect) {
    const ctx = d.context as Extract<DecisionContext, { type: "stale_blocker" }>;
    const at = now().toISOString();
    const ladder = { rung: "ceo", since: at, ticketId: ctx.blockerTicketId ?? ctx.blockedTicketId, about: [] as string[], hops: [{ to: "ceo", at, why: "the owner asked the CEO to decide" }] };
    const [moved] = await db
      .update(decisions)
      .set({ tier: "ceo", forAgentId: null, context: { ...ctx, ladder } })
      .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (!moved) return null;
    const [blocker] = ctx.blockerTicketId ? await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId)) : [];
    await record(db, { companyId: d.companyId, ticketId: ladder.ticketId, kind: "decision_answered", summary: `The owner handed "${d.question}" to the CEO to decide`, at: now() });
    await tellCeo(d.companyId, `${untrusted("Boss Man decision", d.question)}\nThe owner asked you to settle this ${blocker ? `(the blocking ticket is "${blocker.title}")` : ""}. Answer decision ${d.id} with Chase, Reassign (give assigneeAgentId) or Drop dependency.`);
    return { id: d.id, answer: LET_CEO_DECIDE, delivered: null as boolean | null, endedHere: false };
  }

  /** A plan from a plan-first ticket, put to the CEO, or to the owner for high-risk work (R40, R48). */
  async function planRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
    const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId, origin: runs.origin }).from(runs).where(eq(runs.id, event.runId));
    const [t] = run?.ticketId ? await db.select().from(tickets).where(eq(tickets.id, run.ticketId)) : [];
    const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
    const plan = event.detail ?? null;
    // A reviewer has no plan to present: what it sends through ExitPlanMode is its review verdict, so the CEO gets it as that and the owner is not asked to approve a plan (BOS-371).
    if (run?.origin === REVIEW_REASON && t) {
      send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: "deny" });
      const who = agent?.name ?? "A reviewer";
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, runner.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
      if (ceo && wake) await wake({ agentId: ceo.id, ticketId: t.id, reason: "decision", priority: 3, note: `${who} was asked to review "${t.title}" but could only send this through the plan door, so treat it as their review verdict:\n${untrusted("reviewer verdict", (plan ?? "(empty)").slice(0, 3000))}` });
      await record(db, { companyId: runner.companyId, ticketId: t.id, kind: "review_fallback", summary: `${who} sent their review as a plan; it went to the CEO as the verdict, not to the owner as a plan.`, at: now() });
      return { outcome: "deny" as const, rule: "A reviewer's plan is a review verdict", decisionId: null };
    }
    // An approved plan stays: a later plan from someone else never replaces it.
    if (t && plan && !t.planApprovedAt) await db.update(tickets).set({ plan, lastActivityAt: now() }).where(eq(tickets.id, t.id));
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
    if (row && ladder && ceoId)
      await wakeLadderCeo(runner.companyId, row, { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, plan: true, ticketId: t?.id ?? null, planText: plan, ladder }, ceoId, [
          `A plan is waiting for you (decision ${row.id}): ${row.question}`,
          "Approve it to let the agent start building, or send it back with what to change.",
          "Answer with the decisions tool (action answer). If only the owner can settle it, escalate it to them (action escalate).",
          `If you don't answer within ${CEO_HANDOVER_MINUTES} minutes it goes to the owner, marked as tried by you first.`,
        ].join("\n").slice(0, 4000));
    else if (row && tier === "ceo") await tellCeo(runner.companyId, row.question, forAgentId ?? undefined);
    return { outcome: tier, rule: "Plans are approved before work starts", decisionId: row?.id ?? null };
  }

  /** The card's subject, so two cards about the same ticket or deploy can be told apart as duplicates (BOS-149). */
  async function cardSubject(d: typeof decisions.$inferSelect): Promise<string | null> {
    const c = d.context as DecisionContext & { ladder?: { ticketId?: string | null } };
    switch (c.type) {
      case "permission":
        // Keyed on the request, not the run: two different requests in one run are not duplicates (BOS-149).
        return c.requestId ? `request:${c.requestId}` : null;
      case "question":
      case "stalled_run": {
        // Two different questions about one ticket are not duplicates (BOS-149): key on what is asked,
        // never on the ticket alone, so a live owner question is never cleared as a "duplicate".
        const own = (c as { ticketId?: unknown }).ticketId;
        const ticket = typeof own === "string" ? own : c.ladder?.ticketId;
        // The choices are part of what is asked (BOS-195): a card offering a wider choice is never
        // a duplicate of a narrower one, or the CEO could withdraw the option the owner never saw.
        const options = Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string") : [];
        return `question:${ticket ?? "-"}:${JSON.stringify([d.question, options, d.recommendedOption])}`;
      }
      case "check_stuck":
      case "review_loop":
      case "ticket_cap":
      case "risk_review":
      case "lesson":
        return `ticket:${c.ticketId}`;
      case "lesson_replace":
        return `project:${c.projectId}`;
      case "deploy":
        return `deploy:${c.deployId}`;
      case "engagement":
        return `engagement:${c.engagementId}`;
      case "goal_check":
        return `feature:${c.featureId}`;
      case "budget_limit":
        return `budget:${c.policyId}`;
      case "project_cap":
        return `project:${c.projectId}`;
      default:
        break;
    }
    if (c.ladder?.ticketId) return `ticket:${c.ladder.ticketId}`;
    const own = (c as { ticketId?: unknown }).ticketId;
    return typeof own === "string" ? `ticket:${own}` : null;
  }

  /** Its ticket is done or cancelled, so the card no longer asks for anything (BOS-149). */
  async function isStale(d: typeof decisions.$inferSelect): Promise<boolean> {
    const c = d.context as DecisionContext & { ladder?: { ticketId?: string | null } };
    const ids = new Set<string>();
    const own = (c as { ticketId?: unknown }).ticketId;
    if (typeof own === "string") ids.add(own);
    if (c.ladder?.ticketId) ids.add(c.ladder.ticketId);
    const blocked = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
    for (const b of blocked) ids.add(b.ticketId);
    if (!ids.size) return false;
    const rows = await db.select({ systemState: tickets.systemState }).from(tickets).where(inArray(tickets.id, [...ids]));
    return rows.length === ids.size && rows.every((r) => r.systemState === "done");
  }

  /** Another open card of the same kind asks the same thing (BOS-149). */
  async function openSibling(d: typeof decisions.$inferSelect, subject: string): Promise<typeof decisions.$inferSelect | null> {
    const c = d.context as DecisionContext;
    const others = await db.select().from(decisions).where(and(eq(decisions.companyId, d.companyId), eq(decisions.status, "open"), ne(decisions.id, d.id)));
    for (const o of others) {
      if ((o.context as DecisionContext).type !== c.type) continue;
      if ((await cardSubject(o)) === subject) return o;
    }
    return null;
  }

  /** Another open card covers the same thing, so this one is a duplicate (BOS-149). */
  async function isDuplicate(d: typeof decisions.$inferSelect): Promise<boolean> {
    const subject = await cardSubject(d);
    return subject ? (await openSibling(d, subject)) !== null : false;
  }

  /**
   * What this run already decided about the same tool ask (same title and command), for a repeat that
   * comes back as a new request (BOS-376). An Allow once within the last few minutes settles the repeat;
   * a Deny, now or inside that window, means the repeat is a new card. Null when this run has said
   * nothing about this exact ask, or the ask moved to the CEO or a rule since.
   */
  async function repeatAnswer(event: PermissionEvent, fingerprint: string): Promise<{ allow: string | null; denied: boolean }> {
    const since = new Date(now().getTime() - REPEAT_ANSWER_MS);
    const rows = await db
      .select({ id: decisions.id, answer: decisions.answer, context: decisions.context, answeredAt: decisions.answeredAt })
      .from(decisions)
      .where(
        and(
          eq(decisions.kind, "permission"),
          eq(decisions.status, "answered"),
          inArray(decisions.answer, [ALLOW, DENY]),
          sql`${decisions.context}->>'runId' = ${event.runId}`,
          sql`${decisions.context}->'plan' is null`,
        ),
      );
    let allow: string | null = null;
    for (const r of rows) {
      const ctx = r.context as Extract<DecisionContext, { type: "permission" }>;
      if (!sameAsk(ctx, { title: event.title, fingerprint })) continue;
      if (r.answer === DENY) return { allow: null, denied: true };
      if (r.answeredAt && r.answeredAt >= since) allow = r.id;
    }
    return { allow, denied: false };
  }

  /**
   * An Allow once this run gave for the same command within the last few minutes, for a request whose own
   * card is gone (a runner that replays after a restart): the answer on the card is still the answer to
   * the same command (BOS-376). Older than that is a new question, and a Deny is never read here.
   */
  async function allowedCommandOnRun(runId: string, event: PermissionEvent, fingerprint: string): Promise<string | null> {
    const since = new Date(now().getTime() - REPEAT_ANSWER_MS);
    const rows = await db
      .select({ id: decisions.id, context: decisions.context, answeredAt: decisions.answeredAt })
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "answered"), eq(decisions.answer, ALLOW), sql`${decisions.context}->>'runId' = ${runId}`, sql`${decisions.context}->'plan' is null`))
      .orderBy(desc(decisions.answeredAt));
    return rows.find((r) => r.answeredAt !== null && r.answeredAt >= since && sameAsk(r.context as Extract<DecisionContext, { type: "permission" }>, { title: event.title, fingerprint }))?.id ?? null;
  }

  /** Another open card asks the same thing of the same run: a repeat waiting for the answer to the first (BOS-376). */
  async function openSameAsk(event: PermissionEvent, fingerprint: string): Promise<typeof decisions.$inferSelect | null> {
    const rows = await db
      .select()
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`${decisions.context}->>'runId' = ${event.runId}`, sql`${decisions.context}->'plan' is null`));
    return rows.find((d) => sameAsk(d.context as Extract<DecisionContext, { type: "permission" }>, { title: event.title, fingerprint })) ?? null;
  }

  /** The id of a card already answered Allow for this same tool call (same run, same call id, same title), if any. */
  async function allowedSameToolCall(event: PermissionEvent): Promise<string | null> {
    const rows = await db
      .select({ id: decisions.id, context: decisions.context })
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "answered"), eq(decisions.answer, ALLOW), sql`${decisions.context}->>'runId' = ${event.runId}`, sql`${decisions.context}->>'toolCallId' = ${event.toolCallId}`));
    return rows.find((r) => (r.context as { toolTitle?: string | null }).toolTitle === event.title)?.id ?? null;
  }

  return {
    async onPermissionRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
      // An agent asking to leave plan mode is presenting its plan for approval (R40).
      if (event.kind === "switch_mode") {
        const [r] = await db.select({ purpose: runs.purpose }).from(runs).where(eq(runs.id, event.runId));
        if (r?.purpose !== "chat") return planRequest(runner, event);
      }
      const info: PermissionInfo = { title: event.title, kind: event.kind, rawInput: event.rawInput };
      // The owner chat may use Boss Man's own (board) tools and nothing else.
      const [asking] = await db.select({ purpose: runs.purpose, agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
      const { outcome, rule, position } =
        asking?.purpose === "chat"
          ? isBossmanCall(info)
            ? { outcome: "allow" as const, rule: "The owner chat's board tools", position: 0 }
            : { outcome: "deny" as const, rule: "The owner chat has board tools only", position: 0 }
          : evaluatePermission(info, await rulesFor(runner.companyId));
      // tier is where a card ended up (the CEO's own requests, or a paused CEO, go to the owner); outcome is what the rule said.
      const record = (decisionId: string | null, tier: string = outcome, ruleName: string = rule) =>
        permLog.decision({ companyId: runner.companyId, runId: event.runId, agentId: asking?.agentId ?? null, ticketId: asking?.ticketId ?? null, title: event.title, kind: event.kind, rule: ruleName, position, outcome, tier, decisionId });
      // OpenCode asks twice for one shell command that reaches outside the checkout: first for the folder, then for the command. If the owner or CEO has already allowed this tool call, the second ask is not a new question. The rules still apply first, so a denial stands.
      if (outcome !== "allow" && outcome !== "deny" && event.toolCallId) {
        const earlier = await allowedSameToolCall(event);
        if (earlier && send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: "allow" })) {
          record(null, "allow", `Same tool call as decision ${earlier}, already allowed`);
          return { outcome: "allow" as const, rule: `Same tool call as decision ${earlier}, already allowed`, decisionId: null };
        }
      }
      // BOS-376: the same tool call can come back as a new request (a harness retry, or a second run of the
      // same call). It is the same question: the Allow once this run already got settles it, and a Deny this
      // run already got means it is a fresh card, never an Allow.
      // This runs only when the rules would raise a card (BOS-376 security review): it must never override
      // a rule's denial or the private-network block, both of which the rules engine returns as deny above.
      // Two asks are the same only when the run, the tool title and the whole input match, so a fetch of a
      // home-network address can't reuse the Allow once given for a public one.
      if (event.kind !== "switch_mode" && outcome !== "allow" && outcome !== "deny") {
        const fingerprint = inputFingerprint(event.rawInput);
        // A repeat of a card still waiting rides on it: one card, and the answer settles both.
        const waiting = await openSameAsk(event, fingerprint);
        if (waiting) {
          const ctx = waiting.context as Extract<DecisionContext, { type: "permission" }>;
          const repeats = [...(ctx.repeats ?? []), { requestId: event.requestId, runnerId: runner.id, at: now().toISOString() }].slice(-20);
          // The card says a repeat rides on it, so the human sees one question, not two (BOS-376).
          const note = `The same request was asked again as request ${event.requestId}: one answer covers both.`;
          const question = waiting.question.includes(note) ? waiting.question : `${waiting.question}\n${note}`;
          await db.update(decisions).set({ context: { ...ctx, repeats }, question }).where(eq(decisions.id, waiting.id));
          record(waiting.id, "ceo", "A repeat of a card already waiting");
          return { outcome: "ceo" as const, rule: "A repeat of a card already waiting", decisionId: waiting.id };
        }
        const decided = await repeatAnswer(event, fingerprint);
        if (decided.allow && send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: "allow" })) {
          const [shown] = await db.select({ context: decisions.context }).from(decisions).where(eq(decisions.id, decided.allow));
          await db.update(decisions).set({ context: { ...(shown?.context as object), settledByRepeat: { sameAs: decided.allow, at: now().toISOString() } } as DecisionContext }).where(eq(decisions.id, decided.allow));
          record(null, "allow", `Same request as decision ${decided.allow}, already allowed`);
          return { outcome: "allow" as const, rule: `Same request as decision ${decided.allow}, already allowed`, decisionId: null };
        }
      }
      if (outcome === "allow" || outcome === "deny") {
        record(null);
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
          const why = workingCopy ? "deletes in the agent's working copy go to the CEO first" : rule === TEMP_CLEANUP_RULE ? "temp-file cleanup goes to the CEO first" : rule === UNKNOWN_TOOL_RULE ? "the tool isn't one Boss Man recognises, so it goes to the CEO first" : `the rule "${rule}" sends it to the CEO`;
          ladder = { rung: "ceo", since, minutes: CEO_HANDOVER_MINUTES, ticketId: run?.ticketId ?? null, about: run?.agentId ? [run.agentId] : [], hops: [{ to: "ceo", at: since, why }] };
        } else tier = "owner";
      }
      // Standing rules are the owner's call, never an agent's.
      const always = tier === "owner" ? alwaysChoices(info, explain) : [];
      // The rules judge (BOS-337) only picks which button is suggested. The policy above already decided who answers; nothing here answers a card.
      const [company] = await db.select({ mode: companies.permissionJudge }).from(companies).where(eq(companies.id, runner.companyId));
      const judgeMode = company?.mode ?? "watch";
      const judgedCommand = commandOf(info.rawInput);
      // Very long commands are not judged (the old recommendation stays): the patterns are not built for them and this runs on the server loop.
      const reading = judgeMode === "off" || !isJudgeable(judgedCommand) ? null : judgePermission(`${explain.title}. ${explain.summary}`, judgedCommand, run?.ticketId ?? undefined, workspaceRoot && (run?.ticketId ?? run?.agentId) ? `${workspaceRoot}/${run?.ticketId ?? run?.agentId}`.replace(/[^A-Za-z0-9]/g, "-") : undefined, workspaceRoot);
      // The model second opinion (BOS-338) is asked only when the rules judge allows: it can only make a card stricter.
      const askSecond = !!reading && reading.verdict === "allow" && judgeMode !== "off" && !!secondOpinion && (await secondOpinion.enabled(runner.companyId).catch(() => false));
      const judge: JudgeNote | undefined = reading && judgeMode !== "off" ? { mode: judgeMode, verdict: reading.verdict, row: reading.row, reason: reading.reasonLabel, ...(askSecond ? { second: { state: "pending" as const } } : {}) } : undefined;
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), toolTitle: event.title, toolInput: inputFingerprint(event.rawInput), explain, ...(judge ? { judge } : {}), ...(always.length ? { always } : {}) };
      // workingCopy stays when it falls to the owner (CEO paused), so the card and the audit still say so.
      const stored = { ...context, rule, ...(workingCopy ? { workingCopy } : {}), ...(ladder ? { ...(rule === TEMP_CLEANUP_RULE ? { tempCleanup: true } : {}), ladder } : {}) };
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: runner.companyId,
          kind: "permission",
          // Which checkout the run started in and which files, on every card the CEO or the owner sees
          // (BOS-120). Boss Man only knows where the shell STARTED (BOS-159): a shell keeps its folder
          // between commands, so the card never claims the paths are inside the checkout now.
          question: `${explain.title}. ${explain.summary}${workingCopy ? ` Its relative paths delete from the shell's folder; the run started in ${agent?.name ?? "the agent"}'s working copy for ${workingCopy.ref ?? "its ticket"} (branch ${workingCopy.branch}), and Boss Man can't see where it has moved to since: ${fileList(workingCopy.files, 400)}.` : ""}`,
          options: [ALLOW, ...always.map((a) => a.label), DENY],
          // The same allow-list as everywhere else: build output is Allow, source or anything else is
          // Deny, so the CEO is never handed a pre-selected Allow for rm -rf src (adversarial review).
          // While the second opinion is pending the card suggests Deny: it is advised Allow only once both judges allow (or the model fails, and the rules judge decides alone).
          recommendedOption: (judge?.mode === "advise" ? (judge.second?.state === "pending" ? "deny" : judge.verdict) : recommendedVerdict(info)) === "allow" ? ALLOW : DENY,
          raisedByAgentId: run?.agentId ?? null,
          tier,
          dedupeKey: `permission:${event.requestId}`,
          context: stored,
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id, question: decisions.question });
      // Asked in the background: the runner's events wait on this function, and a slow model must not hold up every agent's events.
      if (row && askSecond && secondOpinion) {
        const ownTicket = run?.ticketId ?? null;
        const p = secondOpinion
          .ask(runner.companyId, { question: `${explain.title}. ${explain.summary}`, command: judgedCommand, ownTicket })
          .then((r) => settleSecondOpinion(row.id, r))
          .catch((err) => log(`second opinion for decision ${row.id} could not be recorded: ${(err as Error).message}`))
          .finally(() => secondInFlight.delete(p));
        secondInFlight.add(p);
      }
      if (row && ceoId && "ladder" in stored && stored.ladder) {
        await wakeLadderCeo(runner.companyId, row, stored as typeof stored & { ladder: Ladder }, ceoId, [
          `A permission request is waiting for you (decision ${row.id}): ${row.question}`,
          `Command: ${explain.command ?? ""}`,
          ...(workingCopy
            ? [
                `Its deletes are plain relative paths and the command has no cd, so they happen in the shell's folder. The run started in ${agent?.name ?? "the agent"}'s working copy for ${workingCopy.ref ?? "its ticket"} (branch ${workingCopy.branch}): ${fileList(workingCopy.files, 1000)}. The shell keeps its folder between commands and a cd is allowed on its own, so Boss Man can't vouch for where it sits now. Any other deletes are of entries directly in /tmp, and everything else in it is on Boss Man's short list of commands, so it came to you rather than the owner.`,
                "Boss Man can't see the runner's files: if a folder on one of those paths is a symlink, the delete follows it out of the checkout. It recommends Allow only for build output (dist, node_modules and the like). Allow it when the paths are the agent's own throwaway files (a probe or test file it made, build output such as dist or node_modules) and its ticket explains them.",
                "Deny it, or escalate it to the owner (decisions tool, action escalate), if it deletes source folders or files the ticket doesn't account for, or anything you can't explain.",
              ]
            : rule === TEMP_CLEANUP_RULE
              ? [
                  "Its only deletes are of entries directly in /tmp, and everything else in it is on Boss Man's short list of commands, so it came to you rather than the owner. Any folder it writes into in /tmp is one the same command deleted first, so it can't be a shortcut link to somewhere else.",
                  "Two exceptions on that list reach outside /tmp. git worktree add writes into the project's repository (.git) and creates its -b branch there: check the branch name is the asking agent's own. pnpm or npm install runs the project's own install scripts, which can do anything: check that the folder is a checkout of the asking agent's own ticket branch.",
                  "Allow it when the rest of the command looks like the agent's own work. Deny it, or escalate it to the owner (decisions tool, action escalate), if anything in it reaches outside /tmp, pushes, or you can't account for it.",
                ]
              : rule === UNKNOWN_TOOL_RULE
                ? [
                    "Boss Man doesn't recognise this tool, so it came to you before the owner. Allow it only if you know what the tool does and the asking agent should have it; a name close to one of Boss Man's own tools (see the warning in the request) may be a copy made to get past the checks. Deny it if you can't vouch for it; escalate it to the owner (decisions tool, action escalate) if only they can settle it.",
                  ]
              : [
                  "A company rule sends it to you rather than the owner. Allow it if you can vouch for it, or deny it if not; if only the owner can settle it (a secret, host access, sign-off, an owner-only choice), escalate it to them (decisions tool, action escalate).",
                ]),
          "Answer with the decisions tool (action answer) and give a note saying why: the owner reads it.",
          `If you don't answer within ${CEO_HANDOVER_MINUTES} minutes it goes to the owner, marked as tried by you first.`,
        ].join("\n").slice(0, 4000));
      } else if (row && tier === "ceo") await tellCeo(runner.companyId, row.question);
      record(row?.id ?? null, tier);
      return { outcome, rule, decisionId: row?.id ?? null };
    },

    async raise(input: { companyId: string; agentId: string | null; question: string; options: string[]; recommended: string; blocksTicketId?: string; triedFirst?: string; steps?: string[]; stillNeeded?: string }) {
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
            context: { type: "question", ...(input.blocksTicketId ? { ticketId: input.blocksTicketId } : {}), ...(input.triedFirst ? { triedFirst: input.triedFirst } : {}), ...(input.steps?.length ? { steps: input.steps } : {}), ...(input.stillNeeded ? { stillNeeded: input.stillNeeded } : {}) },
          })
          .returning();
        if (input.blocksTicketId) {
          // The same guarded writer every other link uses (BOS-86 round 12): a proposer can't block
          // the Security Reviewer's task with a question, on any route.
          await addTicketDependency(tx as unknown as Db, {
            companyId: input.companyId,
            blockedTicketId: input.blocksTicketId,
            blockerDecisionId: row!.id,
            actor: { type: "agent", agentId: input.agentId },
            hold: true,
            now,
          });
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
        const payload = ev.payload as PermissionEvent;
        const fingerprint = inputFingerprint(payload.rawInput);
        // A repeat of the same request this run was already allowed (BOS-376): the old answer reaches the
        // runner again, and the ask gets no second card. Only when the rules would instead raise a card: a
        // replayed request the rules deny (a home-network fetch) must still be denied, never allowed by an
        // earlier Allow for a different request (security review).
        const info: PermissionInfo = { title: payload.title, kind: payload.kind, rawInput: payload.rawInput };
        const { outcome } = evaluatePermission(info, await rulesFor(runner.companyId));
        const mayRepeat = outcome !== "allow" && outcome !== "deny";
        const allowed = mayRepeat ? await allowedCommandOnRun(p.runId, payload, fingerprint) : null;
        if (allowed && send(runner.id, { type: "permission.decide", runId: p.runId, requestId: p.requestId, verdict: "allow" })) {
          resent++;
          continue;
        }
        // A request that never got a row of its own because its first card is still open (BOS-376): it
        // rides on that card, so the runner waits for the same answer, not a new decision.
        if (mayRepeat && (await openSameAsk(payload, fingerprint))) continue;
        const r = await this.onPermissionRequest(runner, payload);
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

    setPermissionLog(l: PermissionLog) {
      permLog = l;
    },

    /** A runner reported a tool call that failed with "User refused permission" (BOS-306): log it with the run, agent and ticket. */
    async onRefusedCall(runner: { companyId: string }, runId: string, title: string | null) {
      const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(and(eq(runs.id, runId), eq(runs.companyId, runner.companyId)));
      permLog.refusedCall({ companyId: runner.companyId, runId, agentId: run?.agentId ?? null, ticketId: run?.ticketId ?? null, title });
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

    setModelChangeHook(hook: ModelChangeHook) {
      onModelChange = hook;
    },

    setTeamPlanHook(hook: TeamPlanHook) {
      onTeamPlan = hook;
    },

    setSkillHook(hook: SkillHook) {
      onSkill = hook;
    },

    /**
     * The owner's call on a proposed skill. One open decision per proposal. A card that ended
     * without installing (answered after a crash, withdrawn or expired) keeps its dedupe key
     * only while it is open, so the same proposal can be put in front of the owner again.
     */
    async raiseSkill(input: { companyId: string; proposalId: string; agentId: string | null; question: string; options: string[]; recommended: string }, dbc: Db = db) {
      const dedupeKey = `skill:${input.proposalId}`;
      await dbc.update(decisions).set({ dedupeKey: null }).where(and(eq(decisions.dedupeKey, dedupeKey), ne(decisions.status, "open")));
      const [row] = await dbc
        .insert(decisions)
        .values({ companyId: input.companyId, kind: "skill", tier: "owner", question: input.question, options: input.options, recommendedOption: input.recommended, raisedByAgentId: input.agentId, dedupeKey, context: { type: "skill", proposalId: input.proposalId } })
        .onConflictDoNothing()
        .returning();
      if (row) return row;
      // Another caller already put this card in front of the owner: adopt it rather than asking twice.
      const [open] = await dbc.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, dedupeKey), eq(decisions.status, "open")));
      return open ? { id: open.id } : null;
    },

    /** Takes a skill decision off the owner's queue when the proposal ended some other way. */
    async withdrawSkill(id: string) {
      await db.update(decisions).set({ status: "withdrawn", dedupeKey: null, answeredAt: now() }).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
    },

    setLoopHooks(hooks: LoopHooks) {
      loopHooks = hooks;
    },

    /** The model second opinion on permission cards (BOS-338). */
    setSecondOpinion(hook: SecondOpinionHook) {
      secondOpinion = hook;
    },

    /**
     * A card whose second opinion is still pending well past the 5 s deadline lost its asker (a restart or a
     * blue/green swap): it is settled as failed, so the rules judge decides alone (BOS-338).
     */
    async expireSecondOpinions() {
      const stale = await db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`${decisions.context} #>> '{judge,second,state}' = 'pending'`, sql`${decisions.createdAt} < ${new Date(now().getTime() - 60_000).toISOString()}::timestamptz`));
      for (const d of stale) await settleSecondOpinion(d.id, { failed: "Boss Man restarted before the model answered" });
      return stale.length;
    },

    /** Waits for second opinions still being asked (shutdown, tests). Each takes at most the 5 s deadline. */
    async drainSecondOpinions() {
      while (secondInFlight.size) await Promise.all([...secondInFlight]);
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
     * ranked by an explainable score. `includeAll` is the CEO's view (BOS-149): every open card
     * in the company, any tier, including lesson cards and cards still with the CEO or the
     * Scrum Master. `companyId` narrows that view to one company.
     */
    async queue(opts: { includeAll?: boolean; companyId?: string } = {}) {
      const t = now();
      const open = await db
        .select({ d: decisions, companyName: companies.name, agentName: agents.name })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
        // Boss Man's alerts still with the Scrum Master or the CEO aren't the owner's yet (BOS-64); withTeam lists them.
        .where(
          and(
            eq(decisions.status, "open"),
            ...(opts.companyId ? [eq(decisions.companyId, opts.companyId)] : []),
            ...(opts.includeAll
              ? []
              : [sql`coalesce(${decisions.context}->'ladder'->>'rung', 'owner') = 'owner'`, sql`coalesce(${decisions.context}->>'type', '') not in ('lesson', 'lesson_replace')`]),
          ),
        );
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
      // A push card names the branch it goes to, which can be a ticket other than the run's own.
      const pushTicketIds = open.flatMap(({ d }) => {
        const explain = (d.context as DecisionContext).type === "permission" ? (d.context as { explain?: PermissionExplanation }).explain : undefined;
        return explain?.push?.ticketId ? [explain.push.ticketId] : [];
      });
      const wantedAbout = [...new Set([...open.flatMap(({ d }) => aboutIds(d)), ...pushTicketIds])];
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
        const c = d.context as DecisionContext;
        const push = c.type === "permission" ? c.explain?.push : undefined;
        const pushTicket = push?.ticketId ? aboutInfo.get(push.ticketId) : undefined;
        const context = pushTicket && c.type === "permission" && c.explain
          ? { ...c, explain: { ...c.explain, push: { ...push!, ref: ticketRef(pushTicket.prefix, pushTicket.number) ?? undefined } } }
          : d.context;
        return { ...d, context, companyName, agentName, forAgentName: d.forAgentId ? (forNames.get(d.forAgentId) ?? null) : null, blocks: chain, about, ...rank };
      });
      const refs = await resolveRefs(db, open.map(({ d }) => ({ id: d.id, companyId: d.companyId, text: cardText(d) })));
      // Newest first, by when the card was raised; the score is shown but never reorders (BOS-164).
      const sorted = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
      // The CEO proposed the skill on this card, so it must not get to reword the card the owner decides on (BOS-168).
      if (d.kind === "skill") throw new AnswerError("The CEO proposed this skill, so it can't rewrite this card. If something is unclear, ask the CEO about it in chat.");
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
      const [dependency] = await db
        .select({ ticketId: tickets.id, title: tickets.title })
        .from(ticketDependencies)
        .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
        .where(eq(ticketDependencies.blockerDecisionId, id));
      const permission = ctx.type === "permission" ? ctx : null;
      const [run] = permission ? await db.select({ ticketId: runs.ticketId }).from(runs).where(eq(runs.id, permission.runId)) : [];
      const ticketId = dependency?.ticketId ?? run?.ticketId ?? null;
      const [held] = ticketId
        ? await db.select({ ticketId: tickets.id, title: tickets.title }).from(tickets).where(eq(tickets.id, ticketId))
        : [dependency];
      const lines = permission
        ? [
            "The owner asked for your advice on a permission request. It stays open and the owner can still answer it.",
            `Decision ${d.id}: ${d.question}`,
            `Command: ${permission.explain?.command ?? "the request didn't include one"}`,
            `Boss Man's plain reading: ${permission.explain?.summary ?? "Boss Man couldn't read this request"}`,
            ...(permission.explain?.reason ? [`The agent says it is for: ${permission.explain.reason}`] : []),
            `Options: ${(d.options as string[]).join(" | ") || "none"} (recommended: ${d.recommendedOption})`,
            ...(held ? [`The ticket it belongs to: "${held.title}" (${held.ticketId}).`] : []),
            note ? `What's unclear, in the owner's words: ${note}` : "The owner wants to know what the command does and whether to allow it.",
            "Use the decisions tool, action advise, outcome advice: give what (what the command does, in plain words), needed (whether the ticket actually needs it), recommendation (allow or deny) and why (a short reason). The owner sees this on the card. If the card is genuinely yours to settle, you may instead use outcome handled with summary and answer, under the existing routing rules. Do this within the time limit or it returns to the owner as it was.",
          ]
        : [
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
    async advise(input: { id: string; companyId: string; agentId: string | null; outcome: "reissue"; runId?: string; question: string; options: string[]; recommended: string; triedFirst: string; steps?: string[] } | { id: string; companyId: string; agentId: string | null; outcome: "handled"; runId?: string; summary: string; answer?: string } | { id: string; companyId: string; agentId: string | null; outcome: "advice"; runId?: string; what: string; needed: string; recommendation: "allow" | "deny"; why: string }) {
      const via = input.runId ? ` (CEO run ${input.runId})` : "";
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, input.id), eq(decisions.companyId, input.companyId)));
      if (!d) throw new AnswerError("No decision with that id.");
      if (d.status !== "open") return null;
      const advice = adviceOf(d.context);
      if (advice?.state !== "asking") throw new AnswerError(advice?.state === "timed_out" ? "The time ran out and the decision went back to the owner." : "The owner hasn't asked for advice on this decision.");
      const at = now().toISOString();
      if (input.outcome === "advice") {
        // Only a command the owner has been asked to allow makes sense here: the advice says what it does
        // and whether to allow it, and stays on the card while the owner decides.
        if (d.kind !== "permission" || (d.context as { type?: string }).type !== "permission") throw new AnswerError("Advice in these words is for a permission request. For other cards use reissue or handled.");
        const what = input.what.trim();
        const needed = input.needed.trim();
        const why = input.why.trim();
        if (what.length < 10 || needed.length < 5 || why.length < 10) throw new AnswerError("Say what the command does, whether the ticket needs it, and why, in short plain sentences.");
        const [done] = await db
          .update(decisions)
          .set({ context: { ...(d.context as object), advice: { ...advice, state: "advised", at, what, needed, recommendation: input.recommendation, why } } })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), sql`${decisions.context}->'advice'->>'state' = 'asking'`))
          .returning({ id: decisions.id });
        if (!done) return null;
        const held = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
        await record(db, { companyId: d.companyId, agentId: input.agentId, ticketId: held[0]?.ticketId, kind: "decision_advised", summary: `CEO advised ${input.recommendation === "allow" ? "Allow" : "Deny"} on "${d.question}": ${why}${via}`, at: now() });
        return { outcome: "advice" as const, id: d.id };
      }
      if (input.outcome === "reissue") {
        if (d.kind === "permission") throw new AnswerError("A permission request has its command and options already. Use outcome advice to tell the owner what it does and whether to allow it.");
        // The CEO proposed this skill, so it must not get to reword the card the owner decides on (BOS-168).
        if (d.kind === "skill") throw new AnswerError("The CEO proposed this skill, so it can't rewrite this card. If something is unclear, the owner can ask the CEO about it in chat.");
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
      // A permission request may be settled here only where the routing already lets the CEO settle it
      // (a card at the CEO's tier with no owner-only hold). An owner-tier request stays the owner's.
      const maySettlePermission = d.kind === "permission" && (d.context as { type?: string }).type === "permission" && ceoAnswerRefusal(d, input.answer) === null;
      if (!maySettlePermission && !ceoCanHandle(d, raiser?.role === "ceo" || d.raisedByAgentId === input.agentId)) throw new AnswerError("Only the owner can settle this one: only an agent's plain question can be handled by the CEO, never the CEO's own request, an approval, a permission the routing leaves to the owner, or anything with steps for the owner. Rewrite it with reissue instead, or leave it for the owner.");
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

    /**
     * The CEO clears a card that is stale or a duplicate (BOS-149), with a reason the owner can read.
     * Owner-only cards may only go when their ticket is finished (never as a duplicate); system and
     * info cards may be cleared directly, except merge cards, which must be stale or duplicate.
     * Returns null when it is already settled.
     */
    async withdrawCard(input: { id: string; companyId: string; agentId: string; note: string }) {
      const note = input.note.replace(/\s+/g, " ").trim().slice(0, 500);
      if (note.length < 10) throw new AnswerError("Give a reason of at least 10 characters: the owner reads it in the audit list.");
      const [ceo] = await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId), eq(agents.role, "ceo")));
      if (!ceo) throw new AnswerError("Only the CEO withdraws a card.");
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, input.id), eq(decisions.companyId, input.companyId), eq(decisions.status, "open")));
      if (!d) return null;
      const ctx = d.context as DecisionContext & { ladder?: { rung?: string } };
      // An alert still with the Scrum Master is not the CEO's to clear (BOS-149): withdrawing it would
      // keep it from ever reaching the owner. Leave it for the ladder to hand over.
      if (ctx.ladder?.rung === "scrum_master") throw new AnswerError("This alert is still with the Scrum Master, so it isn't yours to withdraw yet. Leave it for the ladder to hand over.");
      // An alert that has climbed to the owner is theirs: withdrawing it would take it off their queue
      // without their seeing it, exactly what the ladder exists to prevent (BOS-149). The one exception
      // is a plain "Got it" system card about an agent's run (not the owner's own choice): once it is
      // stale, the CEO may clear it, as it could before the ladder handed it over (BOS-469 point 4).
      // A folded account card (account_limit) can name several agents' live failures, and `isStale` sees only
      // its first raise's ticket, so it stays out of this: it closes itself once the cause is gone (BOS-469).
      const ownerTierInfo = ctx.ladder?.rung === "owner" && isSystemCard(d) && ctx.type !== "check_stuck" && !OWNER_ONLY_ANSWER_TYPES.has(ctx.type) && !STALE_ONLY_WITHDRAW_TYPES.has(ctx.type) && (ctx as { decisionsKind?: string }).decisionsKind !== "alert:account_limit";
      if (ctx.ladder?.rung === "owner" && !ownerTierInfo) throw new AnswerError("This alert is already with the owner, so it isn't yours to withdraw. Leave it for them.");
      if (ownerTierInfo && !(await isStale(d))) throw new AnswerError("This alert is with the owner. Clear it only once it is stale (its ticket is done or cancelled).");
      // A permission request holds a live run and is the owner's alone: the CEO never withdraws it,
      // stale or not. It expires on its own (BOS-149).
      if (ctx.type === "permission") throw new AnswerError("A permission request holds a live run, so the CEO can't withdraw it. Leave it for the owner; it expires on its own.");
      // Fail closed: only system and info cards may be cleared outright, and a live merge card never:
      // it is waiting on the owner and can only be answered, not dropped (BOS-149).
      const direct = isSystemCard(d) && ctx.type !== "check_stuck";
      const staleOnly = OWNER_ONLY_ANSWER_TYPES.has(ctx.type) || STALE_ONLY_WITHDRAW_TYPES.has(ctx.type);
      if (staleOnly) {
        // Two open sign-offs or loop cards for one ticket are normal (one per round), so a duplicate
        // is not a reason to clear one of the owner's own cards: only a finished ticket is.
        if (!(await isStale(d))) {
          throw new AnswerError("This card is the owner's own choice. Withdraw it only when its ticket is finished (done or cancelled).");
        }
      } else if (!direct && !(await isStale(d)) && !(await isDuplicate(d))) {
        throw new AnswerError("This card is the owner's. Withdraw it only when it is stale (its ticket is done or cancelled) or a duplicate of another open card.");
      }
      const withdrawal: Withdrawal = { by: "ceo", agentId: input.agentId, name: ceo.name, note, at: now().toISOString() };
      const [closed] = await db
        .update(decisions)
        .set({ status: "withdrawn", answeredAt: now(), dedupeKey: null, context: { ...(d.context as object), withdrawn: withdrawal } })
        .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
        .returning({ id: decisions.id });
      if (!closed) return null;
      await record(db, { companyId: d.companyId, agentId: input.agentId, kind: "decision_withdrawn", summary: `${ceo.name} withdrew "${d.question}": ${note}`, at: now() });
      // A withdrawn card must never be left holding a ticket (BOS-149): move its hold to an identical
      // open card when there is one, so the owner's surviving question still holds it, and drop it
      // otherwise. A ticket is never blocked on a decision nobody can answer.
      const freed = await db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
      if (freed.length) {
        const subject = await cardSubject(d);
        const sibling = subject ? await openSibling(d, subject) : null;
        for (const f of freed) {
          if (sibling) {
            const [already] = await db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(and(eq(ticketDependencies.blockedTicketId, f.blockedTicketId), eq(ticketDependencies.blockerDecisionId, sibling.id)));
            if (!already) await db.update(ticketDependencies).set({ blockerDecisionId: sibling.id }).where(eq(ticketDependencies.id, f.id));
            else await db.delete(ticketDependencies).where(eq(ticketDependencies.id, f.id));
          } else {
            await db.delete(ticketDependencies).where(eq(ticketDependencies.id, f.id));
          }
          await releaseIfFree(f.blockedTicketId);
        }
      }
      return { id: d.id, name: ceo.name };
    },

    /** Withdraws a finished ticket's open merge cards (BOS-149), so a merged or closed ticket leaves no card behind. */
    async withdrawMergeCardsForTicket(ticketId: string) {
      return clearMergeCards(db, ticketId, { by: "system", note: "The ticket is finished, so its merge card no longer applies.", at: now().toISOString() });
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
      // Cards the CEO cleared as stale or duplicates (BOS-149), with the reason they gave. Kept for
      // 30 days so the owner can still trace a withdrawal after a day.
      const withdrawnSince = new Date(now().getTime() - 30 * 24 * 3_600_000);
      const withdrawn = await db
        .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context })
        .from(decisions)
        .where(and(eq(decisions.status, "withdrawn"), sql`${decisions.context}->'withdrawn'->>'by' = 'ceo'`, sql`(${decisions.context}->'withdrawn'->>'at')::timestamptz > ${withdrawnSince.toISOString()}::timestamptz`))
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
        ...withdrawn.map((r) => {
          const w = (r.context as { withdrawn: Withdrawal }).withdrawn;
          return { id: r.id, companyId: r.companyId, question: r.question.split("\n")[0]!.slice(0, 300), withdrawn: { by: w.name ?? "the CEO", note: w.note } };
        }),
        ...fromAlerts,
      ];
    },

    /** Records the answer and resumes what was waiting. Returns null if not open. */
    async answer(id: string, answer: string, extra: AnswerExtra = {}) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) {
        // A sign-off the owner pressed twice (or the CEO settled) is already answered, and the ticket page's
        // Approve and merge still merges it rather than refusing on a card that is no longer open (BOS-471).
        if (answer === APPROVE_MERGE) {
          const [row] = await db.select({ status: decisions.status, context: decisions.context }).from(decisions).where(eq(decisions.id, id));
          if (row?.status === "answered" && (row.context as DecisionContext).type === "risk_review") return { settled: "already" };
        }
        return null;
      }
      // The server's own guard (BOS-149): a CEO answer may never settle an owner-only card, whatever the tool text says.
      if (extra.settledBy) {
        // The Scrum Master settles its own alerts through `settledBy` too, so the "not yours yet" rung
        // rule only applies when the settler is the CEO (BOS-64) — the rest of the refusal does not.
        const [who] = await db.select({ role: agents.role }).from(agents).where(eq(agents.id, extra.settledBy.agentId));
        const refusal = ceoAnswerRefusal(d, answer, { ladder: who?.role === "ceo" });
        if (refusal) throw new AnswerError(refusal);
      }
      const options = d.options as string[];
      // A drop-one decision also takes the short form "Replace #12" for its numbered option.
      const short = /^Replace #(\d+)$/.exec(answer.trim());
      if (short && (d.context as DecisionContext).type === "lesson_replace") answer = options.find((o) => o.startsWith(`Replace #${short[1]}: `)) ?? answer;
      // An agent's question can be answered in the owner's own words; anything that acts on the
      // answer (a permission, a deploy, a budget) keeps to its options.
      const ownWords = extra.custom === true && d.kind === "question";
      if (extra.custom && !ownWords) throw new AnswerError("This decision needs one of its options; only an agent's question takes your own answer.");
      const handOff = (d.context as DecisionContext).type === "stale_blocker" && answer === LET_CEO_DECIDE; // also on cards raised before the option existed
      if (handOff && extra.settledBy) throw new AnswerError("Only the owner can hand this to the CEO; answer Chase, Reassign or Drop dependency.");
      if (options.length > 0 && !ownWords && !handOff && !options.includes(answer)) throw new AnswerError(`Answer must be one of: ${options.join(", ")}`);
      await validate(d, answer, extra);
      if (handOff) return handToCeo(d);
      const ctx = d.context as DecisionContext;
      // What came in while the card was open, so every later write keeps it (BOS-376). Once the answer is
      // known each repeat is marked settled, and every later write keeps those marks (so a delivery that
      // fails and is re-sent doesn't lose the audit of what this one answer settled).
      let repeatsNow = ctx.type === "permission" ? ctx.repeats : undefined;
      if (ctx.type === "model_change" && answer === MODEL_EDIT && !extra.modelConfig) throw new AnswerError("Edit needs the harness, provider, model and paid-from you want.");
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
      // Kept on the decision so the owner can see who settled it and why (BOS-111). Written on a copy, not
      // on ctx itself, so reopening a card later restores the pre-answer context without this record.
      let settled: Settled | undefined;
      let settledContext: DecisionContext | undefined;
      if (extra.settledBy) {
        const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, extra.settledBy.agentId));
        settled = { agentId: extra.settledBy.agentId, name: who?.name ?? "the CEO", note: extra.note?.trim().replace(/\s+/g, " ").slice(0, 500) || null, at: now().toISOString() };
        settledContext = { ...(ctx as object), settled } as DecisionContext;
      }
      // Conditional on still being open (and, for the CEO, still asked) and still on the same tier it
      // was read on, so whoever closes it first wins and the loser changes nothing. The tier clause
      // closes the race where the ladder hands the open card to the owner between the CEO reading it
      // and answering: the answer then matches nothing instead of closing the owner's card (BOS-159).
      const [closed] = await db
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again; so does a
        // loop alert (alert-ladder.ts), whose key only stops a repeat while it is open.
        .set({
          status: "answered",
          answer,
          answeredAt: now(),
          ...(ctx.type === "stale_blocker" || ctx.type === "check_stuck" || d.dedupeKey?.startsWith("alert:") ? { dedupeKey: null } : {}),
          ...(extra.handled ? { context: { ...(d.context as object), advice: { ...adviceOf(d.context), state: "handled", ...extra.handled } } } : settled ? { context: settledContext! } : {}),
        })
        .where(and(eq(decisions.id, id), eq(decisions.status, "open"), eq(decisions.tier, d.tier), ...(extra.by === "ceo" ? [sql`${decisions.context}->'advice'->>'state' = 'asking'`] : [])))
        .returning({ id: decisions.id });
      // A repeat of this command waited on this card (BOS-376): an Allow once settles it too, and a Deny
      // never turns into one. The card keeps what settled, so the audit shows the repeat.
      if (closed && ctx.type === "permission" && repeatsNow?.length) {
        const say = answer === ALLOW || answer === APPROVE_PLAN ? "allow" : "deny";
        // Do not ignore the send result (BOS-376 review): a repeat whose runner has dropped off is not
        // settled yet, so it is left unmarked and a reconnect resend still answers it. Only mark a repeat
        // settled once its answer has actually been sent.
        repeatsNow = repeatsNow.map((r) => (send(r.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: r.requestId, verdict: say }) ? { ...r, settled: say } : r));
        await db.update(decisions).set({ context: { ...ctx, repeats: repeatsNow } as DecisionContext }).where(eq(decisions.id, id));
      }
      if (!closed) return null;

      // Whatever else we told the owner about these tickets may now be out of date (BOS-123).
      // A permission click allowed a command; it isn't the owner doing the thing the note asked about.
      // The answer is already saved, so this can't be allowed to stop it reaching the asker or
      // releasing the tickets it blocked (BOS-175): a failure is logged, not thrown.
      if (ctx.type !== "permission") {
        try {
          const about = await decisionTicketIds(db, d);
          if (about.length) await ownerActed(db, { companyId: d.companyId, ticketIds: about, reason: `${extra.by === "ceo" ? "the CEO settled" : "the owner answered"} "${d.question.slice(0, 80)}"`, wake, now: now(), skipAgents: [d.raisedByAgentId] });
        } catch (err) {
          log(`answering decision ${id} was saved, but marking related cards out of date failed: ${(err as Error).message}`);
        }
      }

      // Watch mode (BOS-337): the judge's reading next to what the human chose, so the owner can see how often they agree before turning advice on. The reading is also kept on the decision row.
      if (ctx.type === "permission" && ctx.judge) {
        const human = answer === ALLOW || answer === APPROVE_PLAN ? "allow" : "deny";
        // With a second opinion (BOS-338) the combined advice is what is compared: Allow only when both allowed.
        const second = ctx.judge.second;
        const combined = second?.state === "deny" ? "deny" : ctx.judge.verdict;
        const secondPart = second ? ` second=${second.state}${second.state === "failed" ? ` (${second.reason})` : ""}` : "";
        log(`permission judge (${ctx.judge.mode}): decision ${id} judge=${ctx.judge.verdict} (${ctx.judge.row})${secondPart} human=${human}${human === combined ? "" : " DISAGREE"}`);
      }
      // The audit says how many repeats this one answer settled (BOS-376).
      if (ctx.type === "permission" && repeatsNow?.length) log(`permission decision ${id} settled ${repeatsNow.length} repeat(s) of the same command`);

      let delivered: boolean | null = null;
      let endedHere = false;
      if (ctx.type === "permission") {
        const allowed = answer === ALLOW || answer === APPROVE_PLAN;
        if (ctx.plan && allowed && ctx.ticketId) await db.update(tickets).set({ planApprovedAt: now() }).where(eq(tickets.id, ctx.ticketId));
        if (ctx.plan && !allowed) {
          // Sent before the verdict, so the agent picks it up as its next turn and keeps planning.
          // "Keep planning" on a later card never withdraws a plan the ticket already has approved (BOS-371).
          const [already] = ctx.ticketId ? await db.select({ at: tickets.planApprovedAt }).from(tickets).where(eq(tickets.id, ctx.ticketId)) : [];
          send(ctx.runnerId, {
            type: "run.message",
            runId: ctx.runId,
            text: already?.at
              ? `This plan wasn't approved.${extra.note ? ` Feedback: ${extra.note}` : ""} The ticket's earlier approved plan still stands; this does not undo it.`
              : `Your plan wasn't approved yet.${extra.note ? ` Feedback: ${extra.note}` : ""} Revise the plan and present it again with ExitPlanMode.`,
            interrupt: false,
          });
        }
        const [permRun] = await db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, ctx.runId));
        delivered = send(ctx.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: allowed ? "allow" : "deny" });
        const [asked] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, ctx.runId));
        permLog.answer({ companyId: d.companyId, runId: ctx.runId, agentId: asked?.agentId ?? null, ticketId: asked?.ticketId ?? null, decisionId: id, answeredBy: extra.settledBy ? "ceo" : "owner", answer });
        if (!delivered && permRun?.endedAt) {
          // The agent has finished, so there is nothing to deliver to: record that and don't alarm the owner (BOS-342).
          await db.update(decisions).set({ context: { ...ctx, ...(repeatsNow ? { repeats: repeatsNow } : {}), delivered: "run_ended" } }).where(eq(decisions.id, id));
        } else if (!delivered) {
          // Never fail silently (R22): flag it, and re-send when the runner reconnects.
          await db.update(decisions).set({ context: { ...ctx, repeats: repeatsNow, delivered: false } }).where(eq(decisions.id, id));
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
            update: ctx.update,
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
      } else if (ctx.type === "model_change") {
        if (answer !== MODEL_REJECT) {
          try {
            const config = answer === MODEL_EDIT ? extra.modelConfig! : ctx.proposed;
            const applied = (await onModelChange?.(ctx, d.companyId, config)) ?? { afterRunId: null };
            await db
              .update(decisions)
              .set({ context: { ...ctx, applied: { at: now().toISOString(), afterRunId: applied.afterRunId, config } } })
              .where(eq(decisions.id, id));
          } catch (err) {
            // Nothing changed, so leave the card open for another try.
            await db.update(decisions).set({ status: "open", answer: null, answeredAt: null }).where(eq(decisions.id, id));
            throw err instanceof AnswerError ? err : new AnswerError((err as Error).message);
          }
        }
      } else if (ctx.type === "skill") {
        try {
          await onSkill?.(ctx, d.companyId, answer, extra.by ?? "the owner");
        } catch (err) {
          // Not an expected refusal: keep the question open so the answer can be given again.
          // Restore the pre-answer context, so a CEO's settled-by record doesn't stay on the reopened card.
          await db.update(decisions).set({ status: "open", answer: null, answeredAt: null, context: d.context as object }).where(eq(decisions.id, id));
          throw err;
        }
      } else if (ctx.type === "hire" || ctx.type === "instructions" || ctx.type === "rename") {
        try {
          await onAgentDecision?.(ctx, d.companyId, answer === "Hire" || answer === "Apply the change");
        } catch (err) {
          // Nothing was hired or changed (a setup that no longer validates, or a card from before
          // the setup was checked), so leave the card open for another try.
          await db.update(decisions).set({ status: "open", answer: null, answeredAt: null }).where(eq(decisions.id, id));
          const message = err instanceof Error ? err.message : String(err);
          throw err instanceof AnswerError ? err : new AnswerError(`${ctx.type === "hire" ? "Nobody was hired" : "Nothing was changed"}: ${message} The card is still open for another try.`);
        }
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
        // The sign-off is answered: any "sign-off still waiting" retry card for this ticket is stale now (BOS-446), and the merge starts below.
        await clearMergeCards(db, ctx.ticketId, { by: "system", note: "The owner's sign-off was answered, so this retry card is no longer needed.", at: new Date().toISOString() });
        if (answer === APPROVE_MERGE) await loopHooks?.land(ctx.ticketId, "the owner", extra.merge);
        else await loopHooks?.sendBack(ctx.ticketId, `The owner sent this back.${extra.note ? ` ${extra.note}` : ""}`, "the owner");
      } else if (ctx.type === "check_stuck") {
        if (answer === CHECK_SEND_BACK) await loopHooks?.sendBack(ctx.ticketId, `The review was approved, but ${ctx.command ? `the check \`${ctx.command}\`` : "the merge"} couldn't finish, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${ctx.output}`, "the owner");
        else
          try {
            await loopHooks?.landAgain(ctx.ticketId, answer === CHECK_SKIP);
          } catch (err) {
            // The retry couldn't start: keep the card open so the answer can be given again.
            // Restore the pre-answer context, so a CEO's settled-by record doesn't stay on the reopened card.
            await db.update(decisions).set({ status: "open", answer: null, answeredAt: null, context: d.context as object }).where(eq(decisions.id, id));
            throw new AnswerError(`The check wasn't run again: ${(err as Error).message}`);
          }
      } else if (ctx.type === "lesson") {
        await answerLessons(d, ctx, answer, extra);
        await retroHook?.lessonAnswered(id, answer, extra.note);
      } else if (ctx.type === "workflow_change") {
        await retroHook?.answered(ctx.changeId, answer, { reason: extra.note!, reasonLink: extra.reasonLink?.trim() || null, decidedBy: extra.settledBy ? "ceo" : "owner" });
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

    /** The agent that raised a card takes it back (BOS-123); what it blocked can move again. */
    async withdraw(id: string, actor: { agentId: string | null }, reason?: string) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      if (!actor.agentId || d.raisedByAgentId !== actor.agentId) throw new AnswerError("You can only withdraw a decision you raised.");
      // Only a question asked through raise_decision may be taken back. System cards that also
      // record an agent (owner sign-off, permission, deploy, engagement, lesson, review loop,
      // ticket cap, stalled run) must go through their own answer path: withdrawing a risk_review
      // card would delete the dependency and let the ticket merge without the owner's sign-off.
      const type = (d.context as { type?: string } | null)?.type;
      if (d.kind !== "question" || type !== "question") throw new AnswerError("Only a question card you raised with raise_decision can be withdrawn; this card belongs to another flow and has to be answered.");
      const [closed] = await db.update(decisions).set({ status: "withdrawn", answeredAt: now(), dedupeKey: null }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning({ id: decisions.id });
      if (!closed) return null;
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      for (const f of freed) await releaseIfFree(f.ticketId, false);
      await record(db, { companyId: d.companyId, agentId: actor.agentId, ticketId: freed[0]?.ticketId, kind: "decision_withdrawn", summary: `Withdrew "${d.question}"${reason ? `: ${reason}` : ""}`, at: now() });
      return { id, withdrawn: true };
    },
  };
}
