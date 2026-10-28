// Workflow retros (docs/19-workflow-retros.md parts 2 and 3): the fixed lists a retro and its proposals draw from.

/** Short failure labels, after the MAST taxonomy of multi-agent failures, cut down to a coding team. */
export const RETRO_FAILURES = ["unclear_spec", "missing_tests", "wrong_reviewer", "slow_review", "rework_loop", "stalled_handoff", "scope_creep", "environment"] as const;
export type RetroFailure = (typeof RETRO_FAILURES)[number];

export const RETRO_FAILURE_LABEL: Record<RetroFailure, string> = {
  unclear_spec: "The ticket was unclear",
  missing_tests: "Tests were missing or weak",
  wrong_reviewer: "The wrong person reviewed it",
  slow_review: "Review took too long",
  rework_loop: "Work went round in circles",
  stalled_handoff: "A handoff stalled",
  scope_creep: "The work grew past the ticket",
  environment: "Tools, CI or the environment got in the way",
};

export type RetroFinding = {
  failure: RetroFailure;
  handoff?: { from: string; to: string };
  /** Ticket ids (the tool takes refs or ids). */
  tickets: string[];
  count: number;
  note: string;
};

/** The settings a retro can propose changing. A hire and a plan-first setting are not here: see docs/19. */
export const WORKFLOW_LEVERS = ["playbook", "lesson", "instructions", "review_policy", "watchdog", "model", "thinking"] as const;
export type WorkflowLever = (typeof WORKFLOW_LEVERS)[number];
/** The CEO approves playbooks and brief lessons; the owner approves the rest. */
export const leverApprover = (lever: WorkflowLever): "ceo" | "owner" => (lever === "playbook" || lever === "lesson" ? "ceo" : "owner");

/** Measures the scorecard can compute again later. */
export const ROLE_METRICS = ["firstPassRate", "meanRework", "medianCycleMs", "costPerDoneMicros", "watchdogFlags"] as const;
export const HANDOFF_METRICS = ["medianWaitMs", "bounceRate"] as const;
export const COMPANY_METRICS = ["tailLagMs"] as const;
export const WORKFLOW_METRICS = [...ROLE_METRICS, ...HANDOFF_METRICS, ...COMPANY_METRICS] as const;
export type WorkflowMetric = (typeof WORKFLOW_METRICS)[number];
export type MetricScope = { role: string } | { agentId: string } | { from: string; to: string; kind: "assign" | "review" } | Record<string, never>;

/** Days a change runs before part 4 checks it. */
export const CHECK_AFTER_DAYS = 14;
