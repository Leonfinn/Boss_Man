// The browser talks to the server's JSON API on the same origin, with the session cookie.
import { reportAnswered, reportFailure, reportSlow } from "./server-watch";
import { sharedGet } from "./shared-get";
import type { Criterion, DeviceMeasures, DeviceProfile, DeviceReport, PortalShowVerdict } from "@boss-man/shared";

export type { Criterion, DeviceMeasures, DeviceProfile, DeviceReport };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Which field a save conflict is about (BOS-905): title, body or acceptanceCriteria. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** The server's short error codes, as sentences the owner can read. */
const PLAIN_ERROR_CODES: Record<string, string> = {
  not_found: "That item no longer exists. Reload the page.",
  already_exists: "Something with that name already exists.",
  unknown_reference: "Something this refers to has been removed. Reload and try again.",
  constraint_violated: "That change clashes with existing data, so it wasn't saved.",
  internal_error: "Something went wrong on the server. Try again; if it keeps happening, tell the CEO.",
};

/** What a failed request means in plain words, for when the server sent no message of its own. */
export function plainStatus(status: number, error?: unknown): string {
  if (status === 502 || status === 503 || status === 504) return "Boss Man is restarting or switching versions for a moment, so your click may not have gone through. Wait a few seconds and look at the page: if the card is still there, press the button again.";
  if (status === 404 && error === "not_open") return "This card was already closed, so there is nothing more to do here.";
  if (status === 401) return "You have been signed out. Sign in again, then repeat that.";
  const plain = typeof error === "string" && Object.hasOwn(PLAIN_ERROR_CODES, error) ? PLAIN_ERROR_CODES[error] : undefined;
  if (plain) return plain;
  return typeof error === "string" && error ? error : `Something went wrong (code ${status}). Nothing needs doing from you; try again, and tell the CEO if it keeps happening.`;
}

function readOnly(init: { method?: string; body?: unknown }) {
  return (init.method ?? "GET") === "GET" && init.body === undefined;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  // Two hooks polling the same read share one request and its result (BOS-408).
  if (readOnly(init)) return sharedGet(path, (signal) => apiOnce<T>(path, { ...init, signal }));
  return apiOnce<T>(path, init);
}

/** One request, no sharing: what `api` sends for a write, or a path nothing else should join. */
export async function apiOnce<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  // How long the server took, so a stall that still answers shows the banner (BOS-637).
  const started = Date.now();
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.body !== undefined ? { "content-type": "application/json" } : {},
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    const went = new ApiError(0, "Can't reach the Boss Man server.");
    reportFailure(went);
    throw went;
  }
  reportAnswered();
  reportSlow(Date.now() - started);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // A proxy's own error page, not JSON: fall through to the plain message for the status.
  }
  if (!res.ok) {
    // A rejected secret lists what's wrong with it; other errors carry a message.
    const problems = Array.isArray(data.problems) ? (data.problems as string[]).join(" ") : null;
    const failed = new ApiError(res.status, problems ?? String(data.message ?? plainStatus(res.status, data.error)), typeof data.field === "string" ? data.field : undefined);
    reportFailure(failed);
    throw failed;
  }
  return data as T;
}

// ---------- Shapes the screens use ----------

export type Agent = { id: string; companyId: string; name: string; role: "ceo" | "manager" | "worker"; agentKind: string; model: string | null; fundingSourceId: string | null; paused: boolean; starred: boolean; duty: string | null; title?: string | null; template?: string | null; avatarAt?: string | null };
export type Company = { id: string; name: string; mission: string | null; paused: boolean; goalCheckDays?: number; nudgesPerHour?: number; adviceTimeoutMinutes?: number; maxRunMinutes?: number | null; standingRules?: string | null; standingRulesBy?: string | null; standingRulesAt?: string | null; permissionJudge?: "off" | "watch" | "advise"; autoTempCleanup?: boolean; fenceMode?: "off" | "watch" | "enforce"; fenceModeChosenAt?: string | null; diskCapBytes?: number | null; holdStartsMergesWaiting?: number | null; holdStartsQuickChecksQueued?: number | null; holdStartsOwnerWaiting?: number | null; ticketPrefix?: string | null; nextTicketNumber?: number; agents: Agent[]; projects?: { id: string; name: string; starred: boolean }[] };
export type Project = {
  id: string;
  companyId: string;
  name: string;
  archivedAt?: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  verifyCommand: string | null;
  deepVerifyCommand: string | null;
  /** How approved work lands (R59), and the git host found for the repo. */
  landing: "merge" | "pull_request";
  gitHost: "github" | "gitea" | null;
  gitApiBase: string | null;
  starred: boolean;
  ticketCostCapMicros: number | null;
  monthlyCapMicros: number | null;
};

