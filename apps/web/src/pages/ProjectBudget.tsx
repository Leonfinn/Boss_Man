import { useState, type FormEvent } from "react";
import { api, usd, type Project } from "../api";
import { useAction } from "./settings/shared";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { Loader } from "../components/Loader";

type Tokens = { input: number; output: number };
type Spend = { tokens?: { month: Tokens; total: Tokens }; monthMicros: number; totalMicros: number; ticketCostCapMicros: number | null; monthlyCapMicros: number | null; monthStart: string; topTickets: { id: string; title: string; micros: number }[] };

const n = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Add a monthly spending limit for one project (the only screen that calls POST /api/budget-policies, BOS-1564). It then shows under Settings → Funding → Spending limits. */
export function ProjectLimitForm({ project }: { project: Project }) {
  const [usdLimit, setUsdLimit] = useState("");
  const [onLimit, setOnLimit] = useState("ask");
  const act = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      await api("/api/budget-policies", { method: "POST", body: { scopeKind: "project", scopeId: project.id, windowKind: "calendar_month", limitUsd: Number(usdLimit), onLimit } });
      setUsdLimit("");
      return "Limit added. It is listed under Settings → Funding → Spending limits.";
    });
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
      <label>
        Spending limit per month (USD)
        <input type="number" min="0" step="0.01" required value={usdLimit} onChange={(e) => setUsdLimit(e.target.value)} />
      </label>
      <label>
        At the limit
        <select value={onLimit} onChange={(e) => setOnLimit(e.target.value)}>
          <option value="ask">Ask me</option>
          <option value="pause">Pause</option>
        </select>
      </label>
      <button type="submit" disabled={act.busy || usdLimit === ""}>Add limit</button>
      {act.view}
    </form>
  );
}

/** What a project has cost: money only (subscription use isn't counted), the month being the UTC calendar month. */
export function ProjectBudget({ project }: { project: Project }) {
  const spend = usePoll((signal) => api<Spend>(`/api/projects/${project.id}/spend`, { signal }), 30_000, `spend-${project.id}`);
  const s = spend.data;
  if (spend.error && !away(spend.error)) return <p className="error" role="alert">{spend.error.message}</p>;
  if (!s) return <Loader label="Loading the budget" />;
  return (
    <>
      <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
        <div><dt className="muted">This month</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.monthMicros)}</dd></div>
        <div><dt className="muted">All time</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.totalMicros)}</dd></div>
        <div><dt className="muted">Cap per task</dt><dd style={{ fontSize: 24, margin: 0 }}>{s.ticketCostCapMicros ? usd(s.ticketCostCapMicros) : "None"}</dd></div>
      </dl>
      {s.monthlyCapMicros ? (
        <div>
          <label htmlFor="month-cap">{usd(s.monthMicros)} of the {usd(s.monthlyCapMicros)} monthly cap</label>
          <progress id="month-cap" style={{ display: "block", width: "100%" }} max={s.monthlyCapMicros} value={Math.min(s.monthMicros, s.monthlyCapMicros)} />
          {s.monthMicros >= s.monthlyCapMicros && <small role="status">Cap reached: no new runs start for this project until next month or you raise it.</small>}
        </div>
      ) : (
        <p className="muted">No monthly cap. Set one on the Config tab.</p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>Money is pay-as-you-go and API credit only: runs paid from a subscription (such as Claude Max) cost nothing extra, so they aren't in these figures and caps don't stop them. The month is the calendar month (UTC). Set the caps on the Config tab.</p>
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
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Most expensive tasks</h2>
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
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Spending limit</h2>
      <ProjectLimitForm project={project} />
    </>
  );
}
