import { api, usd, type Project } from "../api";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { Loader } from "../components/Loader";

type Tokens = { input: number; output: number };
type Spend = { tokens?: { month: Tokens; total: Tokens }; monthMicros: number; totalMicros: number; ticketCostCapMicros: number | null; monthlyCapMicros: number | null; monthStart: string; topTickets: { id: string; title: string; micros: number }[] };

const n = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** What a project has cost on pay-as-you-go (plan runs aren't in the dollar figures), the month being the UTC calendar month. */
export function ProjectBudget({ project }: { project: Project }) {
  const spend = usePoll((signal) => api<Spend>(`/api/projects/${project.id}/spend`, { signal }), 30_000, `spend-${project.id}`);
  const s = spend.data;
  if (spend.error && !away(spend.error)) return <p className="error" role="alert">{spend.error.message}</p>;
  if (!s) return <Loader label="Loading the budget" />;
  return (
    <>
      <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
        <div><dt className="muted">Pay-as-you-go, this month</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.monthMicros)}</dd></div>
        <div><dt className="muted">Pay-as-you-go, all time</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.totalMicros)}</dd></div>
        <div><dt className="muted">Cap per task</dt><dd style={{ fontSize: 24, margin: 0 }}>{s.ticketCostCapMicros ? usd(s.ticketCostCapMicros) : "None"}</dd></div>
      </dl>
      {s.monthlyCapMicros ? (
        <div>
          <label htmlFor="month-cap">{usd(s.monthMicros)} of the {usd(s.monthlyCapMicros)} monthly cap (pay-as-you-go runs only)</label>
          <progress id="month-cap" style={{ display: "block", width: "100%" }} max={s.monthlyCapMicros} value={Math.min(s.monthMicros, s.monthlyCapMicros)} />
          {s.monthMicros >= s.monthlyCapMicros && <small role="status">Cap reached: no new runs start for this project until next month or you raise it.</small>}
        </div>
      ) : (
        <p className="muted">No monthly cap. Set one on the Config tab.</p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>The dollar figures count pay-as-you-go runs only, not total spend. Runs paid from a subscription plan (such as Claude Max) are left out, and the monthly cap does not stop them. The cap per task does count plan runs, at list prices. Extra usage and top-up credit bought from a provider are not seen here. The month is the calendar month (UTC). Set the caps on the Config tab.</p>
      {s.tokens && (
        <>
          <h2 style={{ fontSize: 16, marginTop: 24 }}>Tokens</h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Every run on this project's tasks, subscription runs included.</p>
          <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
            <div><dt className="muted">This month in / out</dt><dd style={{ fontSize: 20, margin: 0 }}>{n.format(s.tokens.month.input)} / {n.format(s.tokens.month.output)}</dd></div>
            <div><dt className="muted">All time in / out</dt><dd style={{ fontSize: 20, margin: 0 }}>{n.format(s.tokens.total.input)} / {n.format(s.tokens.total.output)}</dd></div>
          </dl>
        </>
      )}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Costliest tasks</h2>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Pay-as-you-go cost only; plan runs aren't counted.</p>
      {s.topTickets.length ? (
        <ol>
          {s.topTickets.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`}>{t.title}</a> <span className="mono">{usd(t.micros)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p>No pay-as-you-go spend on this project's tasks yet. Plan runs don't show here.</p>
      )}
    </>
  );
}