/** Review routing per risk tier (step 1): "ceo", "senior-dev" or an agent id; the plan column also takes "owner" and "none". */
/** A reviewer cell: "ceo", "senior-dev", one agent id, or several agent ids (each review goes to one of them). */
export type ReviewerRef = string | string[];
export type ReviewRule = { planApprover: string; reviewer: ReviewerRef; ownerSignoff: boolean; /** Extra reviews: a kind that is missing is off; "marked" is a legacy value the migration replaced. */ kinds?: Partial<Record<ReviewKindName, ReviewerRef>> };
export type ReviewKindName = "security" | "infra" | "adversarial";
export const REVIEW_KINDS: ReviewKindName[] = ["security", "infra", "adversarial"];
export type ReviewPolicy = Record<Risk, ReviewRule>;
export type Risk = "trivial" | "low" | "medium" | "high" | "critical";
export const RISKS: Risk[] = ["trivial", "low", "medium", "high", "critical"];

/** A permission request in plain words, worked out by the server (shared/explain.ts). */
export type PushReading = {
  kind: "ticket" | "branch" | "many" | "unnamed" | "unreadable";
  headline: string;
  ticketId?: string;
  ref?: string;
  warnings: string[];
  dangerous: boolean;
};
export type PermissionExplanation = { title: string; summary: string; effect: "reads" | "changes" | "deletes" | "network" | "pushes" | "unknown"; command?: string; reason?: string; alwaysNote?: string; ownerWhy?: string; scratch?: { note: string; unchecked: string[] }; push?: PushReading };

/** One of Boss Man's alerts the Scrum Master or the CEO still holds (BOS-64): not the owner's yet. */
/** Where a decision stands with the CEO after the owner pressed "Ask the CEO for advice". */
export type Advice = { state: "asking" | "reissued" | "clarified" | "handled" | "timed_out" | "replacement" | "advised"; note?: string; askedAt?: string; at?: string; replacedBy?: string; replaces?: string; summary?: string; originalQuestion?: string; what?: string; needed?: string; recommendation?: "allow" | "deny"; denyStops?: string; why?: string };
/** A decision the CEO settled: by advice (advice), a permission request it answered itself (settled, BOS-111), or a stale/duplicate card it cleared (withdrawn, BOS-149). */
export type AdvisedDecision = {
  id: string;
  companyId: string;
  question: string;
  about?: Array<{ ticketId: string; ref: string | null; title: string }>;
  advice?: Advice;
  settled?: { by: string; answer: string; note: string | null; command: string | null; tempCleanup: boolean; workingCopy?: boolean };
  withdrawn?: { by: string; note: string; /** The closed-card notice a card Boss Man closed by itself left (BOS-740). */ notice?: string; /** A plan card a newer plan replaced (BOS-1219): the newer card, its author (null if unknown) and when. */ newer?: { id: string; author: string | null; at: string } };
};
export type TeamAlert = { id: string; companyId: string; question: string; holder: string; since: string };
/** A card Boss Man closed by itself in the last couple of hours (BOS-739): the notice, and the steps it showed. */
export type ClosedNotice = {
  /** "closed": Boss Man closed it by its own check (its ticket finished, a plan approved elsewhere; BOS-1691). */
  why: "live" | "newer" | "switched-back" | "replaced" | "withdrawn" | "closed";
  text: string;
  at: string;
  until: string;
  commit?: string;
  newer?: { decisionId: string; label: string };
};
export type ClosedNoticeCard = {
  id: string;
  companyId: string;
  question: string;
  /** A hand-apply card keeps its steps as `handSteps`; a hand-apply to-do as `steps` (BOS-739). */
  context: { steps?: string[]; handSteps?: string[]; check?: string; rollback?: string };
  notice: ClosedNotice;
};

/** An agent's harness/provider/model/paid-from setup on a model-change card (BOS-128). */
export type ModelConfigView = { harness: string; provider: string; model: string; fundingSourceId: string; fundingSourceName?: string };

/** What a Boss Man update contains, as the deploy card shows it (BOS-213). */
export type DeployUpdate = {
  from: string;
  to: string;
  total: number;
  files: number;
  changes: Array<{ ticketId: string; ref: string; title: string }>;
  more: number;
  otherCommits: string[];
  otherMore?: number;
  handBecause?: string;
  handFiles?: string[];
  handEffect?: "server" | "deployer" | "both";
  needsDeployerCopy?: boolean;
  needsRunnerUpdate?: boolean;
  risks: string[];
};

