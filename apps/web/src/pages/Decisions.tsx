import { useState } from "react";
import { api, type Company, type Decision } from "../api";
import { art } from "../brand";
import { State } from "../components/State";

const KIND: Record<string, { label: string; tone: string }> = {
  permission: { label: "Permission", tone: "" },
  budget: { label: "Budget", tone: "blue" },
  engagement: { label: "Engagement", tone: "green" },
  approval: { label: "Approval", tone: "blue" },
  plan: { label: "Plan", tone: "blue" },
  stale_blocker: { label: "Stale blocker", tone: "amber" },
  stalled_run: { label: "Stalled run", tone: "amber" },
  question: { label: "Question", tone: "" },
  deploy: { label: "Production deploy", tone: "red" },
};

function kindOf(d: Decision) {
  const ctx = (d as Decision & { context?: { type?: string } }).context;
  const key = ctx?.type === "deploy" ? "deploy" : d.options.includes("Approve plan") ? "plan" : d.kind;
  return KIND[key] ?? { label: d.kind.replace(/_/g, " "), tone: "" };
}

export function Decisions({ decisions, companies, loaded, agentsWorking, onAnswered }: { decisions: Decision[]; companies: Company[]; loaded: boolean; agentsWorking: number; onAnswered: () => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The owner's own answer to an agent's question, being written; absent while not.
  const [ownWords, setOwnWords] = useState<Record<string, string>>({});

  const shown = decisions.filter((d) => !filter || d.companyId === filter);
  const open = shown.filter((d) => !answered[d.id]);
  const answer = async (d: Decision, option: string, custom = false) => {
    setBusy(d.id);
    try {
      const note = notes[d.id]?.trim();
      await api(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: option, ...(note ? { note } : {}), ...(custom ? { custom: true } : {}) } });
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
                    <h2 style={{ whiteSpace: "pre-wrap" }}>{d.question}</h2>
                    <div className="meta">
                      {d.blocks.length > 0 && <span>Blocks {d.blocks.length === 1 ? `"${d.blocks[0]!.title}"` : `${d.blocks.length} tickets`}</span>}
                      {d.dueDate && <span>Due {new Date(d.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
                      {d.reasons.map((r) => (
                        <span key={r}>{r}</span>
                      ))}
                    </div>
                    {d.context?.planText && (
                      <details className="plan" open={!done}>
                        <summary>The plan</summary>
                        <pre>{d.context.planText}</pre>
                      </details>
                    )}
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
                        {d.options.some((o) => o === "Keep planning" || o === "Send it back") && (
                          <div className="field">
                            <label htmlFor={`note-${d.id}`}>Note for the agent (if you send it back)</label>
                            <textarea id={`note-${d.id}`} rows={2} value={notes[d.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))} />
                          </div>
                        )}
                        {ownWords[d.id] === undefined ? (
                          <div className="actions">
                            {d.options.map((o) => (
                              <button type="button" key={o} className={`btn${o === d.recommendedOption ? " primary" : ""}`} disabled={busy === d.id} onClick={() => answer(d, o)}>
                                {o}
                              </button>
                            ))}
                            {d.kind === "question" && (
                              <button type="button" className="btn" disabled={busy === d.id} onClick={() => setOwnWords((w) => ({ ...w, [d.id]: d.recommendedOption ?? "" }))}>
                                Write my own answer
                              </button>
                            )}
                          </div>
                        ) : (
                          <form
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              const text = ownWords[d.id]!.trim();
                              if (text) void answer(d, text, true);
                            }}
                          >
                            <div className="field">
                              <label htmlFor={`own-${d.id}`}>Your answer, in your own words. It goes to {d.agentName ?? "the agent"} exactly as you write it.</label>
                              <textarea
                                id={`own-${d.id}`}
                                rows={5}
                                maxLength={4000}
                                autoFocus
                                value={ownWords[d.id]}
                                onChange={(e) => setOwnWords((w) => ({ ...w, [d.id]: e.target.value }))}
                                style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
                              />
                            </div>
                            <div className="actions">
                              <button type="submit" className="btn primary" disabled={busy === d.id || !ownWords[d.id]!.trim()}>
                                Send my answer
                              </button>
                              <button type="button" className="btn" onClick={() => setOwnWords(({ [d.id]: _, ...rest }) => rest)}>
                                Back to the options
                              </button>
                            </div>
                          </form>
                        )}
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
