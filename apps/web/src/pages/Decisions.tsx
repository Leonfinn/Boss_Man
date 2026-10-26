import { useState, type ReactNode } from "react";
import { api, type Company, type Decision, type StallEvidence } from "../api";
import { art } from "../brand";
import { State } from "../components/State";
import { describe, useTranscript } from "../transcript";
import { when } from "./Runs";
import { OUTCOMES } from "./Rules";

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
  self_deploy: { label: "Boss Man update", tone: "blue" },
  rule_proposal: { label: "Proposed rule", tone: "blue" },
};

const EFFECT = {
  reads: { label: "Reads only", tone: "" },
  changes: { label: "Changes files", tone: "amber" },
  deletes: { label: "Deletes files", tone: "red" },
  network: { label: "Network", tone: "amber" },
  pushes: { label: "Pushes code", tone: "red" },
  unknown: { label: "Unknown", tone: "amber" },
};

const OPTION_HELP: Record<string, string> = {
  "Cancel run": "Cancel run: stops it; message the agent on the task to start again.",
  "Keep waiting": "Keep waiting: you'll be asked again in 30 minutes if it stays quiet.",
};

const minutesAgo = (iso: string) => {
  const m = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return m >= 120 ? `${Math.floor(m / 60)} hours` : m === 1 ? "1 minute" : `${m} minutes`;
};

/** The facts behind a stalled-run alert, in plain words: who, since when, the last sign of life, the runner, the last steps. */
const PREVIEW_LINES = 8;

