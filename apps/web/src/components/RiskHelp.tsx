import { api, type Risk } from "../api";
import { usePoll } from "../hooks";

export type RiskTiers = Array<{ tier: Risk; summary: string }>;

/** The shared check sentence, said once at the top of the compact levels instead of in every line (BOS-1195). */
const CHECK = /^(?:the project's check and its deeper check run before it merges|the project's check runs before it merges)$/;
const LEAD = "Sets who checks the work and how much planning comes first. Every level runs the project's check before it merges.";

/** Every level to compare in a "?" pop-over, one short line each, with this task's level marked in words (BOS-1195). */
export function RiskLevels({ tiers, current }: { tiers: RiskTiers; current: Risk | null }) {
  return (
    <div className="risk-levels">
      <p style={{ margin: "0 0 6px" }}>{LEAD}</p>
      <dl>
        {tiers.map((t) => (
          <div key={t.tier} style={{ display: "contents" }}>
            <dt>{label(t.tier)}{t.tier === current ? " (this task)" : ""}</dt>
            <dd>{shortSummary(t.summary)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A tier's summary with the shared check sentence left out, as the levels' top line already says it. */
export function shortSummary(summary: string): string {
  const parts = summary.replace(/\.$/, "").split("; ");
  return parts.map((p) => p.trim()).filter((p) => p && !CHECK.test(p)).join("; ") + ".";
}

/** The server's own description of each risk tier, fetched once per page. */
export function useRiskTiers(companyId?: string) {
  return usePoll((signal) => api<RiskTiers>(`/api/risk-tiers${companyId ? `?companyId=${companyId}` : ""}`, { signal }), 300_000, `risk-tiers-${companyId ?? ""}`).data ?? [];
}

const label = (r: string) => r[0]!.toUpperCase() + r.slice(1);

/** Under a risk picker: what the chosen tier means, and every tier to compare (R61). */
export function RiskHelp({ tiers, current }: { tiers: RiskTiers; current: Risk | null }) {
  const chosen = tiers.find((t) => t.tier === current);
  return (
    <div className="risk-help" style={{ fontSize: 13 }}>
      {chosen && <p className="muted" style={{ margin: 0 }}>{chosen.summary}</p>}
      <details>
        <summary style={{ cursor: "pointer", color: "var(--link)" }}>Compare the risk levels</summary>
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
