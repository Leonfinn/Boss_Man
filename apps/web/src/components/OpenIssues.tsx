import { api } from "../api";
import { usePoll } from "../hooks";
import { when } from "../pages/Runs";
import { Loader } from "./Loader";

export type OpenIssue = {
  id: string;
  source: "flag" | "alert";
  ticketId: string;
  ticketRef: string | null;
  ticketTitle: string;
  warning: string;
  rule: string | null;
  holder: "scrum_master" | "ceo" | "owner";
  since: string;
  done: Array<{ label: string; reason: string; at: string }>;
  nextAt: string | null;
  nextText: string;
  openedAt: string;
};

const HOLDER: Record<OpenIssue["holder"], string> = { scrum_master: "the Scrum Master", ceo: "the CEO", owner: "you" };

/** Every warning the health badge counts, with who has it and what happens next. */
export function OpenIssues({ companyId }: { companyId: string }) {
  const issues = usePoll((signal) => api<OpenIssue[]>(`/api/companies/${companyId}/watchdog/issues`, { signal }), 15_000, `watchdog-issues-${companyId}`);
  const rows = Array.isArray(issues.data) ? issues.data : [];
  return (
    <section id="open-now" aria-label="Open now" style={{ scrollMarginTop: 16, marginBottom: 24 }}>
      <h2 className="section-label">Open now{issues.data ? ` (${rows.length})` : ""}</h2>
      {!issues.data ? (
        <Loader label="Loading open issues" />
      ) : !rows.length ? (
        <p className="muted">Nothing open</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((issue) => (
            <li key={issue.id} className="card" style={{ padding: "10px 14px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                {issue.ticketRef && <a href={`#/tickets/${issue.ticketId}`}>{issue.ticketRef}</a>}
                <strong style={{ fontWeight: 600 }}>{issue.ticketTitle}</strong>
                <span style={{ marginLeft: "auto", fontSize: 13 }} className="muted">
                  {issue.warning}
                </span>
              </div>
              <p style={{ margin: "4px 0" }}>With {HOLDER[issue.holder]} since {when(issue.since)}.</p>
              <p style={{ margin: "4px 0" }}>
                Done so far: {issue.done.length ? issue.done.map((d) => `${d.label} at ${when(d.at)}: ${d.reason}`).join("; ") : "nothing yet."}
              </p>
              <p style={{ margin: "4px 0" }}>Next: {issue.nextText}{issue.nextAt ? ` at ${when(issue.nextAt)}` : ""}.</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
