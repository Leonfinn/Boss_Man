// Risk tiers (R48). A ticket's tier sets who reviews it, how deep the checks go before it
// merges, and whether it must run in staging before production. Unrated tickets are medium.
export const RISK_TIERS = ["trivial", "low", "medium", "high", "critical"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const riskOf = (risk: RiskTier | null | undefined): RiskTier => risk ?? "medium";
const serious = (risk: RiskTier | null | undefined) => riskOf(risk) === "high" || riskOf(risk) === "critical";

/** The owner, not the CEO, approves high and critical work (and its plans). */
export const ownerReviews = serious;
/** High and critical work also passes the project's deeper check before it merges. */
export const deepChecks = serious;
/** High and critical work ships to a staging target before production. */
export const stagingFirst = serious;

/** High and critical tickets are plan-first unless set otherwise when they're created. */
export const planFirstByDefault = serious;

/** How much planning a ticket's tier asks for, as a line for the agent's prompt. */
export function planningGuidance(risk: RiskTier | null | undefined): string {
  switch (riskOf(risk)) {
    case "trivial":
      return "Planning: this is trivial. Make the change directly; no plan needed.";
    case "low":
      return "Planning: this is low risk. State your approach in a sentence, then do it.";
    case "medium":
      return "Planning: before you change anything, write a short plan in your first message: the steps, the files you expect to touch, and how you'll check it works.";
    case "high":
    case "critical":
      return "Planning: this is high risk. Your plan must cover the steps, the files, what could go wrong and how you'd undo it, and how you'll verify it, including the project's deeper check.";
  }
}

/** A CEO chapter rolls over once its context is this full, or after this many days. */
export const CHAPTER_CONTEXT_LIMIT = 0.7;
export const CHAPTER_MAX_DAYS = 7;

/** Why a CEO chapter should close, if it should. */
export function chapterDue(c: { startedAt: Date; contextUsed: number | null; contextSize: number | null; rollRequestedAt: Date | null }, now: Date): "owner" | "context" | "age" | null {
  if (c.rollRequestedAt) return "owner";
  if (c.contextUsed != null && c.contextSize && c.contextUsed / c.contextSize >= CHAPTER_CONTEXT_LIMIT) return "context";
  if (now.getTime() - c.startedAt.getTime() >= CHAPTER_MAX_DAYS * 86_400_000) return "age";
  return null;
}
