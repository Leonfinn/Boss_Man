// The browser talks to the server's JSON API on the same origin, with the session cookie.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
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
    throw new ApiError(0, "Can't reach the Boss Man server.");
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    // A rejected secret lists what's wrong with it; other errors carry a message.
    const problems = Array.isArray(data.problems) ? (data.problems as string[]).join(" ") : null;
    throw new ApiError(res.status, problems ?? String(data.message ?? data.error ?? `HTTP ${res.status}`));
  }
  return data as T;
}

// ---------- Shapes the screens use ----------

export type Agent = { id: string; companyId: string; name: string; role: "ceo" | "manager" | "worker"; agentKind: string; model: string | null; fundingSourceId: string | null; paused: boolean; starred: boolean; duty: string | null; title?: string | null; reviewKind?: ReviewKindName | null };
export type Company = { id: string; name: string; mission: string | null; paused: boolean; agents: Agent[]; projects?: { id: string; name: string; starred: boolean }[] };
export type Project = {
  id: string;
  companyId: string;
  name: string;
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
export type ReviewRule = { planApprover: string; reviewer: string; ownerSignoff: boolean; /** Extra reviews: a kind that is missing is off; "marked" is the agent marked as that kind's reviewer. */ kinds?: Partial<Record<ReviewKindName, string>> };
export type ReviewKindName = "security" | "infra" | "adversarial";
export const REVIEW_KINDS: ReviewKindName[] = ["security", "infra", "adversarial"];
export type ReviewPolicy = Record<Risk, ReviewRule>;
export type Risk = "trivial" | "low" | "medium" | "high" | "critical";
export const RISKS: Risk[] = ["trivial", "low", "medium", "high", "critical"];

/** A permission request in plain words, worked out by the server (shared/explain.ts). */
export type PermissionExplanation = { title: string; summary: string; effect: "reads" | "changes" | "deletes" | "network" | "pushes" | "unknown"; command?: string; reason?: string; alwaysNote?: string };

export type Decision = {
  id: string;
  companyId: string;
  kind: string;
  question: string;
  options: string[];
  recommendedOption: string | null;
  tier: "ceo" | "owner";
  createdAt: string;
  companyName: string;
  agentName: string | null;
  /** The agent a CEO-tier decision is put to instead of the CEO (review policy). */
  forAgentName?: string | null;
  blocks: Array<{ id: string; title: string }>;
  score: number;
  parts: { blocking: number; urgency: number; age: number; liveRun: number };
  reasons: string[];
  dueDate: string | null;
  context?: { type?: string; output?: string; planText?: string | null; ticketId?: string | null; explain?: PermissionExplanation; always?: Array<{ label: string }>; rule?: { name: string; outcome: string; match: { kinds?: string[]; commandPattern?: string; titlePattern?: string; safeOnly?: boolean } } };
  /** For a stalled run: what the owner needs to judge it, worked out by the server when asked. */
  evidence?: StallEvidence | null;
};

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
  systemState: string;
  outcome: string | null;
  assigneeAgentId: string | null;
  assignedToOwner: boolean;
  dueDate: string | null;
  blockedBy: Array<{ ticketId: string | null; engagementId: string | null; decisionId: string | null }>;
  branch: string | null;
  risk: Risk | null;
  planFirst: boolean;
  plan: string | null;
  planApprovedAt: string | null;
  /** The feature it delivers and the task it is a sub-task of, by title, on a board card. */
  featureId?: string | null;
  featureTitle?: string | null;
  parentTitle?: string | null;
  lastActivityAt?: string;
  /** In review with an owner sign-off decision still open (the "Your review" lane). */
  waitingOnOwner?: boolean;
  waitingDecisionId?: string | null;
  approvedBy?: string | null;
};
export type TicketDetail = Ticket & { milestoneId: string | null; featureId: string | null; body: string | null; project: string; projectId: string; companyId: string; repoUrl: string | null; defaultBranch: string; assignee: string | null; mergeCommit: string | null; lastActivityAt: string; createdAt: string; landing: "merge" | "pull_request"; verifyCommand: string | null; ownerSignoff: boolean; pullRequestUrl: string | null; pullRequestNumber: number | null; pullRequestNote: string | null; watcherAgentId: string | null; watchEveryMinutes: number | null; watchedAt: string | null; monitorAt: string | null; monitorNote: string | null; monitorAttempts: number; monitorMax: number };
export type WorkspaceDiff = { baseCommit: string; head: string; commits: Array<{ sha: string; subject: string }>; files: Array<{ path: string; added: number; removed: number }>; diff: string; truncated: boolean; turn?: { number: number; at: string } };
export type Board = { project: Project; columns: Array<{ id: string; name: string; systemState: string; wipLimit: number | null; tickets: Ticket[] }> };