export type Decision = {
  id: string;
  companyId: string;
  kind: string;
  question: string;
  options: string[];
  recommendedOption: string | null;
  tier: "ceo" | "owner";
  createdAt: string;
  /** An owner action made this card possibly out of date; the raising agent is checking it (BOS-123). */
  staleAt?: string | null;
  staleReason?: string | null;
  /** BOS-1193: set while the card is being re-checked but still shown (urgent, a live run, a merge card): who is checking it. */
  /** BOS-1691: `hidden` when it is off the main list for the re-check (a line shows in its place); `backBy` is the latest it returns. */
  rechecking?: { by: string; stage: "author" | "ceo"; backBy?: string; hidden?: boolean } | null;
  /** BOS-1193: set when nobody re-checked the card in an hour; says plainly who failed to. */
  notRechecked?: string | null;
  companyName: string;
  agentName: string | null;
  /** The agent a CEO-tier decision is put to instead of the CEO (review policy). */
  forAgentName?: string | null;
  blocks: Array<{ ticketId: string; ref?: string | null; title: string }>;
  /** The tickets this decision is about (the ones it holds up directly). */
  about?: Array<{ ticketId: string; ref: string | null; title: string }>;
  /** BOS-1744: the projects of the tickets this card is about; empty = company-wide. */
  projects?: Array<{ id: string; name: string }>;
  /** Ticket references written in the card's text, resolved in the owner's own company. */
  refs?: Record<string, { ticketId: string; ref: string; title: string }>;
  score: number;
  parts: { blocking: number; urgency: number; age: number; liveRun: number };
  reasons: string[];
  /** The rank reason that is only the card's age; the card shows the age itself and hides this one (BOS-869). */
  ageReason: string;
  dueDate: string | null;
  /** (BOS-551) For a card that needs your hands: its place in the do-this-next order, 1-based. */
  step?: number | null;
  /** (BOS-551) Shown in the "Waiting, nothing to do yet" group: why there is nothing to do on this card now. */
  waiting?: string | null;
  /** (BOS-551) A short label for the card this one must be done after, for each one. */
  doAfter?: string[];
  /** (BOS-551) A short label for the card this one must be done before, for each one. */
  doBefore?: string[];
  context?: { type?: string; /** BOS-1755: the card's ticket finished while it was still unanswered; it stays open for the owner. */ keptOpen?: { note: string; at: string }; /** BOS-2085: a go-live card's live line on the high or critical repo security alerts open now. */ openAlerts?: string;/** A stale blocker: the ticket in the way (absent when it is an engagement). */ blockerTicketId?: string | null; advice?: Advice; handoverRanOut?: { at: string }; /** A skill the CEO proposed. */ proposalId?: string; /** Numbered steps when the owner must do something. */ steps?: string[]; /** Where each step's clicks came from (R19), by step (BOS-1665). */ stepSources?: Array<import("@boss-man/shared").StepSource | null>; /** BOS-1660: why and how long from the agent, where written by Boss Man from the steps. */ opening?: { why: string; minutes: number; where: string[] }; /** What the owner-step lint flagged (BOS-417), and a CEO override with its reason. */ lint?: { warn: Array<{ step: number; problem: string }>; override?: { reason: string; findings: Array<{ step: number; rule?: string; problem: string }>; /** One per reason, with the findings it covers (R35). */ entries?: Array<{ reason: string; findings: Array<{ step: number; rule?: string; problem: string }> }> }; /** How the host commands were proven (R11, DR-024): shown as a banner. */ proof?: { rehearsed: true; script: string; commit: string } | { rehearsed: false; part: string } }; /** An owner to-do (BOS-122): how to check the approved change worked. */ check?: string; /** An owner to-do: how to roll it back. */ rollback?: string; /** An owner to-do: the note from the last "A step failed". */ lastFailure?: { note: string; at: string }; /** What the agent tried first, and why it needs the owner. */ triedFirst?: string; /** An instruction change: the full new text (the question holds only its start). */ instructions?: string; /** A standing-rules change: the exact text that will be saved (already stripped and capped). */ text?: string; hires?: Array<{ name: string; template?: string; title?: string | null; model?: string | null; harness?: string; provider?: string; fundingSourceId?: string | null; skills?: string[]; reason: string }>; /** A hire: the proposal the owner is being asked to approve. */ proposal?: { skills?: string[] }; /** A model-setup change: current and proposed values, and when it was applied. */ agentId?: string; before?: ModelConfigView; proposed?: ModelConfigView; applied?: { at: string; afterRunId: string | null; config?: ModelConfigView }; output?: string; planText?: string | null; ticketId?: string | null; /** A Boss Man update card or to-do: what it contains, in plain words. */ update?: DeployUpdate; /** A Boss Man update carrying the fix for a live problem (BOS-639): its heading leads the card. */ urgent?: { heading: string; fixes: Array<{ ticketId: string; ref: string; symptom: string }>; repeat?: boolean }; /** A hand-apply card: the steps the owner will need to do, shown before approval. */ handSteps?: string[]; /** A self-update that needs applying by hand (infra change). */ infra?: boolean; explain?: PermissionExplanation; /** The rules judge's reading (BOS-337); `reason` is a fixed label. */ judge?: { mode: "watch" | "advise"; verdict: "allow" | "deny"; reason: string; /** The model second opinion (BOS-338); `reason` is the model's cleaned line, or why it failed. */ second?: { state: "pending" | "allow" | "deny" | "failed"; reason?: string } }; always?: Array<{ label: string; what?: string }>; /** The agent an "always" rule is limited to unless the owner widens it (BOS-294). */ alwaysAgent?: { id: string; name: string }; rule?: { name: string; outcome: string; match: { kinds?: string[]; commandPattern?: string; titlePattern?: string; safeOnly?: boolean } }; /** A hand-applied server update's to-do (BOS-420): how quiet the machine is. */ quiet?: { ready: boolean; runs: number; checks: number; freeMb: number | null; needMb: number | null; why: string[]; at: string }; /** A sign-off card (BOS-1236): who reviewed and what they said, the last quick check, the risk, the size of the change and who built it. */ reviews?: Array<{ name: string; kind: string; verdict: "passed" | "changes" | "waiting" | "overruled" }>; quickCheck?: { result: "passed" | "failed"; sha: string; at: string } | null; files?: number | null; builder?: string | null; risk?: string };
  /** For a stalled run: what the owner needs to judge it, worked out by the server when asked. */
  evidence?: StallEvidence | null;
};

