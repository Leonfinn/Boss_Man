import { api, usd, type ActiveRun, type BudgetRow, type Company, type FundingSource, type FundingStatus } from "../api";
import { art } from "../brand";
import { State } from "../components/State";
import { usePoll } from "../hooks";

const pct = (f: number) => `${Math.round(f * 100)}%`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function SourceCard({ s }: { s: FundingStatus }) {
  const kind = s.source.kind === "api_credit" ? "API credit" : s.source.kind === "subscription" ? "Subscription" : s.source.kind === "api_payg" ? "API, pay as you go" : s.source.kind;
  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby={`fs-${s.source.id}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h2 id={`fs-${s.source.id}`} style={{ fontSize: 15, fontWeight: 600 }}>
          {s.source.name}
        </h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {kind} · {s.source.provider}
        </span>
      </div>
      {s.credit ? (
        <>
          <span className="big">
            {usd(s.credit.remainingMicros)} <small>of {usd(s.credit.grantMicros)} left</small>
          </span>
          <div className={`bar${s.credit.fractionUsed >= 0.9 ? " warn" : ""}`} aria-hidden="true">
            <span style={{ width: pct(Math.min(1, s.credit.fractionUsed)) }} />
          </div>
          <span className="muted" style={{ fontSize: 13 }}>
            Resets {when(s.credit.cycleEnd)} · {usd(s.credit.spentMicros)} spent this cycle
          </span>
        </>
      ) : s.quota.length ? (
        s.quota.map((q) => (
          <div key={q.window} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{q.window === "five_hour" ? "5-hour window" : q.window === "seven_day" ? "This week" : q.window.replace(/_/g, " ")}</span>
              <span className="mono" style={{ color: q.utilization >= 0.9 ? "var(--amber-ink)" : undefined }}>
                {pct(q.utilization)}
              </span>
            </div>
            <div className={`bar${q.utilization >= 0.9 ? " warn" : ""}`} aria-hidden="true">
              <span style={{ width: pct(Math.min(1, q.utilization)) }} />
            </div>
            {q.resetsAt && (
              <span className="muted" style={{ fontSize: 12 }}>
                Resets {when(q.resetsAt)}
                {q.overageInUse ? " · using usage credits" : ""}
              </span>
            )}
          </div>
        ))
      ) : s.source.kind === "subscription" ? (
        // A subscription isn't paid per run, so there's no money to show; its quota appears after its first run.
        <span className="muted">No quota reported yet. It shows here after the first run on this subscription.</span>
      ) : (
        <span className="big">
          {usd(s.totalSpentMicros)} <small>spent through Boss Man</small>
        </span>
      )}
      {s.coverage === "boss_man_runs_only" && s.source.kind !== "subscription" && (
        <span className="muted" style={{ fontSize: 12 }}>
          Counted from Boss Man's own runs. Spend outside Boss Man isn't included: see the{" "}
          <a href="https://console.anthropic.com/settings/cost" target="_blank" rel="noreferrer">
            Console cost page
          </a>
          .
        </span>
      )}
    </section>
  );
}

export function Funding({ companies }: { companies: Company[] }) {
  const sources = usePoll(
    async (signal) => {
      const list = await api<FundingSource[]>("/api/funding-sources", { signal });
      return Promise.all(list.map((s) => api<FundingStatus>(`/api/funding-sources/${s.id}/status`, { signal })));
    },
    30_000,
    "sources",
  );
  const budgets = usePoll((signal) => api<BudgetRow[]>("/api/budgets", { signal }), 30_000, "budgets");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 10_000, "runs");
  const scopeName = (b: BudgetRow) => (b.policy.scopeKind === "instance" ? "All companies" : b.policy.scopeKind === "company" ? (companies.find((c) => c.id === b.policy.scopeId)?.name ?? "A company") : `A ${b.policy.scopeKind}`);
  const agentName = (id: string | null) => companies.flatMap((c) => c.agents).find((a) => a.id === id)?.name ?? "An agent";

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Funding</h1>
          <p className="sub">Where agent work is paid from, and how much is left this cycle.</p>
        </div>
      </header>
      {sources.data && sources.data.length === 0 ? (
        <State img={art.setup} alt="No funding sources yet" title="No funding sources yet">
          <p>Add a Claude subscription (with a setup-token) or an API key so agents have something to run on.</p>
        </State>
      ) : (
        <div className="grid-cards">{sources.data?.map((s) => <SourceCard key={s.source.id} s={s} />)}</div>
      )}

      {(budgets.data?.length ?? 0) > 0 && (
        <section aria-labelledby="budgets-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 id="budgets-h" style={{ fontSize: 18, fontWeight: 600 }}>
            Budgets
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Window</th>
                  <th scope="col">Used</th>
                  <th scope="col">At the limit</th>
                </tr>
              </thead>
              <tbody>
                {budgets.data!.map((b) => (
                  <tr key={b.policy.id}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {scopeName(b)}
                    </th>
                    <td>{b.policy.windowKind.replace(/_/g, " ")}</td>
                    <td className="mono" style={{ color: b.status.state === "ok" ? undefined : "var(--amber-ink)" }}>
                      {usd(b.status.usedMicros)} / {usd(b.status.limitMicros)} · {pct(b.status.fractionUsed)}
                    </td>
                    <td>{b.policy.onLimit === "pause" ? "Pause" : "Ask me"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="runs-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="runs-h" style={{ fontSize: 18, fontWeight: 600 }}>
          Running now
        </h2>
        {runs.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Company</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Model</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <td className="mono muted">{when(r.startedAt)}</td>
                    <td>{companies.find((c) => c.id === r.companyId)?.name}</td>
                    <td>{agentName(r.agentId)}</td>
                    <td className="mono">{r.model ?? "default"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No agents are running.</p>
        )}
      </section>
    </>
  );
}
