import { useState, type FormEvent } from "react";
import { api, usd, type Project } from "../api";
import { useAction } from "./settings/shared";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { Loader } from "../components/Loader";

type Tokens = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
type Spend = { tokens?: { month: Tokens; total: Tokens }; monthMicros: number; totalMicros: number; ticketCostCapMicros: number | null; monthlyCapMicros: number | null; monthStart: string; plan?: { provider: string; monthRuns: number; totalRuns: number; monthMicros: number; totalMicros: number }[]; topTickets: { id: string; title: string; micros: number; planMicros: number }[] };
const PROVIDER_NAMES: Record<string, string> = { anthropic: "Claude", openai: "Codex", synthetic: "Synthetic" };

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

/** What a project has cost on API and credit runs (subscription runs aren't in the dollar figures), the month being the UTC calendar month. */
export function ProjectBudget({ project }: { project: Project }) {
  const spend = usePoll((signal) => api<Spend>(`/api/projects/${project.id}/spend`, { signal }), 30_000, `spend-${project.id}`);
  const s = spend.data;
  const plan = s?.plan ?? [];
  if (spend.error && !away(spend.error)) return <p className="error" role="alert">{spend.error.message}</p>;
  if (!s) return <Loader label="Loading the budget" />;
  return (
    <>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <section aria-label="Pay-as-you-go spend" style={{ flex: "1 1 280px" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Pay-as-you-go spend</h2>
          <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
            <div><dt className="muted">This month</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.monthMicros)}</dd></div>
            <div><dt className="muted">All time</dt><dd style={{ fontSize: 24, margin: 0 }}>{usd(s.totalMicros)}</dd></div>
          </dl>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>Estimates at list prices, from the accounts you pay per use (such as OpenRouter or Ollama credit).</p>
        </section>
        <section aria-label="On your subscriptions" style={{ flex: "1 1 280px" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>On your subscriptions</h2>
          {plan.length ? (
            <dl style={{ margin: 0 }}>
              {plan.map((p) => (
                <div key={p.provider} style={{ marginBottom: 6 }}>
                  <dt className="muted">{PROVIDER_NAMES[p.provider] ?? p.provider}, this month</dt>
                  <dd style={{ margin: 0 }}>
                    {p.monthRuns} {p.monthRuns === 1 ? "run" : "runs"}
                    {p.totalMicros > 0 ? <> · <span className="muted">about </span><span className="mono">{usd(p.monthMicros)}</span> <span className="muted">at list prices</span></> : p.totalRuns > 0 ? <span className="muted"> · no price reported by this agent tool, so no estimate</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted" style={{ margin: 0 }}>No runs on a subscription yet.</p>
          )}
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>Plan fees aren't shown. The estimate is what the runs would have cost at list prices, not a bill. See each plan's allowance on the <a href={`#/settings/${project.companyId}/funding`}>Funding cards</a>.</p>
        </section>
      </div>
      <p style={{ margin: "8px 0 0" }}><span className="muted">Cap per task (pay-as-you-go and subscription runs together): </span><strong>{s.ticketCostCapMicros ? usd(s.ticketCostCapMicros) : "None"}</strong></p>
      {s.monthlyCapMicros ? (
        <div>
          <label htmlFor="month-cap">{usd(s.monthMicros)} of the {usd(s.monthlyCapMicros)} monthly cap (API and credit runs only)</label>
          <progress id="month-cap" style={{ display: "block", width: "100%" }} max={s.monthlyCapMicros} value={Math.min(s.monthMicros, s.monthlyCapMicros)} />
          {s.monthMicros >= s.monthlyCapMicros && <small role="status">Cap reached: no new runs start for this project until next month or you raise it.</small>}
        </div>
      ) : (
        <p className="muted">No monthly cap. Set one on the Config tab.</p>
      )}
      <p className="muted" style={{ fontSize: 13 }}>The dollar figures are list-price estimates for API and credit runs, not a bill and not total spend. Runs paid from a subscription (such as Claude Max) are left out, and the monthly cap does not stop them. The cap per task does count subscription runs, at list prices. Extra usage or top-up bought on a subscription is not seen here. The month is the calendar month (UTC). Set the caps on the Config tab.</p>
      {s.tokens && (
        <>
          <h2 style={{ fontSize: 16, marginTop: 24 }}>Tokens</h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Every run on this project's tasks, subscription runs included. "In" is new input only; cached tokens (re-read and written prompt text) are counted on their own line, and the dollar figures include them.</p>
          <dl style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: 0 }}>
            <div><dt className="muted">This month in / out</dt><dd style={{ fontSize: 20, margin: 0 }}>{n.format(s.tokens.month.input)} / {n.format(s.tokens.month.output)}</dd><dd className="muted" style={{ fontSize: 13, margin: 0 }}>Cache read / written: {n.format(s.tokens.month.cacheRead ?? 0)} / {n.format(s.tokens.month.cacheWrite ?? 0)}</dd></div>
            <div><dt className="muted">All time in / out</dt><dd style={{ fontSize: 20, margin: 0 }}>{n.format(s.tokens.total.input)} / {n.format(s.tokens.total.output)}</dd><dd className="muted" style={{ fontSize: 13, margin: 0 }}>Cache read / written: {n.format(s.tokens.total.cacheRead ?? 0)} / {n.format(s.tokens.total.cacheWrite ?? 0)}</dd></div>
          </dl>
        </>
      )}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Costliest tasks</h2>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Pay-as-you-go spend, and on subscriptions what the runs would have cost at list prices (about). Ranked by the two together.</p>
      {s.topTickets.length ? (
        <ol>
          {s.topTickets.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`}>{t.title}</a> <span className="mono">{usd(t.micros)}</span>
              {t.planMicros > 0 && <span className="muted"> + about <span className="mono">{usd(t.planMicros)}</span> on subscriptions</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p>No spend or priced plan runs on this project's tasks yet.</p>
      )}
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Spending limit</h2>
      <ProjectLimitForm project={project} />
    </>
  );
}