/** (BOS-969) The Decisions menu badge and page heading: how many cards need the owner now, and how
 * many are folded into "Waiting, nothing to do yet". One server figure, so the two never drift. */
export type DecisionTally = { open: number; waiting: number; oldestOpenAt?: string | null; medianAnswerMs?: number | null };

export type StallEvidence = {
  runId: string;
  agent: string | null;
  ticketId: string | null;
  ticket: string | null;
  startedAt: string;
  lastEventAt: string | null;
  lastStep: TranscriptItem | null;
  runner: { connected: boolean; lastSeenAt: string | null };
  waitingOnOwner: boolean;
};

export type Ticket = {
  id: string;
  title: string;
  /** Its number in the company's sequence, shown as PREFIX-number. */
  number?: number | null;
  systemState: string;
  outcome: string | null;
  assigneeAgentId: string | null;
  assignedToOwner: boolean;
  dueDate: string | null;
  /** Why this in-progress ticket doesn't count towards the WIP limit; null when it counts (BOS-1172). */
  wipExempt?: "waits" | "plan" | "live" | "busy" | null;
  /** BOS-1908: the ticket this In progress ticket's agent is running instead ("Agent busy on BOS-N"). */
  busyOnTicketId?: string | null;
  busyOnNumber?: number | null;
  /** BOS-1910: the watchdog's verdict, set once it has handed the ticket to the Scrum Master; never for Being checked, Merged watching or Next up. */
  looksStuck?: { rule: string; idleMs: number; since: string } | null;
  /** BOS-1908: in Ready, the agent's one "Next up": starts by itself when the agent finishes what it is running. */
  nextUp?: boolean;
  blockedBy: Array<{ ticketId: string | null; until?: "merged" | "done" | null;ticketTitle?: string | null; ticketNumber?: number | null; engagementId: string | null; decisionId: string | null }>;
  /** Agents running on the ticket right now, with what they're doing (e.g. "Security Reviewer reviewing"). */
  working?: string[];
  /** When the earliest of those runs began. */
  workingSince?: string | null;
  branch: string | null;
  risk: Risk | null;
  /** Relative size: 1, 2, 3, 5 or 8. */
  size?: number | null;
  planFirst: boolean;
  plan: string | null;
  planApprovedAt: string | null;
  /** The feature it delivers and the task it is a sub-task of, by title, on a board card. */
  featureId?: string | null;
  featureTitle?: string | null;
  /** The description; board cards carry it for the search box. */
  body?: string | null;
  parentTitle?: string | null;
  lastActivityAt?: string;
  /** BOS-2400: when the ticket last changed state (the board sends the whole ticket row). */
  stateChangedAt?: string;
  /** In review with an owner sign-off decision still open (the "Your review" lane). */
  waitingOnOwner?: boolean;
  waitingDecisionId?: string | null;
  /** Owner-marked urgent: always passes the subscription quota hold. */
  urgent?: boolean;
  /** BOS-1516: the urgent mark is the owner's "Priority 1" switch. */
  urgentByOwner?: boolean;
  /** A held wake's reset time and why, when routine work is paused by the quota hold. */
  quotaHeldUntil?: string | null;
  quotaHeldReason?: string | null;
  /** BOS-2200: "Waiting for Dylan's working hours, from 00:00" while its agent is outside its hours. */
  workingHoursNote?: string | null;
  /** The ticket can start now but its agent is held by the quota hold for other work (BOS-253). */
  quotaHeldAgent?: boolean;
  /** In review with no agent able to review it, so the owner approves it on the ticket. */
  noReviewer?: boolean;
  /** Who an open agent review waits on and why, e.g. "Sam is busy on BOS-7". */
  reviewWait?: string | null;
  /** BOS-1546: a merged ticket that only waits to go live, in plain words, and the owner's open update card if there is one. */
  goLiveNote?: { text: string; cardId: string | null } | null;
  /** BOS-1907: what a merged ticket watches for after go-live, when the watch ends (the agent's date, else 14 days after go-live), and whether this split-out check ticket's parent is merged. */
  watchingFor?: string | null;
  watchUntil?: string | null;
  watchEndsAt?: string | null;
  checksParentMerged?: boolean;
  /** The merge commit, set once merged; with systemState "blocked" or "in_progress" it puts the card in the "Merged, watching" lane (BOS-1636, BOS-1907). */
  mergeCommit?: string | null;
  /** In review and not the owner's to act on: still with its reviewers, or approved by all of them and only merging (BOS-667). */
  reviewStage?: "awaiting_review" | "merging" | "held" | "checking" | null;
  /** BOS-1906: with reviewStage "checking", where its quick check stands ("running now", "no. 3 in line"). */
  checkLine?: string | null;
  /** BOS-2435: the git host's build result for a card in Review; null with no git host or no branch. */
  build?: { state: "passed" | "failed" | "running" | "none" | "unavailable"; failing: string[] } | null;
  /** A reviewer passed it but holds the merge (BOS-808). */
  hold?: ReviewHold | null;
  /** Where an approved ticket's merge is, in plain words ("Waiting for a check slot."). */
  mergeNote?: string | null;
  /** An open owner decision this ticket waits on, outside review sign-off. */
  ownerQuestion?: string | null;
  /** The open card behind `ownerQuestion`, so the Board's button opens that exact card. */
  ownerQuestionId?: string | null;
  /** The agent re-checking a card this ticket waits on (BOS-1193); the board says so instead of asking the owner to answer. */
  recheckingBy?: string | null;
  approvedBy?: string | null;
};
/** A reviewer's "Passed, hold merge" (BOS-808): why, what it waits on, and the line the badge shows. */
export type ReviewHold = { id: string; /** Boss Man placed it (no reviewer re-checks it): it releases itself. */ system?: boolean; reason: string; reviewer: string | null; releaseAt: string | null; ready: boolean; label: string; waits: Array<{ kind: "ticket" | "decision"; id: string; label: string; closed: boolean }> };
export type TicketDetail = Ticket & { /** What the merged ticket's after-merge checks still wait for (BOS-1021). */ goLiveWait?: "server" | "runner" | "both" | "own" | null; hold?: ReviewHold | null; ref?: string | null; milestoneId: string | null; featureId: string | null; body: string | null; project: string; projectId: string; companyId: string; repoUrl: string | null; defaultBranch: string; assignee: string | null; mergeCommit: string | null; lastActivityAt: string; createdAt: string; landing: "merge" | "pull_request"; verifyCommand: string | null; ownerSignoff: boolean; pullRequestUrl: string | null; pullRequestNumber: number | null; pullRequestNote: string | null; watcherAgentId: string | null; watchEveryMinutes: number | null; watchedAt: string | null; monitorAt: string | null; monitorNote: string | null; monitorAttempts: number; monitorMax: number; acceptanceCriteria: Criterion[]; ownerSetup: string | null; /** The go-live card's opening lines (BOS-1650): what the setup changes, and what happens if it is skipped. */ ownerSetupWhy?: string | null; ownerSetupIfSkipped?: string | null; /** "Fixes live" (BOS-639): the live symptom this ticket fixes, set by the CEO, its author or a reviewer. */ fixesLive?: string | null; /** The CEO's plan and its deadline (BOS-1509). */ ceoPlan?: string | null; ceoPlanDeadline?: string | null; noCode: boolean; urgent: boolean; quotaHeldUntil?: string | null; quotaHeldReason?: string | null; /** The account the ticket's agent is paid from, by name (BOS-471). */ quotaHeldSource?: string | null; /** When another ticket really holds the agent, which one (BOS-471). */ quotaHeldOther?: { ref: string; title: string } | null; /** The owner's sign-off card for this ticket is open (BOS-471). */ signoffWaiting?: boolean; /** Where it stands on the owner's sign-off (BOS-503): waiting (card open), missing (owed, card being raised again), signed_off, or null when not needed. */ signoff?: "waiting" | "missing" | "signed_off" | null; stateNote: string | null; /** When an agent last posted on it, a reply or a state note (BOS-314). */ lastPostAt?: string | null; blockedUntil: string | null; blockedUntilReason: string | null; /** Other open tickets of the project changing the same files (BOS-2179); advisory. */ branchOverlaps?: Array<{ ticketId: string; ref: string | null; title: string; state: string; files: string[]; more: number }> };
export type WorkspaceDiff = { baseCommit: string; head: string; commits: Array<{ sha: string; subject: string }>; files: Array<{ path: string; added: number; removed: number }>; diff: string; truncated: boolean; turn?: { number: number; at: string } };
/** A run going now that no card on the board shows (BOS-155). */
export type UnticketedRun = { id: string; agent: string | null; ticketId: string | null; ticket: string | null; purpose: string | null; origin: string | null; originFrom: string | null; originNote: string | null; wakeNote: string | null; runTicketId: string | null; startedAt: string };
/** `workingAgents` is the number of agents with a run going, the Dashboard's figure. */
/** A run going now on a ticket in another project of the company. */
export type OtherProjectRun = { id: string; agent: string | null; purpose: string | null; startedAt: string; ticketId: string; ticketNumber: number | null; ticketTitle: string; projectId: string; projectName: string };
export type Board = { project: Project; workingAgents: number; withoutTicket: UnticketedRun[]; otherProjects?: OtherProjectRun[]; /** All done tickets in the project; the board sends only the newest unless asked for all. */ doneTotal?: number; columns: Array<{ id: string; name: string; systemState: string; wipLimit: number | null; tickets: Ticket[] }> };

