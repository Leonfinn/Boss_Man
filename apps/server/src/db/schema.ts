// Boss Man's v1 data model (docs/02-architecture.md). Every company-owned row carries
// company_id; cross-company links exist only through engagements.
import { sql } from "drizzle-orm";
import { DEFAULT_REVIEW_POLICY, DEFAULT_WATCHDOG, PERMISSION_JUDGE_MODES, type AddonReport, type RetroFinding, type SandboxReport, type ReviewPolicy, type WatchdogSettings } from "@boss-man/shared";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const micros = (name: string) => bigint(name, { mode: "number" });

// ---------- Owner and sessions ----------

export const owners = pgTable("owners", {
  id: id(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  // SHA-256 of the cookie token; the token itself is never stored.
  tokenHash: text("token_hash").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => owners.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ---------- Companies, agents, runners ----------

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull().unique(),
  mission: text("mission"),
  /** Company kill switch (R30): no new runs start while set. */
  paused: boolean("paused").notNull().default(false),
  /** An engagement this company agrees to provide waits for the owner's approval (R23). */
  ownerApprovesEngagements: boolean("owner_approves_engagements").notNull().default(true),
  /** Workspace disk cap (R54); null means the instance default. */
  diskCapBytes: bigint("disk_cap_bytes", { mode: "number" }),
  /** Who approves plans, who reviews code and whether the owner signs off, per risk tier. */
  reviewPolicy: jsonb("review_policy").$type<ReviewPolicy>().notNull().default(DEFAULT_REVIEW_POLICY),
  /** Days after a feature is released before the owner is asked whether it moved its goal. */
  goalCheckDays: integer("goal_check_days").notNull().default(14),
  /** Most nudges the company's agents may send each other in an hour (BOS-73); past it they write on the ticket instead. */
  nudgesPerHour: integer("nudges_per_hour").notNull().default(30),
  /** Minutes the CEO has to act on a decision the owner asked for advice on, before it goes back to the owner. */
  adviceTimeoutMinutes: integer("advice_timeout_minutes").notNull().default(120),
  /** How the rules judge advises on permission cards (BOS-337): off, watch (only logs next to the answer) or advise (sets the suggested button). Never answers a card. */
  permissionJudge: text("permission_judge", { enum: PERMISSION_JUDGE_MODES }).notNull().default("watch"),
  /** The Scrum Master watchdog's switch and limits (BOS-58), edited by the owner. */
  watchdog: jsonb("watchdog").$type<WatchdogSettings>().notNull().default(DEFAULT_WATCHDOG),
  /** Set when the watchdog hit its hourly cap and switched itself off; cleared when the owner switches it back on. */
  watchdogTrippedAt: timestamp("watchdog_tripped_at", { withTimezone: true }),
  watchdogTrippedReason: text("watchdog_tripped_reason"),
  /** Written by the sweep only, so it never overwrites the owner's settings. */
  watchdogLastSweepAt: timestamp("watchdog_last_sweep_at", { withTimezone: true }),
  /** Tickets are referred to as PREFIX-number (e.g. HOL-12); one sequence per company, handed out by a database trigger. */
  ticketPrefix: text("ticket_prefix"),
  nextTicketNumber: integer("next_ticket_number").notNull().default(1),
  createdAt: createdAt(),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const agentRole = pgEnum("agent_role", ["ceo", "manager", "worker"]);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: agentRole("role").notNull(),
    reportsTo: uuid("reports_to"),
    /** ACP agent kind: "claude", "codex", or another registered adapter. */
    agentKind: text("agent_kind").notNull(),
    /** A pinned model ID applied at launch (spike S2: ACP refuses unlisted models). */
    model: text("model"),
    /** How hard the model thinks (low…max), set through the agent's ACP "thought_level" option; null keeps the adapter's default. */
    thinking: text("thinking"),
    fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "set null" }),
    /** A paused agent isn't started; its work waits until the owner unpauses it. */
    paused: boolean("paused").notNull().default(false),
    /** Starred agents are linked under Chat in the sidebar. */
    starred: boolean("starred").notNull().default(false),
    /** A standing job Boss Man gives the agent: "wiki" keeps the company wiki in order (R73). */
    duty: text("duty"),
    /**
     * Deprecated (BOS-198): the old agent-page mark as one kind's reviewer. Nothing writes it now;
     * migration 0094 moved every use into the review policy, and it is read only for a leftover
     * "marked" cell. Kept one release so a rollback has it; drop it after.
     */
    reviewKind: text("review_kind"),
    /** Job title (e.g. "Scrum Master"), the template it was hired from, and its standing instructions (R62). */
    title: text("title"),
    template: text("template"),
    instructions: text("instructions"),
    /** When the owner last uploaded a picture for the agent (agent_avatars); null shows the template's portrait. */
    avatarAt: timestamp("avatar_at", { withTimezone: true }),
    /** A retired agent no longer works; its history and runs stay. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /** How far this agent's brief has been delivered (R83): advances when a run is launched, not when the brief is built. */
    briefSeenAt: timestamp("brief_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // One CEO per company (R18).
    uniqueIndex("agents_one_ceo_per_company").on(t.companyId).where(sql`${t.role} = 'ceo'`),
    uniqueIndex("agents_one_duty_per_company").on(t.companyId, t.duty).where(sql`${t.duty} is not null and ${t.retiredAt} is null`),
  ],
);

/** Every change to an agent, by the owner or by the CEO, with what it was before (R62). */
export const agentChanges = pgTable(
  "agent_changes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** Who made it: null for the owner, else the agent (the CEO). */
    byAgentId: uuid("by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** hired, retired, rehired, name, title, instructions, model, funding, paused, or undo. */
    field: text("field").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("agent_changes_agent_time").on(t.agentId, t.createdAt)],
);

