// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { randomUUID } from "node:crypto";
import { createPermissionLog, type PermissionLog } from "./permission-log.js";
import { leaveClosedNotice, leaveWithdrawnNotice, parseReplacedBy, switchedBackNotice, withdrawnNotice, type ClosedNotice, type ReplacedBy } from "./closed-notice.js";
import type { NotifyInput } from "./notifications.js";
import { applyFenceAnswer, applyFenceUnavailableAnswer, applyGuardAnswer, checkFenceAnswer } from "./fence-default.js";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  ruleProblems,
  isBossmanCall,
  readCriteria,
  criterionText,
  criteriaForCard,
  isAfterMerge,
  unreportedAfterMerge,
  ruleFor,
  rankDecision,
  orderOwnerCards,
  ticketRef,
  recommendedVerdict,
  isJudgeable,
  judgePermission,
  commandOf,
  type JudgeReading,
  type PermissionJudgeMode,
  TEMP_CLEANUP_AUTO_RULE,
  TEMP_CLEANUP_RULE,
  UNKNOWN_TOOL_RULE,
  UNMATCHED_RULE,
  WORKING_COPY_RULE,
  cleanupScope,
  type BlockedTicket,
  type OrderLink,
  alwaysChoices,
  explainPermission,
  ownerWhy,
  formatDate,
  cardAnswerLine,
  optionVerdictsRefusal,
  type OptionVerdicts,
  type AlwaysChoice,
  type AlwaysScope,
  type PermissionExplanation,
  type PermissionInfo,
  type PolicyMatch,
  type PolicyOutcome,
  type PolicyRuleSpec,
  type RunnerCommand,
  type RunnerEvent,
  untrusted,
  PLAN_REAL_USE_MISSING,
  realUseWalkthrough,
  usabilityGated,
  splitOwnerSteps,
  type StepSource,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import type { SecondOpinionCard, SecondOpinionResult } from "./second-opinion.js";
import { record, record as recordActivity } from "./activity.js";
import { systemMoveTicket } from "./ticket-transition.js";
import { REVIEW_REASON } from "./review-kinds.js";
import { signoffFacts, type SignoffFacts } from "./signoff-facts.js";
import { planOverlapNote as overlapNoteOf, planOverlaps } from "./merge-line-conflicts.js";
import { type CardLint, type HostFacts, type LintFinding, type SelfDeployFacts, NOT_OVERRIDABLE, THIS_HOST_POINTER, fillHostTokens, fillServerHost, lintLines, lintOwnerSteps, parseProof } from "./steps.js";
import { HOST_TOKEN_HELP, type OwnerSetupFacts, checkOwnerSetup } from "./owner-setup-check.js";
import { type CompanyFacts, fillCompanyFacts, loadCompanyFacts } from "./company-facts.js";
import { type OwnerRecordFacts, fillOwnerSetupTokens, usesOwnerSetupToken } from "./owner-record.js";
import type { Addon, AddonFacts } from "./addons.js";
import { addTicketDependency, blockedHolds } from "./ticket-links.js";
import { revokeApproveTokens } from "./approve-tokens.js";
import { ATTACHMENT_LINK } from "./ticket-images.js";
import type { Ladder } from "./alert-ladder.js";
import { recordGoalAnswer } from "./goal-check.js";
import { applyPortalAnswer } from "./feature-portal.js";
import { APPLY_CHANGE, REVERT_CHANGE, checkChangeLink, checkChangeReason } from "./retro.js";
import { ADD_RULE, policyRulesService } from "./policy-rules.js";
import { effectivePolicy, resolveActor } from "./review-policy.js";
import { LESSONS_CAP, LESSON_DONT_ADD, LESSON_EDIT, LESSON_DROP, LESSON_MAX, lessonsFrom, lessonsPageRow, normalizeLesson, writeLesson } from "./project-brief.js";
import { agents, budgetPolicies, companies, decisions, deploys, engagementMessages, engagements, keyResults, milestones, notifications, objectives, policyRules, projects, runnerEvents, runners, runs, ticketArtifacts, ticketDependencies, ticketMessages, tickets, wakes, watchdogActions, wikiPages } from "../db/schema.js";
import type { ClearWhen } from "./alert-clearing.js";
import { unlinkedWaiters } from "./owner-todo.js";
import { decisionTicketIds, ownerActed, recentOwnerAnswer, quotedAnswer, similarQuestion } from "./stale-requests.js";
import { openReviewProposal } from "./skill-proposals.js";
import { lineEvent } from "./merge-line.js";
import { mergeContext } from "./decision-context.js";
import { cardInvalidReason, closeCardBySystem, isCheckableCard, hiddenWhileRechecked, holdsLiveRun } from "./card-validity.js";
import { runFolder } from "./run-folder.js";
import { runCapabilities } from "./run-capabilities.js";

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

/** A do-this-next link the raiser asked for but that wasn't stored (BOS-625), and why. */
export type DroppedOrderLink = { decisionId: string; link: "doAfter" | "doBefore"; reason: "another company" | "not open" | "unknown" };

/**
 * Do-this-next links (BOS-551) that point at a card the raiser may legitimately order against:
 * an open decision in the caller's own company (BOS-625). A link to another company's card, or to
 * an answered one, is dropped rather than stored, so one company can't nudge another's queue order.
 * The queue already ignores ids it can't see; this keeps the bad link out of the card in the first place.
 * Each dropped link comes back with its reason, so raise_decision's reply can say which weren't applied.
 */
async function keepOpenInCompany<T extends OrderLink>(db: Db, companyId: string, links: T[] | undefined, link: DroppedOrderLink["link"]): Promise<{ kept?: T[]; dropped: DroppedOrderLink[] }> {
  if (!links?.length) return { dropped: [] };
  const ids = [...new Set(links.map((l) => l.decisionId))];
  const rows = await db.select({ id: decisions.id, companyId: decisions.companyId, status: decisions.status }).from(decisions).where(inArray(decisions.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Judged once per id, so a link asked for in both directions is reported once.
  const why = new Map(ids.map((id): [string, DroppedOrderLink["reason"] | null] => {
    const r = byId.get(id);
    if (!r) return [id, "unknown"];
    if (r.companyId !== companyId) return [id, "another company"];
    if (r.status !== "open") return [id, "not open"];
    return [id, null];
  }));
  const kept = links.filter((l) => why.get(l.decisionId) === null);
  const dropped = ids.flatMap((id) => { const reason = why.get(id); return reason ? [{ decisionId: id, link, reason }] : []; });
  return { ...(kept.length ? { kept } : {}), dropped };
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

/** A marked ticket in a deploy card's range (BOS-639): the live symptom it fixes, in its author's words. */
export type LiveFix = { ticketId: string; ref: string; symptom: string };
/**
 * A deploy card that carries the fix for a live problem (BOS-639). `heading` leads the card, the phone push
 * and the CEO's wake. `repeat`: every fix on it was already on an earlier card, so it isn't paged again
 * (the owner was paged once per fix, not once per commit main moves on by).
 */
export type DeployUrgent = {
  heading: string;
  /** BOS-1516: for "ready" these are the Priority 1 tickets that merged (`symptom` holds the ticket's title); same shape so repeat suppression is shared. */
  fixes: LiveFix[];
  repeat?: boolean;
  /** "ready": the owner's Priority 1 work is merged and ready to put live (heading "Ready to put live"). Absent: a live fix. */
  kind?: "ready";
};

/** Longest "fixes live" marker: one sentence, short enough to head a card and fit a phone push title. */
export const FIXES_LIVE_MAX = 200;
/** Why a "fixes live" marker can't be stored, or null when it's fine (one line, one short sentence). */
export function fixesLiveProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/[\r\n]/.test(t)) return "fixesLive must be one line: one sentence naming the live symptom, e.g. \"server freezes as memory climbs\".";
  if (t.length > FIXES_LIVE_MAX) return `fixesLive must be at most ${FIXES_LIVE_MAX} characters: one sentence naming the live symptom.`;
  return null;
}
/** The words that head an urgent deploy card and the CEO's wake (BOS-639): "Urgent: contains the fix for <symptom> (BOS-n)". */
export function fixesLiveHeading(fixes: Array<{ symptom: string; ref: string }>): string {
  const clean = (s: string) => s.trim().replace(/[.!\s]+$/, "");
  const [first, ...rest] = fixes;
  if (!first) return "";
  const also = rest.length ? `; also ${rest.map((f) => `${clean(f.symptom)} (${f.ref})`).join("; ")}` : "";
  return `Urgent: contains the fix for ${clean(first.symptom)} (${first.ref})${also}`;
}

/** BOS-1516: the heading of a deploy card that carries the owner's Priority 1 work: "Ready to put live: <title> (BOS-n)". */
export function readyHeading(items: Array<{ symptom: string; ref: string }>): string {
  const clean = (s: string) => s.trim().replace(/[.!\s]+$/, "");
  const [first, ...rest] = items;
  if (!first) return "";
  const also = rest.length ? `; also ${rest.map((f) => `${clean(f.symptom)} (${f.ref})`).join("; ")}` : "";
  return `Ready to put live: ${clean(first.symptom)} (${first.ref})${also}`;
}

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string; /** The tool call this was raised for and its title: a later request for the same call is covered by an Allow here. */ toolCallId?: string; toolTitle?: string | null; /** The whole tool input, normalised, so only an exact repeat matches this card (BOS-376). */ toolInput?: string; plan?: boolean; ticketId?: string | null; explain?: PermissionExplanation; /** What the rules judge made of it and the company setting at the time (BOS-337); the human's answer is logged next to it. */ judge?: JudgeNote; always?: AlwaysChoice[]; /** The agent that asked, so an "always" rule can be limited to it (BOS-294). */ alwaysAgent?: { id: string; name: string }; /** Temp-file cleanup, sent to the CEO first (BOS-111). */ tempCleanup?: boolean; /** Deletes in the agent's working copy, sent to the CEO first (BOS-120). */ workingCopy?: WorkingCopy; /** Who on the team settled it, and why (BOS-111 audit). */ settled?: Settled; /** A repeat of a command this run already had an Allow once for (BOS-376): the card answered at once, with sameAs. */ settledByRepeat?: { sameAs: string; at: string }; /** A repeat of the same command in the same run, settled from this card when its answer arrives (BOS-376). */ repeats?: Array<{ requestId: string; runnerId: string; at: string; settled?: "allow" | "deny" }> }
  | { type: "engagement"; engagementId: string }
  | { type: "question"; /** Why only the owner can take this card (BOS-1318). Counted by Moony; the CEO may never answer one. */ ownerOnly?: OwnerOnlyKind; ownerOnlyWhy?: string; /** What the agent tried first, and why only the owner can do this. */ triedFirst?: string; /** Numbered steps when the owner must do something, with no checker tags (BOS-1665). */ steps?: string[]; /** Where each step's clicks came from (R19), by step; the owner reads a muted line from it, never the tag. */ stepSources?: Array<StepSource | null>; /** Why this ask is still fresh even though the owner answered something like it before (BOS-123). */ stillNeeded?: string; /** The owner has to act (BOS-243 rule 1: never phone-approvable). */ ownerMustDo?: true; /** The raiser marked it as holding the linked ticket's merge until it is answered (BOS-1078); without it the card never holds a merge. */ holdsMerge?: true; /** One line, by the asking agent, on what the recommended option does: the phone Approve text (BOS-243). */ approveSummary?: string; /** What the owner-step lint flagged, and a CEO override (BOS-417). */ lint?: CardLint; /** A plan put by submit_plan for a plan-first ticket that has no ExitPlanMode (BOS-531): approving it sets planApprovedAt. */ plan?: boolean; ticketId?: string; /** The after-merge criteria this card settles, as 0-based indexes into the ticket's list (BOS-963): the owner's answer records those, whatever its wording. Unset means the card's own words decide. */ criterionIndexes?: number[]; /** What each option means for those criteria, by option text: pass, fail or none (BOS-1155). The only thing that turns an answer into a verdict. */ optionVerdicts?: Record<string, "pass" | "fail" | "none">; /** Ordering against other owner cards (BOS-551): this one has to be done after these. */ doAfter?: OrderLink[]; /** Ordering against other owner cards: this one has to be done before these. */ doBefore?: OrderLink[]; /** A restart of the server would reset what this card measures, so a server update card lists it to do first (BOS-551). */ resetsOnRestart?: boolean }
  | { type: "stale_blocker"; dependencyId: string; blockedTicketId: string; blockerTicketId: string | null; blockerEngagementId: string | null }
  | { type: "stalled_run"; runnerId: string; runId: string }
  | { type: "deploy"; deployId: string; /** BOS-1516: the owner's Priority 1 work is in this deploy: the card is marked urgent, headed "Ready to put live". */ urgent?: DeployUrgent }
  /** The follow-up after a feature ships: did it move its key result? */
  | { type: "goal_check"; featureId: string }
  /** A feature held off the portal (the security guess or a keep-off mark): the owner keeps it off or publishes it (BOS-1358). */
  | { type: "feature_portal_hold"; featureId: string }
  /**
   * An approved decision whose next step is the owner's own (BOS-122): a deploy whose target has to be
   * applied by hand. It stays open as a to-do on the owner's queue until they mark it done or the live
   * commit is confirmed to have changed. `ofDecisionId` names the approval it came from; `steps`, `check`
   * and `rollback` are shown on the card. `fromCommit` is what ran when it was approved: once the live
   * commit differs, the hand-apply reached the host (BOS-122). `lastFailure` keeps the owner's note from
   * "A step failed" on the card.
   */
  | { type: "owner_todo"; ofDecisionId: string; steps: string[]; ownerMustDo?: true; check?: string; rollback?: string; /** What the to-do applies: a self-deploy's target and commit, or a deploy target's deploy id. */ target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string; lastFailure?: { note: string; at: string }; /** What the approved update contains, so the to-do says the same as the card (BOS-213). */ update?: DeployUpdate; /** Owner cards that must be done first, because this update restarts the server (BOS-551). */ doAfter?: OrderLink[]; /** When the owner last opened its steps (BOS-739). */ ownerOpenedAt?: string; /** Why Boss Man closed it, shown where it was (BOS-739). */ closedNotice?: ClosedNotice; /** A server update's quiet-machine check, while the owner waits to apply it by hand (BOS-420). */ quiet?: { ready: boolean; runs: number; checks: number; freeMb: number | null; needMb: number | null; why: string[]; at: string } }
  /**
   * The owner's setup steps for a ticket, raised by Boss Man once the ticket's change is live (DR-011).
   * `ticketId` links it back; `commit` is the live commit it was raised on, so a later switch-back to
   * before that commit withdraws it. Steps are the ticket author's words, checked by review.
   * `tickets` lists every ticket going live with identical steps that share this one card (BOS-741); it
   * always starts with `ticketId`, and a card with one ticket is the same card DR-011 raised before.
   */
  | { type: "owner_setup"; ticketId: string; tickets?: { ticketId: string; title: string }[]; steps: string[]; commit: string }
  /** Boss Man updating itself through the host deployer; `infra` ones are only an alert (the owner deploys those by hand on the host). */
  | { type: "self_deploy"; target: "server" | "runner"; commit: string; fromCommit: string; runnerChanged?: boolean; /** Runner card only (DR-042 point 5): the live tickets whose only setup step is the runner update and whose merge the runners lack, named when the card was raised. */ tickets?: { ticketId: string; title: string }[]; /** Runner card only: raised by the owner's Build and update runners button, so it is never closed under them. */ requested?: boolean; infra?: boolean; /** Commit subjects, so the "updated" note says what changed. */ changes?: string[]; /** For an infra change the owner applies by hand: numbered steps, how to check it worked, and how to roll back. */ handSteps?: string[]; check?: string; rollback?: string; /** What the update contains, in plain words (BOS-213). */ update?: DeployUpdate; /** It carries the fix for a live problem (BOS-639): headed, paged once and sorted first. */ urgent?: DeployUrgent; result?: { result: string; message: string; at: string }; /** Owner cards to do first, because this update restarts Boss Man (BOS-551). */ doAfter?: OrderLink[]; /** When the owner last opened its hand-apply steps (BOS-739). */ ownerOpenedAt?: string; /** Why Boss Man closed it, shown where it was (BOS-739). */ closedNotice?: ClosedNotice }
  /** The runner update's deadline question (services/maintenance.ts): stop the rest, wait more, or cancel. */
  | { type: "maintenance"; since: string; /** BOS-1377: the runs the card listed; "Stop these" touches no others. Absent on an older card. */ runIds?: string[] }
  /** An approved server update still waiting for a quiet machine (services/deploy-wait.ts, BOS-420): keep waiting, update now, or cancel. */
  | { type: "deploy_wait"; approvedAt: string }
  | { type: "review_loop"; ticketId: string; message: string; reviewer: string; /** The failed checks the "move to after the merge" choice would move (BOS-422). */ movable?: string[] }
  /** A review woken this round again and again with no verdict (BOS-404, BOS-426): the CEO acts on it. */
  | { type: "review_stall"; ticketId: string; reviewId: string; reviewerAgentId: string; kind: string }
  | { type: "ticket_cap"; ticketId: string }
  | { type: "project_cap"; projectId: string }
  /** A run stopped for passing the company's per-run time limit (BOS-846); "Raise the limit" lifts it by half. */
  | { type: "run_time_limit"; companyId: string; runId: string; minutes: number }
  /** A company still at the old unchosen fence Off, on a runner that can fence (BOS-940): switch to Watch or keep Off. */
  | { type: "fence_default" }
  /** A company's agent work held because its runner can't fence (BOS-373): run agents without the fence, or keep them stopped. */
  | { type: "fence_unavailable" }
  /** A company's agent work held because its runner's network guard isn't proven on (DR-049 point 1, BOS-938). */
  | { type: "guard_unavailable" }
  | { type: "budget_limit"; policyId: string }
  /**
   * The owner's sign-off (R48). `head` and `risk` are what was reviewed when the card was raised; "Approve and merge"
   * by the owner copies them into `signedOff`, so a later round on the same commit reuses it (DR-013).
   */
  | ({ type: "risk_review"; ticketId: string; reviewer: string; head?: string; risk?: string; signedOff?: { head: string; risk: string | null; at: string; by: "owner" }; /** A real conflict with a branch ahead in the merge line (BOS-1411): one line, never a hold. */ conflictsBecause?: string } & Partial<SignoffFacts>)
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
  /** A change to the company's standing rules (BOS-353), applied when the owner approves. */
  | { type: "standing_rules"; text: string; byAgentId: string }
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
/** The stuck-review card's third choice (BOS-422): offered when the reviewers fail only checks that need the live work. */
export const MOVE_AFTER_MERGE = "Move these checks to after the merge";
export const CHECK_AGAIN = "Run the check again";
export const CHECK_SEND_BACK = "Send it back to the agent";
export const CHECK_SKIP = "Merge without the check";
/** A stalled review (BOS-404, BOS-426): real actions on the review instead of "Got it". */
export const TAKE_REVIEW = "Take the review myself";
export const REASSIGN_REVIEW = "Give it to another reviewer";
export const SEND_BACK_FOR_MERGE = "Send it back to the author";
export const WAIT_ANOTHER_HOUR = "Leave it another hour";
export const REVIEW_STALL_ACTIONS = [TAKE_REVIEW, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, WAIT_ANOTHER_HOUR];
/** An owner to-do (BOS-122): the approved deploy still needs the owner's own hand. */
export const TODO_DONE = "Done, it's applied";
export const TODO_FAILED = "A step failed";
/** The approval for a change that has to be applied by hand: approving it leaves a to-do rather than deploying. */
export const APPROVE_HAND_APPLY = "Approve";
/** A hand-applied server update's to-do (BOS-420): make room on the machine before the owner applies it. */
export const QUIET_FIRST = "Quiet the machine first";