export type FundingSource = { id: string; name: string; kind: string; provider: string; monthlyGrantMicros: number | null; cycleAnchor?: string | null; quotaHoldAt?: number; quotaOverage?: "pause" | "urgent" | "all"; quotaDisabledWindows?: string[]; secretId?: string | null; fallbackRank?: number | null };
export type FundingStatus = {
  source: FundingSource;
  credit: { grantMicros: number; spentMicros: number; remainingMicros: number; fractionUsed: number; cycleStart: string; cycleEnd: string } | null;
  quota: Array<{ window: string; utilization: number; resetsAt: string | null; status: string | null; overageInUse: boolean; observedAt: string }>;
  /** Every window name the adapter has reported for this source, for the hold switches. */
  windowsSeen: string[];
  /** Whether new runs are going to this account right now (the owner's ranked Claude accounts, BOS-383). */
  claudeActive?: boolean;
  /** Per window: when it runs out at its pace so far (R78, BOS-1012); null with no readings. */
  forecasts: Record<string, { utilization: number; resetsAt: string | null; perHour: number | null; runsOutPerHour: number | null; runsOutAt: string | null; beforeReset: boolean } | null>;
  /** Synthetic's own used/limit reading, cached on the server; null for other providers, null counts mean unknown. */
  providerQuota?: {
    used: number | null;
    limit: number | null;
    renewsAt: string | null;
    /** "weekly" for the plan's weekly credits (the real measure, BOS-260); "requests" for the old request window. */
    measure?: "weekly" | "requests";
    /** Seconds since the reading was taken from Synthetic (BOS-239); null when there is none. */
    ageSeconds: number | null;
    /** Recent readings, newest first. */
    history: Array<{ used: number; limit: number; renewsAt: string | null; takenAt: string }>;
    /** The warnings the owner has had this period (80, 100). */
    warned: number[];
  } | null;
  /** The last 7 days, oldest first (UTC days). */
  daily: Array<{ day: string; runs: number; inputTokens: number; outputTokens: number; costMicros: number }>;
  /** The last 7 days per company, biggest first. */
  byCompany?: Array<{ companyId: string; name: string; runs: number; tokens: number; costMicros: number }>;
  /** The last 7 days by agent and by project: plan tokens, pay-as-you-go spend and share of the source's total. */
  whoUsedIt?: {
    days: number;
    totalTokens: number;
    totalMicros: number;
    agents: Array<{ id: string | null; name: string; tokens: number; costMicros: number; share: number; engagement: boolean }>;
    agentsOthers?: { tokens: number; costMicros: number; share: number; count: number } | null;
    projects: Array<{ id: string | null; name: string; company: string | null; tokens: number; costMicros: number; share: number; engagement: boolean }>;
    projectsOthers?: { tokens: number; costMicros: number; share: number; count: number } | null;
  };
  /** The last 8 weeks, newest first: plan use at each reset, spend and the times work was held for this source's quota. */
  weeks?: Array<{
    start: string;
    end: string;
    plans: Array<{ window: string; resets: number; peak: number; limit: number | null }>;
    spendMicros: number;
    holds: Array<{ window: string; startedAt: string; endedAt: string | null; ms: number }>;
  }>;
  totalSpentMicros: number;
  coverage: string;
};
export type BudgetRow = {
  policy: { id: string; scopeKind: string; scopeId: string; windowKind: string; limitMicros: number; onLimit: string };
  status: { usedMicros: number; limitMicros: number; fractionUsed: number; state: string };
};
export type ActiveRun = RunRow;