export type FundingSource = { id: string; name: string; kind: string; provider: string; monthlyGrantMicros: number | null; cycleAnchor?: string | null };
export type FundingStatus = {
  source: FundingSource;
  credit: { grantMicros: number; spentMicros: number; remainingMicros: number; fractionUsed: number; cycleStart: string; cycleEnd: string } | null;
  quota: Array<{ window: string; utilization: number; resetsAt: string | null; status: string | null; overageInUse: boolean }>;
  /** Per window: when it runs out at the recent rate (R78); null with no readings. */
  forecasts: Record<string, { utilization: number; resetsAt: string | null; perHour: number | null; runsOutAt: string | null; beforeReset: boolean } | null>;
  /** The last 7 days, oldest first (UTC days). */
  daily: Array<{ day: string; runs: number; inputTokens: number; outputTokens: number; costMicros: number }>;
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
  /** Tokens over the run, when the agent reported them (R67). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  /** "subscription" or "api_credit": subscriptions show tokens, API credit shows money. */
  fundingKind?: string | null;
};
export type TranscriptItem = { seq: number; type: string; at: string; event: Record<string, unknown> & { update?: Record<string, unknown> } };
export type Transcript = { run: RunRow & { endedAt: string | null; outcome: string | null; costMicros: number }; items: TranscriptItem[]; next: number; more: boolean };

export type EngagementRow = { id: string; title: string; status: string; requester: string; provider: string; budgetCapUsd: number | null };
export type EngagementView = EngagementRow & {
  scope: string;
  deliverables: string | null;
  acceptanceCriteria: string[];
  spentUsd: number;
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
export type NoticeFeed = { items: Notice[]; unread: number };
export type NotifySettings = {
  quietHours: { start: string; end: string; timeZone: string } | null;
  agentHourlyCap: number;
  ntfy: { url: string; topic: string; hasToken: boolean } | null;
  pushLevels: NotifyLevel[];
  publicUrl: string | null;
};

export type MilestoneStatus = "done" | "late" | "at_risk" | "on_track" | "no_work" | "unscheduled";
export type Horizon = "now" | "next" | "later";
export type RoadmapMilestone = { id: string; title: string; targetDate: string | null; total: number; done: number; blocked: number; active: number; status: MilestoneStatus; horizon: Horizon; pinned: Horizon | null };
export type RoadmapObjective = {
  id: string;
  title: string;
  priority: number;
  status: "active" | "done" | "dropped";
  keyResults: Array<{ id: string; title: string; current: number | null; target: number | null; unit: string | null; progress: number | null }>;
  milestones: RoadmapMilestone[];
};
export type RoadmapCompany = { id: string; name: string; objectives: RoadmapObjective[] };

export type PlanNode = {
  id: string;
  kind: "ticket" | "engagement" | "decision";
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
export type Plan = { nodes: PlanNode[]; edges: Array<{ id: string; from: string; to: string }>; columns: string[][] };
export type TicketLinks = {
  waitsOn: Array<{ dependencyId: string; kind: "ticket" | "engagement" | "decision"; id: string; title: string; state: string; open: boolean; link: string }>;
  blocks: Array<{ dependencyId: string; id: string; title: string; state: string; link: string }>;
};

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
  companyId: string;
  areaId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  status: FeatureStatus;
  effort: number | null;
  driverScores: Record<string, number | null>;
  milestoneId: string | null;
  objectiveId: string | null;
  portalVisible: boolean;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
  demand: number;
  insightCount: number;
  customerCount: number;
  value: number;
  demandPart: number;
  priority: number;
  tickets: { total: number; done: number; items: Array<{ id: string; title: string; state: string; outcome: string | null; assignee: string | null }> };
};
export type ScoredFeatures = { settings: { demandWeight: number; ceoTriage: boolean }; drivers: Driver[]; maxDemand: number; features: Feature[] };
export type FeedbackSettingsView = { demandWeight: number; ceoTriage: boolean; portalEnabled: boolean; portalToken: string | null; portalTitle: string | null; portalIntro: string | null; hasLogo: boolean; portalUrl: string | null; drivers: Driver[]; areas: FeatureArea[] };
export type NoteSummary = { id: string; companyId: string; title: string | null; text: string; source: string; state: "unprocessed" | "processed" | "archived"; untrusted: boolean; createdAt: string; customer: string | null; insightCount: number };
export type Insight = { id: string; noteId: string; featureId: string; importance: Importance; highlight: string | null; createdBy: string; createdAt: string };
export type NoteDetail = {
  note: Omit<NoteSummary, "customer" | "insightCount"> & { customerId: string | null; processedAt: string | null };
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