/** Long text shows its first lines and opens in place, so a card stays short until it's read. */
export function MoreText({ text, label, lines: keep = PREVIEW_LINES, chars }: { text: string; label?: string; lines?: number; chars?: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const byLines = lines.length > keep + 2 ? lines.slice(0, keep).join("\n") : text;
  const preview = chars && byLines.length > chars ? byLines.slice(0, chars).replace(/\s+\S*$/, "") : byLines;
  const long = preview !== text;
  return (
    <div>
      {label && <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>{label}</p>}
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{long && !open ? `${preview}…` : text}</p>
      {long && (
        <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾ Show less" : `▸ Show all${byLines !== text ? ` (${lines.length - keep} more lines)` : ""}`}
        </button>
      )}
    </div>
  );
}

function StallEvidenceView({ e }: { e: StallEvidence }) {
  const { items } = useTranscript(e.runId, 60_000);
  const steps = items.map((i) => ({ i, d: describe(i) })).filter(({ d }) => d.tone !== "text" || d.body?.trim());
  const last = e.lastStep ? describe(e.lastStep) : null;
  return (
    <div className="stall-evidence" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
      <p>
        {e.agent ?? "An agent"} on {e.ticketId ? <a href={`#/tickets/${e.ticketId}`}>{e.ticket ?? "a task"}</a> : (e.ticket ?? "no task")}. Run started {when(e.startedAt)}.
      </p>
      <p>
        {e.lastEventAt ? `Last activity ${minutesAgo(e.lastEventAt)} ago${last ? `: ${last.label}${last.body && last.tone !== "text" ? ` ${last.body.slice(0, 100)}` : ""}` : "."}` : "No sign of life since it was sent to the runner."}
      </p>
      <p>{e.runner.connected ? "Runner: connected." : `Runner: offline${e.runner.lastSeenAt ? ` since ${when(e.runner.lastSeenAt)}` : ""}.`}</p>
      <p>{e.waitingOnOwner ? "It is waiting on you for a permission answer." : "It is not waiting on you."}</p>
      {steps.length > 0 && (
        <>
          <ol className="run-steps">
            {steps.slice(-5).map(({ i, d }) => (
              <li key={i.seq} className={d.tone}>
                <time className="mono muted">{new Date(i.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
                <span>{d.label}</span>
              </li>
            ))}
          </ol>
          <p className="muted" style={{ fontSize: 12 }}>
            <a href={`#/runs/${e.runId}`}>See the whole run</a>
          </p>
        </>
      )}
    </div>
  );
}

function kindOf(d: Decision) {
  const ctx = (d as Decision & { context?: { type?: string } }).context;
  const key = ctx?.type === "deploy" || ctx?.type === "self_deploy" || ctx?.type === "rule_proposal" ? ctx.type : d.options.includes("Approve plan") ? "plan" : d.kind;
  return KIND[key] ?? { label: d.kind.replace(/_/g, " "), tone: "" };
}

/** The score in words: what each part added. */
function why(d: { score: number; parts: { blocking: number; liveRun: number; urgency: number; age: number } }) {
  const n = (x: number) => Math.round(x * 10) / 10;
  const bits = [
    d.parts.liveRun ? `${n(d.parts.liveRun)} for a paused agent` : null,
    d.parts.blocking ? `${n(d.parts.blocking)} for the tasks it blocks` : null,
    d.parts.urgency ? `${n(d.parts.urgency)} for being due soon` : null,
    `${n(d.parts.age)} for waiting`,
  ].filter(Boolean);
  return `Score ${Math.round(d.score)}: ${bits.join(" + ")}.`;
}

export function Decisions({ decisions, companies, loaded, agentsWorking, onAnswered, banner, elsewhere = [], onPickCompany }: { decisions: Decision[]; companies: Company[]; loaded: boolean; agentsWorking: number; onAnswered: () => void; banner?: ReactNode; elsewhere?: Array<{ id: string; name: string; count: number }>; onPickCompany?: (id: string) => void }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [endedHere, setEndedHere] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The owner's own answer to an agent's question, being written; absent while not.
  const [ownWords, setOwnWords] = useState<Record<string, string>>({});
  // A team plan's ticked hires, by position; all of them until the owner unticks one.
  const [picks, setPicks] = useState<Record<string, number[]>>({});

  const shown = decisions.filter((d) => !filter || d.companyId === filter);
  const open = shown.filter((d) => !answered[d.id]);
  const answer = async (d: Decision, option: string, custom = false) => {
    setBusy(d.id);
    try {
      const note = notes[d.id]?.trim();
      const r = await api<{ endedHere?: boolean }>(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: option, ...(note ? { note } : {}), ...(custom ? { custom: true } : {}), ...(d.context?.hires && option === "Hire the ticked ones" ? { picks: picks[d.id] ?? d.context.hires.map((_, i) => i) } : {}) } });
      setAnswered((a) => ({ ...a, [d.id]: option }));
      if (r?.endedHere) setEndedHere((x) => ({ ...x, [d.id]: true }));
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
            {filter ? "" : companies.length === 1 ? ` in ${companies[0]!.name}` : " across all companies"}, ranked by what they unblock.
          </p>
          {elsewhere.length > 0 && (
            <p className="sub">
              Also waiting:{" "}
              {elsewhere.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <button type="button" className="linkish" onClick={() => onPickCompany?.(c.id)}>
                    {c.count} in {c.name}
                  </button>
                </span>
              ))}
            </p>
          )}
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
      {banner}

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
          <div className="formula">
            <p>The number is each decision's priority score: the highest comes first. It adds up three things, drawn as the bar under it:</p>
            <ul className="score-legend">
              <li>
                <span className="swatch" style={{ background: "var(--accent)" }} /> what it holds up: tasks it blocks, or 5 when an agent is paused until you answer
              </li>
              <li>
                <span className="swatch" style={{ background: "var(--amber)" }} /> how soon it is due
              </li>
              <li>
                <span className="swatch" style={{ background: "#8a94a3" }} /> how long it has waited: 1 a day, up to 7
              </li>
            </ul>
          </div>
          <ol className="queue">
            {shown.map((d) => {
              const k = kindOf(d);
              const total = Math.max(1, d.parts.blocking + d.parts.urgency + d.parts.age + d.parts.liveRun);
              const w = (n: number) => `${Math.round((n / total) * 48)}px`;
              const done = answered[d.id];
              const x = d.context?.explain;
              const rule = d.context?.rule;
              return (
                <li className="decision" key={d.id}>
                  <div className="score" title={why(d)}>
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
                        {d.tier === "ceo" ? ` · for ${d.forAgentName ?? "the CEO"}` : ""}
                      </span>
                    </div>
                    {d.context?.type === "instructions" && d.context.instructions ? (
                      <>
                        {/* The question holds only the start of the new text; the decision keeps all of it, and that is what's applied. */}
                        <h2 style={{ whiteSpace: "pre-wrap" }}>{d.question.split("\n\nNew instructions:")[0]}</h2>
                        <MoreText label="New instructions" text={d.context.instructions} />
                      </>
                    ) : !x && !rule && d.question.split("\n").length > PREVIEW_LINES + 2 ? (
                      <>
                        <h2 style={{ whiteSpace: "pre-wrap" }}>{d.question.split("\n\n")[0]}</h2>
                        <MoreText text={d.question.split("\n\n").slice(1).join("\n\n")} />
                      </>
                    ) : (
                      <h2 style={{ whiteSpace: "pre-wrap" }}>{x ? x.title : rule ? d.question.split("\n\n")[0] : d.question}</h2>
                    )}
                    {rule && (
                      <>
                        <p style={{ whiteSpace: "pre-wrap" }}>{d.question.split("\n\n").slice(1).join("\n\n")}</p>
                        <details>
                          <summary>The exact rule</summary>
                          <ul style={{ paddingLeft: 18 }}>
                            <li>Name: {rule.name}</li>
                            {rule.match.kinds?.length ? <li>Tool kinds: {rule.match.kinds.join(", ")}</li> : null}
                            {rule.match.commandPattern && <li>Command pattern: <code className="mono">{rule.match.commandPattern}</code></li>}
                            {rule.match.titlePattern && <li>Title pattern: <code className="mono">{rule.match.titlePattern}</code></li>}
                            <li>Then: {OUTCOMES.find((o) => o.value === rule.outcome)?.label ?? rule.outcome}</li>
                          </ul>
                        </details>
                      </>
                    )}
                    {x && (
                      <>
                        {x.scratch && (
                          <p>
                            <span className="tag green">Temporary folder only</span> {x.scratch.note}
                          </p>
                        )}
                        <p>
                          <span className={`tag ${EFFECT[x.effect].tone}`}>{EFFECT[x.effect].label}</span> {x.summary}
                          {x.effect === "unknown" && " Read the exact command before you allow it."}
                        </p>
                        {x.alwaysNote && !done && <p className="muted" style={{ fontSize: 13 }}>{x.alwaysNote}</p>}
                        {x.reason && <p className="muted">What the agent says it's for: {x.reason}</p>}
                        {x.command && (
                          <details>
                            <summary>Show the exact command</summary>
                            <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.command}</pre>
                          </details>
                        )}
                      </>
                    )}
                    <p className="muted" style={{ fontSize: 13 }}>{why(d)}</p>
                    <div className="meta">
                      {d.blocks.length > 0 && <span>Blocks {d.blocks.length === 1 ? `"${d.blocks[0]!.title}"` : `${d.blocks.length} tasks`}</span>}
                      {d.dueDate && <span>Due {new Date(d.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
                      {d.reasons.map((r) => (
                        <span key={r}>{r}</span>
                      ))}
                    </div>
                    {d.evidence && !done && <StallEvidenceView e={d.evidence} />}
                    {d.context?.steps && d.context.steps.length > 0 && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>What to do</p>
                        <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                          {d.context.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {d.context?.triedFirst && (
                      <details className="plan">
                        <summary>What {d.agentName ?? "the agent"} tried first</summary>
                        <p style={{ fontSize: 14 }}>{d.context.triedFirst}</p>
                      </details>
                    )}
                    {d.context?.planText && (
                      <details className="plan" open={!done}>
                        <summary>The plan</summary>
                        <pre>{d.context.planText}</pre>
                      </details>
                    )}
                    {d.context?.output && (
                      <details className="plan">
                        <summary>Last output of the check</summary>
                        <pre>{d.context.output}</pre>
                      </details>
                    )}
                    {done ? (
                      <p style={{ color: "var(--green-ink)", fontWeight: 500, fontSize: 14 }}>Answered: {done}.{d.context?.always?.some((a) => a.label === done) ? " Saved as a rule in Settings → Rules." : ""}{endedHere[d.id] ? " The runner is offline, so Boss Man marked the run as stopped." : ""}</p>
                    ) : (
                      <>
                        {d.context?.hires && (
                          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                            <legend style={{ fontWeight: 600, marginBottom: 4 }}>Who to hire</legend>
                            {d.context.hires.map((h, i) => {
                              const chosen = picks[d.id] ?? d.context!.hires!.map((_, j) => j);
                              return (
                                <label key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                                  <input type="checkbox" checked={chosen.includes(i)} onChange={(e) => setPicks((p) => ({ ...p, [d.id]: e.target.checked ? [...chosen, i].sort((a, b) => a - b) : chosen.filter((x) => x !== i) }))} />
                                  <span>
                                    <strong>{h.name}</strong>
                                    {h.title ? `, ${h.title}` : ""}
                                    {h.template ? <span className="muted"> ({h.template})</span> : null}: {h.reason}
                                    {h.skills?.length ? <span className="muted"> Skills: {h.skills.join(", ")}.</span> : null}
                                  </span>
                                </label>
                              );
                            })}
                          </fieldset>
                        )}
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
                        {d.evidence && (
                          <ul className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
                            {d.options.filter((o) => OPTION_HELP[o]).map((o) => (
                              <li key={o}>{OPTION_HELP[o]}</li>
                            ))}
                          </ul>
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
