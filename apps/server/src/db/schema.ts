// Boss Man's v1 data model (docs/02-architecture.md). Every company-owned row carries
// company_id; cross-company links exist only through engagements.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
  createdAt: createdAt(),
});

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
    fundingSourceId: uuid("funding_source_id").references(() => fundingSources.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    // One CEO per company (R18).
    uniqueIndex("agents_one_ceo_per_company").on(t.companyId).where(sql`${t.role} = 'ceo'`),
  ],
);

export const runners = pgTable("runners", {
  id: id(),
  companyId: uuid("company_id").notNull().unique().references(() => companies.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  imageVersion: text("image_version"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  /** Disk use of the runner's workspaces from its last clean-up pass (R54). */
  diskUsedBytes: bigint("disk_used_bytes", { mode: "number" }),
  diskCheckedAt: timestamp("disk_checked_at", { withTimezone: true }),
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
  /** A check that must pass in a ticket's worktree before it can be merged and done (R47). */
  verifyCommand: text("verify_command"),
  /** An extra, slower check run before merging high and critical risk tickets (R48). */
  deepVerifyCommand: text("deep_verify_command"),
  /** Default spend ceiling per ticket across all its runs (R53). */
  ticketCostCapMicros: micros("ticket_cost_cap_micros"),
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

export const milestones = pgTable("milestones", {
  id: id(),
  objectiveId: uuid("objective_id").notNull().references(() => objectives.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  targetDate: date("target_date"),
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
    /** Spend ceiling across all of this ticket's runs (R53); falls back to the project's default. */
    costCapMicros: micros("cost_cap_micros"),
    /** Risk tier (R48): who reviews it, how deep the checks go, staging first. Null is medium. */
    risk: riskTier("risk"),
    /** Plan-first (R40): the agent starts in plan mode until its plan is approved. */
    planFirst: boolean("plan_first").notNull().default(false),
    plan: text("plan"),
    planApprovedAt: timestamp("plan_approved_at", { withTimezone: true }),
    customFields: jsonb("custom_fields").notNull().default({}),
    createdAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tickets_company_state").on(t.companyId, t.systemState)],
);

// ---------- Decisions and engagements ----------

export const decisionKind = pgEnum("decision_kind", ["question", "approval", "permission", "stale_blocker", "stalled_run", "engagement", "budget"]);
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
  status: decisionStatus("status").notNull().default("open"),
  answer: text("answer"),
  /** Collapses repeats, e.g. one stale-blocker row per blocker. */
  dedupeKey: text("dedupe_key").unique(),
  /** What answering it resumes, e.g. { runnerId, runId, requestId } for a permission. */
  context: jsonb("context").notNull().default({}),
  createdAt: createdAt(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
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

export const wakeStatus = pgEnum("wake_status", ["queued", "deferred", "launched", "dropped"]);

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
  (t) => [index("wakes_status_priority").on(t.status, t.priority)],
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
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  engagementId: uuid("engagement_id").references(() => engagements.id, { onDelete: "set null" }),
  acpSessionId: text("acp_session_id"),
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
});

export const fundingKind = pgEnum("funding_kind", ["api_credit", "subscription", "usage_credits", "api_payg"]);
export const provider = pgEnum("provider", ["anthropic", "openai"]);

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
