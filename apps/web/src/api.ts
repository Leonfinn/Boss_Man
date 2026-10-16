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
  if (!res.ok) throw new ApiError(res.status, String(data.message ?? data.error ?? `HTTP ${res.status}`));
  return data as T;
}

// ---------- Shapes the screens use ----------

export type Agent = { id: string; companyId: string; name: string; role: "ceo" | "manager" | "worker"; agentKind: string; model: string | null };
export type Company = { id: string; name: string; mission: string | null; paused: boolean; agents: Agent[] };
export type Project = { id: string; companyId: string; name: string; repoUrl: string | null; defaultBranch: string };

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
  blocks: Array<{ id: string; title: string }>;
  score: number;
  parts: { blocking: number; urgency: number; age: number; liveRun: number };
  reasons: string[];
  dueDate: string | null;
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
};
export type Board = { project: Project; columns: Array<{ id: string; name: string; systemState: string; wipLimit: number | null; tickets: Ticket[] }> };

export type FundingSource = { id: string; name: string; kind: string; provider: string; monthlyGrantMicros: number | null };
export type FundingStatus = {
  source: FundingSource;
  credit: { grantMicros: number; spentMicros: number; remainingMicros: number; fractionUsed: number; cycleStart: string; cycleEnd: string } | null;
  quota: Array<{ window: string; utilization: number; resetsAt: string | null; status: string | null; overageInUse: boolean }>;
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