export const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

export type RunRow = {
  id: string;
  companyId: string;
  agent: string | null;
  agentId: string | null;
  ticketId: string | null;
  ticket: string | null;
  model: string | null;
  startedAt: string;
  endedAt?: string | null;
  outcome?: string | null;
  costMicros?: number;
  /** Why it started: the wake's reason and note, and "chat" for the owner chat. */
  purpose?: string | null;
  reason?: string | null;
  note?: string | null;
  /** What started it, kept on the run (BOS-118): "nudge", "wiki upkeep", "owner_chat" and so on. */
  origin?: string | null;
  /** A nudge's sender and why, when a nudge started the run. */
  originFrom?: string | null;
  originNote?: string | null;
  /** The wake's own note, which names the tickets a review run is about. */
  wakeNote?: string | null;
  /** The ticket it was about without being on it (a nudge that named one). */
  runTicketId?: string | null;
  /** That ticket's reference, e.g. "HOL-12", for the "Working on" headline (BOS-254). */
  runTicketRef?: string | null;
  /** Tokens over the run, when the agent reported them (R67). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  /** "subscription" or "api_credit": subscriptions show tokens, API credit shows money. */
  fundingKind?: string | null;
  /** The funding account the run was paid from, by name (BOS-1943). */
  account?: string | null;
};
export type TranscriptItem = { seq: number; type: string; at: string; event: Record<string, unknown> & { update?: Record<string, unknown> } };
export type Transcript = { run: RunRow & { endedAt: string | null; outcome: string | null; costMicros: number }; items: TranscriptItem[]; next: number; more: boolean };

export type EngagementSummary = {
  openByState: Record<string, number>;
  waitingOnRequester: number;
  waitingOnProvider: number;
  waitingOnOther: number;
  spend30dPlanUseUsd: number;
  spend30dPayAsYouGoUsd: number;
  medianDaysToFinish: number | null;
  finishedCount: number;
};
/** `summary` rides on the first row of the owner's first page only (BOS-2427). */
export type EngagementRow = { id: string; title: string; status: string; requester: string; provider: string; budgetCapUsd: number | null; stateSince?: string; summary?: EngagementSummary | null };
export type EngagementView = EngagementRow & {
  scope: string;
  deliverables: string | null;
  acceptanceCriteria: string[];
  spentUsd: number;
  /** The provider's tickets doing the work; absent in the requester's view. */
  tickets?: Array<{ id: string; ref: string | null; title: string; state: string; assignee: string | null; spentUsd: number }>;
  counterTerms: unknown;
  delivery: { summary?: string; refs?: string[] } | null;
  thread: Array<{ from: string; fromCompanyId: string; kind: string; body: string; at: string }>;
};