/** Who ended a card without answering it, and why (BOS-149): the CEO clears a stale or duplicate card, or the product does. */
/** The "replaced by" fields of a withdraw call, as the tool received them (DR-058 B). */
export type Replacement = { replacedBy?: string; when?: string };
export type Withdrawal ={ by: "ceo" | "system"; agentId?: string; name?: string; note: string; at: string; /** Set when a newer plan card replaced this one (BOS-1219). */ newer?: { id: string; author: string | null; at: string } };

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
  // BOS-1318: a card marked owner-only stays the owner's even if a row were ever left on the CEO's tier.
  if (ctx.type === "question" && (ctx.ownerOnly || ctx.ownerMustDo)) return "This card is marked as the owner's alone (a secret, money, a host step, a sign-off or an owner choice), so only they can answer it. Leave it for them; if they asked for your advice, use action advise.";
  if (ctx.type === "review_stall" && answer !== undefined && !REVIEW_STALL_ACTIONS.includes(answer)) return `On a stalled review, choose one of: ${REVIEW_STALL_ACTIONS.join(", ")}.`;
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
  "owner_setup",
  "maintenance",
  "deploy_wait",
  "hire",
  "instructions",
  "rename",
  "standing_rules",
  "model_change",
  "team_plan",
  "risk_review",
  "budget_limit",
  "engagement",
  "project_cap",
  "run_time_limit",
  "fence_default",
  "fence_unavailable",
  "guard_unavailable",
  "ticket_cap",
  "rule_proposal",
  "goal_check",
  "feature_portal_hold",
]);

/**
 * Cards the CEO may withdraw only when their ticket is finished, never as a duplicate (BOS-149).
 * Two review-loop or merge cards about one ticket can be open at once, and each holds the owner's
 * choice: dropping one as a "duplicate" would take away that choice.
 */
const STALE_ONLY_WITHDRAW_TYPES = new Set(["review_loop", "check_stuck"]);

/**
 * Withdraws the open "must merge first" cards the carried-work gate raised on this ticket (BOS-733) once every
 * ticket a card names is done, so the card stops holding a merge that can now go ahead. A card still naming an
 * unfinished ticket stays.
 */
export async function clearCarriedCards(db: Db, ticketId: string, withdrawal: Withdrawal) {
  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'carried'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`));
  let cleared = 0;
  for (const r of rows) {
    const named = ((r.context as { carried?: unknown[] }).carried ?? []).filter((id): id is string => typeof id === "string");
    if (!named.length) continue;
    // Merged counts as well as done: a ticket with an after-merge check left is merged but back in progress.
    const open = await db.select({ id: tickets.id }).from(tickets).where(and(inArray(tickets.id, named), ne(tickets.systemState, "done"), isNull(tickets.mergeCommit)));
    if (open.length) continue;
    const [done] = await db
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: new Date(withdrawal.at), dedupeKey: null, context: mergeContext({ withdrawn: withdrawal }) })
      .where(and(eq(decisions.id, r.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) {
      cleared++;
      await markDecisionNotificationRead(db, r.id, new Date(withdrawal.at));
    }
  }
  return cleared;
}

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
      .set({ status: "withdrawn", answeredAt: new Date(withdrawal.at), dedupeKey: null, context: mergeContext({ withdrawn: withdrawal }) })
      .where(and(eq(decisions.id, r.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) {
      cleared++;
      await markDecisionNotificationRead(db, r.id, new Date(withdrawal.at));
    }
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
      .set({ status: "withdrawn", answeredAt: new Date(withdrawal.at), dedupeKey: null, context: mergeContext({ withdrawn: withdrawal }) })
      .where(and(eq(decisions.id, r.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) {
      cleared++;
      await markDecisionNotificationRead(db, r.id, new Date(withdrawal.at));
      await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, r.id));
    }
  }
  return cleared;
}

/**
 * One open plan card per ticket (BOS-1161): a new plan for the ticket closes the older open plan cards for it, recorded
 * as "superseded by <new card>". Until now only the owner could clear them, so a revised plan left duplicates (BOS-373, BOS-382).
 * A plan card whose run is still alive stays: that run is waiting on its answer, and closing it would leave the run hanging.
 * Both shapes count: the plan an agent submits (a question card with plan) and ExitPlanMode's (a permission card with plan).
 */
export async function supersedePlanCards(db: Db, input: { companyId: string; ticketId: string; newCardId: string; now?: Date; release?: (ticketId: string) => Promise<unknown>; /** Who wrote the new plan, named in the closed card's note (BOS-1219). */ author?: string | null; /** Called for each closed card the owner had asked the CEO about (BOS-1219): moves that request to the new card. */ carryAdvice?: (from: { id: string; advice: Advice }) => Promise<unknown> }) {
  const at = input.now ?? new Date();
  const rows = await db
    .select({ id: decisions.id, question: decisions.question, companyId: decisions.companyId, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "open"), ne(decisions.id, input.newCardId), sql`${decisions.context}->>'ticketId' = ${input.ticketId}`, sql`${decisions.context}->>'plan' = 'true'`, sql`${decisions.context}->>'type' in ('permission', 'question')`));
  // BOS-1219: says what replaced it (card, author, time), on the closed card and in the audit list.
  const note = `Superseded by card ${input.newCardId} (newer plan from ${input.author ?? "an agent"}, ${at.toISOString()})`;
  let cleared = 0;
  for (const r of rows) {
    // BOS-1193: the shared close path, so the old card's approve links are revoked and its ticket is released too.
    if (await holdsLiveRun(db, r.context)) continue;
    if (await closeCardBySystem(db, r, note, { markRead: (id, when) => markDecisionNotificationRead(db, id, when), release: input.release, now: () => at, newer: { id: input.newCardId, author: input.author ?? null, at: at.toISOString() } })) {
      cleared++;
      // BOS-1219: the owner's open "Ask the CEO" request moves to the new card. Only a request that was still open is moved.
      const advice = adviceOf(r.context);
      if (advice?.state === "asking" && input.carryAdvice) await input.carryAdvice({ id: r.id, advice }).catch(() => undefined);
    }
  }
  return cleared;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  await lineEvent(db, t, { event: "hold_started", hold: "card", note: `the merge didn't finish: ${why}`.slice(0, 200) });
  return db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `"${t.title}" was approved, but its merge didn't finish (${why}). This isn't a problem with the agent's work.${fix}`,
      options: [CHECK_AGAIN, CHECK_SEND_BACK],
      recommendedOption: CHECK_AGAIN,
      // The CEO first, like a stuck check (BOS-1015): it can run the check again or send the work back; skipping the check stays the owner's.
      tier: "ceo",
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
  t: { companyId: string; question: string; key: string; steps: string[]; check?: string; rollback?: string; ofDecisionId: string; raisedByAgentId?: string | null; target?: "server" | "runner"; commit?: string; fromCommit?: string; deployId?: string; update?: DeployUpdate; doAfter?: OrderLink[]; /** Offer "Quiet the machine first" (a hand-applied server update, BOS-420). */ quietFirst?: boolean },
) {
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: t.question,
      options: t.quietFirst ? [QUIET_FIRST, TODO_DONE, TODO_FAILED] : [TODO_DONE, TODO_FAILED],
      recommendedOption: t.quietFirst ? QUIET_FIRST : TODO_DONE,
      tier: "owner",
      raisedByAgentId: t.raisedByAgentId ?? null,
      dedupeKey: t.key,
      context: { type: "owner_todo", ofDecisionId: t.ofDecisionId, steps: t.steps, ownerMustDo: true, ...(t.check ? { check: t.check } : {}), ...(t.rollback ? { rollback: t.rollback } : {}), ...(t.target ? { target: t.target } : {}), ...(t.commit ? { commit: t.commit } : {}), ...(t.fromCommit ? { fromCommit: t.fromCommit } : {}), ...(t.deployId ? { deployId: t.deployId } : {}), ...(t.update ? { update: t.update } : {}), ...(t.doAfter?.length ? { doAfter: t.doAfter } : {}) } satisfies DecisionContext,
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id });
  return row ?? null;
}

/**
 * Marks a settled card's notification read at the moment it is answered or withdrawn (BOS-413), so the
 * owner's feed is right without the GET path having to sweep every notification on every poll. A
 * background sweep is kept as a safety net for cards closed outside these helpers.
 */
export async function markDecisionNotificationRead(db: Db, decisionId: string, at: Date = new Date()) {
  await db.update(notifications).set({ readAt: at }).where(and(eq(notifications.decisionId, decisionId), isNull(notifications.readAt)));
  // BOS-1097: the card is settled, so take its push off the phone. Fire and forget: the answer never waits
  // on ntfy and never fails because of it (the clear writes its own failure on the notification).
  if (settledListener) void Promise.resolve(settledListener(decisionId)).catch(() => undefined);
}

// lost on restart, harmless because app.ts wires the listener again at every start
let settledListener: ((decisionId: string) => unknown) | null = null;
/** Wired in app.ts to the notifications service's clearPush (BOS-1097). */
export function setDecisionSettledListener(fn: ((decisionId: string) => unknown) | null) {
  settledListener = fn;
}

/** The dedupe key for a ticket's owner setup card (DR-011): one per ticket, ever. */
export const ownerSetupKey = (ticketId: string) => `owner-setup:${ticketId}`;

/**
 * The owner's setup card for the tickets whose change is now live (DR-011, BOS-741). `steps` is the author's
 * text, already through the card check, and shared by every ticket in `tickets` (identical after normalising
 * whitespace): one card lists them all, so one Done clears it for every one. The key is the first ticket's,
 * the same key DR-011 used when a ticket was alone, so a repeat go-live pass can't stack a second card.
 * Returns the row, or null when a card is already open for the first ticket.
 */
export async function raiseOwnerSetup(db: Db, t: { companyId: string; tickets: { ticketId: string; title: string }[]; steps: string[]; commit: string; facts?: OwnerSetupFacts; override?: string | null }) {
  const [first, ...others] = t.tickets;
  if (!first) return null;
  // DR-052: the same fill and card check every owner card gets, on the text the owner will read: host tokens are
  // filled from the deployer's report (or, unreported, become a pointer to where Boss Man shows them), then the
  // whole lint runs. Steps that fail never reach the owner and are never dropped either: the CEO gets a card to fix
  // them, and the owner's card goes out on a later pass once they pass (release-log.ts retries while it is open).
  // DR-057: other companies' records are read here, per card, by the server (an agent can't see them).
  const company = t.facts?.company ?? (await loadCompanyFacts(db, t.companyId, t.steps));
  const check = checkOwnerSetup(t.steps, { ...(t.facts ?? {}), ...(company ? { company } : {}) }, "raise");
  const override = t.override?.trim() || null;
  if (check.hard.length || (check.soft.length && !override)) {
    await raiseOwnerSetupFix(db, { companyId: t.companyId, tickets: t.tickets, findings: [...check.hard, ...check.soft], commit: t.commit });
    return null;
  }
  const unknownHost = check.generic ? `\n\nBoss Man doesn't know this server's folders yet, so where a step needs one it says where to look it up (${THIS_HOST_POINTER}).` : "";
  const overridden = check.soft.length && override ? `\n\nThe CEO let these steps past Boss Man's card check: ${override}` : "";
  const heading =
    others.length === 0
      ? `"${first.title}" is live.`
      : others.length === 1
        ? `"${first.title}" and "${others[0]!.title}" are live.` // two read better than a list of two
        : `${t.tickets.length} tickets are live: ${t.tickets.map((x) => `"${x.title}"`).join(", ")}.`;
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `${heading}${others.length ? " To start using them all:" : " To start using it:"}\n\n${check.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}${unknownHost}${overridden}`,
      options: [TODO_DONE],
      recommendedOption: TODO_DONE,
      tier: "owner",
      dedupeKey: ownerSetupKey(first.ticketId),
      context: { type: "owner_setup", ticketId: first.ticketId, tickets: t.tickets, steps: check.steps, commit: t.commit } satisfies DecisionContext,
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id, companyId: decisions.companyId });
  if (!row) return null;
  // The steps went out, so a CEO card about them is done with (DR-052).
  for (const x of t.tickets) await clearOwnerTodo(db, ownerSetupFixKey(x.ticketId), `The fixed setup steps went to the owner.`);
  await record(db, {
    companyId: row.companyId,
    ticketId: first.ticketId,
    kind: "decision_raised",
    summary: others.length ? `The owner's setup steps for ${t.tickets.length} tickets are live (${t.tickets.map((x) => `"${x.title}"`).join(", ")}): raised one card for them all.` : `The owner's setup steps for "${first.title}" are live: raised their card.`,
    at: new Date(),
  });
  return row;
}

/** The dedupe key for the CEO's card about a live ticket whose setup steps failed the card check (DR-052). */
export const ownerSetupFixKey = (ticketId: string) => `owner-setup-fix:${ticketId}`;
export const OWNER_SETUP_FIX_PREFIX = "owner-setup-fix:";

/**
 * DR-052 point 4: a live ticket's setup steps failed the card check, so instead of the owner's card the CEO gets one
 * to fix them. One per ticket (the first of a shared card), never stacked; it closes by itself when the owner's card
 * goes out. While it is open the CEO may change the merged ticket's steps (work.ts `setupFix`).
 */
async function raiseOwnerSetupFix(db: Db, t: { companyId: string; tickets: { ticketId: string; title: string }[]; findings: LintFinding[]; commit: string }) {
  const first = t.tickets[0]!;
  const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
  const nums = await db.select({ id: tickets.id, number: tickets.number }).from(tickets).where(inArray(tickets.id, t.tickets.map((x) => x.ticketId)));
  const refOf = (x: { ticketId: string; title: string }) => ticketRef(co?.prefix, nums.find((n) => n.id === x.ticketId)?.number) ?? `"${x.title}"`;
  const names = t.tickets.map(refOf).join(", ");
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `${names} ${t.tickets.length > 1 ? "are" : "is"} live, but the setup steps can't go to the owner as written:\n${lintLines(t.findings)}\nFix the steps with update_ticket ownerSetup on ${refOf(first)} (allowed while this card is open, though the ticket is merged), or pass lintOverride with the reason if a finding is wrong. ${HOST_TOKEN_HELP} Leave this card open: Boss Man raises the owner's card on its next pass once the steps pass, and closes this one itself.`,
      // A "Got it" notice the CEO can settle; the real close is the owner's card going out (raiseOwnerSetup).
      options: ["Got it"],
      recommendedOption: "Got it",
      tier: "ceo",
      dedupeKey: ownerSetupFixKey(first.ticketId),
      context: { type: "question", ticketId: first.ticketId, triedFirst: "Boss Man checked the setup steps against this server's host facts when the change went live, and they failed the owner-card check." } satisfies DecisionContext,
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id });
  if (row) await record(db, { companyId: t.companyId, ticketId: first.ticketId, kind: "decision_raised", summary: `The setup steps are live but failed the owner-card check, so the CEO was asked to fix them: ${t.findings.map((f) => `step ${f.step}: ${f.problem}`).join("; ").slice(0, 400)}`, at: new Date() });
  return row ?? null;
}

/**
 * Takes back an owner setup card when the live commit moves back to before its merge (DR-011): a
 * rollback or a switch-back. `cardId` is the card itself (`tickets.ownerSetupDecisionId`), not a key,
 * because one card can cover several tickets (BOS-741): every ticket in `ticketIds` that points at it has
 * its pointer cleared, so none keeps a stale card for a card that is gone. Frees the key so the next
 * go-live raises it again with its steps. Returns null when the card is already answered or withdrawn.
 *
 * BOS-740: it leaves the same closed-card notice as BOS-739's hand-apply cards (why it closed, what's
 * live, that the owner can stop, and anything to undo), so the card doesn't just vanish from Decisions.
 */
export async function withdrawOwnerSetup(db: Db, cardId: string, ticketIds: string[], note: string, deps?: { notify?: (n: NotifyInput) => Promise<unknown>; now?: () => Date }) {
  const [open] = await db.select().from(decisions).where(and(eq(decisions.id, cardId), eq(decisions.status, "open")));
  if (!open) return null;
  const now = deps?.now?.() ?? new Date();
  const withdrawal: Withdrawal = { by: "system", note, at: now.toISOString() };
  // The whole context goes back as the closed notice reads it: the steps the card showed stay readable with it.
  const closedNotice = switchedBackNotice({ steps: (open.context as { steps?: string[] }).steps, now });
  const [row] = await db
    .update(decisions)
    .set({ status: "withdrawn", answeredAt: now, dedupeKey: null, context: mergeContext({ withdrawn: withdrawal, closedNotice }) })
    .where(and(eq(decisions.id, open.id), eq(decisions.status, "open")))
    .returning({ id: decisions.id, companyId: decisions.companyId });
  if (row) {
    if (ticketIds.length) await db.update(tickets).set({ ownerSetupDecisionId: null }).where(inArray(tickets.id, ticketIds));
    await record(db, { companyId: row.companyId, ticketId: ticketIds[0] ?? (open.context as { ticketId?: string }).ticketId ?? null, kind: "decision_withdrawn", summary: note, at: now });
    if (deps?.notify) await leaveClosedNotice(db, row.id, closedNotice, { notify: deps.notify, now: deps.now });
  }
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
  if (row) await markDecisionNotificationRead(db, row.id);
  return row ?? null;
}

export const DEPLOY = "Deploy";
export const UPDATE_RUNNERS = "Update runners";
/** BOS-1086: on a server card whose change needs a runner rebuild: deploy now, and queue the runner update for when the trial ends. */
export const DEPLOY_AND_RUNNERS = "Deploy, then update runners after the trial";
export const NOT_NOW = "Not now";
export const STOP_AND_UPDATE = "Stop the remaining runs and update now";
export const KEEP_WAITING_MORE = (minutes: number) => `Keep waiting another ${minutes} min`;
export const CANCEL_UPDATE = "Cancel the update";
/** BOS-1377: the runner update's deadline card. Stop only the runs the card listed (each through the per-run Stop), wait 10 more minutes, or cancel the update. */
export const STOP_THESE_CARRY_ON = "Stop these and carry on";
export const WAIT_TEN_MORE = "Wait 10 more minutes";
export const CANCEL_RUNNER_UPDATE = "Cancel the runner update";
/** BOS-1600: the deadline card when only checks remain. The checks on the runner end and start again from the beginning afterwards. */
export const STOP_CHECKS_UPDATE_NOW = "Stop the checks and update now";
export const DEADLINE_WAIT_MINUTES = 10;
/** The quiet-host wait's deadline question (BOS-420): send the update now, past the host's memory floor too. */
export const UPDATE_NOW_ANYWAY = "Update now anyway";

export class AnswerError extends Error {}

