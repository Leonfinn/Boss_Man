import { useState } from "react";
import { api } from "../api";
import { buildCsv, download } from "../csv";
import { hashQuery, usePoll } from "../hooks";
import { when } from "../pages/Runs";
import { Loader } from "./Loader";
import { LoadError } from "./LoadError";

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
const HOLDER_CSV: Record<OpenIssue["holder"], string> = { scrum_master: "Scrum Master", ceo: "CEO", owner: "you" };

/** The warnings as a spreadsheet: one row each, in the order shown. */
export function openIssuesCsv(rows: OpenIssue[]): string {
  return buildCsv(
    ["ticket", "title", "warning", "with", "since", "done so far", "next", "next at"],
    rows.map((i) => [i.ticketRef ?? "", i.ticketTitle, i.warning, HOLDER_CSV[i.holder], i.since, i.done.map((d) => `${d.label} at ${d.at}: ${d.reason}`).join("; "), i.nextText, i.nextAt ?? ""]),
  );
}

/** Every warning the health badge counts, with who has it and what happens next. */
export function OpenIssues({ companyId }: { companyId: string }) {
  const issues = usePoll((signal) => api<OpenIssue[]>(`/api/companies/${companyId}/watchdog/issues`, { signal }), 15_000, `watchdog-issues-${companyId}`);
  const [mine, setMine] = useState(() => hashQuery().get("mine") === "1");
  const all = Array.isArray(issues.data) ? issues.data : [];
  const withOwner = all.filter((i) => i.holder === "owner").length;
  const rows = mine ? all.filter((i) => i.holder === "owner") : all;
  const change = (on: boolean) => {
    setMine(on);
    // Keep the choice in the page link without adding history entries or re-routing.
    const params = hashQuery();
    if (on) params.set("mine", "1");
    else params.delete("mine");
    const q = params.toString();
    const base = window.location.hash.split("?")[0] || "#/scrum-master";
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${base}${q ? `?${q}` : ""}`);
  };
  return (
    <section id="open-now" aria-label="Open now" style={{ scrollMarginTop: 16, marginBottom: 24 }}>
      <h2 className="section-label">Open now{issues.data ? ` (${all.length})` : ""}</h2>
      {all.length > 0 && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", minHeight: 44 }}>
            <input type="checkbox" role="switch" checked={mine} onChange={(e) => change(e.target.checked)} /> With you only
          </label>
          <span className="muted">{withOwner} with you</span>
          <button type="button" disabled={!rows.length} onClick={() => download(`open-warnings-${new Date().toISOString().slice(0, 10)}.csv`, openIssuesCsv(rows))} style={{ marginLeft: "auto", minHeight: 44 }}>
            Download CSV
          </button>
        </div>
      )}
      {!issues.data ? (
        issues.error ? <LoadError what="the open issues" message={issues.error.message} onRetry={issues.reload} /> : <Loader label="Loading open issues" />
      ) : !all.length ? (
        <p className="muted">Nothing open</p>
      ) : !rows.length ? (
        <p className="muted">Nothing with you</p>
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