export type NotifyLevel = "note" | "flag" | "page" | "ask";
export type Notice = {
  id: string;
  companyId: string | null;
  company: string | null;
  agentId: string | null;
  requested: NotifyLevel;
  level: NotifyLevel;
  demotedBy: string | null;
  title: string;
  body: string | null;
  link: string;
  pushedAt: string | null;
  pushError: string | null;
  readAt: string | null;
  createdAt: string;
};
/** Unread notices by level and by company id ("none" = no company), ignoring any filter (BOS-1277). */
export type NoticeCounts = { level: Partial<Record<NotifyLevel, number>>; company: Record<string, number> };
export type NoticeFeed = { items: Notice[]; unread: number; counts?: NoticeCounts };
export type NotifySettings = {
  quietHours: { start: string; end: string; timeZone: string } | null;
  agentHourlyCap: number;
  ntfy: { url: string; topic: string; hasToken: boolean } | null;
  /** Which cards go to the phone (BOS-1006): urgent ones by default. */
  phonePush?: "urgent" | "all";
  /** Only "flag" matters now: the Flags tick. */
  pushLevels?: NotifyLevel[];
  publicUrl: string | null;
  /** Phone Approve buttons (BOS-243): on unless switched off. */
  approveButtons?: boolean;
  /** The owner's phone type (BOS-1484); null or missing: not said yet. */
  phoneType?: "android" | "iphone" | "both" | null;
  /** Whether Approve buttons are actually offered, and if not why. */
  approve?: { on: true } | { on: false; why: string };
  /** The ntfy address the phone app must use (the add-on's NTFY_BASE_URL, as the host reports it); null when not known. */
  phoneAddress?: string | null;
  /** The ntfy container's name on the host (for `docker exec`); null when the host doesn't report it. */
  phoneContainer?: string | null;
  /** Whether the "Create phone login" button can work on this host, and if not why (BOS-1004). */
  phoneLogin?: { available: true } | { available: false; why: string };
  /** The last test push: when sent, and when the phone tapped Got it (null: not tapped). */
  phoneTest?: { sentAt: string; confirmedAt: string | null } | null;
};

export type MilestoneStatus = "done" | "late" | "at_risk" | "on_track" | "no_work" | "unscheduled";
export type Horizon = "now" | "next" | "later";
export type RoadmapMilestone = { id: string; title: string; targetDate: string | null; total: number; done: number; blocked: number; active: number; status: MilestoneStatus; horizon: Horizon; pinned: Horizon | null; forecast: MilestoneForecast; /** 8 weekly points, oldest first (BOS-2397). */ burnup?: BurnupPoint[] };
export type BurnupPoint = { weekEnd: string; done: number; total: number };
export type MilestoneForecast = { pointsDone: number; pointsLeft: number; unsized: number; pace: number; expectedFinish: string | null; daysLate: number };
export type RoadmapObjective = {
  id: string;
  title: string;
  priority: number;
  status: "active" | "done" | "dropped";
  keyResults: Array<{ id: string; title: string; current: number | null; target: number | null; unit: string | null; progress: number | null }>;
  milestones: RoadmapMilestone[];
};
export type RoadmapCompany = { id: string; name: string; objectives: RoadmapObjective[] };

export type RoadmapFeature = {
  id: string;
  title: string;
  status: FeatureStatus;
  rank: number | null;
  horizon: Horizon | null;
  /** Where it sits: now, next, later, or released (its own folded list). */
  column: Horizon | "released";
  priority: number;
  releasedAt: string | null;
  objective: { id: string; title: string; priority: number } | null;
  publicSummary: string | null;
  showPublicly: boolean;
  tickets: { total: number; done: number };
  milestones: Array<{ id: string; title: string; targetDate: string | null; pinned: Horizon | null }>;
};
export type FeatureRoadmapCompany = { id: string; name: string; features: RoadmapFeature[] };

export type PlanNode = {
  id: string;
  kind: "ticket" | "engagement" | "decision";
  /** The ticket's reference, e.g. BOS-458; null for engagements and decisions. */
  ref: string | null;
  title: string;
  state: string;
  open: boolean;
  link: string;
  assignee: string | null;
  project: string | null;
  layer: number;
  blocked: boolean;
  causes: string[];
  holdingUp: number;
};
export type Plan = { nodes: PlanNode[]; edges: Array<{ id: string; from: string; to: string }>; columns: string[][]; startHold?: { reason: string; tickets: Array<{ id: string; title: string; link: string }> } | null };
export type TicketLinks = {
  waitsOn: Array<{ dependencyId: string; kind: "ticket" | "engagement" | "decision"; id: string; title: string; state: string; open: boolean; until?: "merged" | "done"; link: string }>;
  blocks: Array<{ dependencyId: string; id: string; title: string; state: string; link: string }>;
};

