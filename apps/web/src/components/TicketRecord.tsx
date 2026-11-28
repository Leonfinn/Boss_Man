import { api, usd } from "../api";
import { useHasCode, usePoll } from "../hooks";
import { ago } from "../pages/Dashboard";

type Record_ = {
  runs: { total: number; errored: number };
  spendMicros: number;
  capMicros: number | null;
  lastCheck: { result: "pass" | "fail"; scope: string; at: string | null } | null;
  filesChanged: number | null;
};

/** Opens the page's "Changes" row, which holds the file list, and scrolls to it. */
function showChanges() {
  const row = [...document.querySelectorAll("details.detail-row")].find((d) => d.querySelector(".detail-title")?.textContent === "Changes") as HTMLDetailsElement | undefined;
  if (!row) return;
  row.open = true;
  row.scrollIntoView({ block: "start" });
}

/**
 * "What Boss Man recorded" (BOS-2175): the facts from Boss Man's own records, shown beside the agent's
 * own account of the work. Read-only.
 */
export function TicketRecord({ ticketId }: { ticketId: string }) {
  const rec = usePoll((signal) => api<Record_>(`/api/tickets/${ticketId}/record`, { signal }), 60_000, `record-${ticketId}`);
  const hasCode = useHasCode();
  const r = rec.data;
  if (!r || !r.runs) return rec.error ? <p className="muted" data-testid="ticket-record">What Boss Man recorded: couldn't load.</p> : null;
  const over = r.capMicros != null && r.spendMicros >= r.capMicros;
  return (
    <section className="card" aria-label="What Boss Man recorded" data-testid="ticket-record">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>What Boss Man recorded</h2>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li data-testid="record-runs">
          Runs: {r.runs.total === 0 ? "No runs yet" : `${r.runs.total}, ${r.runs.errored === 0 ? "none ended in error" : `${r.runs.errored} ended in error`}`}
        </li>
        <li data-testid="record-spend" style={over ? { color: "var(--red-ink)" } : undefined}>
          Spent so far: {usd(r.spendMicros)}
          {r.capMicros != null ? ` of ${usd(r.capMicros)}${over ? " (cap reached)" : ""}` : " (no cap set)"}
        </li>
        <li data-testid="record-check">
          Last check: {r.lastCheck ? `${r.lastCheck.result === "pass" ? "passed" : "failed"} (${r.lastCheck.scope})${r.lastCheck.at ? `, ${ago(r.lastCheck.at)}` : ""}` : "none yet"}
        </li>
        {hasCode && (
        <li data-testid="record-files">
          Files changed: {r.filesChanged == null ? "not available" : r.filesChanged}
          {r.filesChanged ? (
            <>
              {" "}
              (<button type="button" className="related-more" onClick={showChanges}>see the list</button>)
            </>
          ) : null}
        </li>
        )}
      </ul>
    </section>
  );
}