/** The option for dropping a line: numbered, so a long lesson can be chosen by its number. */
const replaceOption = (i: number, lesson: string) => `Replace #${i + 1}: ${lesson}`;
/** The lesson a drop answer names, in the numbered or the older "Replace: " form. */
const replacedLesson = (answer: string) => /^Replace(?: #\d+)?: ([\s\S]*)$/.exec(answer)?.[1];

/**
 * Whether an agent's ask may be raised: it must say what was tried first, give steps when the owner has to act,
 * and its steps must work as written (BOS-417: `lintOwnerSteps`). `error` is the refusal; otherwise `lint` is what
 * the card keeps (warnings, and a CEO override). Every route that raises an agent card calls this, so the lint
 * can't be skipped: raise_decision, the CEO's reissue and escalate, and the Scrum Master's raise_decision.
 * `lintOverride` lets a refusal through with a reason; only the CEO may pass one (`byCeo`), and never past R3/R4/R10 (`NOT_OVERRIDABLE`).
 * `hosts` are the host facts Boss Man recorded (BOS-427): when given, R6 checks a login-run block against what the
 * host says it can read; without them it only checks that every block names a host and an account.
 * `serverHost` is the name the host deployer reports for the server itself (BOS-774): a card that names another host
 * is refused, a block with no host label gets this name, and `{{host}}` is filled from it; with no report yet a
 * named host is only warned about, and `{{host}}` is refused because there is nothing to fill.
 * `newHost` (DR-046) names the host a CEO-raised card is setting up, which the record has none for yet: only the CEO
 * may pass it, and only that one name may be unrecorded on the card.
 * `addons` are the add-on facts for R9 (DR-023); a route that has them passes them, and `setsUp` names the
 * add-on this card sets up, so its own setup steps aren't refused for it not running yet.
 * `proof` says how host commands were proven (R11, DR-024); a malformed one is refused before the lint runs,
 * and a good one is kept on the card for its banner.
 */
export function checkAsk(a: { ownerSetup?: OwnerRecordFacts; triedFirst: string; ownerMustDo?: boolean; steps?: string[]; options?: string[]; lintOverride?: string; byCeo?: boolean; hosts?: HostFacts[]; serverHost?: string | null; newHost?: string; hostValues?: Record<string, string>; addons?: AddonFacts; setsUp?: Addon; selfDeploy?: SelfDeployFacts; proof?: string; company?: CompanyFacts; images?: Record<string, string>; mismatchedSites?: Record<string, string> }): { error: string; lint?: undefined; steps?: undefined; stepSources?: undefined } | { error: null; lint?: CardLint; steps?: string[]; stepSources?: Array<StepSource | null> } {
  const t = a.triedFirst.trim();
  if (t.length < 20 || t.split(/\s+/).length < 4 || /^(n\/?a|none|nothing|no|nil|-+)\W*$/i.test(t)) {
    return { error: "triedFirst is too thin. Say what you tried yourself and why an agent can't do this (no host access, a secret only the owner can grant, owner sign-off). Try again once you have, or do it yourself." };
  }
  if (a.ownerMustDo && !a.steps?.length) {
    return { error: "The owner has to do something, so give steps: a short numbered list in plain words, with exact paths in the app (for example Settings → Server and runner → Updates → Build and update runners) and how to undo it. Prefer an in-app button over host commands." };
  }
  const override = a.lintOverride?.replace(/\s+/g, " ").trim();
  if (override !== undefined && !a.byCeo) return { error: "Only the CEO can pass lintOverride. Fix the steps instead, or ask the CEO to raise the card." };
  if (override !== undefined && override.length < 10) return { error: "lintOverride needs a reason the owner can read, at least 10 characters." };
  if (!a.steps?.length) return { error: null };
  const proof = a.proof?.trim() ? parseProof(a.proof) : undefined;
  if (typeof proof === "string") return { error: `The ${proof}.` };
  // `{{host.…}}` tokens (DR-008): filled from the recorded host facts before the lint, so the lint reads what the owner
  // will. A fact that isn't recorded stops the card; a caller with no facts leaves the token, which R4 refuses.
  // DR-057: another company's facts (tokens, "[if … exists]" branches, R18b) before the host facts, as on a setup card.
  const company = fillCompanyFacts(a.steps, a.company, "raise");
  let steps = company.steps;
  if (a.hostValues) {
    const filled = fillHostTokens(steps, a.hostValues);
    if (filled.missing.length) {
      return { error: `These steps use host facts Boss Man doesn't have: ${filled.missing.map((k) => `{{host.${k}}}`).join(", ")}. The host deployer hasn't reported them (it may not be applied yet, or the fact can't be detected). Ask the owner to confirm it in Settings → This host, or wait for the host's report, then raise the card again.` };
    }
    steps = filled.steps;
  }
  // BOS-1596: `{{checkWorkers.…}}` is filled from the record of what the owner has set up; a caller with no record leaves the token (R4 refuses it).
  if (a.ownerSetup && usesOwnerSetupToken(steps)) {
    const filled = fillOwnerSetupTokens(steps, a.ownerSetup);
    if (filled.missing.length) return { error: `These steps use worker facts Boss Man doesn't have: ${filled.missing.map((k) => `{{checkWorkers.${k}}}`).join(", ")}. Known: added, everConnected, online.` };
    steps = filled.steps;
  }
  // DR-046: a card that sets up a new host may name that one host, which isn't in the record yet. Only the CEO can
  // mark it, and only as a plain name (the same shape a fence line accepts).
  const newHost = a.newHost?.trim() || undefined;
  if (newHost !== undefined) {
    if (!a.byCeo) return { error: "Only the CEO can pass newHost: a host Boss Man has no record for may be named only on the card the CEO raises to set it up. Write host=\"{{host}}\" for the server Boss Man runs on, or leave the host out." };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(newHost)) return { error: "newHost must be a plain host name (letters, digits, dot, dash, underscore), like the fence line's host." };
    // The new host's own name, where it is recorded, is the same as naming another host: refuse it, so a move card
    // can't quietly point at a host that already has a record under a different name.
    if (a.hosts?.some((h) => h.name.toLowerCase() === newHost.toLowerCase())) return { error: `newHost names "${newHost}", which Boss Man already has a record for, so the card can name it as host="${a.hosts.find((h) => h.name.toLowerCase() === newHost.toLowerCase())!.name}" directly.` };
  }
  // BOS-774: a block that names the account but leaves the host out runs on the server Boss Man runs on, so the
  // reported name is filled in rather than a default. A block that names no host and no account is left for R6.
  // DR-046: `{{host}}` names that same server, filled from the report; with no report it can't be filled, so say so
  // plainly rather than leave an unfilled token for R4.
  const usesHostToken = steps.some((s) => /\{\{\s*host\s*\}\}/.test(s));
  if (usesHostToken && !(a.serverHost?.trim())) {
    return { error: "These steps use {{host}} to name the server Boss Man runs on, but the host deployer hasn't reported a name yet (it may not be set up). Write the server's name yourself, or wait for the host's report, then raise the card again." };
  }
  steps = fillServerHost(steps, a.serverHost);
  const lint0 = lintOwnerSteps(steps, { ...(a.options ? { options: a.options } : {}), ...(a.hosts ? { hosts: a.hosts } : {}), ...(a.serverHost ? { serverHost: a.serverHost } : {}), ...(newHost ? { newHost } : {}), ...(a.addons ? { addons: a.addons, setsUp: a.setsUp } : {}), ...(a.selfDeploy ? { selfDeploy: a.selfDeploy } : {}), ...(a.images ? { images: a.images } : {}), ...(a.mismatchedSites ? { mismatchedSites: a.mismatchedSites } : {}) }, proof);
  const refuse = [...company.findings, ...lint0.refuse];
  const warn = lint0.warn;
  const hard = refuse.filter((f) => NOT_OVERRIDABLE.has(f.rule));
  const soft = refuse.filter((f) => !NOT_OVERRIDABLE.has(f.rule));
  const tail = "Fix the steps and raise it again. The owner pastes each command exactly as written and has no other document open.";
  if (hard.length) return { error: `These steps can't go to the owner as written:\n${lintLines(refuse)}\n${tail}${override ? " lintOverride can't let through a command that isn't copy-safe, a value Boss Man doesn't have, or a command that waits for typed input, opens a pager or never returns." : ""}` };
  if (soft.length && !override) return { error: `These steps can't go to the owner as written:\n${lintLines(soft)}\n${tail}${a.byCeo ? " If a finding is wrong, pass lintOverride with the reason; the owner sees it on the card." : ""}` };
  const lint: CardLint = { warn, ...(soft.length && override ? { override: { reason: override, findings: soft } } : {}), ...(proof ? { proof } : {}) };
  // BOS-1665: the checker read the tags above; the owner's steps leave here without them, and the source of each step
  // is kept beside them for the muted "Written from…" line. No screen or push has to remember to strip a tag.
  const owner = splitOwnerSteps(steps, a.images);
  return { error: null, steps: owner.steps, ...(owner.stepSources ? { stepSources: owner.stepSources } : {}), ...(lint.warn.length || lint.override || lint.proof ? { lint } : {}) };
}

/** An agent's model setup as the CEO sets it and the owner sees it (BOS-128). */
export type AgentModelConfig = { harness: string; provider: string; model: string; fundingSourceId: string; fundingSourceName?: string };

/** One proposed hire in a team plan (docs/13). */
export type TeamHire = { name: string; template?: string; title?: string | null; model?: string | null; fundingSourceId?: string | null; fundingSourceName?: string; harness?: string; provider?: string; skills?: string[]; reason: string; serves?: string | null };
export type HireProposal = { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; harness?: string; provider?: string; reason?: string; /** Skills or packs the new agent gets before its first run. */ skills?: string[]; /** Tickets waiting for this hire; they go to the new agent once hired. */ forTickets?: string[] };
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
  /** With an "always" answer: whose requests the saved rule covers. Defaults to the asking agent only (BOS-294). */
  alwaysScope?: AlwaysScope;
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

/** How long a team question waits with the CEO before it moves to the owner (BOS-1318). Housekeeping isn't urgent, and nobody's run waits on it. */
export const CEO_QUESTION_HANDOVER_MINUTES = 60;

/**
 * The only reasons an agent's card stays on the owner's queue without steps (BOS-1318): a fixed list,
 * never guessed from the card's wording, so a mistake errs toward the owner.
 */
export const OWNER_ONLY_KINDS = ["secret", "money", "host", "signoff", "owner_choice", "owner_setup"] as const;
export type OwnerOnlyKind = (typeof OWNER_ONLY_KINDS)[number];

/**
 * Where an agent's raise_decision card goes (BOS-1318), by structure only. "owner" unless nothing about the
 * card needs the owner: no ownerOnly kind, no steps, not ownerMustDo, not an add-on setup, not an after-merge
 * check, raised by an agent that is not the CEO, and a CEO that can take it.
 */
export function routeAgentCard(c: { ownerOnly?: OwnerOnlyKind; ownerMustDo?: boolean; steps?: string[]; setsUp?: unknown; criterionIndexes?: number[]; raiserRole: string | null; ceoAvailable: boolean }): { tier: "owner" | "ceo"; why: string } {
  if (c.ownerOnly) return { tier: "owner", why: `owner-only: ${c.ownerOnly}` };
  if (c.ownerMustDo || c.steps?.length) return { tier: "owner", why: "the owner has steps to do" };
  if (c.setsUp) return { tier: "owner", why: "an add-on setup card" };
  if (c.criterionIndexes?.length) return { tier: "owner", why: "the owner's after-merge check" };
  if (c.raiserRole === null || c.raiserRole === "ceo") return { tier: "owner", why: "the CEO can't answer its own card, or no agent raised it" };
  if (!c.ceoAvailable) return { tier: "owner", why: "the CEO can't take it now" };
  return { tier: "ceo", why: "a team question goes to the CEO first" };
}

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
  /** advised: what wouldn't get done if the owner denies it, in plain words (BOS-233). */
  denyStops?: string;
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
 * Whether an answer is a refusal button (BOS-1094): one of the card's own options that says "Send it back", "Deny"
 * or "Reject" (so free text and a plain "No" never count: those are often just the answer to a yes/no question).
 */
export function isRefusalAnswer(answer: string, options: readonly string[] | null | undefined): boolean {
  if (!options?.includes(answer)) return false;
  const a = answer.trim().toLowerCase().replace(/[.!\s]+$/, "");
  return /^(no, |not approved, )?(send it back|deny|reject)\b/.test(a) || a === "do not approve" || a === "don't approve";
}

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

type WakeHook = (input: { agentId: string; reason: string; ticketId?: string | null; note?: string | null; priority?: number; replyLane?: boolean }) => Promise<unknown>;

type EngagementHook = (engagementId: string, approved: boolean) => Promise<unknown>;
type DeployHook = (deployId: string, approved: boolean) => Promise<unknown>;
export type LoopHooks = {
  sendBack(ticketId: string, text: string, reviewer: string): Promise<unknown>;
  stopTicket(ticketId: string): Promise<unknown>;
  /** Marks the named criteria "after the merge" and clears the failed reviews that only failed them (BOS-422). */
  moveAfterMerge(ticketId: string, criteria: string[]): Promise<unknown>;
  raiseCap(ticketId: string): Promise<unknown>;
  /** Merges an approved ticket once the owner has signed off on it (R48); `merge.markDone` finishes a ticket with nothing to merge. */
  land(ticketId: string, reviewer: string, merge?: AnswerExtra["merge"]): Promise<unknown>;
  /** Lands again in the background after a check that couldn't finish; `skipChecks` merges without it. */
  landAgain(ticketId: string, skipChecks: boolean): Promise<unknown>;
  /** A stalled-review card's action on the review (BOS-426): the reviewer, the reviewer's id and the kind. Returns false when the review can't take that action any more, which keeps the card open. */
  reviewStall?(ctx: Extract<DecisionContext, { type: "review_stall" }>, answer: string, byAgentId: string | null): Promise<boolean>;
  /** A sign-off card for commit `cardHead` is being approved: null if that commit still stands, else the plain reason it can't (the card is replaced) (BOS-734). */
  signoffStale?(ticketId: string, cardHead: string): Promise<string | null>;
};

export type MaintenanceHook = { answered(answer: string, ctx?: { runIds?: string[] }): Promise<unknown> };
type SelfDeployCtx = Extract<DecisionContext, { type: "self_deploy" }>;
export type SelfDeployHook = { check(ctx: Extract<DecisionContext, { type: "self_deploy" }>): Promise<void>; send(ctx: Extract<DecisionContext, { type: "self_deploy" }>, decisionId: string, opts?: { override?: boolean; thenRunners?: boolean }): Promise<unknown> };
/** The quiet-machine wait of a server update (BOS-420, deploy-wait.ts). */
export type DeployWaitHook = {
  get(): Promise<{ decisionId: string; origin: "approve" | "hand" } | null>;
  begin(input: { decisionId: string; commit: string; fromCommit: string; origin?: "approve" | "hand"; thenRunners?: boolean }): Promise<unknown>;
  answered(answer: string): Promise<unknown>;
};

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
type AgentDecisionHook = (ctx: Extract<DecisionContext, { type: "hire" | "instructions" | "rename" | "standing_rules" }>, companyId: string, approved: boolean) => Promise<unknown>;
type ModelChangeHook = (ctx: Extract<DecisionContext, { type: "model_change" }>, companyId: string, config: AgentModelConfig) => Promise<{ afterRunId: string | null }>;

/** How long a card's question can be in an "unblocked" wake; the answer itself is never cut (BOS-951). */
const UNBLOCKED_QUESTION_MAX = 200;
/** Past this, the wake carries a short line instead: the whole answer is on the ticket's conversation (BOS-951). */
const UNBLOCKED_TOTAL_MAX = 800;
const UNBLOCKED_POINTER = "The whole answer and note are on this ticket's conversation.";

/**
 * The plain state note for a ticket Boss Man frees from Blocked (BOS-1209), so it never keeps "waiting on the owner"
 * after the owner answered. Names the answer when there is one.
 */
