import { api, usd, type Project } from "../api";
import { usePoll } from "../hooks";

type Spend = { monthMicros: number; totalMicros: number; ticketCostCapMicros: number | null; monthStart: string; topTickets: { id: string; title: string; micros: number }[] };

/** What a project has cost: money only (subscription use isn't counted), the month being the UTC calendar month. */
export function ProjectBudget({ project }: { project: Project }) {
  const spend = usePoll((signal) => api<Spend>(`/api/projects/${project.id}/spend`, { signal }), 30_000, `spend-${project.id}`);
  const s = spend.data;
  if (spend.error) return <p className="error" role="alert">{spend.error.message}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
        <div><dt className="muted">This month</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.monthMicros)}</dd></div>
        <div><dt className="muted">All time</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.totalMicros)}</dd></div>
        <div><dt className="muted">Cap per task</dt><dd style={{ fontSize: 24, margin: 0 }}>{s.ticketCostCapMicros ? usd(s.ticketCostCapMicros) : "None"}</dd></div>
      </dl>
      <p className="muted" style={{ fontSize: 13 }}>Pay-as-you-go and API credit only; subscription use isn't money spent. The month is the calendar month (UTC). Set the cap on the Config tab.</p>
      <h2 style={{ fontSize: 16 }}>Most expensive tasks</h2>
      {s.topTickets.length ? (
        <ol>
          {s.topTickets.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`}>{t.title}</a> <span className="mono">{usd(t.micros)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p>No spend on this project's tasks yet.</p>
      )}
    </>
  );
}
