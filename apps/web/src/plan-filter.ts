import type { Plan, PlanNode } from "./api";
import { buildCsv } from "./csv";

/** The Plan page's filters. An empty string means "any". */
export type PlanFilter = { project: string; assignee: string; kind: "" | PlanNode["kind"]; finished: boolean };

export const NO_PLAN_FILTER: PlanFilter = { project: "", assignee: "", kind: "", finished: false };
/** The assignee filter value for items nobody holds. */
export const UNASSIGNED = "__none__";

const KINDS = ["ticket", "engagement", "decision"] as const;

/** Reads the filters from a page link's query (e.g. "#/plan?project=Web&finished=1"). */
export function parsePlanFilter(q: URLSearchParams): PlanFilter {
  const kind = q.get("kind") ?? "";
  return {
    project: q.get("project") ?? "",
    assignee: q.get("assignee") ?? "",
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as PlanFilter["kind"]) : "",
    finished: q.get("finished") === "1",
  };
}

/** The query text for a filter ("" when nothing is set), without a leading "?". */
export function planFilterQuery(f: PlanFilter): string {
  const q = new URLSearchParams();
  if (f.project) q.set("project", f.project);
  if (f.assignee) q.set("assignee", f.assignee);
  if (f.kind) q.set("kind", f.kind);
  if (f.finished) q.set("finished", "1");
  return q.toString();
}

export function matchesPlanFilter(n: PlanNode, f: PlanFilter): boolean {
  if (!f.finished && !n.open) return false;
  if (f.project && n.project !== f.project) return false;
  if (f.assignee && (f.assignee === UNASSIGNED ? n.assignee !== null : n.assignee !== f.assignee)) return false;
  if (f.kind && n.kind !== f.kind) return false;
  return true;
}

export type FilteredPlan = {
  /** The plan to draw: shown items plus the faded ones that explain their waits. */
  plan: Plan;
  /** Items that match the filters. */
  shown: PlanNode[];
  /** Ids drawn faded: hidden by a filter but named as the cause of a shown item's wait. */
  faded: Set<string>;
};

export function applyPlanFilter(plan: Plan, f: PlanFilter): FilteredPlan {
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const shown = plan.nodes.filter((n) => matchesPlanFilter(n, f));
  const keep = new Set(shown.map((n) => n.id));
  const faded = new Set<string>();
  for (const n of shown) {
    if (!n.blocked) continue;
    for (const c of n.causes) {
      if (!keep.has(c) && byId.has(c)) faded.add(c);
    }
  }
  for (const id of faded) keep.add(id);
  const columns = plan.columns.map((col) => col.filter((id) => keep.has(id))).filter((col) => col.length);
  return {
    plan: { ...plan, nodes: plan.nodes.filter((n) => keep.has(n.id)), edges: plan.edges.filter((e) => keep.has(e.from) && keep.has(e.to)), columns },
    shown,
    faded,
  };
}

export type PersonRow = { assignee: string; open: number; blocked: number; holdingUp: number };

/** One row per assignee with open items, the one holding the most work up first. */
export function personSummary(nodes: PlanNode[]): PersonRow[] {
  const rows = new Map<string, PersonRow>();
  for (const n of nodes) {
    if (!n.open) continue;
    const key = n.assignee ?? UNASSIGNED;
    const r = rows.get(key) ?? { assignee: key, open: 0, blocked: 0, holdingUp: 0 };
    r.open += 1;
    if (n.blocked) r.blocked += 1;
    r.holdingUp += n.holdingUp;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.holdingUp - a.holdingUp || b.open - a.open || a.assignee.localeCompare(b.assignee));
}

/** The items as a CSV: ref, title, kind, state, assignee, project, blocked, holding up. */
export function planToCsv(nodes: PlanNode[]): string {
  return buildCsv(
    ["Ref", "Title", "Kind", "State", "Assignee", "Project", "Blocked", "Holding up"],
    nodes.map((n) => [n.ref ?? "", n.title, n.kind, n.state, n.assignee ?? "", n.project ?? "", n.blocked ? "yes" : "no", n.holdingUp]),
  );
}
