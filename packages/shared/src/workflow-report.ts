// Shapes of the workflow scorecard figures that the Workflow report's findings card reads (BOS-1883, BOS-1936).

/** The figures for a group of finished tickets: a role's row, or the whole team's. */
export type WorkflowStats = {
  done: number;
  firstPassRate: number | null;
  meanRework: number | null;
  medianCycleMs: number | null;
  costPerDoneMicros: number | null;
  ownCostPerDoneMicros: number | null;
  watchdogFlags: number;
  overrideShare: number | null;
  answered: number;
};

/** How long work waits when it passes from one role to another. */
export type WorkflowHandoff = { from: string; to: string; kind: "assign" | "review"; count: number; medianWaitMs: number | null; bounceRate: number | null };

/** The window just before the chosen one (now minus 2N days to now minus N days): only what the findings compare against. */
export type WorkflowPrevious = { overall: WorkflowStats; handoffs: WorkflowHandoff[] };
