// Plain words for one stored permission decision on the Run page (BOS-2185).
export type PermissionRow = {
  id: string;
  at: string;
  title: string | null;
  kind: string | null;
  rule: string;
  position: number;
  outcome: string;
  tier: string;
  answeredBy: string | null;
  answeredAt: string | null;
};

/** Where it ended up: the tier wins over the rule's outcome (a paused CEO's cards go to the owner). */
export function permissionOutcome(row: Pick<PermissionRow, "outcome" | "tier">): string {
  const where = row.tier || row.outcome;
  if (where === "allow") return "Allowed";
  if (where === "deny") return "Refused";
  if (where === "ceo") return "Asked the CEO";
  if (where === "owner") return "Asked you";
  return where;
}

/** The rule that matched, or "no rule: asked" when nothing listed matched and it went to a card. */
export function permissionRule(row: Pick<PermissionRow, "rule" | "position" | "outcome" | "tier">): string {
  const asked = row.tier === "ceo" || row.tier === "owner";
  if (asked && row.position === 0) return "no rule: asked";
  return row.rule || (asked ? "no rule: asked" : "");
}

export function permissionAnsweredBy(row: Pick<PermissionRow, "tier" | "answeredBy">): string {
  const asked = row.tier === "ceo" || row.tier === "owner";
  if (!asked) return "";
  if (row.answeredBy === "owner") return "You";
  if (row.answeredBy === "ceo") return "The CEO";
  return row.answeredBy ?? "Not answered yet";
}