export const runners = pgTable("runners", {
  id: id(),
  companyId: uuid("company_id").notNull().unique().references(() => companies.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  imageVersion: text("image_version"),
  /** Versions of the harnesses in the runner image, from its last hello (BOS-305); null until it reports them. */
  harnessVersions: jsonb("harness_versions").$type<Record<string, string>>(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** The boot id from the runner's last hello (BOS-352); a different id means the runner restarted. */
  bootId: text("boot_id"),
  /** When a restart last pulled parked checks forward, so a restart loop doesn't do it again straight away. */
  bootPulledAt: timestamp("boot_pulled_at", { withTimezone: true }),
  /** Disk use of the runner's workspaces from its last clean-up pass (R54). */
  diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
  diskCheckedAt: timestamp("disk_checked_at", { withTimezone: true }),
  /** The runner's last report on its add-ons (docs/12); null until it reports one. */
  addons: jsonb("addons").$type<AddonReport[]>(),
  /** What the runner can fence agents with, from its start-up self-test (BOS-321); null until it reports. */
  sandbox: jsonb("sandbox").$type<SandboxReport>(),
  sandboxCheckedAt: timestamp("sandbox_checked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Every event a runner has delivered, stored once per (runner, seq) (R31). */
export const runnerEvents = pgTable(
  "runner_events",
  {
    id: id(),
    runnerId: uuid("runner_id").notNull().references(() => runners.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("runner_events_runner_seq").on(t.runnerId, t.seq),
    // A run's transcript is read by the run id inside the event (R43).
    index("runner_events_run").on(sql`(${t.payload}->>'runId')`, t.seq),
  ],
);

// ---------- Work structure ----------

export const systemState = pgEnum("system_state", ["backlog", "ready", "in_progress", "blocked", "review", "done"]);

export const projects = pgTable("projects", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** The project's git repo (R38). When set, each ticket works in its own worktree and branch. */
  repoUrl: text("repo_url"),
  /** The branch new tickets start from, and that approved tickets merge into (R46). */
  defaultBranch: text("default_branch").notNull().default("main"),
  /** How approved work lands (R59): "merge" straight into the default branch, or "pull_request" on the host. */
  landing: text("landing").notNull().default("merge"),
  /** The git host ("github" or "gitea") and its API base, detected from the repo address (R59). */
  gitHost: text("git_host"),
  gitApiBase: text("git_api_base"),
  /** A check that must pass in a ticket's worktree before it can be merged and done (R47). */
  verifyCommand: text("verify_command"),
  /** An extra, slower check run before merging high and critical risk tickets (R48). */
  deepVerifyCommand: text("deep_verify_command"),
  /** Default spend ceiling per ticket across all its runs (R53). */
  ticketCostCapMicros: micros("ticket_cost_cap_micros"),
  /** Starred projects show under Projects in the sidebar. */
  starred: boolean("starred").notNull().default(false),
  /** Money this project may spend per UTC calendar month; at the cap no new runs start for its tickets. */
  monthlyCapMicros: micros("monthly_cap_micros"),
  /** Overrides the company's review policy for this project's tickets; null uses the company's. */
  reviewPolicy: jsonb("review_policy").$type<ReviewPolicy>(),
  /** An archived project is hidden from menus and agents and takes no new tickets; its tickets and history stay. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const workflowColumns = pgTable("workflow_columns", {
  id: id(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  systemState: systemState("system_state").notNull(),
  position: integer("position").notNull(),
  wipLimit: integer("wip_limit"),
});

export const objectives = pgTable("objectives", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  priority: integer("priority").notNull().default(2),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const krMethod = pgEnum("kr_method", ["manual", "agent", "check"]);

export const keyResults = pgTable("key_results", {
  id: id(),
  objectiveId: uuid("objective_id").notNull().references(() => objectives.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  target: real("target"),
  current: real("current"),
  unit: text("unit"),
  method: krMethod("method").notNull().default("manual"),
  checkSpec: jsonb("check_spec"),
});

export const roadmapHorizon = pgEnum("roadmap_horizon", ["now", "next", "later"]);

export const milestones = pgTable("milestones", {
  id: id(),
  objectiveId: uuid("objective_id").notNull().references(() => objectives.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  targetDate: date("target_date"),
  /** Pinned to Now, Next or Later on the roadmap; null places it from its date and work. */
  horizon: roadmapHorizon("horizon"),
});

export const riskTier = pgEnum("risk_tier", ["trivial", "low", "medium", "high", "critical"]);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    systemState: systemState("system_state").notNull().default("backlog"),
    /** Set when systemState is done. */
    outcome: text("outcome"),
    columnId: uuid("column_id").references(() => workflowColumns.id, { onDelete: "set null" }),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    keyResultId: uuid("key_result_id").references(() => keyResults.id, { onDelete: "set null" }),
    /** Set on the provider's tickets that do work for an engagement; their runs are charged back (R26). */
    engagementId: uuid("engagement_id").references((): AnyPgColumn => engagements.id, { onDelete: "set null" }),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The agent that created it through MCP, so a repeated call after a resume returns the same ticket. */
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assignedToOwner: boolean("assigned_to_owner").notNull().default(false),
    dueDate: date("due_date"),
    /** The ticket's git branch and the commit it started from, reported by the runner (R38). */
    branch: text("branch"),
    baseCommit: text("base_commit"),
    /** The merge commit on the target branch once the ticket's branch is merged (R46). */
    mergeCommit: text("merge_commit"),
    /** The merge commit the checks ran on and that was pushed, when the gate checks the merged result (BOS-313). */
    checkedCommit: text("checked_commit"),
    /** The pull request approved work is waiting in (R59), and why it isn't merged yet. */
    pullRequestUrl: text("pull_request_url"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestNote: text("pull_request_note"),
    /** The commit that was reviewed: the host merges only this head, never later pushes. */
    pullRequestHead: text("pull_request_head"),
    /** The head commit and check result the agent was last told about ("sha:failed"), so each is told once (R86). */
    pullRequestCi: text("pull_request_ci"),
    /** A watcher (R80): an agent that reports this ticket's progress to the owner every so often. Off when null. */
    watcherAgentId: uuid("watcher_agent_id").references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    watchEveryMinutes: integer("watch_every_minutes"),
    /** When the watcher was last asked for a report on this ticket. */
    watchedAt: timestamp("watched_at", { withTimezone: true }),
    /** The ticket's facts as of the last report, so the watcher runs only when something changed (R85). */
    watchFingerprint: text("watch_fingerprint"),
    /** The stopped state of this ticket's tree the watcher was last woken for; null while the tree is moving. */
    watchStoppedFp: text("watch_stopped_fp"),
    /** Spend ceiling across all of this ticket's runs (R53); falls back to the project's default. */
    costCapMicros: micros("cost_cap_micros"),
    /** Risk tier (R48): who reviews it, how deep the checks go, staging first. Null is medium. */
    risk: riskTier("risk"),
    /** Plan-first (R40): the agent starts in plan mode until its plan is approved. */
    planFirst: boolean("plan_first").notNull().default(false),
    /** Relative size, 1, 2, 3, 5 or 8 (docs/19 part 6), set by whoever creates the task; null is unsized. */
    size: integer("size"),
    /** The CEO's order for this ticket's reviews (slots by name); null or empty means all at once. */
    reviewOrder: jsonb("review_order").$type<string[]>(),
    plan: text("plan"),
    planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
    /** The feature request this ticket delivers, if any. */
    featureId: uuid("feature_id").references((): AnyPgColumn => features.id, { onDelete: "set null" }),
    /** The task this is a sub-task of (one level only); the parent waits on it. */
    parentTicketId: uuid("parent_ticket_id").references((): AnyPgColumn => tickets.id, { onDelete: "set null" }),
    /** Monitor: wake the assignee at monitor_at to re-check monitor_note; monitor_attempts of monitor_max checks used. Not in the version trigger. */
    monitorAt: timestamp("monitor_at", { withTimezone: true }),
    monitorNote: text("monitor_note"),
    monitorAttempts: integer("monitor_attempts").notNull().default(0),
    monitorMax: integer("monitor_max").notNull().default(5),
    /** When a runner restart pulled this check forward (BOS-352); the wake says so, then this is cleared. */
    monitorRestartAt: timestamp("monitor_restart_at", { withTimezone: true }),
    customFields: jsonb("custom_fields").notNull().default({}),
    /** The ticket's acceptance criteria (1 to 10 non-empty strings), checked against at review; empty means none. */
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    /** Research, wiki, docs or deploy-only work: an empty diff is expected, so review and landing don't insist on a change. */
    noCode: boolean("no_code").notNull().default(false),
    /** Owner-marked urgent work: it always passes the subscription quota hold (BOS-227). */
    urgent: boolean("urgent").notNull().default(false),
    /** Bumped by a database trigger whenever state, assignee, title, body, risk or plan-first changes (R81). */
    version: integer("version").notNull().default(1),
    /** What the agent said when it last moved the ticket (R85). Not in the version trigger, so it never bumps it. */
    stateNote: text("state_note"),
    stateNoteAt: timestamp("state_note_at", { withTimezone: true }),
    /** When an agent last posted on this ticket, a reply or a state note (BOS-314). */
    lastPostAt: timestamp("last_post_at", { withTimezone: true }),
    /** When an owner action made the state note possibly out of date (BOS-123). */
    stateNoteStaleAt: timestamp("state_note_stale_at", { withTimezone: true }),
    /** Its number in the company's sequence (shown as PREFIX-number); set by a database trigger on insert unless given. */
    number: integer("number"),
    /** When system_state last changed; set by a database trigger, so every write path counts (BOS-58). */
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Optional "blocked until" time and reason (BOS-59); the same trigger clears both when the ticket leaves blocked. */
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    blockedUntilReason: text("blocked_until_reason"),
    createdAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tickets_company_state").on(t.companyId, t.systemState), uniqueIndex("tickets_company_number").on(t.companyId, t.number), check("tickets_size_scale", sql`${t.size} is null or ${t.size} in (1, 2, 3, 5, 8)`)],
);

// ---------- Decisions and engagements ----------

export const decisionKind = pgEnum("decision_kind", ["question", "approval", "permission", "stale_blocker", "stalled_run", "engagement", "budget", "skill"]);
export const decisionTier = pgEnum("decision_tier", ["ceo", "owner"]);
export const decisionStatus = pgEnum("decision_status", ["open", "answered", "withdrawn"]);

export const decisions = pgTable("decisions", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  kind: decisionKind("kind").notNull(),
  question: text("question").notNull(),
  options: jsonb("options").notNull().default([]),
  /** Required for every decision an agent raises (R20). */
  recommendedOption: text("recommended_option").notNull(),
  raisedByAgentId: uuid("raised_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  tier: decisionTier("tier").notNull().default("owner"),
  /** With tier "ceo": the agent (a plan approver per the review policy) this is put to instead of the CEO; the CEO can still answer. */
  forAgentId: uuid("for_agent_id").references(() => agents.id, { onDelete: "set null" }),
  status: decisionStatus("status").notNull().default("open"),
  answer: text("answer"),
  /** Collapses repeats, e.g. one stale-blocker row per blocker. */
  dedupeKey: text("dedupe_key").unique(),
  /** What answering it resumes, e.g. { runnerId, runId, requestId } for a permission. */
  context: jsonb("context").notNull().default({}),
  createdAt: createdAt(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  /** An owner action made this open card possibly out of date (BOS-123); the author is woken to confirm or withdraw it. */
  staleAt: timestamp("stale_at", { withTimezone: true }),
  staleReason: text("stale_reason"),
});

export const engagementStatus = pgEnum("engagement_status", [
  "requested",
  "countered",
  "accepted",
  "rejected",
  "in_progress",
  "delivered",
  "signed_off",
]);

export const engagements = pgTable(
  "engagements",
  {
    id: id(),
    requesterCompanyId: uuid("requester_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    requesterProjectId: uuid("requester_project_id").references(() => projects.id, { onDelete: "set null" }),
    providerCompanyId: uuid("provider_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    scope: text("scope").notNull(),
    deliverables: text("deliverables"),
    acceptanceCriteria: jsonb("acceptance_criteria").notNull().default([]),
    budgetCapMicros: micros("budget_cap_micros"),
    status: engagementStatus("status").notNull().default("requested"),
    /** The provider's proposed changes while status is countered. */
    counterTerms: jsonb("counter_terms"),
    /** What the provider handed over: a summary plus git refs, artifact links or instructions. */
    delivery: jsonb("delivery"),
    createdAt: createdAt(),
  },
  (t) => [check("engagements_distinct_companies", sql`${t.requesterCompanyId} <> ${t.providerCompanyId}`)],
);

export const engagementMessages = pgTable("engagement_messages", {
  id: id(),
  engagementId: uuid("engagement_id").notNull().references(() => engagements.id, { onDelete: "cascade" }),
  fromCompanyId: uuid("from_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  /** What the message records: a plain message, or a step such as "accepted" or "delivered". */
  kind: text("kind").notNull().default("message"),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const ticketDependencies = pgTable(
  "ticket_dependencies",
  {
    id: id(),
    blockedTicketId: uuid("blocked_ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    blockerTicketId: uuid("blocker_ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    blockerEngagementId: uuid("blocker_engagement_id").references(() => engagements.id, { onDelete: "cascade" }),
    blockerDecisionId: uuid("blocker_decision_id").references(() => decisions.id, { onDelete: "cascade" }),
  },
  (t) => [
    check(
      "ticket_dependencies_one_blocker",
      sql`num_nonnulls(${t.blockerTicketId}, ${t.blockerEngagementId}, ${t.blockerDecisionId}) = 1`,
    ),
  ],
);

// ---------- Scheduling (R30) ----------

/** Instance-wide settings, e.g. the global kill switch and launch limits. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const wakeStatus = pgEnum("wake_status", ["queued", "deferred", "launched", "dropped", "steered"]);

/** Requests to start an agent. Durable, so a restart doesn't lose queued work. */
export const wakes = pgTable(
  "wakes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    /** Extra context for the prompt, e.g. a decision's answer. */
    note: text("note"),
    /** Higher launches first. */
    priority: integer("priority").notNull().default(2),
    /** How many wake-ups led to this one; capped to stop loops. */
    causationDepth: integer("causation_depth").notNull().default(0),
    causedByRunId: uuid("caused_by_run_id"),
    /** The agent whose run caused this wake, for the self-wake limit. */
    causedByAgentId: uuid("caused_by_agent_id"),
    status: wakeStatus("status").notNull().default("queued"),
    statusReason: text("status_reason"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    runId: uuid("run_id"),
    /** Recovery (R42): the interrupted run this wake picks up from. */
    resumeRunId: uuid("resume_run_id"),
    /** Set when this wake carries out an approved deploy; that run alone gets the target's secrets. */
    deployId: uuid("deploy_id").references((): AnyPgColumn => deploys.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
  },
  (t) => [index("wakes_status_priority").on(t.status, t.priority), index("wakes_run_id").on(t.runId)],
);

// ---------- Runs, funding and cost ----------

/** Per-run bearer tokens for the Boss Man MCP server; scoped to one company and agent. */
export const runTokens = pgTable("run_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  runId: uuid("run_id").notNull(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const runs = pgTable("runs", {
  id: id(),
  /** The funding source this run was started on, when the scheduler chose one from the owner's list of subscriptions (BOS-383). */
  fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "set null" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  engagementId: uuid("engagement_id").references(() => engagements.id, { onDelete: "set null" }),
  acpSessionId: text("acp_session_id"),
  /** "chat" for an owner chat run: board tools only, no workspace (v1.1). */
  /** Tokens over the run's turns, when the agent reports them (R67). */
  inputTokens: bigint("input_tokens", { mode: "number" }),
  outputTokens: bigint("output_tokens", { mode: "number" }),
  cachedReadTokens: bigint("cached_read_tokens", { mode: "number" }),
  cachedWriteTokens: bigint("cached_write_tokens", { mode: "number" }),
  purpose: text("purpose"),
  /**
   * What started the run, in plain words, for runs with no ticket: "nudge", "wiki upkeep",
   * "owner_chat" and so on (the wake's reason). It may name a ticket the run was about
   * without being on it (a nudge that passed one); that link is `runTicketId`.
   */
  origin: text("origin"),
  /** The ticket the run was about, when it wasn't formally on it (a nudge naming one). */
  runTicketId: uuid("run_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  /** The CEO chapter this run belongs to, if any. */
  chapterId: uuid("chapter_id").references((): AnyPgColumn => ceoChapters.id, { onDelete: "set null" }),
  /** How full the session's context was when last reported, in tokens. */
  contextUsed: integer("context_used"),
  contextSize: integer("context_size"),
  model: text("model"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  /** When the runner last reported anything for this run; a long silence is a stall (R32). */
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  outcome: text("outcome"),
  /** When the owner asked to stop the run; the sweep ends it if the runner never confirms. */
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  /** When the run last posted on its ticket (a reply or a state note); silence is measured from it (BOS-314). */
  lastPostAt: timestamp("last_post_at", { withTimezone: true }),
  /** When Boss Man asked the silent run for a status, so it is asked once (BOS-314). */
  silentSteeredAt: timestamp("silent_steered_at", { withTimezone: true }),
}, (t) => [index("runs_ticket_open").on(t.ticketId, t.endedAt)]);

export const fundingKind = pgEnum("funding_kind", ["api_credit", "subscription", "usage_credits", "api_payg"]);
export const provider = pgEnum("provider", ["anthropic", "openai", "bedrock", "foundry", "gateway", "openrouter", "ollama", "synthetic"]);
/** What routine work does when a subscription window passes its hold threshold (BOS-227). */
export const quotaOverageMode = pgEnum("quota_overage_mode", ["pause", "urgent", "all"]);

export const fundingSources = pgTable("funding_sources", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: fundingKind("kind").notNull(),
  provider: provider("provider").notNull(),
  /** For api_credit: the monthly grant, e.g. $200 on Max 20x. */
  monthlyGrantMicros: micros("monthly_grant_micros"),
  /** Any cycle start; cycles repeat monthly from it. */
  cycleAnchor: timestamp("cycle_anchor", { withTimezone: true }),
  /** The credential agents on this source use. */
  secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
  /** Position in the owner's ordered list of Claude subscriptions (1 = preferred). Null: not part of the list (BOS-383). */
  fallbackRank: integer("fallback_rank"),
  /** Subscription utilisation at which routine work is held (0.8–1, default 0.95). */
  quotaHoldAt: real("quota_hold_at").notNull().default(0.95),
  /** Whether extra usage may be spent, and for which work: pause (default), urgent, or all. */
  quotaOverage: quotaOverageMode("quota_overage").notNull().default("pause"),
  /** Window names (as the adapter reports them) that never trigger the hold. Empty means all of them can. */
  quotaDisabledWindows: jsonb("quota_disabled_windows").$type<string[]>().notNull().default([]),
  /** The owner was told the current hold started; cleared when it lifts. */
  quotaHeldNotified: boolean("quota_held_notified").notNull().default(false),
  /** The owner was told credits are in use; cleared when overage stops. */
  quotaOverageNotified: boolean("quota_overage_notified").notNull().default(false),
  createdAt: createdAt(),
});

export const costBasis = pgEnum("cost_basis", ["list_estimate", "billed"]);

export const costEvents = pgTable(
  "cost_events",
  {
    id: id(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    fundingSourceId: uuid("funding_source_id").notNull().references(() => fundingSources.id, { onDelete: "cascade" }),
    /** The company whose agent did the work. */
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    engagementId: uuid("engagement_id").references(() => engagements.id, { onDelete: "set null" }),
    /** Charge-back (R26): engagement work is charged to the requester's company and project. */
    chargedCompanyId: uuid("charged_company_id").references(() => companies.id, { onDelete: "set null" }),
    chargedProjectId: uuid("charged_project_id").references(() => projects.id, { onDelete: "set null" }),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costMicros: micros("cost_micros").notNull(),
    basis: costBasis("basis").notNull().default("list_estimate"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cost_events_source_time").on(t.fundingSourceId, t.occurredAt)],
);

export const quotaSamples = pgTable(
  "quota_samples",
  {
    id: id(),
    fundingSourceId: uuid("funding_source_id").notNull().references(() => fundingSources.id, { onDelete: "cascade" }),
    window: text("window").notNull(),
    utilization: real("utilization").notNull(),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    status: text("status"),
    overageInUse: boolean("overage_in_use").notNull().default(false),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quota_samples_source_window_time").on(t.fundingSourceId, t.window, t.observedAt)],
);

/**
 * One reading of Synthetic's own quota endpoint (BOS-239), per funding source. The newest row for a
 * source is the current reading; older ones are the trend inside a period and are pruned after 30 days.
 */
export const providerQuotaReadings = pgTable(
  "provider_quota_readings",
  {
    id: id(),
    fundingSourceId: uuid("funding_source_id").notNull().references(() => fundingSources.id, { onDelete: "cascade" }),
    used: integer("used").notNull(),
    limit: integer("limit_limit").notNull(),
    renewsAt: timestamp("renews_at", { withTimezone: true }),
    /** When the reading was taken from Synthetic (not when it was read from this table). */
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("provider_quota_readings_source_time").on(t.fundingSourceId, t.takenAt)],
);

/** A warning the owner already had about a provider's quota, so the same one isn't repeated (BOS-239). */
export const providerQuotaWarnings = pgTable(
  "provider_quota_warnings",
  {
    fundingSourceId: uuid("funding_source_id").notNull().references(() => fundingSources.id, { onDelete: "cascade" }),
    /** The period the warning is for, e.g. the renewal time, so a new period warns again. */
    period: text("period").notNull(),
    /** 80 or 100. */
    threshold: integer("threshold").notNull(),
    warnedAt: timestamp("warned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fundingSourceId, t.period, t.threshold] })],
);

/** "instance" covers every company (R53); its scope_id is the nil UUID. */
export const budgetScope = pgEnum("budget_scope", ["company", "project", "agent", "instance"]);
export const budgetWindow = pgEnum("budget_window", ["lifetime", "calendar_month", "billing_cycle", "rolling_days"]);
export const budgetOnLimit = pgEnum("budget_on_limit", ["ask", "pause"]);

export const budgetPolicies = pgTable("budget_policies", {
  id: id(),
  scopeKind: budgetScope("scope_kind").notNull(),
  scopeId: uuid("scope_id").notNull(),
  /** Null: counts spend from every funding source. */
  fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "cascade" }),
  windowKind: budgetWindow("window_kind").notNull(),
  rollingDays: integer("rolling_days"),
  limitMicros: micros("limit_micros").notNull(),
  onLimit: budgetOnLimit("on_limit").notNull(),
  warnAt: real("warn_at").notNull().default(0.9),
  createdAt: createdAt(),
});

// ---------- Secrets, grants, deploy targets, policy ----------

export const secrets = pgTable("secrets", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(),
  /** base64(iv | tag | ciphertext) under a per-secret data key. */
  ciphertext: text("ciphertext").notNull(),
  /** The data key, wrapped by the master key: base64(iv | tag | ciphertext). */
  wrappedKey: text("wrapped_key").notNull(),
  masterKeyVersion: integer("master_key_version").notNull().default(1),
  hint: text("hint").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployTargetKind = pgEnum("deploy_target_kind", ["ssh", "docker", "git"]);

export const deployTargets = pgTable("deploy_targets", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: deployTargetKind("kind").notNull(),
  endpoint: text("endpoint").notNull(),
  isProduction: boolean("is_production").notNull().default(false),
  rules: jsonb("rules").notNull().default({}),
  createdAt: createdAt(),
});

export const deployStatus = pgEnum("deploy_status", ["pending_approval", "approved", "rejected", "running", "succeeded", "failed"]);

/** A request to ship something to a deploy target (R14, R15). Production targets wait for the owner. */
export const deploys = pgTable("deploys", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  targetId: uuid("target_id").notNull().references(() => deployTargets.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  /** What to ship: a git ref, image tag or release name. */
  ref: text("ref").notNull(),
  notes: text("notes"),
  status: deployStatus("status").notNull().default("pending_approval"),
  /** The run that carries the deploy out; only it receives the target's secrets. */
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  outcome: text("outcome"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const secretGrants = pgTable(
  "secret_grants",
  {
    id: id(),
    secretId: uuid("secret_id").notNull().references(() => secrets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The environment variable the runner sets, e.g. CLAUDE_CODE_OAUTH_TOKEN. */
    envName: text("env_name").notNull(),
    deployTargetId: uuid("deploy_target_id").references(() => deployTargets.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("secret_grants_company_env").on(t.companyId, t.envName)],
);

/** Limits a grant to these agents. A grant with no rows here goes to every agent in the company. */
export const secretGrantAgents = pgTable(
  "secret_grant_agents",
  {
    grantId: uuid("grant_id").notNull().references(() => secretGrants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.agentId] })],
);

export const secretAccessLog = pgTable("secret_access_log", {
  id: id(),
  grantId: uuid("grant_id").references(() => secretGrants.id, { onDelete: "set null" }),
  secretId: uuid("secret_id").notNull(),
  companyId: uuid("company_id").notNull(),
  runId: uuid("run_id"),
  purpose: text("purpose").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const policyOutcome = pgEnum("policy_outcome", ["allow", "ceo", "owner", "deny"]);

export const policyRules = pgTable("policy_rules", {
  id: id(),
  /** Null: applies to every company. */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(),
  condition: jsonb("condition").notNull().default({}),
  outcome: policyOutcome("outcome").notNull(),
  position: integer("position").notNull().default(0),
});

// ---------- Loop guards (R49, R50) ----------

/** Every review verdict on a ticket, so repeated findings and endless rounds can be spotted. */
export const ticketReviews = pgTable("ticket_reviews", {
  id: id(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  verdict: text("verdict").notNull(),
  comments: jsonb("comments").notNull().default([]),
  /** One per comment: path plus normalised text, to recognise the same finding again. */
  fingerprints: jsonb("fingerprints").notNull().default([]),
  createdAt: createdAt(),
});

/**
 * One required review of a ticket in one round (a round is one trip into review). Parallel by
 * default; a higher seq waits until every lower seq has approved or been overruled.
 */
export const reviewRequests = pgTable(
  "review_requests",
  {
    id: id(),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    /** "code" (the tier's reviewer) or an extra kind. */
    kind: text("kind").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    round: integer("round").notNull(),
    seq: integer("seq").notNull().default(0),
    /** pending, approved, changes_requested, overruled, or skipped (never ran because an earlier review failed). */
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    comments: jsonb("comments").notNull().default([]),
    overruledByAgentId: uuid("overruled_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    overruleReason: text("overrule_reason"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("review_requests_slot").on(t.ticketId, t.round, t.kind)],
);

/**
 * One row per ticket state change, written by the same database trigger that keeps state_changed_at,
 * so every write path counts (docs/19-workflow-retros.md).
 */
// shortcut: history starts at deploy; older tickets have only the activity log. Upgrade if a retro needs them.
export const ticketTransitions = pgTable(
  "ticket_transitions",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    /** Null for the first state of a new ticket. */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_transitions_company_at").on(t.companyId, t.at), index("ticket_transitions_ticket_at").on(t.ticketId, t.at)],
);

/** One row per CI or verify result on a commit; tickets.pull_request_ci keeps only the latest CI result. */
export const checkResults = pgTable(
  "check_results",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    sha: text("sha"),
    /** ci, verify or deep_verify. */
    kind: text("kind").notNull(),
    passed: boolean("passed").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    detail: text("detail"),
  },
  (t) => [index("check_results_ticket_at").on(t.ticketId, t.at)],
);

/** A workflow retro (docs/19-workflow-retros.md part 2): the period it looked at and, once the agent saves them, its ranked findings. */
export const retros = pgTable(
  "retros",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** The period: from the last retro's end (or the company's start) to when this one started. */
    since: timestamp("since", { withTimezone: true }).notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
    doneCount: integer("done_count").notNull(),
    /** Null until save_retro; then the ranked list of findings. */
    findings: jsonb("findings").$type<RetroFinding[]>(),
    savedAt: timestamp("saved_at", { withTimezone: true }),
  },
  (t) => [index("retros_company_started").on(t.companyId, t.startedAt)],
);

/** One proposed change to how the team works, from a retro (part 3). Part 4 adds the kept and reverted statuses. */
export const workflowChanges = pgTable(
  "workflow_changes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    retroId: uuid("retro_id").notNull().references(() => retros.id, { onDelete: "cascade" }),
    /** One of WORKFLOW_LEVERS. */
    lever: text("lever").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    targetRole: text("target_role"),
    summary: text("summary").notNull(),
    /** What the setting was when proposed, so Revert can put it back; and what Apply sets. */
    before: jsonb("before"),
    after: jsonb("after"),
    /** One of WORKFLOW_METRICS, the scope it is measured over ({role} | {agentId} | {from, to, kind}) and its value when proposed. */
    metric: text("metric").notNull(),
    metricScope: jsonb("metric_scope").notNull().default({}),
    baseline: real("baseline"),
    /** Ticket ids. */
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    approver: text("approver").$type<"ceo" | "owner">().notNull(),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    /** Why the decision went the way it did, and the wiki page (optionally a section, slug#Heading) that explains it (BOS-216). */
    reason: text("reason"),
    reasonLink: text("reason_link"),
    /** Who applied or skipped it. Older changes have none. */
    decidedBy: text("decided_by").$type<"ceo" | "owner">(),
    status: text("status").$type<"proposed" | "applied" | "skipped" | "kept" | "reverted">().notNull().default("proposed"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    checkDueAt: timestamp("check_due_at", { withTimezone: true }),
    /** Part 4: what the check measured (value, when, how many relevant tickets or handoffs, whether the 30-day cap raised it) and the Keep / Revert decision. */
    result: jsonb("result").$type<{ value: number | null; measuredAt: string; sample: number; capped: boolean }>(),
    checkDecisionId: uuid("check_decision_id").references(() => decisions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("workflow_changes_company").on(t.companyId, t.createdAt), index("workflow_changes_retro").on(t.retroId)],
);

/** Normalised failures (run errors, failed checks), to spot an agent going round in circles. */
export const failureSignatures = pgTable(
  "failure_signatures",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    signature: text("signature").notNull(),
    sample: text("sample").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("failure_signatures_lookup").on(t.ticketId, t.signature, t.createdAt)],
);

/** Agent-to-agent nudges (R86), kept for the pair rate limit and ping-pong detection. */
export const nudges = pgTable(
  "nudges",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    /** What was said, for the owner's alert when two agents loop. */
    why: text("why"),
    /** The wake this nudge delivered. Its run says who nudged and why (BOS-118). */
    wakeId: uuid("wake_id").references(() => wakes.id, { onDelete: "set null" }),
    /** Dropped as a ping-pong: not delivered, and not counted again. */
    dropped: boolean("dropped").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("nudges_pair").on(t.fromAgentId, t.toAgentId, t.createdAt)],
);

// ---------- Notifications (R44) ----------

export const notifyLevel = pgEnum("notify_level", ["note", "flag", "page", "ask"]);

/** What the owner is told, at what level, and where the evidence is. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The level asked for, and the level it was delivered at after quiet hours and caps. */
    requested: notifyLevel("requested").notNull(),
    level: notifyLevel("level").notNull(),
    demotedBy: text("demoted_by"),
    title: text("title").notNull(),
    body: text("body"),
    /** Where the evidence is, as a link in the app, e.g. #/runs/<id>. */
    link: text("link").notNull(),
    /** A decision this tells the owner about; one notification per decision. */
    decisionId: uuid("decision_id").unique().references(() => decisions.id, { onDelete: "cascade" }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    pushError: text("push_error"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_agent_time").on(t.agentId, t.createdAt), index("notifications_time").on(t.createdAt)],
);

/**
 * CEO continuity (v1.1). A CEO works in chapters: one long agent session with a directive
 * frozen at the start, so prompt caching holds. A chapter closes at 70% context, after 7
 * days, or when the owner asks; the CEO writes a handoff that opens the next one.
 */
export const ceoChapters = pgTable(
  "ceo_chapters",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** Frozen for the chapter: identity, mission, objectives and how to work. */
    directive: text("directive").notNull(),
    /** The previous chapter's handoff, given at the start of this one. */
    handoffIn: text("handoff_in"),
    acpSessionId: text("acp_session_id"),
    contextUsed: integer("context_used"),
    contextSize: integer("context_size"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** The owner asked for a new chapter; it closes at the CEO's next run. */
    rollRequestedAt: timestamp("roll_requested_at", { withTimezone: true }),
    /** Set while the closing run writes its handoff. */
    closingRunId: uuid("closing_run_id"),
    endReason: text("end_reason"),
    /** For the next chapter: written by the CEO, or put together by Boss Man if it didn't. */
    handoff: text("handoff"),
    handoffBy: text("handoff_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ceo_chapters_agent_number").on(t.agentId, t.number),
    uniqueIndex("ceo_chapters_one_open").on(t.agentId).where(sql`${t.endedAt} is null`),
  ],
);

export const chatRole = pgEnum("chat_role", ["owner", "assistant", "system"]);

/** The owner chat (v1.1): plain language in, tickets and links on the board out. */
export const ownerChatMessages = pgTable(
  "owner_chat_messages",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Whose conversation it is in (R70): the CEO, or any agent the owner messages directly. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    role: chatRole("role").notNull(),
    text: text("text").notNull(),
    /** The run that answered (assistant) or was asked (owner). */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("owner_chat_company_time").on(t.companyId, t.createdAt), index("owner_chat_agent_time").on(t.agentId, t.createdAt)],
);

/**
 * An agent's lasting notes (BOS-85): corrections and preferences the owner gave in chat, shown
 * in every later chat and run. Kept apart from the owner's standing instructions. Only the CEO
 * writes them for now; keyed by agent so others can later.
 */
export const agentNotes = pgTable(
  "agent_notes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    text: text("text").notNull(),
    /** What the owner said, quoted; for an accepted request, the requester's reason. */
    why: text("why").notNull(),
    /** Where it came from: `chat` (saved from the owner chat), `ticket` (saved in a run from the owner's message on `ticketId`, BOS-95), `owner` (Agents page) or `request` (another agent asked, the CEO accepted). */
    source: text("source").notNull(),
    /** For `request`: who asked, and on which ticket; for `ticket`, the ticket the owner wrote on. */
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_notes_agent").on(t.agentId, t.createdAt)],
);

export const noteRequestStatus = pgEnum("note_request_status", ["pending", "accepted", "declined"]);

/** Another agent asking the CEO to keep a note (BOS-85): only the CEO's accept writes one. */
export const noteRequests = pgTable(
  "note_requests",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The CEO it's for. */
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    requestedByAgentId: uuid("requested_by_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    text: text("text").notNull(),
    why: text("why").notNull(),
    status: noteRequestStatus("status").notNull().default("pending"),
    declineReason: text("decline_reason"),
    noteId: uuid("note_id").references(() => agentNotes.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("note_requests_agent_status").on(t.agentId, t.status), index("note_requests_requester_time").on(t.requestedByAgentId, t.createdAt)],
);

/** What the PA did with each owner question (R87): posted, or escalated to the CEO with why; the CEO may mark it right or wrong. */
export const paAnswers = pgTable(
  "pa_answers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    chatMessageId: uuid("chat_message_id").notNull().references(() => ownerChatMessages.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    reply: text("reply"),
    cites: jsonb("cites").$type<Array<{ kind: "ticket" | "decision" | "run"; id: string }>>().notNull().default([]),
    /** "posted" or "escalated:<reason>". */
    outcome: text("outcome").notNull(),
    /** Picked for the CEO's audit list. */
    sampled: boolean("sampled").notNull().default(false),
    /** The copy of an escalated question in the CEO's chat, and when its answer was passed back. */
    ceoMessageId: uuid("ceo_message_id").references(() => ownerChatMessages.id, { onDelete: "set null" }),
    ceoRepliedAt: timestamp("ceo_replied_at", { withTimezone: true }),
    verdict: text("verdict"),
    verdictNote: text("verdict_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pa_answers_one_per_message").on(t.chatMessageId), index("pa_answers_company_time").on(t.companyId, t.createdAt)],
);

export const ticketMessageAuthor = pgEnum("ticket_message_author", ["owner", "agent", "system"]);

/** A ticket's conversation (R65): the owner and the agents working it talk on the ticket. */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    author: ticketMessageAuthor("author").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The run that wrote it (agent), or that it was sent into or woke (owner). */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    /** How an owner message reached an agent: into a live run, as a new run, or not yet. */
    delivery: text("delivery"),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_messages_ticket_time").on(t.ticketId, t.createdAt)],
);

/**
 * An owner message on a ticket that is waiting for an answer (BOS-425). One row per message; it
 * stays open until an agent replies on the ticket, the owner's message needs no reply, or the
 * CEO has answered on the target's behalf. `state` is what the ticket shows under the message.
 */
export const ownerReplies = pgTable(
  "owner_replies",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => ticketMessages.id, { onDelete: "cascade" }),
    /** Who the owner wrote to: the agent working the ticket, or the one they picked. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** How it reached them: "delivered" into a live run or woken now, or "queued" behind their other work. */
    state: text("state").notNull(),
    /** The run it went into, if any. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** Reminders sent so far: 1 the top-priority one after a run ended without a reply, then the 5 and 10 minute ones. */
    reminders: integer("reminders").notNull().default(0),
    /** Set when it is not the target but a stand-in who answered, or who was asked to (the CEO, or the Scrum Master). */
    standInAgentId: uuid("stand_in_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The CEO/SM alert raised at 10 minutes, if any (BOS-425). */
    alertDecisionId: uuid("alert_decision_id").references(() => decisions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Set when an agent replied on the ticket (the message is answered), or the CEO answered for the target. */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by"),
  },
  (t) => [index("owner_replies_open").on(t.companyId, t.clearedAt, t.createdAt)],
);

// ---------- Feature requests ----------

export const featureStatus = pgEnum("feature_status", ["idea", "considering", "planned", "in_progress", "released", "declined"]);
export const importance = pgEnum("importance", ["nice_to_have", "important", "critical"]);
export const noteSource = pgEnum("note_source", ["owner", "chat", "agent", "portal", "email", "import"]);
export const noteState = pgEnum("note_state", ["unprocessed", "processed", "archived"]);

/** Per company: how features are prioritised, whether the CEO triages feedback, and the portal. */
export const feedbackSettings = pgTable("feedback_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  /** How much demand counts against the criteria, 0 to 10. */
  demandWeight: integer("demand_weight").notNull().default(3),
  ceoTriage: boolean("ceo_triage").notNull().default(false),
  portalEnabled: boolean("portal_enabled").notNull().default(false),
  /** The secret part of the portal's link. Rotating it ends the old link. */
  portalToken: text("portal_token").unique(),
  portalTitle: text("portal_title"),
  portalIntro: text("portal_intro"),
  /** The logo beside the portal heading: png, jpeg or webp bytes, checked on upload. */
  portalLogo: bytea("portal_logo"),
  portalLogoType: text("portal_logo_type"),
});

/** A criterion features are scored on, 0 to 5, e.g. "Fits the mission". */
export const featureDrivers = pgTable("feature_drivers", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  weight: integer("weight").notNull().default(1),
  position: integer("position").notNull().default(0),
});

export const featureAreas = pgTable("feature_areas", {
  id: id(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
});

export const features = pgTable(
  "features",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    areaId: uuid("area_id").references(() => featureAreas.id, { onDelete: "set null" }),
    /** A subfeature's parent. One level only. */
    parentId: uuid("parent_id").references((): AnyPgColumn => features.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: featureStatus("status").notNull().default("idea"),
    /** 1 (tiny) to 5 (huge); null until someone sizes it. */
    effort: integer("effort"),
    /** A person's ranking, 1 (most important) to 5; null until ranked. Separate from the computed priority. */
    rank: integer("rank"),
    /** Pinned to the Now / Next / Later roadmap column; null places it from its status and work. */
    horizon: roadmapHorizon("horizon"),
    /** Driver id to score, 0 to 5. */
    driverScores: jsonb("driver_scores").notNull().default({}),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    /** Linked to a whole objective instead of one of its milestones. */
    objectiveId: uuid("objective_id").references(() => objectives.id, { onDelete: "set null" }),
    portalVisible: boolean("portal_visible").notNull().default(false),
    /** A plain-language summary for readers outside the team; null until written. */
    publicSummary: text("public_summary"),
    /** Off by default; nothing is published anywhere until a later public roadmap uses it. */
    showPublicly: boolean("show_publicly").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /** When to ask whether the released feature moved its goal. Set once, on the first release, and never again. */
    goalCheckDueAt: timestamp("goal_check_due_at", { withTimezone: true }),
    /** Set when that question has been put to the owner. */
    goalCheckRaisedAt: timestamp("goal_check_raised_at", { withTimezone: true }),
    /** The owner's answer: Keep, Change or Drop. */
    goalCheckAnswer: text("goal_check_answer"),
    goalCheckAnsweredAt: timestamp("goal_check_answered_at", { withTimezone: true }),
  },
  (t) => [index("features_company").on(t.companyId, t.status)],
);

/** The people (or other companies) feedback comes from. */
export const feedbackCustomers = pgTable(
  "feedback_customers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    segment: text("segment"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("feedback_customers_name").on(t.companyId, sql`lower(${t.name})`)],
);

/** A piece of feedback, as it arrived. Passages of it are linked to features as insights. */
export const feedbackNotes = pgTable(
  "feedback_notes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    text: text("text").notNull(),
    source: noteSource("source").notNull().default("owner"),
    customerId: uuid("customer_id").references(() => feedbackCustomers.id, { onDelete: "set null" }),
    state: noteState("state").notNull().default("unprocessed"),
    /** From outside: the portal, or relayed by an agent. Agents see it marked as untrusted. */
    untrusted: boolean("untrusted").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The portal visitor who sent it, so a repeat vote updates rather than adds. */
    portalVoter: text("portal_voter"),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("feedback_notes_company_state").on(t.companyId, t.state, t.createdAt)],
);

/** A link from (a passage of) a note to a feature, with how much it matters to them. */
export const insights = pgTable(
  "insights",
  {
    id: id(),
    noteId: uuid("note_id").notNull().references(() => feedbackNotes.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id").notNull().references(() => features.id, { onDelete: "cascade" }),
    importance: importance("importance").notNull().default("important"),
    highlight: text("highlight"),
    /** "the owner", an agent's name, or "portal". */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("insights_note_feature").on(t.noteId, t.featureId), index("insights_feature").on(t.featureId)],
);

// ---------- Wiki and what tickets produce (R69) ----------

/** The company's wiki: Markdown pages the owner and agents write and keep up to date. */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The page's address: its folders and name, lower-case and hyphenated ("research/agent-landscape"); unique within the company. */
    slug: text("slug").notNull(),
    /** The folders it sits in, as written ("Research/Competitors"); empty at the top level. */
    folder: text("folder").notNull().default(""),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The ticket the page was first written for, if any. */
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    /** Who last changed it: an agent, or the owner when null. */
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wiki_pages_company_slug").on(t.companyId, t.slug),
    // Full-text search (wiki.search); the query must use this exact expression to hit the index.
    index("wiki_pages_fts").using("gin", sql`to_tsvector('english', ${t.title} || ' ' || ${t.body})`),
  ],
);

/** Every saved version of a page, newest last, so a change can be seen and undone. */
export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: id(),
    pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("wiki_revisions_page_time").on(t.pageId, t.createdAt)],
);

/** Per company: optional semantic wiki search. Off by default; the API key is a secret in the encrypted store. */
export const wikiSemanticSettings = pgTable("wiki_semantic_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  baseUrl: text("base_url").notNull().default("https://openrouter.ai/api/v1"),
  model: text("model").notNull().default("google/gemini-embedding-001"),
  dims: integer("dims").notNull().default(768),
  secretId: uuid("secret_id").references(() => secrets.id, { onDelete: "set null" }),
});

/** One embedding per wiki section. Searched exactly (no index); add an HNSW index on embedding with vector_cosine_ops when sections number in the hundreds of thousands. */
export const wikiSectionEmbeddings = pgTable(
  "wiki_section_embeddings",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").notNull().references(() => wikiPages.id, { onDelete: "cascade" }),
    sectionPath: text("section_path").notNull(),
    /** sha256 of model, dims, path and text: unchanged means no need to embed again. */
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wiki_section_embeddings_page_path").on(t.pageId, t.sectionPath), index("wiki_section_embeddings_company").on(t.companyId)],
);

export const artifactKind = pgEnum("artifact_kind", ["wiki_page", "repo_file", "url"]);

/** What a ticket produced: a wiki page, a file in the repo, or a link, shown on the ticket. */
export const ticketArtifacts = pgTable(
  "ticket_artifacts",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    kind: artifactKind("kind").notNull(),
    title: text("title").notNull(),
    wikiPageId: uuid("wiki_page_id").references(() => wikiPages.id, { onDelete: "cascade" }),
    /** repo_file: the path in the repo, and the branch or commit it's on. */
    path: text("path"),
    ref: text("ref"),
    url: text("url"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_artifacts_ticket").on(t.ticketId), uniqueIndex("ticket_artifacts_one_page").on(t.ticketId, t.wikiPageId)],
);

/** A short log of what changed in a company, for the brief every agent gets at a wake (R83). */
export const activity = pgTable(
  "activity",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Who did it; null for the owner or Boss Man. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    /**
     * The full record behind a summary that has to be shortened, such as both sides of a skill edit
     * (BOS-178). Null when the summary says all there is.
     */
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
  },
  (t) => [index("activity_company_at").on(t.companyId, t.at)],
);

// ---------- Scrum Master watchdog (BOS-58) ----------

/**
 * One row per episode of a rule tripping on a ticket: opened when it first trips, closed when it
 * clears. due_at is when it may next be handed to anyone, so a handled ticket isn't re-flagged
 * until its limit passes again. Read by the activity view, health indicator and daily summary.
 */
export const watchdogFlags = pgTable(
  "watchdog_flags",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    /** One of WATCHDOG_RULES. */
    rule: text("rule").notNull(),
    /** open or closed. */
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    lastFlaggedAt: timestamp("last_flagged_at", { withTimezone: true }),
    /** Times handed to the Scrum Master. */
    flagCount: integer("flag_count").notNull().default(0),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozeReason: text("snooze_reason"),
    /** Snoozes in a row in this episode; after two, the next time it is due it goes to the CEO. */
    snoozeCount: integer("snooze_count").notNull().default(0),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** Hand-offs in a row with nothing happening on the ticket in between; each doubles the wait before the next (BOS-121). */
    backoffSteps: integer("backoff_steps").notNull().default(0),
    /** The facts when it last tripped: idleMs, limitMs, runId, runOutcome, decisionId, holds, bounces. */
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [
    uniqueIndex("watchdog_flags_one_open").on(t.ticketId, t.rule).where(sql`${t.status} = 'open'`),
    index("watchdog_flags_company").on(t.companyId, t.status),
  ],
);

/** Everything the watchdog and the Scrum Master did, each with a one-line reason and what undo needs. */
export const watchdogActions = pgTable(
  "watchdog_actions",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    flagId: uuid("flag_id").references(() => watchdogFlags.id, { onDelete: "set null" }),
    /** The Scrum Master; null when Boss Man did it (a sweep wake, an owner reminder, a trip). */
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The Scrum Master's run that did it. */
    actorRunId: uuid("actor_run_id"),
    /** One of WATCHDOG_ACTIONS. */
    kind: text("kind").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    undoable: boolean("undoable").notNull().default(false),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneByActionId: uuid("undone_by_action_id"),
    createdAt: createdAt(),
  },
  (t) => [index("watchdog_actions_company_at").on(t.companyId, t.createdAt), index("watchdog_actions_ticket").on(t.ticketId)],
);

// ---------- Skills (R71) ----------

export const skillSource = pgEnum("skill_source", ["written", "link", "upload", "retro"]);

/**
 * A company's skill library: Agent Skills folders (a SKILL.md and any supporting files) that
 * agents load when relevant. Added from a GitHub link (pinned to a commit), written in Boss
 * Man, or uploaded.
 */
export const skills = pgTable(
  "skills",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The folder name agents see: lower-case letters, digits and hyphens. */
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: skillSource("source").notNull(),
    /** Where a linked skill came from, and the commit it's pinned to. */
    sourceUrl: text("source_url"),
    sourceRef: text("source_ref"),
    /** Skills added together from one link form a pack (e.g. "obra/superpowers"), given and updated as one. */
    pack: text("pack"),
    packUrl: text("pack_url"),
    /** The folder's files, SKILL.md first; content is base64 so scripts and images survive. */
    files: jsonb("files").$type<Array<{ path: string; content: string }>>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Runner add-ons the skill needs (docs/12); it is left out of runs whose runner lacks one. */
    requiresAddons: jsonb("requires_addons").$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skills_company_name").on(t.companyId, t.name)],
);

export type SkillFinding = { file: string; lineStart: number; lineEnd: number; title: string; severity: "critical" | "high" | "medium" | "low"; confidence: "confirmed" | "likely"; behaviour: string; harm: string; fix: string; blocks: boolean };

/** A skill the CEO proposes (own draft or internet link). Nothing here is in the library until the owner decides; the install step is the only writer to skills. */
export const skillProposals = pgTable(
  "skill_proposals",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source").$type<"draft" | "link" | "retro">().notNull(),
    sourceUrl: text("source_url"),
    /** For a link: the commit the files were read at. Install re-reads this exact commit, never a branch. */
    pinnedRef: text("pinned_ref"),
    /** The reviewed bytes (base64), kept so install writes exactly what the reviewer saw. */
    files: jsonb("files").$type<Array<{ path: string; content: string }>>().notNull(),
    /** sha256 hex per file path, and over the whole sorted set. */
    fileHashes: jsonb("file_hashes").$type<Record<string, string>>().notNull(),
    bundleHash: text("bundle_hash").notNull(),
    why: text("why").notNull(),
    proposedAgentIds: jsonb("proposed_agent_ids").$type<string[]>().notNull().default([]),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Set: this proposal is a new version of that installed skill. */
    replacesSkillId: uuid("replaces_skill_id").references(() => skills.id, { onDelete: "set null" }),
    /** Fingerprint of the skill this replaces when the proposal was made: install refuses if it was edited since. */
    replacesBundleHash: text("replaces_bundle_hash"),
    /** Worked out by the system from the files, never taken from the CEO. */
    hasScripts: boolean("has_scripts").notNull(),
    scriptFiles: jsonb("script_files").$type<string[]>().notNull().default([]),
    reviewRequired: boolean("review_required").notNull(),
    status: text("status").$type<"proposed" | "in_review" | "awaiting_owner" | "installed" | "rejected" | "stale" | "expired">().notNull().default("proposed"),
    reviewTicketId: uuid("review_ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    verdict: text("verdict").$type<"recommend" | "conditions" | "advise_against">(),
    verdictSummary: text("verdict_summary"),
    findings: jsonb("findings").$type<SkillFinding[]>(),
    conditions: jsonb("conditions").$type<string[]>(),
    /** Bundle hash the verdict was given for; must equal bundleHash to count. */
    reviewedBundleHash: text("reviewed_bundle_hash"),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    overridden: boolean("overridden").notNull().default(false),
    overriddenBy: text("overridden_by"),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    installedSkillId: uuid("installed_skill_id").references(() => skills.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One open proposal per name.
    uniqueIndex("skill_proposals_open_name").on(t.companyId, t.name).where(sql`status in ('proposed','in_review','awaiting_owner')`),
  ],
);

/** Which agents have which skills, and who gave them. */
export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    /** The owner, or the CEO (an agent id). */
    assignedByAgentId: uuid("assigned_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

/** Extra MCP servers a company's agents can use. The token stays in the secret store: secret_env names the granted secret. */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    transport: text("transport").$type<"http" | "sse">().notNull(),
    headerName: text("header_name").notNull().default("Authorization"),
    /** {secret} is replaced by the runner with the value of secret_env. */
    headerValue: text("header_value").notNull().default("Bearer {secret}"),
    secretEnv: text("secret_env"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_servers_company_name").on(t.companyId, t.name)],
);

/** The picture the owner uploaded for an agent: png, jpeg or webp bytes, checked on upload. Kept apart so agent rows stay small. */
/** Images attached to a ticket, such as a tester's screenshots (PNG, JPEG or WebP, checked by their bytes). */
export const ticketImages = pgTable(
  "ticket_images",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Null for an image the owner pasted into a chat or a new task's description before it existed. */
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    /** The file name it was saved under, e.g. issue-003-step-2.png. */
    name: text("name").notNull(),
    caption: text("caption"),
    type: text("type").notNull(),
    size: integer("size").notNull(),
    bytes: bytea("bytes").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_images_ticket").on(t.ticketId)],
);

export const agentAvatars = pgTable("agent_avatars", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  bytes: bytea("bytes").notNull(),
  type: text("type").notNull(),
  /** The ticket image the CEO picked (BOS-265): copies are shared by it, so agents sharing a picture keep one copy. Null for one the owner uploaded. */
  imageId: uuid("image_id").references(() => ticketImages.id, { onDelete: "set null" }),
});
