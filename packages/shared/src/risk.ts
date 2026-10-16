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