export async function releasedNote(db: Db, ticketId: string, answered?: { question: string; answer: string; keepNote?: boolean }) {
  // A card linked to after-merge criteria carries the criterion record on the note (a "none" answer writes nothing): leave it.
  if (answered?.keepNote) return undefined;
  const [r] = await db.select({ name: agents.name, note: tickets.stateNote }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(eq(tickets.id, ticketId));
  // This answer already wrote its own line on the note (the owner's check of an after-merge criterion): keep it.
  if (answered && r?.note?.includes(`Owner answered "${answered.question.split("\n")[0]!.replace(/[.;,\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}"`)) return undefined;
  const cut = (s: string, n: number) => { const x = s.replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  const what = answered ? `the owner answered "${cut(answered.question, 80)}" (${cut(answered.answer, 80)})` : "what it was waiting on is settled";
  return `Ready: ${what}. Starts when ${r?.name ?? "its assignee"} has a free slot.`;
}

/**
 * What the blockers that just resolved produced, for the "unblocked" wake (R85). An answered
 * decision's dependency row is already gone by then, so its question and answer come in as `answered`.
 * The question is cut, never the answer: the answer is what the agent has to act on (BOS-951).
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
  const asked = (question: string) => `${question.replace(/\s+/g, " ").trim().slice(0, UNBLOCKED_QUESTION_MAX)}${question.length > UNBLOCKED_QUESTION_MAX ? "…" : ""}`;
  const lines = blockers.flatMap((b) => {
    if (b.id) {
      const outs = made.filter((m) => m.ticketId === b.id).map((m) => m.slug ?? m.title);
      return [`- "${b.title}" is done.${b.note ? ` Its note: ${b.note}` : ""}${outs.length ? ` It produced: ${outs.join(", ")}.` : ""}`];
    }
    return b.question && b.answer ? [`- You asked "${asked(b.question)}"; the answer was: ${b.answer}`] : [];
  });
  if (answered) lines.push(`- You asked "${asked(answered.question)}"; the answer was: ${answered.answer}`);
  if (!lines.length) return undefined;
  const text = `What you were waiting on:\n${lines.join("\n")}`;
  // A short note is sent whole. A long one keeps its first 800 characters, which now leaves room for the answer
  // because the question above is cut; the whole thing is on the ticket's conversation either way (BOS-951).
  return text.length <= UNBLOCKED_TOTAL_MAX ? text : `${text.slice(0, UNBLOCKED_TOTAL_MAX)}\n\n${UNBLOCKED_POINTER}`;
}

/**
 * The owner's answer to a card that was holding a ticket up, written on that ticket's conversation (BOS-951).
 * The wake that follows is short, so this is where the assignee reads the whole answer and note. Attributed to
 * the owner on the ticket, as it is their words. Returns the tickets it wrote to; it never throws into the
 * answer path, as the answer is already saved by then.
 */
async function postAnswerOnTickets(
  db: Db,
  d: { companyId: string; question: string; answer: string | null },
  ticketIds: string[],
  who: string,
  note: string | undefined,
  log: (message: string) => void,
  now: () => Date,
) {
  if (!ticketIds.length) return [];
  const answer = (d.answer ?? "").trim();
  if (!answer) return [];
  const lines = [`${who} answered your card on this ticket: ${answer}`];
  if (note?.trim()) lines.push("", "Their note:", note.trim());
  lines.push("", `The card asked: ${d.question.replace(/\s+/g, " ").trim().slice(0, 300)}${d.question.length > 300 ? "…" : ""}`);
  const text = lines.join("\n");
  const wrote: string[] = [];
  for (const ticketId of [...new Set(ticketIds)]) {
    try {
      await db.insert(ticketMessages).values({ companyId: d.companyId, ticketId, author: "owner", agentId: null, runId: null, delivery: null, text });
      await record(db, { companyId: d.companyId, ticketId, kind: "message", summary: `The owner's answer was posted here: ${answer}` });
      wrote.push(ticketId);
    } catch (err) {
      log(`answering decision was saved, but the owner's answer couldn't be posted on ticket ${ticketId}: ${(err as Error).message}`);
    }
  }
  return wrote;
}

/**
 * The owner's answer on a card that blocks a ticket settles that ticket's after-merge criteria (DR-024 #5):
 * the card was how the owner was to check the live work, so the answer is its pass or fail. Which criteria it
 * settles is worked out from the card (its question and options) rather than from what is still unreported
 * (BOS-963): on BOS-905 a card worded in its own way never recorded, and a second card after an earlier answer
 * had written the criterion wrote nothing at all. The verdict goes on the note as a numbered line ("5 pass"),
 * which the done gate reads however the criterion is worded; the owner's words are quoted too.
 * Returns the tickets it wrote to.
 */
async function recordOwnerHostChecks(db: Db, d: { question: string; answer: string | null; options?: string[] | null; recommended?: string | null; criterionIndexes?: number[] | null; optionVerdicts?: Record<string, string> | null }, ticketIds: string[], by: string, now: () => Date): Promise<string[]> {
  const answer = (d.answer ?? "").trim();
  if (!ticketIds.length || !answer) return [];
  const rows = await db.select({ id: tickets.id, criteria: tickets.acceptanceCriteria, note: tickets.stateNote, merged: tickets.mergeCommit }).from(tickets).where(inArray(tickets.id, ticketIds));
  // Only a choice the owner made on purpose is a verdict (BOS-1091). A chosen option counts as the raiser
  // said when raising the card (BOS-1155): optionVerdicts maps each option to pass, fail or none. No guessing
  // from the option's words or from which one was recommended: on BOS-753 "Close it on the tests" was
  // taken for a fail. A card with no map, or an option mapped to none, records no verdict.
  // A one-word "pass"/"fail"/"yes"/"no" typed in is one too. Any other typed text is not judged: on
  // BOS-1052 and BOS-993 the owner described a pass ("It answered in 1.7 s with a valid verdict", pasted
  // panel text holding "not") and the old word test recorded both as fail and opened false follow-ups.
  // Keyword-guessing free text either way could turn a real fail into a pass, so the note says the owner
  // answered in their own words and leaves the criterion unreported: the done gate then makes the assignee
  // (or the CEO) read the answer, which is on the ticket's conversation, and report it.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const chosen = (d.options ?? []).find((o) => norm(o) === norm(answer));
  let verdict: "pass" | "fail" | null;
  if (chosen !== undefined) {
    const mapped = Object.entries(d.optionVerdicts ?? {}).find(([o]) => norm(o) === norm(chosen))?.[1];
    if (mapped !== "pass" && mapped !== "fail") return [];
    verdict = mapped;
  } else {
    const bare = /^(pass|passed|fail|failed|yes|no)[.!]?$/i.exec(answer)?.[1]?.toLowerCase();
    verdict = !bare ? null : bare.startsWith("fail") || bare === "no" ? "fail" : "pass";
  }
  const said = answer.replace(/\s+/g, " ").slice(0, 200);
  const wrote: string[] = [];
  for (const r of rows) {
    const criteria = readCriteria(r.criteria);
    // Only a merged ticket has after-merge checks to settle; before that its own assignee reports them.
    if (!r.merged) continue;
    // The criteria the raiser named on the card win (BOS-963): an exact link, whatever the wording. Failing
    // that, the criteria the card's own words name, then the ones still unreported, as before.
    const explicit = (d.criterionIndexes ?? []).filter((i) => i >= 0 && i < criteria.length && isAfterMerge(criteria[i]!));
    const named = explicit.length ? explicit : criteriaForCard(criteria, d.question, d.options ?? []);
    const settle = named.length ? named : unreportedAfterMerge(criteria, r.note).flatMap((text) => criteria.flatMap((c, i) => (criterionText(c) === text ? [i] : [])));
    if (!settle.length) continue;
    if (verdict === null) {
      // No pass or fail word, no question and no criterion words here: readVerdicts reads a verdict from any
      // sentence holding a criterion's words, so this line must not read as one. The owner's own words are
      // already on the ticket's conversation (postAnswerOnTickets).
      const nums = settle.map((i) => i + 1).join(" and ");
      const line = `The owner answered a card on criterion ${nums} in their own words rather than choosing an option, so Boss Man records no verdict: read their answer on the ticket's conversation and report criterion ${nums}`;
      await db.update(tickets).set({ stateNote: `${(r.note ?? "").trim()}${r.note ? ". " : ""}${line}`.slice(0, 4000), stateNoteAt: now() }).where(eq(tickets.id, r.id));
      wrote.push(r.id);
      continue;
    }
    // Numbered, so the verdict holds whatever the criterion's wording: "5 pass". The criteria's own words
    // are quoted after it so a reader sees what was checked.
    // cardAnswerLine keeps it one segment that readVerdicts reads by number and a later author verdict replaces.
    const line = cardAnswerLine(d.question.split("\n")[0]!, by, settle.map((i) => ({ n: i + 1, verdict: verdict!, text: criterionText(criteria[i]!) })), said);
    await db.update(tickets).set({ stateNote: `${(r.note ?? "").trim()}${r.note ? ". " : ""}${line}`.slice(0, 4000), stateNoteAt: now() }).where(eq(tickets.id, r.id));
    wrote.push(r.id);
  }
  return wrote;
}

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date(), isConnected: (runnerId: string) => boolean = () => false, log: (message: string) => void = () => {}, workspaceRoot?: string) {
  /** The plan-overlap note for an approval (BOS-1411, warning 1): the words the asker reads when its plan is approved. */
  async function planApprovalOverlapNote(ticketId: string, planText: string): Promise<string> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t) return "";
    // The ExitPlanMode card carries the plan text; a submit_plan card stores the plan on the ticket instead.
    return overlapNoteOf(await planOverlaps(db, t, planText || t.plan || ""));
  }
  // The record of permission decisions (BOS-306); app.ts swaps in one that writes log lines.
  let permLog: PermissionLog = createPermissionLog();
  let wake: WakeHook | null = null;
  // DR-058: the feed note a withdrawn owner card sends; wired in app.ts. Without it the card still gets its notice.
  let notifyFeed: ((n: NotifyInput) => Promise<unknown>) | null = null;
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
  let deployWait: DeployWaitHook | null = null;
  let maintenance: MaintenanceHook | null = null;

  // (BOS-996) The tally, kept for a few seconds per view so the badge, the page heading and the
  // dashboard share one walk of the ranked queue instead of one each. Cleared on every answer.
  // shortcut: a 5-second copy, cleared on every answer; lost on restart, harmless because the next
  // read simply walks the queue again.
  const TALLY_CACHE_MS = 5_000;
  const tallyCache = new Map<string, { tally: { open: number; waiting: number }; until: number }>();
  const clearTallyCache = () => tallyCache.clear();

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
  async function releaseIfFree(ticketId: string, wakeAssignee = true, answered?: { question: string; answer: string; keepNote?: boolean }) {
    // DR-061 Q2a: the same "held in Blocked" rule Blocked is accepted by (a date ahead, an open blocker, another open card, unreported after-merge checks, a go-live wait).
    if ((await blockedHolds(db, ticketId, { now: now() })).length) return null;
    const t = await systemMoveTicket(db, { ticketId, from: ["blocked"], to: "ready", reason: "Boss Man: its last blocker finished", now: now(), stateNote: await releasedNote(db, ticketId, answered) });
    if (wakeAssignee && t?.assigneeAgentId && wake) await wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked", note: await unblockedNote(db, t.id) });
    return t ?? null;
  }

  /** Checks an answer's extra input before anything changes. */
  async function validate(d: typeof decisions.$inferSelect, answer: string, extra: AnswerExtra) {
    const ctx = d.context as DecisionContext;
    if (ctx.type === "self_deploy" && (answer === DEPLOY || answer === UPDATE_RUNNERS || answer === DEPLOY_AND_RUNNERS)) {
      if (!selfDeploy) throw new AnswerError("Self-deploy is not set up on this install.");
      await selfDeploy.check(ctx);
      // One server update at a time (BOS-420): one already waiting for a quiet machine, or in its window, holds the line.
      const w = ctx.target === "server" ? await deployWait?.get() : null;
      if (w && w.decisionId !== d.id) throw new AnswerError("Another server update is waiting for a quiet machine or is in its standby window. Cancel it in Settings → Server and runner → Updates first, or wait for it to finish.");
    }
    if (ctx.type === "owner_todo" && answer === QUIET_FIRST) {
      if (!deployWait) throw new AnswerError("The quiet-machine wait is not set up on this install.");
      if (ctx.target !== "server" || !ctx.commit || !ctx.fromCommit) throw new AnswerError("Only a server update can wait for a quiet machine.");
      const w = await deployWait.get();
      if (w && w.decisionId !== ctx.ofDecisionId) throw new AnswerError("Another server update is already waiting for a quiet machine. Cancel it in Settings → Server and runner → Updates first.");
    }
    if (ctx.type === "stale_blocker" && answer === REASSIGN) {
      if (!ctx.blockerTicketId) throw new AnswerError("Only a ticket can be reassigned.");
      if (!extra.assigneeAgentId) throw new AnswerError("Pick who should take this ticket.");
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, extra.assigneeAgentId), eq(agents.companyId, t?.companyId ?? "")));
      if (!a) throw new AnswerError("That person isn't on this ticket's team. Pick someone from the list.");
      // Defence in depth for the security review's own tasks (BOS-176): the other ticket-writing tools all
      // refuse to move an open skill-review ticket, so this route must too. The owner's own answer is the
      // owner writing (settledBy is only ever an agent), so they stay allowed, as they are there.
      if (t?.companyId && extra.settledBy && (await openReviewProposal(db, t.companyId, ctx.blockerTicketId))) {
        throw new AnswerError("This is a security review task: only the Security Reviewer and the owner can move it. Pick another ticket to hand on, or chase it instead.");
      }
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
    if (ctx.type === "fence_default") {
      const problem = await checkFenceAnswer(db, d.companyId, answer);
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

  /** The company's switch for allowing plain /tmp cleanups with no card (BOS-1453). Only an explicit off turns it off, so a missing row never widens or narrows anything by accident. */
  async function autoCleanupOn(companyId: string): Promise<boolean> {
    const [c] = await db.select({ on: companies.autoTempCleanup }).from(companies).where(eq(companies.id, companyId));
    return c?.on !== false;
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
   * What a new plan card passes to supersedePlanCards (BOS-1219), the same for both plan paths: the author's name for the
   * "Superseded by" note, and the move of the owner's open "Ask the CEO" request onto the new card, with the CEO told.
   */
  async function supersedeExtras(companyId: string, ticketId: string, newCardId: string, authorId: string | null) {
    const [author] = authorId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, authorId)) : [];
    return {
      author: author?.name ?? null,
      carryAdvice: async (from: { id: string; advice: Advice }) => {
        const [moved] = await db
          .update(decisions)
          .set({ context: sql`jsonb_set(${decisions.context}, '{advice}', ${JSON.stringify(from.advice)}::jsonb)` })
          .where(and(eq(decisions.id, newCardId), eq(decisions.status, "open"), sql`${decisions.context}->'advice' is null`))
          .returning({ id: decisions.id });
        if (!moved) return;
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
        if (ceo && wake) await wake({ agentId: ceo.id, ticketId, reason: "decision", note: `The owner's request for your advice was on plan card ${from.id}, which a newer plan has replaced. The request now belongs on card ${newCardId}: give your advice there (decisions tool, action advise).${from.advice.note ? ` What the owner wrote: ${from.advice.note}` : ""}`.slice(0, 4000) });
      },
    };
  }

  /** "This amends the approved plan of <time>" for a new plan card on a ticket whose plan the owner already approved (BOS-1219). */
  const amendsText = (approvedAt: Date | null | undefined) => (approvedAt ? ` This amends the approved plan of ${approvedAt.toISOString()}; the approval stays in force.` : "");

  /**
   * Wakes the CEO about a card on the ladder, tied to the card's ticket so it can't hit the
   * ticketless-wake limit (BOS-159). If the wake is dropped anyway, the card goes straight to the
   * owner: a request must never sit at a rung nobody was woken for while the runner counts down.
   */
  async function wakeLadderCeo(companyId: string, row: { id: string }, ctx: { ladder: Ladder } & Record<string, unknown>, ceoId: string, note: string) {
    if (!wake) return;
    // High priority, like an alert: the agent is waiting, and the runner gives up at 10 minutes.
    const w = (await wake({ agentId: ceoId, ticketId: ctx.ladder.ticketId, reason: "decision", priority: 3, replyLane: true, note })) as { status?: string; statusReason?: string | null } | null;
    if (w?.status !== "dropped") return;
    const at = now().toISOString();
    const why = `the CEO's wake was dropped (${w.statusReason ?? "no reason given"})`;
    const ladder: Ladder = { ...ctx.ladder, rung: "owner", since: at, hops: [...ctx.ladder.hops, { to: "owner", at, why }] };
    const moved = await db
      .update(decisions)
      .set({ tier: "owner", forAgentId: null, context: mergeContext({ triedFirst: `Boss Man tried the CEO first: ${why}.`, ladder }) })
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
      .set({ tier: "ceo", forAgentId: null, context: mergeContext({ ladder }) })
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
        // BOS-1571: a gated ticket's plan without a real-use walk-through says so on the card itself.
        question: t ? `Approve ${agent?.name ?? "An agent"}'s plan for "${t.title}"?${amendsText(t.planApprovedAt)}${usabilityGated(t) && !realUseWalkthrough(plan) ? `\n\n${PLAN_REAL_USE_MISSING}` : ""}` : `${agent?.name ?? "An agent"} has a plan and wants to start building. Approve it?`,
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
    // BOS-1171: a ticket waiting on its plan card sits in Blocked, not In progress (so it doesn't use an in-progress slot).
    // Answering the card frees it the same way as any linked card. A failure here never loses the plan card.
    if (row && t && run?.agentId)
      await addTicketDependency(db, { companyId: runner.companyId, blockedTicketId: t.id, blockerDecisionId: row.id, actor: { type: "agent", agentId: run.agentId }, hold: true, now }).catch(() => undefined);
    // BOS-1161: an older open plan card for this ticket is superseded by this one. A failure never loses the new card.
    if (row && t) await supersedePlanCards(db, { companyId: runner.companyId, ticketId: t.id, newCardId: row.id, now: now(), release: (id) => releaseIfFree(id, false), ...(await supersedeExtras(runner.companyId, t.id, row.id, run?.agentId ?? null)) }).catch((err) => log(`closing older plan cards for ${t.id} failed: ${(err as Error).message}`));
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

  /**
   * DR-058 A: what a withdrawal needs to tell the owner, read before the card closes (closing frees its ticket links).
   * Null when the card never reached the owner: not an owner-tier card, or still with the CEO in its handover.
   */
  async function withdrawFacts(d: typeof decisions.$inferSelect) {
    const ctx = d.context as DecisionContext & { ladder?: { rung?: string; ticketId?: string | null }; steps?: string[]; handSteps?: string[] };
    if (d.tier !== "owner" || (ctx.ladder?.rung && ctx.ladder.rung !== "owner")) return null;
    const ids = new Set<string>();
    const own = (ctx as { ticketId?: unknown }).ticketId;
    if (typeof own === "string") ids.add(own);
    if (ctx.ladder?.ticketId) ids.add(ctx.ladder.ticketId);
    for (const b of await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id))) ids.add(b.ticketId);
    const rows = ids.size ? await db.select({ number: tickets.number, prefix: companies.ticketPrefix, systemState: tickets.systemState }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, [...ids])) : [];
    return { ticket: rows[0] ? ticketRef(rows[0].prefix, rows[0].number) : null, stale: rows.length > 0 && rows.length === ids.size && rows.every((r) => r.systemState === "done"), steps: ctx.handSteps?.length ? ctx.handSteps : ctx.steps };
  }

  /** Leaves the withdrawn notice on a closed card and tells the feed (DR-058 C, D, E). Never fails the withdraw. */
  async function noticeWithdrawn(d: typeof decisions.$inferSelect, facts: NonNullable<Awaited<ReturnType<typeof withdrawFacts>>>, w: { agentId: string; agent: string; reason: string; replacedBy: ReplacedBy }) {
    try {
      let newerLabel: string | undefined;
      if (w.replacedBy.kind === "card") {
        const [n] = await db.select({ question: decisions.question }).from(decisions).where(and(eq(decisions.id, w.replacedBy.id), eq(decisions.companyId, d.companyId)));
        newerLabel = n?.question.split("\n")[0]?.slice(0, 120);
      }
      const notice = withdrawnNotice({ agent: w.agent, ticket: facts.ticket, reason: w.reason, replacedBy: w.replacedBy, ...(newerLabel ? { newerLabel } : {}), steps: facts.steps, now: now() });
      await leaveWithdrawnNotice(db, d.id, { notice, agent: w.agent, agentId: w.agentId, stale: facts.stale }, { notify: notifyFeed ?? (async () => undefined), now });
    } catch (err) {
      log(`withdrawn notice for card ${d.id} failed: ${(err as Error).message}`);
    }
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
      const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
      const info: PermissionInfo = { title: event.title, kind: event.kind, rawInput: event.rawInput, agentId: run?.agentId ?? null };
      // The owner chat may use Boss Man's own (board) tools and nothing else.
      const [asking] = await db.select({ purpose: runs.purpose, agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
      // BOS-1300: an ordinary agent's owner chat has its working tools, so it goes through the company's rules like its ticket runs.
      // The CEO, Scrum Master and personal assistant chats stay board-only.
      const [chatAgent] = asking?.purpose === "chat" && asking.agentId ? await db.select({ role: agents.role, duty: agents.duty }).from(agents).where(eq(agents.id, asking.agentId)) : [];
      const boardOnlyChat = asking?.purpose === "chat" && (!chatAgent || runCapabilities(chatAgent, true).boardToolsOnly);
      const { outcome, rule, position } =
        boardOnlyChat
          ? isBossmanCall(info)
            ? { outcome: "allow" as const, rule: "The owner chat's board tools", position: 0 }
            : { outcome: "deny" as const, rule: "The owner chat has board tools only", position: 0 }
          : evaluatePermission(info, await rulesFor(runner.companyId), { autoTempCleanup: await autoCleanupOn(runner.companyId) });
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
          await db.update(decisions).set({ context: mergeContext({ repeats }), question }).where(eq(decisions.id, waiting.id));
          record(waiting.id, "ceo", "A repeat of a card already waiting");
          return { outcome: "ceo" as const, rule: "A repeat of a card already waiting", decisionId: waiting.id };
        }
        const decided = await repeatAnswer(event, fingerprint);
        if (decided.allow && send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: "allow" })) {
          await db.update(decisions).set({ context: mergeContext({ settledByRepeat: { sameAs: decided.allow, at: now().toISOString() } }) }).where(eq(decisions.id, decided.allow));
          record(null, "allow", `Same request as decision ${decided.allow}, already allowed`);
          return { outcome: "allow" as const, rule: `Same request as decision ${decided.allow}, already allowed`, decisionId: null };
        }
      }
      if (outcome === "allow" || outcome === "deny") {
        record(null);
        // BOS-1453: a plain /tmp cleanup is allowed with no card, so the owner's activity feed is where it shows: the agent and the command.
        if (rule === TEMP_CLEANUP_AUTO_RULE) {
          const [who] = asking?.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, asking.agentId)) : [];
          const command = commandOf(info.rawInput) ?? "";
          await recordActivity(db, { companyId: runner.companyId, agentId: asking?.agentId ?? null, ticketId: asking?.ticketId ?? null, kind: "temp_cleanup_allowed", summary: `Allowed a temp-file cleanup by ${who?.name ?? "an agent"} without asking (only entries directly in /tmp): ${command.slice(0, 300)}`, detail: { command: command.slice(0, 2000), rule }, at: now() });
        }
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
          const why = workingCopy ? "deletes in the agent's working copy go to the CEO first" : rule === TEMP_CLEANUP_RULE ? "temp-file cleanup goes to the CEO first" : rule === UNKNOWN_TOOL_RULE ? "the tool isn't one Boss Man recognises, so it goes to the CEO first" : rule === UNMATCHED_RULE ? "no rule covers it, so it goes to the CEO first" : `the rule "${rule}" sends it to the CEO`;
          ladder = { rung: "ceo", since, minutes: CEO_HANDOVER_MINUTES, ticketId: run?.ticketId ?? null, about: run?.agentId ? [run.agentId] : [], hops: [{ to: "ceo", at: since, why }] };
        } else tier = "owner";
      }
      // BOS-793: say in one line why the owner has it and not the CEO. Display only; routing is already decided.
      const ownerReason = tier !== "owner" ? null : outcome === "ceo" ? (agent?.role === "ceo" ? "Sent to you, not the CEO, because it is the CEO's own request." : "Sent to you, not the CEO, because the CEO could not take it first (paused, or the delete has no checkout of its own).") : ownerWhy(commandOf(info.rawInput), rule);
      if (ownerReason) explain.ownerWhy = ownerReason;
      // Standing rules are the owner's call, never an agent's.
      const always = tier === "owner" ? alwaysChoices(info, explain) : [];
      // The rules judge (BOS-337) only picks which button is suggested. The policy above already decided who answers; nothing here answers a card.
      const [company] = await db.select({ mode: companies.permissionJudge }).from(companies).where(eq(companies.id, runner.companyId));
      const judgeMode = company?.mode ?? "watch";
      const judgedCommand = commandOf(info.rawInput);
      // Very long commands are not judged (the old recommendation stays): the patterns are not built for them and this runs on the server loop.
      const reading = judgeMode === "off" || !isJudgeable(judgedCommand) ? null : judgePermission(`${explain.title}. ${explain.summary}`, judgedCommand, run?.ticketId ?? undefined, workspaceRoot && (run?.ticketId ?? run?.agentId) ? runFolder(workspaceRoot, run?.agentId ?? "", { ticketId: run?.ticketId }).replace(/[^A-Za-z0-9]/g, "-") : undefined, workspaceRoot);
      // The model second opinion (BOS-338) is asked only when the rules judge allows: it can only make a card stricter.
      const askSecond = !!reading && reading.verdict === "allow" && judgeMode !== "off" && !!secondOpinion && (await secondOpinion.enabled(runner.companyId).catch(() => false));
      const judge: JudgeNote | undefined = reading && judgeMode !== "off" ? { mode: judgeMode, verdict: reading.verdict, row: reading.row, reason: reading.reasonLabel, ...(askSecond ? { second: { state: "pending" as const } } : {}) } : undefined;
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), toolTitle: event.title, toolInput: inputFingerprint(event.rawInput), explain, ...(judge ? { judge } : {}), ...(always.length ? { always, ...(run?.agentId ? { alwaysAgent: { id: run.agentId, name: agent?.name ?? "This agent" } } : {}) } : {}) };
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
          question: `${explain.title}. ${explain.summary}${workingCopy ? ` Its relative paths delete from the shell's folder; the run started in ${agent?.name ?? "the agent"}'s working copy for ${workingCopy.ref ?? "its ticket"} (branch ${workingCopy.branch}), and Boss Man can't see where it has moved to since: ${fileList(workingCopy.files, 400)}.` : ""}${ownerReason ? ` ${ownerReason}` : ""}`,
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
              : rule === UNMATCHED_RULE
                ? [
                    "No rule covers this request, so it came to you before the owner (every company works this way). Allow it if it is ordinary work for the asking agent in its own checkout or /tmp; deny it if not; if only the owner can settle it (a secret, host access, sign-off, an owner-only choice), escalate it to them (decisions tool, action escalate).",
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

    async raise(input: { /** The open question card this one replaces (BOS-1193): it closes as superseded in the same call. Your own card, or any card for the CEO. */ replaces?: string; companyId: string; agentId: string | null; question: string; options: string[]; recommended: string; blocksTicketId?: string; /** Other tickets this one card holds too, so one answer releases them all (BOS-1591). */ alsoBlocksTicketIds?: string[]; /** Hold blocksTicketId's merge until this is answered (BOS-1078). */ holdsMerge?: boolean; triedFirst?: string; steps?: string[]; stepSources?: Array<StepSource | null>; stillNeeded?: string; ownerMustDo?: boolean; approveSummary?: string; lint?: CardLint; setsUp?: Addon; /** Checkable conditions that close the card by itself (BOS-1161), already validated by the tool. */ clearWhen?: ClearWhen[]; /** The after-merge criteria this card settles, 0-based indexes into the ticket's list (BOS-963). */ criterionIndexes?: number[]; /** What each option means for those criteria (BOS-1155). */ optionVerdicts?: Record<string, "pass" | "fail" | "none">; /** The ticket's plan (BOS-531): stored on the ticket; approving the card sets planApprovedAt. */ plan?: string; doAfter?: OrderLink[]; doBefore?: OrderLink[]; resetsOnRestart?: boolean; /** Why only the owner can take this card (BOS-1318); it stays on the owner's queue. */ ownerOnly?: OwnerOnlyKind; /** The one-line reason an owner_choice card is the owner's. */ ownerOnlyWhy?: string; /** An agent's card via raise_decision (BOS-1318): goes to the CEO first unless it needs the owner. Plans and system cards leave it out and keep their routing. */ ceoFirst?: boolean }) {
      // BOS-1318: where this card goes. Decided by routeAgentCard from the card's structure, never its wording.
      if (input.ownerOnly === "owner_choice" && !input.ownerOnlyWhy?.trim()) throw new AnswerError("ownerOnly owner_choice needs ownerOnlyWhy: one line saying why this choice is the owner's.");
      let route: { tier: "owner" | "ceo"; why: string } = { tier: "owner", why: "unchanged" };
      let ceoRow: { id: string } | undefined;
      if (input.ceoFirst && !input.plan) {
        const [me] = input.agentId ? await db.select({ role: agents.role }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))) : [];
        const [ceo] = await db.select({ id: agents.id, paused: agents.paused, companyPaused: companies.paused }).from(agents).innerJoin(companies, eq(companies.id, agents.companyId)).where(and(eq(agents.companyId, input.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
        route = routeAgentCard({ ownerOnly: input.ownerOnly, ownerMustDo: input.ownerMustDo, steps: input.steps, setsUp: input.setsUp, criterionIndexes: input.criterionIndexes, raiserRole: me?.role ?? null, ceoAvailable: !!ceo && !ceo.paused && !ceo.companyPaused && !!wake });
        if (route.tier === "ceo") ceoRow = ceo;
      }
      // A card this one replaces (BOS-1193): checked before anything is written, so a wrong id changes nothing.
      let replaced: { id: string; question: string; companyId: string } | null = null;
      if (input.replaces) {
        const [old] = await db.select().from(decisions).where(and(eq(decisions.id, input.replaces), eq(decisions.companyId, input.companyId), eq(decisions.status, "open")));
        if (!old) throw new AnswerError("replaces: no open card with that ID in your company.");
        const [me] = input.agentId ? await db.select({ role: agents.role }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))) : [];
        if (!me || (me.role !== "ceo" && old.raisedByAgentId !== input.agentId)) throw new AnswerError("replaces: you can only replace a card you raised.");
        if (old.kind !== "question" || (old.context as { type?: string }).type !== "question") throw new AnswerError("replaces: only a question card can be replaced this way; a plan card is replaced by submitting the new plan.");
        replaced = old;
      }
      // Ordering links may only point at open cards in the raiser's own company (BOS-625).
      const after = await keepOpenInCompany(db, input.companyId, input.doAfter, "doAfter");
      const before = await keepOpenInCompany(db, input.companyId, input.doBefore, "doBefore");
      const doAfter = after.kept;
      const doBefore = before.kept;
      const droppedLinks = [...after.dropped, ...before.dropped];
      // BOS-1219: a plan on a ticket whose plan the owner already approved amends it; the approval stays.
      const [approvedOf] = input.plan && input.blocksTicketId ? await db.select({ at: tickets.planApprovedAt }).from(tickets).where(eq(tickets.id, input.blocksTicketId)) : [];
      const questionText = `${input.question}${amendsText(approvedOf?.at)}`;
      const raised = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(decisions)
          .values({
            companyId: input.companyId,
            kind: "question",
            question: questionText,
            options: input.options,
            recommendedOption: input.recommended,
            raisedByAgentId: input.agentId,
            ...(route.tier === "ceo" ? { tier: "ceo" as const } : {}),
            context: { type: "question", ...(input.ownerOnly ? { ownerOnly: input.ownerOnly, ...(input.ownerOnlyWhy?.trim() ? { ownerOnlyWhy: input.ownerOnlyWhy.trim().slice(0, 200) } : {}) } : {}), ...(route.tier === "ceo" ? { ladder: { rung: "ceo", since: now().toISOString(), minutes: CEO_QUESTION_HANDOVER_MINUTES, ticketId: input.blocksTicketId ?? null, about: input.agentId ? [input.agentId] : [], hops: [{ to: "ceo", at: now().toISOString(), why: route.why }] } } : {}), ...(input.blocksTicketId ? { ticketId: input.blocksTicketId } : {}), ...(input.blocksTicketId && input.holdsMerge ? { holdsMerge: true as const } : {}), ...(input.criterionIndexes?.length ? { criterionIndexes: input.criterionIndexes } : {}), ...(input.criterionIndexes?.length && input.optionVerdicts ? { optionVerdicts: input.optionVerdicts } : {}), ...(input.triedFirst ? { triedFirst: input.triedFirst } : {}), ...(input.steps?.length ? { steps: input.steps, ...(input.stepSources?.length ? { stepSources: input.stepSources } : {}) } : {}), ...(input.stillNeeded ? { stillNeeded: input.stillNeeded } : {}), ...(input.ownerMustDo ? { ownerMustDo: true as const } : {}), ...(input.approveSummary ? { approveSummary: input.approveSummary } : {}), ...(input.lint ? { lint: input.lint } : {}), ...(input.plan ? { plan: true } : {}),
              // Ordering against other owner cards (BOS-551): "do after" / "do before" links, checked in the queue.
              ...(doAfter?.length ? { doAfter } : {}), ...(doBefore?.length ? { doBefore } : {}),
              // A restart would reset what this card measures, so a server update card lists it to do first (BOS-551).
              ...(input.resetsOnRestart ? { resetsOnRestart: true } : {}),
              // An add-on's setup card closes itself once the add-on is seen working (DR-023 D, BOS-522).
              ...(input.setsUp ? { setsUp: input.setsUp } : {}),
              // What closes the card by itself: the add-on seen working (DR-023 D) and/or the agent's own checkable conditions (BOS-1161). Alternatives: any one closes it.
              ...(input.setsUp || input.clearWhen?.length ? { clearWhen: [...(input.setsUp ? [{ kind: "addonRunning", addon: input.setsUp }] : []), ...(input.clearWhen ?? [])] } : {}),
            },
          })
          .returning();
        if (input.plan && input.blocksTicketId) await tx.update(tickets).set({ plan: input.plan, lastActivityAt: now() }).where(and(eq(tickets.id, input.blocksTicketId), isNull(tickets.planApprovedAt)));
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
          for (const other of input.alsoBlocksTicketIds ?? []) {
            await addTicketDependency(tx as unknown as Db, { companyId: input.companyId, blockedTicketId: other, blockerDecisionId: row!.id, actor: { type: "agent", agentId: input.agentId }, hold: true, now });
          }
        }
        return row!;
      });
      // BOS-1161: a new plan card closes the older open plan cards for the ticket.
      if (input.plan && input.blocksTicketId) await supersedePlanCards(db, { companyId: input.companyId, ticketId: input.blocksTicketId, newCardId: raised.id, now: now(), release: (id) => releaseIfFree(id, false), ...(await supersedeExtras(input.companyId, input.blocksTicketId, raised.id, input.agentId)) }).catch((err) => log(`closing older plan cards for ${input.blocksTicketId} failed: ${(err as Error).message}`));
      // BOS-1193: the older card closes as superseded. Explicitly (replaces), or when the same agent asks the same thing
      // again on the same ticket (similarQuestion). Two different questions from one agent both stay open.
      if (!input.plan) {
        const closeDeps = { markRead: (id: string, when: Date) => markDecisionNotificationRead(db, id, when), release: (id: string) => releaseIfFree(id, false), now };
        const note = `superseded by ${raised.id}`;
        if (replaced) await closeCardBySystem(db, replaced, note, closeDeps).catch((err) => log(`closing the replaced card ${replaced!.id} failed: ${(err as Error).message}`));
        else if (input.agentId) {
          const same = await db
            .select({ id: decisions.id, question: decisions.question, companyId: decisions.companyId, options: decisions.options, recommendedOption: decisions.recommendedOption })
            .from(decisions)
            .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "open"), ne(decisions.id, raised.id), eq(decisions.raisedByAgentId, input.agentId), eq(decisions.kind, "question"), sql`${decisions.context}->>'type' = 'question'`, sql`${decisions.context}->>'plan' is null`, input.blocksTicketId ? sql`${decisions.context}->>'ticketId' = ${input.blocksTicketId}` : sql`${decisions.context}->>'ticketId' is null`));
          // A card that offers other choices, or recommends another, is a different ask (BOS-195): it stays.
          const sameChoices = (o: (typeof same)[number]) => o.recommendedOption === input.recommended && [...((o.options as string[] | null) ?? [])].sort().join("\u0000") === [...input.options].sort().join("\u0000");
          for (const o of same) if (similarQuestion(o.question, input.question) && sameChoices(o)) await closeCardBySystem(db, o, note, closeDeps).catch((err) => log(`closing the repeated card ${o.id} failed: ${(err as Error).message}`));
        }
      }
      await record(db, { companyId: input.companyId, agentId: input.agentId, ticketId: input.blocksTicketId, kind: "decision_raised", summary: `${route.tier === "ceo" ? "Asked the CEO first" : "Asked the owner"}: ${input.question}`, at: now() });
      // (BOS-996) A new card is in the queue: the kept tally is stale from this moment.
      clearTallyCache();
      // BOS-1318: a team question waits with the CEO. If the CEO's wake is dropped it goes straight to the owner (wakeLadderCeo).
      if (route.tier === "ceo" && ceoRow) {
        const ladder = (raised.context as { ladder: Ladder }).ladder;
        await wakeLadderCeo(input.companyId, raised, { ladder }, ceoRow.id, [
          `A team question is waiting for you (decision ${raised.id}):\n${untrusted("agent's question", input.question.slice(0, 1000))}`,
          "An agent asked it, and it needs none of the owner's hands, money, secrets or sign-off, so it came to you before the owner. Settle it yourself: answer with the decisions tool (action answer, one of its options) and a note saying why. The agent is woken with your answer and the owner can read the note.",
          `If it really is the owner's call (product direction, a secret, money, a host step or a sign-off), escalate it at once (decisions tool, action escalate, with triedFirst). If you don't answer within ${CEO_QUESTION_HANDOVER_MINUTES} minutes it goes to the owner, marked as tried by you first.`,
        ].join("\n").slice(0, 4000));
      }
      // Links that weren't stored come back so the tool's reply can say which, and why (BOS-625).
      let withCeo = false;
      if (route.tier === "ceo") {
        const [now1] = await db.select({ tier: decisions.tier }).from(decisions).where(eq(decisions.id, raised.id));
        withCeo = now1?.tier === "ceo";
      }
      return { ...raised, droppedLinks, withCeo };
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
          await db.update(decisions).set({ context: mergeContext({ delivered: ok ? true : "run_ended" }) }).where(eq(decisions.id, d.id));
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
        // The asking agent counts too: a rule limited to one agent must apply here as it did at the first ask (BOS-598).
        const [asker] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, p.runId));
        const info: PermissionInfo = { title: payload.title, kind: payload.kind, rawInput: payload.rawInput, agentId: asker?.agentId ?? null };
        const { outcome } = evaluatePermission(info, await rulesFor(runner.companyId), { autoTempCleanup: await autoCleanupOn(runner.companyId) });
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

    setDeployWaitHook(hook: DeployWaitHook) {
      deployWait = hook;
    },

    setPermissionLog(l: PermissionLog) {
      permLog = l;
    },

    /** A runner reported a tool call that failed with "User refused permission" (BOS-306): log it with the run, agent and ticket. */
    async onRefusedCall(runner: { companyId: string }, runId: string, title: string | null) {
      const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(and(eq(runs.id, runId), eq(runs.companyId, runner.companyId)));
      permLog.refusedCall({ companyId: runner.companyId, runId, agentId: run?.agentId ?? null, ticketId: run?.ticketId ?? null, title });
    },

    /** A fenced run's tool call failed with a kernel refusal (BOS-325): logged with the run, agent and ticket. Wording only, never a decision. */
    async onFenceDenied(runner: { companyId: string }, runId: string, title: string | null) {
      const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(and(eq(runs.id, runId), eq(runs.companyId, runner.companyId)));
      permLog.fenceDenied({ companyId: runner.companyId, runId, agentId: run?.agentId ?? null, ticketId: run?.ticketId ?? null, title });
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
      const [done] = await db.update(decisions).set({ status: "withdrawn", dedupeKey: null, answeredAt: now() }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning({ id: decisions.id });
      if (done) await markDecisionNotificationRead(db, id, now());
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

    setNotifyHook(hook: (n: NotifyInput) => Promise<unknown>) {
      notifyFeed = hook;
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
     * One card by id, settled or not (BOS-951): after an answer it drops off the open list, and the owner
     * and the CEO still need to read the question, the full answer and note. Null when the company doesn't hold it.
     */
    async cardById(id: string, companyId: string) {
      const [row] = await db
        .select({ d: decisions, raisedBy: agents.name })
        .from(decisions)
        .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
        .where(and(eq(decisions.id, id), eq(decisions.companyId, companyId)));
      if (!row) return null;
      const d = row.d;
      const about = await decisionTicketIds(db, d);
      const ticketsAbout = about.length
        ? await db
            .select({ id: tickets.id, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix })
            .from(tickets)
            .innerJoin(companies, eq(companies.id, tickets.companyId))
            .where(and(eq(tickets.companyId, companyId), inArray(tickets.id, about)))
        : [];
      return {
        id: d.id,
        kind: d.kind,
        status: d.status,
        question: d.question,
        options: d.options as string[],
        recommended: d.recommendedOption,
        answer: d.answer,
        answerNote: (d.context as { settled?: { note?: string | null } }).settled?.note ?? (d.context as { answerNote?: string | null }).answerNote ?? null,
        answeredAt: d.answeredAt,
        settledBy: (d.context as { settled?: { name?: string } }).settled?.name ?? null,
        raisedBy: row.raisedBy ?? "Boss Man",
        tickets: ticketsAbout.map((t) => ({ id: t.id, title: t.title, ref: ticketRef(t.prefix, t.number) })),
        context: d.context,
        createdAt: d.createdAt,
      };
    },

    /**
     * The owner's queue (R20): every open decision with what it holds up, down the chain,
     * ranked by an explainable score. `includeAll` is the CEO's view (BOS-149): every open card
     * in the company, any tier, including lesson cards and cards still with the CEO or the
     * Scrum Master. `companyId` narrows that view to one company.
     */
    /**
     * What the owner has to do now (BOS-969). The number on the Decisions menu and the page's heading
     * must never drift, so both take it from here, over the same rows and the same rule as the list:
     * a card is actionable when it is not in the "Waiting, nothing to do yet" group. It walks the
     * owner's own queue (CEO-tier and lesson cards are left out there, so they wait for the ladder).
     * `companyId` narrows it to one company. (BOS-996) The page no longer sends its own figures: the
     * tally is the server's alone, and the heading reads the same number the menu does. The tally is
     * kept for a few seconds per view, so the menu badge, the page heading and the dashboard's
     * "need your answer" figure, polling together, share one walk of the ranked queue rather than
     * three. `now()` is the service's clock, so a test can step past the window.
     */
    async queueTally(opts: { includeAll?: boolean; companyId?: string } = {}): Promise<{ open: number; waiting: number }> {
      const key = opts.includeAll ? "*" : (opts.companyId ?? "");
      const hit = tallyCache.get(key);
      if (hit && hit.until > now().getTime()) return hit.tally;
      const query: { includeAll?: boolean; companyId?: string } = {};
      if (opts.includeAll) query.includeAll = true;
      if (opts.companyId) query.companyId = opts.companyId;
      const rows = (await this.queue(query)) as unknown as Array<{ waiting?: string | null }>;
      const waiting = rows.filter((r) => !!r.waiting).length;
      const tally = { open: rows.length - waiting, waiting };
      tallyCache.set(key, { tally, until: now().getTime() + TALLY_CACHE_MS });
      return tally;
    },

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

      // (BOS-413) Read only what the open cards point at, never every open ticket in every company with
      // its objective joins, and never every dependency row: the rows that name an open card, then the
      // chain below the tickets those reach.
      const openIds = open.map(({ d }) => d.id);
      const directDeps = await db.select().from(ticketDependencies).where(inArray(ticketDependencies.blockerDecisionId, openIds));

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
      const engagementTicketIds = [...new Set(open.flatMap(({ d }) => {
        const c = d.context as DecisionContext;
        return c.type === "engagement" ? [c.engagementId] : [];
      }))];
      const engagementDeps = engagementTicketIds.length
        ? await db.select({ engagementId: ticketDependencies.blockerEngagementId, blockedTicketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(inArray(ticketDependencies.blockerEngagementId, engagementTicketIds))
        : [];
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
            return engagementDeps.filter((x) => x.engagementId === c.engagementId).map((x) => x.blockedTicketId);
          default:
            return directDeps.filter((x) => x.blockerDecisionId === d.id).map((x) => x.blockedTicketId);
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
      // (BOS-413) The dependents chain below the tickets the cards hold up, in one round trip: a
      // recursive walk down from those tickets only, capped at the same depth of 10, reading only
      // rows that name a ticket already in the chain. Nothing outside the chain is read.
      const dependents = new Map<string, string[]>();
      {
        const seed = [...new Set(open.flatMap(({ d }) => direct(d)))];
        if (seed.length) {
          // node-postgres and PGlite both answer db.execute with the rows, but one wraps them.
          const result = (await db.execute(sql`
            with recursive chain(dep, blocker, blocked, depth) as (
              select d.id, d.blocker_ticket_id, d.blocked_ticket_id, 1
                from ticket_dependencies d
                join tickets k on k.id = d.blocker_ticket_id
                join tickets b on b.id = d.blocked_ticket_id
               where d.blocker_ticket_id in (${sql.join(seed.map((id) => sql`${id}`), sql`, `)})
                 and k.system_state <> 'done' and b.system_state <> 'done'
              union
              select d.id, d.blocker_ticket_id, d.blocked_ticket_id, c.depth + 1
                from ticket_dependencies d
                join chain c on d.blocker_ticket_id = c.blocked
                join tickets k on k.id = d.blocker_ticket_id
                join tickets b on b.id = d.blocked_ticket_id
               where c.depth < 10 and k.system_state <> 'done' and b.system_state <> 'done'
            )
            -- One row per edge, carrying the smallest dependency row that made it, so the consumer's
            -- order is the same on every run and every database.
            select min(dep::text) as dep, blocker, blocked from chain group by blocker, blocked`)) as unknown as { rows?: Array<{ dep: string; blocker: string; blocked: string }> } | Array<{ dep: string; blocker: string; blocked: string }>;
          const found = Array.isArray(result) ? result : (result.rows ?? []);
          // Under each blocker, its dependents in the order of the dependency rows that made them: the
          // same order the old walk over every dependency row produced (Postgres returns rows in no
          // promised order, so the sort is done here rather than in SQL).
          for (const r of [...found].sort((x, y) => x.dep.localeCompare(y.dep))) {
            dependents.set(r.blocker, [...(dependents.get(r.blocker) ?? []), r.blocked]);
          }
        }
      }

      // The chains' tickets, and only those, with the most important objective each serves and its
      // effective due date; plus the tickets a card is about, which may be done or hold nothing up.
      const chainIds = [...new Set([...dependents.keys(), ...[...dependents.values()].flat()])];
      const wantedTickets = [...new Set([...chainIds, ...wantedAbout])];
      const work = wantedTickets.length
        ? await db
            .select({
              id: tickets.id,
              title: tickets.title,
              number: tickets.number,
              systemState: tickets.systemState,
              assigneeAgentId: tickets.assigneeAgentId,
              companyId: tickets.companyId,
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
            // A chain member that is done is skipped, as before; a card's "about" ticket may be done.
            .where(inArray(tickets.id, wantedTickets))
        : [];
      const msObjectives = [...new Set(work.map((w) => w.milestoneObjectiveId).filter((x): x is string => !!x))];
      const msPriority = new Map(
        msObjectives.length ? (await db.select({ id: objectives.id, p: objectives.priority }).from(objectives).where(inArray(objectives.id, msObjectives))).map((o) => [o.id, o.p]) : [],
      );
      const info = new Map(
        work.map((w) => {
          const ps = [w.krPriority, w.milestoneObjectiveId ? msPriority.get(w.milestoneObjectiveId) : undefined].filter((p): p is number => p != null);
          return [w.id, { title: w.title, ref: ticketRef(w.prefix, w.number), companyId: w.companyId, prefix: w.prefix, number: w.number, dueDate: effectiveDueDate(w.dueDate, w.milestoneTarget), objectivePriority: ps.length ? Math.min(...ps) : null, systemState: w.systemState, assigneeAgentId: w.assigneeAgentId } as const];
        }),
      );
      // Only live tickets are in a chain; a done one (or a deleted one) is left out of the walk, and so
      // is everything below it: a done ticket never starts a chain, nor is it a hop through one.
      const liveOnly = new Set(work.filter((w) => w.systemState !== "done").map((w) => w.id));
      // Names of the agents holding the tickets a card is about, so a waiting reason can say who has it.
      const ticketAssigneeIds = [...new Set(work.map((w) => w.assigneeAgentId).filter((x): x is string => !!x))];
      const agentNameById = new Map(forNames);
      if (ticketAssigneeIds.length) {
        for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ticketAssigneeIds))) agentNameById.set(a.id, a.name);
      }

      // The ticket each card is about and where it stands, kept off the row so the queue's shape is
      // unchanged (BOS-551). A card whose ticket is back with an agent has nothing to do yet.
      const cardTicket = new Map<string, { state: string | null; agent: string | null }>();
      // (BOS-1236) A sign-off card lists who reviewed the ticket and how its last quick check ended, as of now.
      const signoffFactsOf = new Map<string, SignoffFacts>();
      for (const { d } of open) {
        const c = d.context as DecisionContext;
        if (c.type === "risk_review" && c.ticketId) signoffFactsOf.set(d.id, await signoffFacts(db, c.ticketId, typeof c.files === "number" ? c.files : null));
      }
      const rows = open.map(({ d, companyName, agentName }) => {
        // Walk down the chain, nearest first; each ticket counts once.
        const chain: Array<BlockedTicket & { ticketId: string; title: string; ref: string | null }> = [];
        const seen = new Set<string>();
        // Nearest first, and at each depth by ticket id: an order that is the same on every run,
        // which a read of every dependency row (the old walk) never promised anyway.
        const byTicket = (a: string, b: string) => a.localeCompare(b);
        let frontier = direct(d).filter((id) => liveOnly.has(id)).sort(byTicket);
        for (let depth = 1; frontier.length && depth <= 10; depth++) {
          const next: string[] = [];
          for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            const i = info.get(id);
            if (!i || !liveOnly.has(id)) continue;
            chain.push({ ticketId: id, title: i.title, ref: i.ref, depth, dueDate: i.dueDate, objectivePriority: i.objectivePriority });
            next.push(...(dependents.get(id) ?? []));
          }
          frontier = next.sort(byTicket);
        }
        const rank = rankDecision({ createdAt: d.createdAt, blocked: chain, holdsLiveRun: d.kind === "permission" }, t);
        const about = aboutIds(d).flatMap((id) => { const r = info.get(id); return r && r.companyId === d.companyId ? [{ ticketId: id, title: r.title, ref: ticketRef(r.prefix, r.number) }] : []; });
        const aboutTicket = aboutIds(d).map((id) => info.get(id)).find((r) => r && r.companyId === d.companyId);
        cardTicket.set(d.id, { state: aboutTicket?.systemState ?? null, agent: aboutTicket?.assigneeAgentId ? (agentNameById.get(aboutTicket.assigneeAgentId) ?? null) : null });
        const c = d.context as DecisionContext;
        const push = c.type === "permission" ? c.explain?.push : undefined;
        const pushTicket = push?.ticketId ? info.get(push.ticketId) : undefined;
        const facts = signoffFactsOf.get(d.id);
        const context = pushTicket && c.type === "permission" && c.explain
          ? { ...c, explain: { ...c.explain, push: { ...push!, ref: ticketRef(pushTicket.prefix, pushTicket.number) ?? undefined } } }
          : facts && c.type === "risk_review"
            ? { ...c, ...facts }
            : d.context;
        return { ...d, context, companyName, agentName, forAgentName: d.forAgentId ? (forNames.get(d.forAgentId) ?? null) : null, blocks: chain, about, ...rank };
      });
      const refs = await resolveRefs(db, open.map(({ d }) => ({ id: d.id, companyId: d.companyId, text: cardText(d) })));
      // Newest first, by when the card was raised; the score is shown but never reorders (BOS-164). The one
      // exception is a deploy card carrying the fix for a live problem (BOS-639): it goes to the top, because
      // the owner leaving it for later is what kept the BOS-410 memory fix off the live server for 12 hours.
      // It is put first here, in the base order the do-this-next ordering below breaks ties by, so it is
      // step 1, except that cards it says to do first (BOS-551: readings its restart would wipe) still
      // come just before it. Deploying first would destroy those readings, and they are quick.
      const urgent = (r: (typeof rows)[number]) => ((r.context as DecisionContext).type === "self_deploy" && !!(r.context as SelfDeployCtx).urgent ? 1 : 0);
      const sorted = rows.sort((a, b) => urgent(b) - urgent(a) || b.createdAt.getTime() - a.createdAt.getTime());

      // (BOS-551) Do-this-next ordering and the "waiting on an agent" group. Only cards that need the
      // owner's hands are numbered and ordered against each other; everything else keeps the newest-first
      // order and is never skipped. A card whose ticket is back with an agent (the owner acted and the
      // agent is confirming, or a merge/check card sent back) goes to the bottom group with its reason.
      const byId = new Map(sorted.map((r) => [r.id, r]));
      const label = (id: string) => {
        const r = byId.get(id);
        if (!r) return "";
        return r.question.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 80);
      };
      const contextOf = (r: (typeof sorted)[number]) => r.context as DecisionContext;
      const linksOf = (c: DecisionContext): { doAfter: OrderLink[]; doBefore: OrderLink[] } =>
        c.type === "question" ? { doAfter: c.doAfter ?? [], doBefore: c.doBefore ?? [] } : c.type === "owner_todo" || c.type === "self_deploy" ? { doAfter: c.doAfter ?? [], doBefore: [] } : { doAfter: [], doBefore: [] };
      // A server update restarts Boss Man, the same restart whether or not it is an infra hand-apply
      // (BOS-551): every self_deploy counts as hands-on so its "Do after" links are shown.
      const handsOn = (r: (typeof sorted)[number]) => {
        const c = contextOf(r);
        if (r.tier !== "owner") return false;
        if (c.type === "owner_todo" || c.type === "owner_setup") return true;
        if (c.type === "self_deploy") return true;
        if (c.type === "deploy") return true;
        if (c.type === "question") return !!c.steps?.length;
        return false;
      };
      // Why this card has nothing to do yet: the owner acted and the raising agent is checking it, or its
      // ticket is back with an agent (a merge check sent back, a review bounced). A card that is still the
      // owner's own call, or one that holds a live run, is not waiting.
      const AGENT_BACK_STATES = new Set(["in_progress"]);
      // Only a merge/review card can be waiting on the agent because its ticket is back with one. A
      // question, to-do or setup card is the owner's own live ask: it must keep its answer buttons even
      // when its ticket reads "in progress" (an agent may hold the ticket while the owner's card is
      // open, because starting a ticket ignores decision blockers; BOS-551 follow-up). Folding it here
      // would hide a reading behind a server update that resets it. An agent re-checking such a card
      // after the owner acted is already how `staleAt` folds it, so nothing is lost.
      const aboutTicket = (c: DecisionContext) => c.type === "review_loop" || c.type === "risk_review" || c.type === "check_stuck" || c.type === "review_stall";
      // (BOS-1193) Cards in a live re-check, and which of them the owner must still see.
      const isRechecking = (r: (typeof sorted)[number]) => !!r.staleAt && (r.recheckStage === "author" || r.recheckStage === "ceo");
      const hiddenRechecks = await hiddenWhileRechecked(db, sorted);
      const waitingOf = (r: (typeof sorted)[number]): { reason: string } | null => {
        // (BOS-1159) A flagged card that still holds up a live ticket stays in the main list with its
        // answer buttons: the Board shows that ticket as waiting on the owner, and the raising agent may
        // never get to confirm or withdraw, so folding it left the owner a "Answer in Decisions" button
        // that led to nothing. The card itself says the owner acted since it was written.
        // (BOS-1193, DR-054) A card being re-checked is folded away whatever it blocks: the Board agrees (it shows "card being
        // re-checked", not "Answer in Decisions"), and the card is back here, flagged as lapsed, if nobody settles it in an hour.
        // Urgent cards, a request holding a live run and merge/review-loop cards stay in the main list, marked.
        if (hiddenRechecks.has(r.id)) return { reason: `Being re-checked by ${r.agentName ?? "the agent"} (${r.staleReason ?? "something it depends on changed"}). It comes back here if it is not confirmed or closed within the hour.` };
        const c = contextOf(r);
        const t = cardTicket.get(r.id);
        if (aboutTicket(c) && t && t.state && AGENT_BACK_STATES.has(t.state)) {
          const who = t.agent ?? "an agent";
          const why = c.type === "check_stuck" ? "the merge check failed, so the ticket is back with" : "the ticket is back with";
          return { reason: `Nothing to do yet: ${why} ${who}.` };
        }
        return null;
      };
      const waitingIds = new Set(sorted.filter((r) => waitingOf(r)).map((r) => r.id));
      const ordered = sorted.filter((r) => !waitingIds.has(r.id));
      // Hands-on cards, plus any card that carries links to another card, are ordered against each other:
      // a link on a card that needs no hands-on work still says when to do it (BOS-551).
      const carriesLinks = (r: (typeof sorted)[number]) => { const l = linksOf(contextOf(r)); return l.doAfter.length > 0 || l.doBefore.length > 0; };
      const orderCards = ordered.filter((r) => r.tier === "owner" && (handsOn(r) || carriesLinks(r)));
      const orderInput = orderCards.map((r) => {
        const c = contextOf(r);
        const links = (x?: OrderLink[]) => (x ?? []).filter((l) => byId.has(l.decisionId) && !waitingIds.has(l.decisionId)).map((l) => ({ decisionId: l.decisionId, label: l.label || label(l.decisionId) }));
        // A card's stored links carry the label as written when raised; fall back to the live card's first line.
        const l = linksOf(c);
        return { id: r.id, doAfter: links(l.doAfter), doBefore: links(l.doBefore) };
      });
      const { steps: stepOf } = orderOwnerCards(orderInput);
      const edgeLabels = new Map<string, { after: string[]; before: string[] }>();
      for (const o of orderInput) {
        edgeLabels.set(o.id, { after: o.doAfter.map((l) => l.label || label(l.decisionId)), before: o.doBefore.map((l) => l.label || label(l.decisionId)) });
      }
      // Hands-on cards come first, in their do-this-next order. Everything else keeps today's newest-first
      // order after them, and the waiting group goes last. A card with no ordering info is never displaced
      // among its own kind: the ordering helper's tie-break is that same newest-first order. Only hands-on
      // cards show a step number; a link-only card is ordered but not numbered.
      const handsOnIds = new Set(orderCards.filter((r) => handsOn(r)).map((r) => r.id));
      const orderIds = new Set(orderCards.map((r) => r.id));
      const orderOut = orderCards.slice().sort((a, b) => stepOf[a.id]! - stepOf[b.id]!);
      const restOut = ordered.filter((r) => !orderIds.has(r.id));
      // The waiting group goes last, newest-first among themselves.
      const waitingOut = sorted.filter((r) => waitingIds.has(r.id));
      const finalRows = [...orderOut, ...restOut, ...waitingOut];

      return Promise.all(
        finalRows.map(async (r) => {
          // (BOS-1193) A card kept in the main list while it is re-checked says who is checking it; one that nobody re-checked in
          // time says plainly who failed to, not "may be out of date".
          const rechecking = isRechecking(r) ? { by: r.agentName ?? "the agent", stage: r.recheckStage as "author" | "ceo" } : null;
          const notRechecked = r.staleAt && r.recheckStage === "lapsed" ? `Not re-checked: ${r.agentName ?? "the agent that raised it"} and the CEO didn't confirm this within an hour. Flagged because ${r.staleReason ?? "something it depends on changed"}.` : null;
          const withRefs = { ...r, refs: refs.get(r.id) ?? {}, rechecking, notRechecked };
          const w = waitingOf(r);
          const step = handsOnIds.has(r.id) ? (stepOf[r.id] ?? null) : null;
          const e = edgeLabels.get(r.id);
          const ordering = {
            ...(step ? { step } : {}),
            ...(w ? { waiting: w.reason } : {}),
            ...(e && e.after.length ? { doAfter: e.after } : {}),
            ...(e && e.before.length ? { doBefore: e.before } : {}),
          };
          const withOrdering = { ...withRefs, ...ordering };
          return (r.context as DecisionContext).type === "stalled_run" ? { ...withOrdering, evidence: await stallEvidence((r.context as { runId: string }).runId) } : withOrdering;
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
      const claimed = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(decisions)
          .set({ context: sql`jsonb_set(${decisions.context}, '{advice}', ${JSON.stringify(advice)}::jsonb)` })
          .where(and(eq(decisions.id, id), eq(decisions.status, "open"), sql`coalesce(${decisions.context}->'advice'->>'state', '') <> 'asking'`))
          .returning({ id: decisions.id });
        // The card may now be reworded by the CEO: a phone Approve link sent for it must not outlive that (BOS-243 rule 5).
        if (row) await revokeApproveTokens(tx as unknown as Db, id, now());
        return row;
      });
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
    async advise(input: { id: string; companyId: string; agentId: string | null; outcome: "reissue"; runId?: string; question: string; options: string[]; recommended: string; triedFirst: string; steps?: string[]; stepSources?: Array<StepSource | null>; lint?: CardLint; /** What each new option means for the criteria the card settles (BOS-1155); needed when the card is linked to criteria. */ optionVerdicts?: Record<string, string>; /** The owner must act now (BOS-1110): stored as the card's urgent mark, so it also reaches their phone. */ urgentWhy?: string } | { id: string; companyId: string; agentId: string | null; outcome: "handled"; runId?: string; summary: string; answer?: string } | { id: string; companyId: string; agentId: string | null; outcome: "advice"; runId?: string; what?: string; needed?: string; recommendation?: "allow" | "deny"; why: string }) {
      const via = input.runId ? ` (CEO run ${input.runId})` : "";
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, input.id), eq(decisions.companyId, input.companyId)));
      if (!d) throw new AnswerError("No decision with that id.");
      if (d.status !== "open") return null;
      const advice = adviceOf(d.context);
      const at = now().toISOString();
      if (input.outcome === "advice") {
        // Advice on a permission request is for the owner's queue whatever the rung: the CEO may add it
        // unasked (BOS-233 item 3), and on a CEO-rung card it travels down when the card does, without
        // settling it. A permission request the CEO raised itself goes to the owner as before.
        const permission = d.kind === "permission" && (d.context as { type?: string }).type === "permission";
        if (permission) {
          if (d.raisedByAgentId && d.raisedByAgentId === input.agentId) throw new AnswerError("That's the CEO's own permission request; its advice would be on its own request. Leave it for the owner.");
        } else if (advice?.state !== "asking") {
          // On any other card advice answers the owner's question, so it needs the owner to have asked.
          throw new AnswerError(advice?.state === "timed_out" ? "The time ran out and the decision went back to the owner." : "The owner hasn't asked for advice on this decision.");
        }
        const what = (input.what ?? "").trim();
        const needed = (input.needed ?? "").trim();
        const why = input.why.trim();
        if (why.length < 10) throw new AnswerError("Say why, in a short plain sentence: the owner reads it on the card.");
        if (permission && (what.length < 10 || needed.length < 5)) throw new AnswerError("Say what the command does and whether the ticket needs it, in short plain sentences.");
        // A permission card shows the advice block (what it does / whether it's needed / the recommendation).
        // Any other card only carries a plain note answering the owner's question.
        const nextAdvice: Advice = permission
          ? { ...advice, state: "advised", at, what, needed, recommendation: input.recommendation, why }
          : { state: "advised", at, note: advice?.note, originalQuestion: advice?.originalQuestion, summary: why, why };
        const [done] = await db
          .update(decisions)
          .set({ context: mergeContext({ advice: nextAdvice }) })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), permission ? undefined : sql`${decisions.context}->'advice'->>'state' = 'asking'`))
          .returning({ id: decisions.id });
        if (!done) return null;
        const held = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
        await record(db, { companyId: d.companyId, agentId: input.agentId, ticketId: held[0]?.ticketId, kind: "decision_advised", summary: permission ? `CEO advised ${input.recommendation === "allow" ? "Allow" : "Deny"} on "${d.question}": ${why}${via}` : `CEO advised on "${d.question}": ${why}${via}`, at: now() });
        return { outcome: "advice" as const, id: d.id };
      }
      if (advice?.state !== "asking") throw new AnswerError(advice?.state === "timed_out" ? "The time ran out and the decision went back to the owner." : "The owner hasn't asked for advice on this decision.");
      if (input.outcome === "reissue") {
        if (d.kind === "permission") throw new AnswerError("A permission request has its command and options already. Use outcome advice to tell the owner what it does and whether to allow it.");
        // The CEO proposed this skill, so it must not get to reword the card the owner decides on (BOS-168).
        if (d.kind === "skill") throw new AnswerError("The CEO proposed this skill, so it can't rewrite this card. If something is unclear, the owner can ask the CEO about it in chat.");
        const ctx = d.context as DecisionContext;
        const asking = sql`${decisions.context}->'advice'->>'state' = 'asking'`;
        // The CEO's urgent mark (BOS-1097, BOS-1110): the same stored field escalate sets, so the card pushes once it is on the owner's tier.
        const urgentWhy = input.urgentWhy?.trim();
        if (input.urgentWhy !== undefined && (urgentWhy!.length < 10 || urgentWhy!.length > 200)) throw new AnswerError("urgentWhy must be 10 to 200 characters: one short sentence on what the owner must act on now.");
        const [ceoRow] = urgentWhy ? await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, input.agentId ?? ""), eq(agents.companyId, d.companyId), eq(agents.role, "ceo"))) : [];
        if (urgentWhy && !ceoRow) throw new AnswerError("Only the CEO marks a card urgent.");
        const urgentMark = urgentWhy ? { urgentPush: { by: ceoRow!.name, at, why: urgentWhy } } : {};
        if (!(d.kind === "question" && ctx.type === "question")) {
          // An approval, plan, hire, deploy and the like keep their id, kind, options and context, so what resumes on
          // them still works: the CEO only rewrites the question and adds what was tried and the steps.
          const clarified = { triedFirst: input.triedFirst.trim(), ...urgentMark, ...(input.steps?.length ? { steps: input.steps, ...(input.stepSources?.length ? { stepSources: input.stepSources } : {}), lint: input.lint } : {}), advice: { ...advice, state: "clarified", at, originalQuestion: advice.originalQuestion ?? d.question } };
          const done = await db.transaction(async (tx) => {
            const [row] = await tx
              .update(decisions)
              .set({ question: input.question, context: mergeContext(clarified) })
              .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), asking))
              .returning({ id: decisions.id });
            if (row) await revokeApproveTokens(tx as unknown as Db, d.id, now());
            return row;
          });
          if (!done) return null;
          const [held] = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
          await record(db, { companyId: d.companyId, agentId: input.agentId, ticketId: held?.ticketId, kind: "decision_reissued", summary: `CEO rewrote "${d.question}" with more detail${via}`, at: now() });
          return { outcome: "reissue" as const, id: d.id, inPlace: true };
        }
        if (!input.options.includes(input.recommended)) throw new AnswerError("The recommended answer must be one of the options.");
        // A card linked to criteria keeps the link, and its reworded options must say what they mean (BOS-1155).
        const linked = (d.context as { criterionIndexes?: number[] }).criterionIndexes;
        if (linked?.length) {
          const refusal = optionVerdictsRefusal(input.options, input.optionVerdicts);
          if (refusal) throw new AnswerError(refusal);
        }
        const newId = randomUUID();
        const made = await db.transaction(async (tx) => {
          const [claimed] = await tx
            .update(decisions)
            .set({ status: "withdrawn", answeredAt: now(), dedupeKey: null, context: mergeContext({ advice: { ...advice, state: "reissued", at, replacedBy: newId } }) })
            .where(and(eq(decisions.id, d.id), eq(decisions.status, "open"), asking))
            .returning({ id: decisions.id });
          if (!claimed) return false;
          await revokeApproveTokens(tx as unknown as Db, d.id, now());
          await tx.insert(decisions).values({
            id: newId,
            companyId: d.companyId,
            kind: "question",
            question: input.question,
            options: input.options,
            recommendedOption: input.recommended,
            raisedByAgentId: d.raisedByAgentId,
            // The card says the CEO wrote it and points back at the original (advice.replaces).
            // A card that held its ticket's merge still does once reworded (BOS-1078): the hold moves with the link below.
            context: { type: "question", ...(linked?.length ? { criterionIndexes: linked, optionVerdicts: input.optionVerdicts as OptionVerdicts } : {}), triedFirst: input.triedFirst.trim(), ...urgentMark, ...(input.steps?.length ? { steps: input.steps, ...(input.stepSources?.length ? { stepSources: input.stepSources } : {}) } : {}), ...(input.lint ? { lint: input.lint } : {}), ...((d.context as { holdsMerge?: boolean } | null)?.holdsMerge ? { holdsMerge: true as const, ...((d.context as { ticketId?: string }).ticketId ? { ticketId: (d.context as { ticketId?: string }).ticketId } : {}) } : {}), advice: { state: "replacement", replaces: d.id, at } satisfies Advice },
          });
          await tx.update(ticketDependencies).set({ blockerDecisionId: newId }).where(eq(ticketDependencies.blockerDecisionId, d.id));
          return true;
        });
        if (!made) return null;
        // The card was withdrawn in the transaction above; its notification is read now (BOS-413).
        await markDecisionNotificationRead(db, d.id, now());
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
    async withdrawCard(input: { id: string; companyId: string; agentId: string; note: string; /** DR-058: what takes the card's place; the tool requires it, and with it a card that reached the owner leaves a notice. */ replacement?: Replacement }) {
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
      // A folded account card (account_limit) can name several agents' live failures, and `cardInvalidReason` sees only
      // its first raise's ticket, so it stays out of this: it closes itself once the cause is gone (BOS-469).
      const ownerTierInfo = ctx.ladder?.rung === "owner" && isSystemCard(d) && ctx.type !== "check_stuck" && !OWNER_ONLY_ANSWER_TYPES.has(ctx.type) && !STALE_ONLY_WITHDRAW_TYPES.has(ctx.type) && (ctx as { decisionsKind?: string }).decisionsKind !== "alert:account_limit";
      if (ctx.ladder?.rung === "owner" && !ownerTierInfo) throw new AnswerError("This alert is already with the owner, so it isn't yours to withdraw. Leave it for them.");
      if (ownerTierInfo && !(await cardInvalidReason(db, d))) throw new AnswerError("This alert is with the owner. Clear it only once it is stale (its ticket is done or merged, or the card is otherwise dead).");
      // A permission request holds a live run and is the owner's alone: the CEO never withdraws it,
      // stale or not. It expires on its own (BOS-149).
      // BOS-1193: except a plan card whose run has ended. Nothing is waiting on it any more, and it is the CEO's to close
      // when it is a duplicate, stale, or being re-checked (below); a run that is still alive is still refused.
      const planCard = (ctx as { plan?: boolean }).plan === true;
      if (ctx.type === "permission" && (!planCard || (await holdsLiveRun(db, d.context)))) throw new AnswerError("A permission request holds a live run, so the CEO can't withdraw it. Leave it for the owner; it expires on its own.");
      // A card being re-checked is the CEO's to settle (BOS-1193), duplicate or stale or not.
      const inRecheck = !!d.staleAt && (d.recheckStage === "author" || d.recheckStage === "ceo");
      // Fail closed: only system and info cards may be cleared outright, and a live merge card never:
      // it is waiting on the owner and can only be answered, not dropped (BOS-149).
      const direct = isSystemCard(d) && ctx.type !== "check_stuck";
      const staleOnly = OWNER_ONLY_ANSWER_TYPES.has(ctx.type) || STALE_ONLY_WITHDRAW_TYPES.has(ctx.type);
      if (staleOnly) {
        // Two open sign-offs or loop cards for one ticket are normal (one per round), so a duplicate
        // is not a reason to clear one of the owner's own cards: only a finished ticket is.
        if (!(await cardInvalidReason(db, d))) {
          throw new AnswerError("This card is the owner's own choice. Withdraw it only when its ticket is finished or merged.");
        }
      } else if (!direct && !inRecheck && !(await cardInvalidReason(db, d)) && !(await isDuplicate(d))) {
        throw new AnswerError("This card is the owner's. Withdraw it only when it is dead (its ticket is finished or merged) or a duplicate of another open card.");
      }
      const withdrawal: Withdrawal = { by: "ceo", agentId: input.agentId, name: ceo.name, note, at: now().toISOString() };
      // DR-058 B, after the checks above so a card the CEO may not withdraw is refused for that reason first.
      const rb = input.replacement ? parseReplacedBy({ reason: note, ...input.replacement }) : null;
      if (rb && !rb.ok) throw new AnswerError(rb.error);
      const facts = rb ? await withdrawFacts(d) : null;
      const closed = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(decisions)
          .set({ status: "withdrawn", answeredAt: now(), dedupeKey: null, recheckStage: null, context: mergeContext({ withdrawn: withdrawal }) })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
          .returning({ id: decisions.id });
        if (row) await revokeApproveTokens(tx as unknown as Db, d.id, now());
        return row;
      });
      if (!closed) return null;
      await markDecisionNotificationRead(db, d.id, now());
      await record(db, { companyId: d.companyId, agentId: input.agentId, kind: "decision_withdrawn", summary: `${ceo.name} withdrew "${d.question}": ${note}`, at: now() });
      if (facts && rb?.ok) await noticeWithdrawn(d, facts, { agentId: input.agentId, agent: ceo.name, reason: rb.reason, replacedBy: rb.replacedBy });
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
      // Cards the CEO cleared as stale or duplicates (BOS-149), with the reason they gave, and every card
      // Boss Man closed by itself (BOS-740: the add-on setup card, a switched-back setup card, a hand-apply
      // card that went live). Kept for 30 days so the owner can still trace a withdrawal after a day.
      const withdrawnSince = new Date(now().getTime() - 30 * 24 * 3_600_000);
      const withdrawn = await db
        .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context })
        .from(decisions)
        .where(and(eq(decisions.status, "withdrawn"), sql`${decisions.context}->'withdrawn'->>'by' in ('ceo', 'system')`, sql`(${decisions.context}->'withdrawn'->>'at')::timestamptz > ${withdrawnSince.toISOString()}::timestamptz`))
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
          const closed = (r.context as { closedNotice?: { text?: string } }).closedNotice;
          return { id: r.id, companyId: r.companyId, question: r.question.split("\n")[0]!.slice(0, 300), about: aboutOf(r), withdrawn: { by: w.name ?? (w.by === "system" ? "Boss Man" : "the CEO"), note: w.note, ...(w.newer ? { newer: w.newer } : {}), ...(closed?.text ? { notice: closed.text } : {}) } };
        }),
        ...fromAlerts,
      ];
    },

    /** Records the answer and resumes what was waiting. Returns null if not open. */
    async answer(id: string, answer: string, extra: AnswerExtra = {}) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      // (BOS-996) The queue changed: the badge, the heading and the dashboard read it afresh next poll.
      clearTallyCache();
      if (!d) {
        // A sign-off the owner pressed twice (or the CEO settled) is already answered, and the ticket page's
        // Approve and merge still merges it rather than refusing on a card that is no longer open (BOS-471).
        if (answer === APPROVE_MERGE) {
          const [row] = await db.select({ status: decisions.status, context: decisions.context }).from(decisions).where(eq(decisions.id, id));
          if (row?.status === "answered" && (row.context as DecisionContext).type === "risk_review") return { settled: "already" };
        }
        return null;
      }
      // DR-061 Q4: a card Boss Man can see is dead (a newer plan, a ticket already in review, a withdrawn engagement) is closed here
      // rather than answered, so a press before the next sweep can't set planApprovedAt or start work nobody asked for.
      if (isCheckableCard(d)) {
        const dead = await cardInvalidReason(db, d);
        if (dead) {
          await closeCardBySystem(db, d, dead, { markRead: (cid, when) => markDecisionNotificationRead(db, cid, when), release: (tid) => releaseIfFree(tid, false), now });
          throw new AnswerError(`This card is no longer valid (${dead}), so Boss Man closed it instead of taking the answer.`);
        }
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
      // A sign-off card for code that has since changed is never taken as an approval: it is replaced, and the owner is told why (BOS-734).
      if (ctx.type === "risk_review" && answer === APPROVE_MERGE && !extra.settledBy && ctx.head && loopHooks?.signoffStale) {
        const stale = await loopHooks.signoffStale(ctx.ticketId, ctx.head).catch(() => null);
        if (stale) throw new AnswerError(stale);
      }
      if (ctx.type === "model_change" && answer === MODEL_EDIT && !extra.modelConfig) throw new AnswerError("Edit needs the harness, provider, model and paid-from you want.");
      if (ctx.type === "team_plan" && extra.picks?.some((i) => !Number.isInteger(i) || i < 0 || i >= ctx.hires.length)) throw new AnswerError("That hire isn't in the plan.");
      // "Allow always" answers this request and adds a rule after the company's own rules, so an owner's deny still wins.
      let saveRule: ((h: typeof db) => Promise<void>) | undefined;
      const always = ctx.type === "permission" ? ctx.always?.find((a) => a.label === answer) : undefined;
      if (always) {
        // Standing rules are the owner's call, never an agent's, whatever the answer path (BOS-294).
        if (extra.settledBy || extra.by === "ceo") throw new AnswerError("Only the owner can save a standing rule.");
        // Built from the choice stored on the card, never from anything the browser sent; only the scope is the owner's pick.
        const scope: AlwaysScope = extra.alwaysScope ?? "agent";
        if (scope !== "agent" && scope !== "company") throw new AnswerError("The scope must be this agent or every agent.");
        const asker = (ctx as Extract<DecisionContext, { type: "permission" }>).alwaysAgent;
        if (scope === "agent" && !asker) throw new AnswerError("This request has no known agent, so the rule can only cover every agent.");
        // Cards raised before file rules were withdrawn may still carry a kind-wide read/edit choice; never save it.
        if (!always.match.commandPattern && !always.match.titlePattern && always.match.kinds?.some((k) => k === "read" || k === "edit" || k === "fetch")) throw new AnswerError("That rule is no longer offered: it would cover files or web addresses Boss Man can't check. Use Allow once.");
        // Same for a server-wide tool choice (it would cover destructive tools and ones added later): only an exact-tool title ending in $ is saved.
        if (always.match.titlePattern?.startsWith("^mcp__") && !always.match.titlePattern.endsWith("$")) throw new AnswerError("That rule is no longer offered: it would cover every tool on the server. Use Allow once.");
        const condition: PolicyMatch = { ...always.match, safeOnly: true, ...(scope === "agent" ? { agentIds: [asker!.id] } : {}) };
        const problems = ruleProblems(condition);
        if (problems.length) throw new AnswerError(`That rule can't be saved: ${problems.join(" ")}`);
        saveRule = async (h) => {
        const [last] = await h.select({ position: policyRules.position }).from(policyRules).where(and(eq(policyRules.trigger, "permission"), eq(policyRules.companyId, d.companyId))).orderBy(desc(policyRules.position)).limit(1);
        const on = formatDate("en-GB", now(), { day: "numeric", month: "short" });
        await h.insert(policyRules).values({ companyId: d.companyId, name: `${always.name}${scope === "agent" ? ` for ${asker!.name}` : ""} (from a request on ${on})`, trigger: "permission", condition, outcome: "allow", position: (last?.position ?? -1) + 1, createdAt: now(), createdBy: extra.by ?? "the owner", sourceDecisionId: d.id });
        };
        answer = ALLOW;
      }
      if (ctx.type === "rule_proposal" && answer === ADD_RULE && !extra.custom) saveRule = async (h) => { await policyRulesService(h).create({ companyId: d.companyId, ...ctx.rule, createdBy: extra.by ?? "the owner", sourceDecisionId: d.id }); };
      // Kept on the decision so the owner can see who settled it and why (BOS-111). Written on a copy, not
      // on ctx itself, so reopening a card later restores the pre-answer context without this record.
      let settled: Settled | undefined;
      if (extra.settledBy) {
        const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, extra.settledBy.agentId));
        settled = { agentId: extra.settledBy.agentId, name: who?.name ?? "the CEO", note: extra.note?.trim().replace(/\s+/g, " ").slice(0, 500) || null, at: now().toISOString() };
      }
      // The owner's own note is kept on the card too (BOS-951), so a card read by id after it drops off the queue
      // shows it beside the answer. `settled` covers the CEO's note; this is the owner's, kept whole in the card.
      const ownerNote = !extra.settledBy && extra.note?.trim() ? extra.note.trim().slice(0, 4000) : null;
      // Conditional on still being open (and, for the CEO, still asked) and still on the same tier it
      // was read on, so whoever closes it first wins and the loser changes nothing. The tier clause
      // closes the race where the ladder hands the open card to the owner between the CEO reading it
      // and answering: the answer then matches nothing instead of closing the owner's card (BOS-159).
      // The rule is saved in the same transaction as the close, so a failed save leaves the card open and
      // no rule behind, and a crash between the two cannot allow once with no rule (BOS-598).
      const close = async (h: typeof db) => {
      const [row] = await h
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again; so does a
        // loop alert (alert-ladder.ts), whose key only stops a repeat while it is open.
        .set({
          status: "answered",
          answer,
          answeredAt: now(),
          ...(ctx.type === "stale_blocker" || ctx.type === "check_stuck" || ctx.type === "review_stall" || d.dedupeKey?.startsWith("alert:") ? { dedupeKey: null } : {}),
          ...(extra.handled
            ? { context: mergeContext({ advice: { ...adviceOf(d.context), state: "handled", ...extra.handled }, ...(ownerNote ? { answerNote: ownerNote } : {}) }) }
            : settled
              ? { context: mergeContext({ settled }) }
              : ownerNote
                ? { context: mergeContext({ answerNote: ownerNote }) }
                : {}),
        })
        .where(and(eq(decisions.id, id), eq(decisions.status, "open"), eq(decisions.tier, d.tier), ...(extra.by === "ceo" ? [sql`${decisions.context}->'advice'->>'state' = 'asking'`] : [])))
        .returning({ id: decisions.id });
      // Only the request that closed the card saves the rule, so a double tap or retry cannot save it twice.
      if (row) await saveRule?.(h);
      return row;
      };
      const closed = saveRule ? await db.transaction((tx) => close(tx)) : await close(db);
      // A repeat of this command waited on this card (BOS-376): an Allow once settles it too, and a Deny
      // never turns into one. The card keeps what settled, so the audit shows the repeat.
      if (closed && ctx.type === "permission" && repeatsNow?.length) {
        const say = answer === ALLOW || answer === APPROVE_PLAN ? "allow" : "deny";
        // Do not ignore the send result (BOS-376 review): a repeat whose runner has dropped off is not
        // settled yet, so it is left unmarked and a reconnect resend still answers it. Only mark a repeat
        // settled once its answer has actually been sent.
        repeatsNow = repeatsNow.map((r) => (send(r.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: r.requestId, verdict: say }) ? { ...r, settled: say } : r));
        await db.update(decisions).set({ context: mergeContext({ repeats: repeatsNow }) }).where(eq(decisions.id, id));
      }
      if (!closed) return null;
      // The card is settled, so its notification is read now rather than on the next feed poll (BOS-413).
      await markDecisionNotificationRead(db, id, now());

      // The owner's answer goes on the conversation of every ticket the card was about (BOS-951): the wake
      // that follows is short, so this is where the assignee reads the whole answer and note, whether the
      // card was a plain question or a system one (a host check, a sign-off, a review loop).
      if (!extra.settledBy) {
        try {
          await postAnswerOnTickets(db, { companyId: d.companyId, question: d.question, answer }, await decisionTicketIds(db, d), extra.by === "ceo" ? "The CEO" : "The owner", extra.note, log, now);
        } catch (err) {
          log(`answering decision ${id} was saved, but posting it on its tickets failed: ${(err as Error).message}`);
        }
      }

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

      // A plan put through submit_plan (BOS-531): approving the card releases plan-first, like approving ExitPlanMode.
      if (ctx.type === "question" && ctx.plan && ctx.ticketId && answer === APPROVE_PLAN) await db.update(tickets).set({ planApprovedAt: now() }).where(eq(tickets.id, ctx.ticketId));

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
          await db.update(decisions).set({ context: mergeContext({ ...(repeatsNow ? { repeats: repeatsNow } : {}), delivered: "run_ended" }) }).where(eq(decisions.id, id));
        } else if (!delivered) {
          // Never fail silently (R22): flag it, and re-send when the runner reconnects.
          await db.update(decisions).set({ context: mergeContext({ repeats: repeatsNow, delivered: false }) }).where(eq(decisions.id, id));
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
            doAfter: ctx.doAfter,
            quietFirst: ctx.target === "server" && !!deployWait,
          });
        } else if (answer === DEPLOY || answer === UPDATE_RUNNERS || answer === DEPLOY_AND_RUNNERS) {
          try {
            // A server update waits for a quiet machine (BOS-420); it is sent at once when the machine is quiet already.
            // Runner updates have their own drain (DR-006) and go as before.
            const thenRunners = answer === DEPLOY_AND_RUNNERS;
            if (ctx.target === "server" && deployWait) await deployWait.begin({ decisionId: id, commit: ctx.commit, fromCommit: ctx.fromCommit, thenRunners });
            else await selfDeploy!.send(ctx, id, { thenRunners });
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
        if (answer === QUIET_FIRST) {
          // Make room before the owner applies a server update by hand (BOS-420). The to-do stays open; the wait
          // writes how quiet the machine is onto it, and nothing is sent to the host.
          await db.update(decisions).set({ status: "open", answer: null, answeredAt: null }).where(eq(decisions.id, id));
          await deployWait!.begin({ decisionId: ctx.ofDecisionId, commit: ctx.commit!, fromCommit: ctx.fromCommit!, origin: "hand" });
        } else if (answer === TODO_FAILED) {
          const note = (extra.note ?? "").trim() || "No details given.";
          // Reopening restores the pre-answer context: only the keys answering wrote (settled, a handled advice) are put back.
          const hadAdvice = (ctx as { advice?: unknown }).advice !== undefined;
          const reopened = mergeContext({ lastFailure: { note, at: now().toISOString() }, ...(hadAdvice ? { advice: (ctx as { advice?: unknown }).advice } : {}) });
          await db
            .update(decisions)
            .set({ status: "open", answer: null, answeredAt: null, context: hadAdvice ? sql`${reopened} - 'settled'` : sql`${reopened} - 'settled' - 'advice'` })
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
        await maintenance?.answered(answer, { runIds: ctx.runIds });
      } else if (ctx.type === "deploy_wait") {
        await deployWait?.answered(answer);
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
              .set({ context: mergeContext({ applied: { at: now().toISOString(), afterRunId: applied.afterRunId, config } }) })
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
      } else if (ctx.type === "hire" || ctx.type === "instructions" || ctx.type === "rename" || ctx.type === "standing_rules") {
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
        else if (ctx.type === "review_loop" && answer === MOVE_AFTER_MERGE && ctx.movable?.length) await loopHooks?.moveAfterMerge(ctx.ticketId, ctx.movable);
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
      } else if (ctx.type === "run_time_limit") {
        // Only lifts a limit that is still the one the card was about, so a limit the owner changed meanwhile isn't overwritten.
        if (answer === "Raise the limit") await db.update(companies).set({ maxRunMinutes: Math.min(10080, Math.ceil(ctx.minutes * 1.5)) }).where(and(eq(companies.id, d.companyId), eq(companies.maxRunMinutes, ctx.minutes)));
      } else if (ctx.type === "fence_default") {
        await applyFenceAnswer(db, d.companyId, answer, now());
      } else if (ctx.type === "fence_unavailable") {
        await applyFenceUnavailableAnswer(db, d.companyId, answer, now());
      } else if (ctx.type === "guard_unavailable") {
        await applyGuardAnswer(db, d.companyId, answer, now());
      } else if (ctx.type === "risk_review") {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        // The sign-off is answered: any "sign-off still waiting" retry card for this ticket is stale now (BOS-446), and the merge starts below.
        await clearMergeCards(db, ctx.ticketId, { by: "system", note: "The owner's sign-off was answered, so this retry card is no longer needed.", at: new Date().toISOString() });
        // DR-013: the owner signed off this commit. Merged into the stored context (not overwriting it) so an advice record stays.
        // Only the owner's own answer counts; the CEO is refused above, and this keeps it so if that guard ever changes.
        if (answer === APPROVE_MERGE && !extra.settledBy && ctx.head) {
          const signedOff = { head: ctx.head, risk: ctx.risk ?? null, at: now().toISOString(), by: "owner" as const };
          await db.update(decisions).set({ context: sql`${decisions.context} || ${JSON.stringify({ signedOff })}::jsonb` }).where(eq(decisions.id, id));
        }
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
      } else if (ctx.type === "feature_portal_hold") {
        await applyPortalAnswer(db, ctx.featureId, answer, now());
      } else if (ctx.type === "stale_blocker") {
        await answerStaleBlocker(ctx, answer, extra);
      } else if (ctx.type === "stalled_run" && answer === CANCEL_RUN) {
        // A run that already ended needs no stopping.
        const r = await cancelRun?.(ctx.runId).catch(() => null);
        endedHere = !!r?.endedHere;
        delivered = !!r && !r.endedHere;
      } else if (ctx.type === "review_stall") {
        // The action on the review; if the review has moved on (a verdict landed meanwhile) the card
        // is reopened rather than closing with nothing done (BOS-426, BOS-433 fix B).
        const did = await loopHooks?.reviewStall?.(ctx, answer, extra.settledBy?.agentId ?? null).catch((err) => {
          if (err instanceof Error) throw new AnswerError(`Nothing was done about the review: ${err.message}`);
          throw err;
        });
        if (did === false) {
          await db.update(decisions).set({ status: "open", answer: null, answeredAt: null, context: d.context as object }).where(eq(decisions.id, id));
          throw new AnswerError("That review has already moved on (it got a verdict or passed), so this card no longer applies. Nothing was changed.");
        }
      }
      // Tickets this decision blocked can move again.
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      // A card that blocked a merged ticket was how the owner checked its live work: their answer is the
      // criterion's pass or fail (DR-024 #5). Only the owner's own answer counts: a CEO settling an agent's
      // question isn't the owner looking at the host, and the assignee still reports that one.
      if (!extra.settledBy && ctx.type === "question") {
        try {
          await recordOwnerHostChecks(db, { question: d.question, answer, options: d.options as string[] | null, recommended: d.recommendedOption, criterionIndexes: (ctx as { criterionIndexes?: number[] }).criterionIndexes ?? null, optionVerdicts: (ctx as { optionVerdicts?: Record<string, string> }).optionVerdicts ?? null }, [...new Set(freed.map((f) => f.ticketId))], "the owner", now);
        } catch (err) {
          // The answer is saved; a failed write here must not stop it reaching the asker.
          log(`answering decision ${id} was saved, but recording the owner's host check on its ticket failed: ${(err as Error).message}`);
        }
      }
      // The activity line is cut at 300 characters, and the brief shows 100, so a long question is shortened here to
      // keep the answer in it (BOS-951 criterion 3: the whats_new line shows the option chosen, not only the question).
      const asked = d.question.length > 80 ? `${d.question.slice(0, 79)}…` : d.question;
      await record(db, { companyId: d.companyId, ticketId: freed[0]?.ticketId, kind: "decision_answered", summary: settled ? `${settled.name} settled "${asked}": ${answer}.${settled.note ? ` Reason: ${settled.note}` : ""}` : `${extra.by === "ceo" ? "The CEO settled" : "Owner answered"} "${asked}": ${answer}`, at: now() });
      let unblocked: Array<typeof tickets.$inferSelect> = [];
      // Linked tickets the card never moved (BOS-919: one in review keeps its state): not released, but still
      // the ticket the answer is about, so the asker is woken on it and its assignee hears the answer too.
      let kept: Array<typeof tickets.$inferSelect> = [];
      if (freed.length > 0) {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        for (const f of freed) {
          const t = await releaseIfFree(f.ticketId, false, { question: d.question, answer, keepNote: !!(ctx as { criterionIndexes?: number[] }).criterionIndexes?.length });
          if (t) unblocked.push(t);
        }
        const rest = [...new Set(freed.map((f) => f.ticketId))].filter((tid) => !unblocked.some((u) => u.id === tid));
        if (rest.length) kept = await db.select().from(tickets).where(and(inArray(tickets.id, rest), eq(tickets.systemState, "review")));
      }
      // The agent that asked is woken with the answer (on the ticket it blocked, if any).
      // A rule proposal answered with a button needs nothing more from the CEO.
      if (wake && d.kind === "question" && d.raisedByAgentId && (ctx.type !== "rule_proposal" || ownWords) && !(ctx.type === "lesson_replace" && ownWords)) {
        let onTicket: { id: string } | undefined = [...unblocked, ...kept].find((t) => t.assigneeAgentId === d.raisedByAgentId) ?? unblocked[0] ?? kept[0];
        // BOS-1120: an alert card blocks no ticket, so its answer would wake the agent with none and open a run with no checkout.
        // Wake it on the ticket the alert is about (the ladder's ticket, else the stalled run's); if that ticket has finished
        // there is nothing to wake the agent for, so the answer is recorded and no run starts.
        let skipWake = false;
        if (!onTicket) {
          const ladderTicket = (ctx as { ladder?: { ticketId?: string | null } }).ladder?.ticketId ?? null;
          const stalledRunId = ctx.type === "stalled_run" ? ctx.runId : null;
          const [stalled] = stalledRunId ? await db.select({ ticketId: runs.ticketId, endedAt: runs.endedAt }).from(runs).where(eq(runs.id, stalledRunId)) : [];
          const aboutId = ladderTicket ?? stalled?.ticketId ?? null;
          const [st] = aboutId ? await db.select({ id: tickets.id, systemState: tickets.systemState, mergeCommit: tickets.mergeCommit }).from(tickets).where(eq(tickets.id, aboutId)) : [];
          if (st) {
            if (st.systemState === "done" || st.mergeCommit) skipWake = true;
            else onTicket = st;
          } else if (ctx.type === "stalled_run") skipWake = true;
        }
        if (skipWake) return { id, answer, delivered, endedHere };
        // An answer in the owner's own words can carry pictures or files (BOS-759): say so plainly, so
        // the agent opens them with open_attachment instead of reading the links as part of the answer.
        const pictures = ownWords && ATTACHMENT_LINK.test(answer) ? " It includes picture(s) or file(s) they attached; open each with open_attachment." : "";
        // A plan approved (BOS-1411, warning 1): the approved plan's files are compared with other open work, and a
        // match is said here, where waiting still saves the build. Read-only; nothing is linked.
        const plan = (ctx as { plan?: boolean; planText?: string | null; ticketId?: string | null });
        const overlap = plan.plan && plan.ticketId && answer === APPROVE_PLAN ? await planApprovalOverlapNote(plan.ticketId, plan.planText ?? "").catch(() => "") : "";
        await wake({ agentId: d.raisedByAgentId, reason: "decision answered", ticketId: onTicket?.id ?? null, note: `${settled ? `${settled.name} settled` : extra.by === "ceo" ? "The CEO settled" : "The owner answered"} your question "${d.question}": ${answer}${extra.note ? ` — their note: ${extra.note}` : ""}${pictures}${overlap ? ` ${overlap}` : ""}` });
      }
      for (const t of unblocked) {
        if (wake && t.assigneeAgentId && t.assigneeAgentId !== d.raisedByAgentId) await wake({ agentId: t.assigneeAgentId, reason: "unblocked", ticketId: t.id, note: await unblockedNote(db, t.id, { question: d.question, answer }) });
      }
      // The owner refused (BOS-1094): a "Send it back" / "Deny" / "Reject" button on an agent's card about a ticket in
      // review stops its merge. The card no longer holds it, so without this the merge went on (BOS-1071).
      const refused = ctx.type === "question" && !extra.settledBy && extra.by !== "ceo" && isRefusalAnswer(answer, d.options as string[] | null);
      if (refused) {
        for (const t of kept) {
          await loopHooks?.sendBack(t.id, `The owner answered "${d.question}" with "${answer}", so this ticket is not to merge as it is.${extra.note ? ` Their note: ${extra.note}` : ""} Change it as they ask, then move it back to review.`, "the owner");
          await record(db, { companyId: d.companyId, ticketId: t.id, kind: "merge_stopped_by_answer", summary: `The owner answered "${asked}" with "${answer}", so the ticket was sent back to in progress and its merge stopped.`, at: now() });
        }
        kept = [];
      }
      for (const t of kept) {
        if (wake && t.assigneeAgentId && t.assigneeAgentId !== d.raisedByAgentId) await wake({ agentId: t.assigneeAgentId, reason: "decision answered", ticketId: t.id, note: `The card "${d.question}" on this ticket was answered: ${answer}. The ticket stays in review; its merge goes on now nothing holds it.` });
      }
      // BOS-1591 (R21): the owner's answer to a question may be what other parked tickets wait for in a note only. Tell the CEO once.
      if (wake && ctx.type === "question" && !extra.settledBy && extra.by !== "ceo" && !(ctx as { plan?: boolean }).plan) {
        try {
          const waiting = await unlinkedWaiters(db, { companyId: d.companyId, question: d.question, releasedIds: freed.map((f) => f.ticketId) });
          const [ceo] = waiting.length ? await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt))) : [];
          if (ceo) {
            const list = waiting.map((w) => `- ${w.number ? `BOS-${w.number}` : w.id} "${w.title}" (${w.id})`).join("\n");
            await wake({ agentId: ceo.id, reason: "decision answered", note: `The owner answered "${asked}" with "${answer}" (card ${id}). These parked tickets have notes that look like they were waiting on that answer, but aren't linked to the card, so nothing released them:\n${list}\nCheck each one; if it is free, move it on and tell its assignee. Where it still waits for something else, link that (update_ticket waitsOn). This is said once.` });
          }
        } catch (err) {
          log(`looking for tickets waiting on the answer to ${id} failed: ${(err as Error).message}`);
        }
      }
      return { id, answer, delivered, endedHere };
    },

    /** The agent that raised a card takes it back (BOS-123); what it blocked can move again. */
    async withdraw(id: string, actor: { agentId: string | null }, reason?: string, replacement?: Replacement) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      // (BOS-996) A withdrawal changes the queue; clear the kept tally before anything reads it again.
      clearTallyCache();
      if (!d) return null;
      if (!actor.agentId || d.raisedByAgentId !== actor.agentId) throw new AnswerError("You can only withdraw a decision you raised.");
      // Only a question asked through raise_decision may be taken back. System cards that also
      // record an agent (owner sign-off, permission, deploy, engagement, lesson, review loop,
      // ticket cap, stalled run) must go through their own answer path: withdrawing a risk_review
      // card would delete the dependency and let the ticket merge without the owner's sign-off.
      const type = (d.context as { type?: string } | null)?.type;
      // BOS-1193: a plan card is the author's to take back too (the plan they submitted, or ExitPlanMode's once its run has
      // ended: a live run is waiting on the answer). Sign-off, merge and other flow cards still have to be answered.
      const isPlanCard = (d.context as { plan?: boolean } | null)?.plan === true && (type === "question" || type === "permission");
      if (isPlanCard && (await holdsLiveRun(db, d.context))) throw new AnswerError("This plan card holds a live run that is waiting for the answer, so it can't be withdrawn until the run ends.");
      if (!isPlanCard && (d.kind !== "question" || type !== "question")) throw new AnswerError("Only a question card you raised with raise_decision can be withdrawn; this card belongs to another flow and has to be answered.");
      // DR-058 B, after the checks above so a card that can't be withdrawn is refused for that reason first.
      const rb = replacement ? parseReplacedBy({ reason, ...replacement }) : null;
      if (rb && !rb.ok) throw new AnswerError(rb.error);
      const facts = rb ? await withdrawFacts(d) : null;
      const closed = await db.transaction(async (tx) => {
        const [row] = await tx.update(decisions).set({ status: "withdrawn", answeredAt: now(), dedupeKey: null, recheckStage: null }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning({ id: decisions.id });
        if (row) await revokeApproveTokens(tx as unknown as Db, id, now());
        return row;
      });
      if (!closed) return null;
      await markDecisionNotificationRead(db, id, now());
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      for (const f of freed) await releaseIfFree(f.ticketId, false);
      await record(db, { companyId: d.companyId, agentId: actor.agentId, ticketId: freed[0]?.ticketId, kind: "decision_withdrawn", summary: `Withdrew "${d.question}"${reason ? `: ${reason}` : ""}`, at: now() });
      if (facts && rb?.ok) {
        const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId));
        await noticeWithdrawn(d, facts, { agentId: actor.agentId, agent: who?.name ?? "An agent", reason: rb.reason, replacedBy: rb.replacedBy });
      }
      return { id, withdrawn: true };
    },

    /**
     * An author, or the CEO, confirms a card that is being re-checked still holds (BOS-1193, DR-054). The flag clears and
     * the one line on what was checked goes in the card's history; nothing is written on the card's face. Refused when Boss
     * Man can see the card is dead (the validity table), so a card it would close can't be confirmed. Only an author's own
     * card, or any card at the CEO's stage or before, for the CEO.
     */
    async confirmRecheck(id: string, actor: { agentId: string }, checked: string) {
      const line = checked.replace(/\s+/g, " ").trim().slice(0, 300);
      if (line.length < 10) throw new AnswerError("Say in one line what you checked against the live state (at least 10 characters). It is kept in the card's history.");
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      const [a] = await db.select({ role: agents.role, companyId: agents.companyId, name: agents.name }).from(agents).where(eq(agents.id, actor.agentId));
      const isCeo = a?.role === "ceo" && a.companyId === d.companyId;
      if (!isCeo && d.raisedByAgentId !== actor.agentId) throw new AnswerError("You can only confirm a card you raised.");
      if (!d.staleAt || !d.recheckStage) throw new AnswerError("This card is not being re-checked, so there is nothing to confirm.");
      if (d.recheckStage === "lapsed") throw new AnswerError("This card was not re-checked in time and is back with the owner; it is theirs to answer.");
      const dead = await cardInvalidReason(db, d);
      if (dead) throw new AnswerError(`Boss Man can see this card is no longer valid (${dead}), so it can't be confirmed. Withdraw it instead.`);
      const [row] = await db
        .update(decisions)
        .set({ staleAt: null, staleReason: null, recheckStage: null, recheckStageAt: null, recheckedAt: now(), recheckedByAgentId: actor.agentId, recheckNote: line, recheckCount: sql`${decisions.recheckCount} + 1` })
        .where(and(eq(decisions.id, id), eq(decisions.status, "open"), isNotNull(decisions.recheckStage)))
        .returning({ id: decisions.id });
      if (!row) return null;
      clearTallyCache();
      await record(db, { companyId: d.companyId, agentId: actor.agentId, kind: "decision_rechecked", summary: `${a?.name ?? "An agent"} re-checked "${d.question.slice(0, 120)}" and it still holds: ${line}`, at: now() });
      return { id };
    },
  };
}
