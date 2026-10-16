import { api, usd, type Company, type RunRow } from "../api";
import { usePoll } from "../hooks";

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** A run's result in a few words: errors and interruptions stand out. */
export function outcomeTag(outcome: string | null | undefined) {
  if (!outcome) return <span className="tag blue">Running</span>;
  if (outcome.startsWith("error")) return <span className="tag red">Failed</span>;
  if (outcome === "interrupted") return <span className="tag amber">Interrupted</span>;
  if (outcome === "cancelled") return <span className="tag">Stopped</span>;
  return <span className="tag green">Finished</span>;
}

function RunTable({ rows, companies, finished }: { rows: RunRow[]; companies: Company[]; finished: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{finished ? "Ended" : "Started"}</th>
            <th scope="col">Agent</th>
            <th scope="col">Ticket</th>
            <th scope="col">Model</th>
            <th scope="col">Result</th>
            {finished && <th scope="col" style={{ textAlign: "right" }}>Cost</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono muted">
                <a href={`#/runs/${r.id}`}>{when(finished ? r.endedAt : r.startedAt)}</a>
              </td>
              <td>
                {r.agent ?? "An agent"}
                <span className="muted"> · {companies.find((c) => c.id === r.companyId)?.name}</span>
              </td>
              <td>{r.ticket ?? <span className="muted">No ticket</span>}</td>
              <td className="mono">{r.model ?? "default"}</td>
              <td>{outcomeTag(finished ? r.outcome : null)}</td>
              {finished && <td className="mono" style={{ textAlign: "right" }}>{usd(r.costMicros ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Runs({ companies }: { companies: Company[] }) {
  const active = usePoll((signal) => api<RunRow[]>("/api/runs", { signal }), 5_000, "active");
  const recent = usePoll((signal) => api<RunRow[]>("/api/runs/recent?limit=50", { signal }), 15_000, "recent");
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="sub">Every agent session: open one to read along, send it a message or stop it.</p>
        </div>
      </header>
      <section aria-labelledby="running-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="running-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Running now
        </h2>
        {active.data?.length ? <RunTable rows={active.data} companies={companies} finished={false} /> : <p className="muted">No agents are running.</p>}
      </section>
      <section aria-labelledby="recent-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="recent-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Finished
        </h2>
        {recent.data?.length ? <RunTable rows={recent.data} companies={companies} finished /> : <p className="muted">No runs have finished yet.</p>}
      </section>
    </>
  );
}
