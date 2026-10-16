import { useState } from "react";
import { api, type Company, type Decision } from "../api";
import { art } from "../brand";
import { State } from "../components/State";

const KIND: Record<string, { label: string; tone: string }> = {
  permission: { label: "Permission", tone: "" },
  budget: { label: "Budget", tone: "blue" },
  engagement: { label: "Engagement", tone: "green" },
  approval: { label: "Approval", tone: "blue" },
  stale_blocker: { label: "Stale blocker", tone: "amber" },
  stalled_run: { label: "Stalled run", tone: "amber" },
  question: { label: "Question", tone: "" },
  deploy: { label: "Production deploy", tone: "red" },
};

function kindOf(d: Decision) {
  const ctx = (d as Decision & { context?: { type?: string } }).context;
  return KIND[ctx?.type === "deploy" ? "deploy" : d.kind] ?? { label: d.kind.replace(/_/g, " "), tone: "" };
}

export function Decisions({ decisions, companies, loaded, agentsWorking, onAnswered }: { decisions: Decision[]; companies: Company[]; loaded: boolean; agentsWorking: number; onAnswered: () => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const shown = decisions.filter((d) => !filter || d.companyId === filter);
  const open = shown.filter((d) => !answered[d.id]);
  const answer = async (d: Decision, option: string) => {
    setBusy(d.id);
    try {
      await api(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: option } });
      setAnswered((a) => ({ ...a, [d.id]: option }));
      setErrors(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      setErrors((e) => ({ ...e, [d.id]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="sub">
            {open.length === 1 ? "1 decision waiting" : `${open.length} decisions waiting`}
            {filter ? "" : " across all companies"}, ranked by what they unblock.
          </p>
        </div>
        {companies.length > 1 && (
          <div role="group" aria-label="Filter by company" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>
              All companies
            </button>
            {companies.map((c) => (
              <button type="button" key={c.id} className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </header>

      {loaded && shown.length === 0 ? (
        agentsWorking > 0 ? (
          <State img={art.busy} alt="Agents at work, nothing needs you" title="Nothing needs you yet">
            <p>{agentsWorking === 1 ? "1 agent is" : `${agentsWorking} agents are`} working. They'll raise a decision here when they need an answer, an approval or more budget.</p>
          </State>
        ) : (
          <State img={art.done} alt="Nothing needs you" title="Nothing needs you">
            <p>Your agents will raise a decision here when they need an answer, an approval or more budget.</p>
          </State>
        )
      ) : (
        <>
          <p className="formula">SCORE = WHAT IT BLOCKS + HOW SOON IT'S DUE + HOW LONG IT HAS WAITED</p>
          <ol className="queue">
            {shown.map((d) => {
              const k = kindOf(d);
              const total = Math.max(1, d.parts.blocking + d.parts.urgency + d.parts.age + d.parts.liveRun);
              const w = (n: number) => `${Math.round((n / total) * 48)}px`;
              const done = answered[d.id];
              return (
                <li className="decision" key={d.id}>
                  <div className="score">
                    <b style={{ color: d.score >= 60 ? "var(--ink)" : "var(--muted)" }} aria-label={`Score ${Math.round(d.score)}`}>
                      {Math.round(d.score)}
                    </b>
                    <div className="parts" aria-hidden="true">
                      <span style={{ width: w(d.parts.blocking + d.parts.liveRun), background: "var(--accent)" }} />
                      <span style={{ width: w(d.parts.urgency), background: "var(--amber)" }} />
                      <span style={{ width: w(d.parts.age), background: "#8a94a3" }} />
                    </div>
                  </div>
                  <div className="body">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <span className={`tag ${k.tone}`}>{k.label}</span>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {d.companyName}
                        {d.agentName ? ` · ${d.agentName}` : ""}
                        {d.tier === "ceo" ? " · for the CEO" : ""}
                      </span>
                    </div>
                    <h2>{d.question}</h2>
                    <div className="meta">
                      {d.blocks.length > 0 && <span>Blocks {d.blocks.length === 1 ? `"${d.blocks[0]!.title}"` : `${d.blocks.length} tickets`}</span>}
                      {d.dueDate && <span>Due {new Date(d.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
                      {d.reasons.map((r) => (
                        <span key={r}>{r}</span>
                      ))}
                    </div>
                    {done ? (
                      <p style={{ color: "var(--green-ink)", fontWeight: 500, fontSize: 14 }}>Answered: {done}.</p>
                    ) : (
                      <>
                        {d.recommendedOption && (
                          <p className="rec">
                            <strong>RECOMMENDED</strong>
                            {d.recommendedOption}
                          </p>
                        )}
                        <div className="actions">
                          {d.options.map((o) => (
                            <button type="button" key={o} className={`btn${o === d.recommendedOption ? " primary" : ""}`} disabled={busy === d.id} onClick={() => answer(d, o)}>
                              {o}
                            </button>
                          ))}
                        </div>
                        {errors[d.id] && (
                          <p className="error" role="alert">
                            {errors[d.id]}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}
