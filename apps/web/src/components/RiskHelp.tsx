import { api, type Risk } from "../api";
import { usePoll } from "../hooks";

export type RiskTiers = Array<{ tier: Risk; summary: string }>;

/** The server's own description of each risk tier, fetched once per page. */
export function useRiskTiers() {
  return usePoll((signal) => api<RiskTiers>("/api/risk-tiers", { signal }), 3_600_000, "risk-tiers").data ?? [];
}

const label = (r: string) => r[0]!.toUpperCase() + r.slice(1);

/** Under a risk picker: what the chosen tier means, and every tier to compare (R61). */
export function RiskHelp({ tiers, current }: { tiers: RiskTiers; current: Risk }) {
  const chosen = tiers.find((t) => t.tier === current);
  return (
    <div className="risk-help" style={{ fontSize: 13 }}>
      {chosen && <p className="muted" style={{ margin: 0 }}>{chosen.summary}</p>}
      <details>
        <summary style={{ cursor: "pointer", color: "var(--accent)" }}>Compare the risk levels</summary>
        <dl style={{ margin: "6px 0 0", display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px" }}>
          {tiers.map((t) => (
            <div key={t.tier} style={{ display: "contents" }}>
              <dt style={{ fontWeight: 600 }}>{label(t.tier)}</dt>
              <dd style={{ margin: 0 }}>{t.summary}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