/** One ticket in the ticket page's Related section. */
export type RelatedTicket = { id: string; ref: string | null; title: string; state: string; cancelled: boolean; /** On a "Waits on" row: when the wait ends (BOS-989). */ until?: "merged" | "done" };
export type TicketRelated = { feature: { id: string; title: string; status: string } | null; parent: RelatedTicket | null; subtasks: RelatedTicket[]; peers: RelatedTicket[]; waitsOn: RelatedTicket[]; blocks: RelatedTicket[]; mentioned: RelatedTicket[] };

/** Today's date in the browser's time zone, YYYY-MM-DD. */
export const today = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---------- Feature requests ----------
export type Importance = "nice_to_have" | "important" | "critical";
export const IMPORTANCES: Importance[] = ["nice_to_have", "important", "critical"];
export const IMPORTANCE_LABEL: Record<Importance, string> = { nice_to_have: "Nice to have", important: "Important", critical: "Critical" };
export type FeatureStatus = "idea" | "considering" | "planned" | "in_progress" | "released" | "declined";
export const FEATURE_STATUSES: FeatureStatus[] = ["idea", "considering", "planned", "in_progress", "released", "declined"];
export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = { idea: "Idea", considering: "Considering", planned: "Planned", in_progress: "In progress", released: "Released", declined: "Declined" };
export type Driver = { id: string; companyId: string; name: string; weight: number; position: number };
export type FeatureArea = { id: string; companyId: string; name: string; position: number };
export type Feature = {
  id: string;
  /** BOS-1516: the owner's Priority 1 switch. */
  priorityOne?: boolean;
  companyId: string;
  areaId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: FeatureStatus;
  effort: number | null;
  /** A person's 1 (most important) to 5 ordering; null until ranked. */
  rank: number | null;
  /** Pinned roadmap column; null follows the status. */
  horizon: Horizon | null;
  driverScores: Record<string, number | null>;
  milestoneId: string | null;
  objectiveId: string | null;
  portalVisible: boolean;
  /** Marked "keep off the portal (sensitive)"; the default never overrides it. */
  keepOffPortal: boolean;
  /** Why someone kept it off the portal, in their own words; null when nobody said why. */
  keepOffReason: string | null;
  publicSummary: string | null;
  /** The title visitors see on the portal; null falls back to the summary's first line (BOS-991). */
  publicTitle: string | null;
  showPublicly: boolean;
  /** Why the feature is on or off the portal: onPortal, or the reason it is held off (BOS-957). */
  portal?: { onPortal: boolean; reason: "sensitive" | "security" | "needs public summary" | null };
  /** Whether visitors actually see it, by the portal's own rule (BOS-1496). */
  portalShow?: PortalShowVerdict;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
  /** The follow-up after release: when it is due, and what the owner answered (Keep, Change or Drop). */
  goalCheckDueAt?: string | null;
  goalCheckAnswer?: string | null;
  goalCheckAnsweredAt?: string | null;
  demand: number;
  insightCount: number;
  customerCount: number;
  value: number;
  demandPart: number;
  priority: number;
  tickets: { total: number; done: number; items: Array<{ id: string; title: string; state: string; outcome: string | null; assignee: string | null }> };
};
export type ScoredFeatures = { settings: { demandWeight: number; ceoTriage: boolean }; drivers: Driver[]; maxDemand: number; features: Feature[] };
export type FeedbackSettingsView = { demandWeight: number; ceoTriage: boolean; portalEnabled: boolean; portalToken: string | null; portalTitle: string | null; portalIntro: string | null; portalBackUrl: string | null; portalBackText: string | null; hasLogo: boolean; portalUrl: string | null; confirmByEmail: boolean; confirmLinkHours: number; rememberAddressDays: number; portalAtBareAddress?: boolean; emailReady: boolean; drivers: Driver[]; areas: FeatureArea[] };
export type NoteSummary = { id: string; companyId: string; title: string | null; text: string; source: string; state: "unprocessed" | "processed" | "archived"; untrusted: boolean; createdAt: string; customer: string | null; insightCount: number; features: Array<{ id: string; title: string; status: FeatureStatus }> };
export type Insight = { id: string; noteId: string; featureId: string; importance: Importance; highlight: string | null; createdBy: string; createdAt: string };
export type NoteDetail = {
  note: Omit<NoteSummary, "customer" | "insightCount" | "features"> & { customerId: string | null; processedAt: string | null };
  customer: { id: string; name: string; email: string | null; segment: string | null } | null;
  insights: Array<Insight & { feature: { id: string; title: string; status: FeatureStatus } }>;
  suggestions: Array<{ id: string; title: string; status: FeatureStatus; score: number; shared: string[] }>;
};
export type FeatureDetail = {
  feature: Feature;
  drivers: Driver[];
  settings: { demandWeight: number };
  maxDemand: number;
  subfeatures: Feature[];
  insights: Array<Insight & { fromSubfeature: boolean; note: { id: string; title: string | null; text: string; source: string; untrusted: boolean; createdAt: string }; customer: { id: string; name: string; segment: string | null } | null }>;
  tickets: Array<{ id: string; title: string; state: string; outcome: string | null; assignee: string | null }>;
};
