import { useEffect, useRef, useState, type ReactNode } from "react";
import { HARNESSES, harnessLabel, providerLabel } from "@boss-man/shared";
import { api, ApiError, type AdvisedDecision, type Company, type Decision, type DeployUpdate, type FundingSource, type ModelConfigView, type StallEvidence, type TeamAlert } from "../api";
import { art } from "../brand";
import { State } from "../components/State";
import { usePoll } from "../hooks";
import { describe, useTranscript } from "../transcript";
import { when } from "./Runs";
import { OUTCOMES } from "./Rules";
import { SkillProposal } from "../components/SkillProposal";

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
  owner_todo: { label: "Waiting for you", tone: "amber" },
  rule_proposal: { label: "Proposed rule", tone: "blue" },
  skill: { label: "Skill", tone: "blue" },
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

type TicketLanding = { state: "running"; startedAt: string; startedBy: string; stale?: boolean } | { state: "finished"; text?: string };
const atTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const startedByLabel = (who: string) => (/interrupted merge/i.test(who) ? "the automatic retry" : who);
const ALREADY_LANDING = /already being checked and merged|merge is running now/i;

const minutesAgo = (iso: string) => {
  const m = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  return m >= 120 ? `${Math.floor(m / 60)} hours` : m === 1 ? "1 minute" : `${m} minutes`;
};

/** The facts behind a stalled-run alert, in plain words: who, since when, the last sign of life, the runner, the last steps. */
const PREVIEW_LINES = 8;

/** Long text shows its first lines and opens in place, so a card stays short until it's read. */
export function MoreText({ text, label, lines: keep = PREVIEW_LINES, chars, refs }: { text: string; label?: string; lines?: number; chars?: number; refs?: Decision["refs"] }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const byLines = lines.length > keep + 2 ? lines.slice(0, keep).join("\n") : text;
  const preview = chars && byLines.length > chars ? byLines.slice(0, chars).replace(/\s+\S*$/, "") : byLines;
  const long = preview !== text;
  return (
    <div>
      {label && <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>{label}</p>}
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{long && !open ? <><Linked text={preview} refs={refs} />…</> : <Linked text={text} refs={refs} />}</p>
      {long && (
        <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾ Show less" : `▸ Show all${byLines !== text ? ` (${lines.length - keep} more lines)` : ""}`}
        </button>
      )}
    </div>
  );
}

function TicketLink({ t }: { t: { ticketId: string; ref?: string | null; title: string } }) {
  return (
    <a href={`#/tickets/${t.ticketId}`}>
      {t.ref ? `${t.ref} ` : ""}
      {t.title}
    </a>
  );
}

/** The tickets a card is about, each as its own link; nothing when it has none. */
function TicketRefs({ about }: { about?: Array<{ ticketId: string; ref: string | null; title: string }> }) {
  if (!about?.length) return null;
  return (
    <ul className="ticket-refs" aria-label="Tickets this is about" style={{ listStyle: "none", padding: 0, margin: "4px 0", display: "flex", flexDirection: "column", gap: 2, overflowWrap: "anywhere" }}>
      {about.map((t) => (
        <li key={t.ticketId}>
          <a href={`#/tickets/${t.ticketId}`}>{t.ref ? <strong>{t.ref}</strong> : null}{t.ref ? " " : ""}{t.title}</a>
        </li>
      ))}
    </ul>
  );
}

const shortSha = (sha: string) => sha.slice(0, 8);

const HAND_EFFECT: Record<NonNullable<DeployUpdate["handEffect"]>, string> = {
  deployer: "This changes the script that runs deploys on your server (scripts/host-deployer.sh); Boss Man's own server doesn't change.",
  server: "This changes how Boss Man runs on your server: its compose file, Dockerfiles or other deploy scripts.",
  both: "This changes both the script that runs deploys on your server (scripts/host-deployer.sh) and how Boss Man runs: its compose file, Dockerfiles or other deploy scripts.",
};

/**
 * What a Boss Man update contains (BOS-213): the tickets merged since the live version, any commits
 * that aren't a ticket, why it needs a hand-apply, and anything that changes the risk. The same
 * block is shown on the approval card and on the to-do it leaves behind.
 */
function DeployUpdateView({ u }: { u: DeployUpdate }) {
  return (
    <div className="deploy-update" style={{ margin: "8px 0", fontSize: 14 }}>
      <p style={{ fontWeight: 600, margin: "0 0 4px" }}>
        This update brings {u.total} change{u.total === 1 ? "" : "s"} across {u.files} file{u.files === 1 ? "" : "s"} since the live version ({shortSha(u.from)} → {shortSha(u.to)}).
      </p>
      {u.changes.length > 0 && (
        <ul aria-label="Tickets in this update" style={{ listStyle: "none", padding: 0, margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 }}>
          {u.changes.map((c) => (
            <li key={c.ticketId} style={{ overflowWrap: "anywhere" }}>
              <a href={`#/tickets/${c.ticketId}`}><strong>{c.ref}</strong> {c.title}</a>
            </li>
          ))}
          {u.more > 0 && (
            <li className="muted">
              and {u.more} more. <a href="#/board">See all the tickets</a>.
            </li>
          )}
        </ul>
      )}
      {u.otherCommits.length > 0 && (
        <details>
          <summary>Other commits: {u.otherCommits.length}</summary>
          <ul style={{ paddingLeft: 20, margin: "4px 0" }}>
            {u.otherCommits.map((s, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}><span className="mono muted">{s}</span></li>
            ))}
          </ul>
        </details>
      )}
      {u.handBecause && (
        <p style={{ margin: "6px 0 2px" }}>
          {u.handBecause}
          {u.handFiles?.length ? <> Files changed: <span className="mono" style={{ overflowWrap: "anywhere" }}>{u.handFiles.join(", ")}</span>.</> : null}
        </p>
      )}
      {u.handEffect && <p style={{ margin: "2px 0" }}>{HAND_EFFECT[u.handEffect]}</p>}
      {u.needsDeployerCopy !== undefined && (
        <p style={{ margin: "2px 0" }}>Deployer copy: {u.needsDeployerCopy ? "needed" : "not needed"}.</p>
      )}
      {u.needsRunnerUpdate !== undefined && (
        <p style={{ margin: "2px 0" }}>Runner update afterwards: {u.needsRunnerUpdate ? "needed" : "not needed"}.</p>
      )}
      {u.risks.length > 0 && (
        <div>
          <p style={{ fontWeight: 600, margin: "8px 0 2px" }}>Worth knowing</p>
          <ul style={{ paddingLeft: 20, margin: "2px 0" }}>
            {u.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Text with ticket references the server resolved (BOS-70) turned into links; anything else stays plain text. */
function Linked({ text, refs }: { text: string; refs?: Decision["refs"] }) {
  if (!refs || !Object.keys(refs).length) return <>{text}</>;
  return (
    <>
      {text.split(/\b([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})\b/).map((part, i) => {
        const t = i % 2 ? refs[part.toUpperCase()] : undefined;
        return t ? <a key={i} href={`#/tickets/${t.ticketId}`} title={t.title}>{part}</a> : part;
      })}
    </>
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

/** What the team did with a decision, in the owner's words. */
function settledWord(answer: string) {
  if (answer === "Allow once") return "allowed";
  if (answer === "Deny") return "denied";
  if (answer === "Keep waiting") return "kept waiting";
  if (answer === "Cancel run") return "cancelled the run";
  if (answer === "Got it") return "settled it";
  return answer;
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

/** Current vs proposed harness, provider, model and paid from on a model-change card (BOS-128). */
function ModelChange({ d, editing, onEdit, onCancel, onSubmit, busy }: { d: Decision; editing: boolean; onEdit: () => void; onCancel: () => void; onSubmit: (config: ModelConfigView) => void; busy: boolean }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, `model-change-sources-${d.id}`);
  const before = d.context?.before;
  // Once answered, show what actually landed (the owner's Edit values), not the CEO's proposal.
  const proposed = d.context?.applied?.config ?? d.context?.proposed;
  const [form, setForm] = useState<ModelConfigView>(proposed ?? { harness: "claude", provider: "anthropic", model: "", fundingSourceId: "" });
  if (!before || !proposed) return null;
  const paidFrom = (c: ModelConfigView) => c.fundingSourceName ?? sources.data?.find((s) => s.id === c.fundingSourceId)?.name ?? c.fundingSourceId;
  const rows: Array<[string, string, string]> = [
    ["Harness", harnessLabel(before.harness), harnessLabel(proposed.harness)],
    ["Provider", providerLabel(before.provider), providerLabel(proposed.provider)],
    ["Model", before.model || "default", proposed.model || "default"],
    ["Paid from", paidFrom(before), paidFrom(proposed)],
  ];
  return (
    <div style={{ marginTop: 8 }}>
      <table className="table" aria-label="Current and proposed model setup">
        <thead>
          <tr>
            <th />
            <th>Current</th>
            <th>Proposed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, current, next]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className={current === next ? "muted" : undefined}>{current}</td>
              <td><strong>{next}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.context?.applied && (
        <p className="muted" role="status">
          Applied {when(d.context.applied.at)}. It takes effect {d.context.applied.afterRunId ? "after the run that was in progress ended" : "from the next run"}.
        </p>
      )}
      {editing ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ harness: form.harness, provider: form.provider, model: form.model, fundingSourceId: form.fundingSourceId });
          }}
        >
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div className="field">
              <label htmlFor={`mc-harness-${d.id}`}>Harness</label>
              <select id={`mc-harness-${d.id}`} value={form.harness} onChange={(e) => setForm({ ...form, harness: e.target.value, model: "" })}>
                {HARNESSES.map((h) => (
                  <option key={h.value} value={h.value}>{h.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`mc-provider-${d.id}`}>Provider</label>
              <select id={`mc-provider-${d.id}`} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                {(sources.data ?? []).map((s) => s.provider).filter((p, i, all) => all.indexOf(p) === i).map((p) => (
                  <option key={p} value={p}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`mc-model-${d.id}`}>Model</label>
              <input id={`mc-model-${d.id}`} className="mono" required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`mc-funding-${d.id}`}>Paid from</label>
              <select
                id={`mc-funding-${d.id}`}
                required
                value={form.fundingSourceId}
                onChange={(e) => {
                  const source = sources.data?.find((s) => s.id === e.target.value);
                  setForm({ ...form, fundingSourceId: e.target.value, ...(source ? { provider: source.provider } : {}) });
                }}
              >
                <option value="">Choose a funding source</option>
                {(sources.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({providerLabel(s.provider)})</option>
                ))}
              </select>
            </div>
          </div>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !form.model || !form.fundingSourceId}>Save and approve</button>
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          </div>
          <small className="muted">The same checks apply as when the CEO proposed it. The change takes effect between runs.</small>
        </form>
      ) : (
        <button type="button" className="linkish" onClick={onEdit}>
          Edit these values before approving
        </button>
      )}
    </div>
  );
}

export function Decisions({ decisions, companies, loaded, agentsWorking, onAnswered, banner, elsewhere = [], onPickCompany, withTeam = [], advised = [] }: { decisions: Decision[]; companies: Company[]; loaded: boolean; agentsWorking: number; onAnswered: () => void; banner?: ReactNode; elsewhere?: Array<{ id: string; name: string; count: number }>; onPickCompany?: (id: string) => void; withTeam?: TeamAlert[]; advised?: AdvisedDecision[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [endedHere, setEndedHere] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // A workflow-retro change's optional wiki link, e.g. a page slug with a section after it.
  const [reasonLinks, setReasonLinks] = useState<Record<string, string>>({});
  // The owner's own answer to an agent's question, being written; absent while not.
  const [ownWords, setOwnWords] = useState<Record<string, string>>({});
  // A team plan's ticked hires, by position; all of them until the owner unticks one.
  const [picks, setPicks] = useState<Record<string, number[]>>({});
  // A model-change card being edited before approval.
  const [modelEdits, setModelEdits] = useState<Record<string, boolean>>({});
  // "Ask the CEO for advice": the optional one-line note being written, absent while not.
  const [adviceNote, setAdviceNote] = useState<Record<string, string>>({});
  // "Reassign" on a stale-blocker card: the agent being picked, and who has the ticket now; absent while not picking.
  const [reassign, setReassign] = useState<Record<string, { pick: string; current: string | null }>>({});
  // A merge started from the ticket page (or a sweep) while its approval card is still open.
  const [landings, setLandings] = useState<Record<string, TicketLanding | null>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const landingIds = [...new Set(decisions.filter((d) => !answered[d.id] && d.context?.type === "risk_review" && d.context.ticketId).map((d) => d.context!.ticketId!))];
  const landingKey = landingIds.sort().join(",");
  useEffect(() => {
    if (!landingIds.length) return;
    let stopped = false;
    const load = async () => {
      const entries = await Promise.all(
        landingIds.map(async (ticketId) => {
          try {
            return [ticketId, (await api<{ landing: TicketLanding | null }>(`/api/tickets/${ticketId}/landing`)).landing] as const;
          } catch {
            return [ticketId, null] as const;
          }
        }),
      );
      if (!stopped) setLandings(Object.fromEntries(entries));
    };
    void load();
    const timer = setInterval(() => void load(), 2_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingKey]);
  const openReassign = async (d: Decision) => {
    const id = d.context?.blockerTicketId;
    let current: string | null = null;
    try {
      if (id) current = (await api<{ assigneeAgentId: string | null }>(`/api/tickets/${id}`)).assigneeAgentId;
    } catch {
      // The picker still works without knowing who has it now.
    }
    setReassign((r) => ({ ...r, [d.id]: { pick: "", current } }));
  };
  const askAdvice = async (d: Decision) => {
    setBusy(d.id);
    try {
      const note = adviceNote[d.id]?.trim();
      await api(`/api/decisions/${d.id}/ask-advice`, { method: "POST", body: note ? { note } : {} });
      setAdviceNote(({ [d.id]: _, ...rest }) => rest);
      setErrors(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      setErrors((e) => ({ ...e, [d.id]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const shown = decisions.filter((d) => !filter || d.companyId === filter);
  const open = shown.filter((d) => !answered[d.id]);
  const answer = async (d: Decision, option: string, extra: { custom?: boolean; modelConfig?: ModelConfigView; assigneeAgentId?: string } = {}) => {
    // A second click can land before React re-renders the disabled button: refuse it here too.
    if (inFlight.current.has(d.id)) return;
    inFlight.current.add(d.id);
    setBusy(d.id);
    try {
      const note = notes[d.id]?.trim();
      const reasonLink = reasonLinks[d.id]?.trim();
      const r = await api<{ endedHere?: boolean }>(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: option, ...(note ? { note } : {}), ...(reasonLink ? { reasonLink } : {}), ...(extra.custom ? { custom: true } : {}), ...(extra.modelConfig ? { modelConfig: extra.modelConfig } : {}), ...(extra.assigneeAgentId ? { assigneeAgentId: extra.assigneeAgentId } : {}), ...(d.context?.hires && option === "Hire the ticked ones" ? { picks: picks[d.id] ?? d.context.hires.map((_, i) => i) } : {}) } });
      setAnswered((a) => ({ ...a, [d.id]: option }));
      setModelEdits(({ [d.id]: _, ...rest }) => rest);
      if (r?.endedHere) setEndedHere((x) => ({ ...x, [d.id]: true }));
      setErrors(({ [d.id]: _, ...rest }) => rest);
      setNotices(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      const ticketId = d.context?.type === "risk_review" ? d.context.ticketId : null;
      if (err instanceof ApiError && err.status === 409 && ALREADY_LANDING.test(err.message)) {
        const current = ticketId ? await api<{ landing: TicketLanding | null }>(`/api/tickets/${ticketId}/landing`).then((r) => r.landing).catch(() => null) : null;
        if (ticketId) setLandings((l) => ({ ...l, [ticketId]: current }));
        const since = current?.state === "running" ? ` since ${atTime(current.startedAt)}` : "";
        setNotices((n) => ({ ...n, [d.id]: `Already being checked and merged${since}; nothing more to do.` }));
        setErrors(({ [d.id]: _, ...rest }) => rest);
      } else setErrors((e) => ({ ...e, [d.id]: (err as Error).message }));
    } finally {
      inFlight.current.delete(d.id);
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
      {withTeam.length > 0 && (
        // Alerts the Scrum Master or CEO still hold: listed so nothing is hidden, but not the owner's to answer yet.
        <details className="sub">
          <summary>Being handled by the team ({withTeam.length})</summary>
          <ul>
            {withTeam.map((a) => (
              <li key={a.id}>
                {a.question} <span className="muted">· with {a.holder} since {when(a.since)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {advised.length > 0 && (
        <details className="sub">
          <summary>Settled or withdrawn by the team in the last 30 days ({advised.length})</summary>
          <ul>
            {advised.map((a) => (
              <li key={a.id}>
                <TicketRefs about={a.about} />
                {a.question}{" "}
                <span className="muted">
                  ·{" "}
                  {a.withdrawn
                    ? `withdrawn by ${a.withdrawn.by}: ${a.withdrawn.note}`
                    : a.settled
                      ? `${settledWord(a.settled.answer)} by ${a.settled.by}${a.settled.tempCleanup ? " (temp-file cleanup)" : a.settled.workingCopy ? " (working-copy cleanup)" : ""}: ${a.settled.note ?? "no reason given"}`
                      : a.advice?.state === "reissued"
                        ? "replaced by a clearer decision"
                        : `handled by the CEO: ${a.advice?.summary ?? "done"}`}
                </span>
                {a.settled?.command && (
                  <pre className="muted">
                    <code>{a.settled.command}</code>
                  </pre>
                )}
                {a.advice?.replacedBy && (
                  <>
                    {" "}
                    <a href="#/decisions">See the new one in the list</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

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
            <p>Newest first. The number is each decision's priority score, a guide to how much it holds up. It adds up three things, drawn as the bar under it:</p>
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
              const advice = d.context?.advice;
              const asking = advice?.state === "asking";
              const ticketId = d.context?.type === "risk_review" ? d.context.ticketId : null;
              const land = ticketId ? landings[ticketId] : null;
              const checking = land?.state === "running" && !land.stale;
              const staleCheck = land?.state === "running" && !!land.stale;
              return (
                <li className="decision" key={d.id} style={asking ? { opacity: 0.7 } : undefined} aria-busy={asking || undefined}>
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
                    <TicketRefs about={d.about} />
                    {d.context?.update && <DeployUpdateView u={d.context.update} />}
                    {d.context?.type === "instructions" && d.context.instructions ? (
                      <>
                        {/* The question holds only the start of the new text; the decision keeps all of it, and that is what's applied. */}
                        <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\nNew instructions:")[0]!} refs={d.refs} /></h2>
                        <MoreText label="New instructions" text={d.context.instructions} />
                      </>
                    ) : !x && !rule && d.question.split("\n").length > PREVIEW_LINES + 2 ? (
                      <>
                        <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n")[0]!} refs={d.refs} /></h2>
                        <MoreText text={d.question.split("\n\n").slice(1).join("\n\n")} refs={d.refs} />
                      </>
                    ) : (
                      <h2 style={{ whiteSpace: "pre-wrap" }}>{x ? x.title : <Linked text={rule ? d.question.split("\n\n")[0]! : d.question} refs={d.refs} />}</h2>
                    )}
                    {d.staleAt && !done && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        May be out of date{d.staleReason ? `: ${d.staleReason}` : ""}. The agent that raised it has been asked to confirm or withdraw it.
                      </p>
                    )}
                    {rule && (
                      <>
                        <p style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n").slice(1).join("\n\n")} refs={d.refs} /></p>
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
                    {d.context?.type === "skill" && d.context.proposalId ? <SkillProposal companyId={d.companyId} proposalId={d.context.proposalId} /> : null}
                    {x && (
                      <>
                        {x.scratch && (
                          <p>
                            <span className="tag green">Temporary folder only</span> {x.scratch.note}
                          </p>
                        )}
                        {x.push ? (
                          <>
                            <p>
                              <span className={`tag ${EFFECT[x.effect].tone}`}>{EFFECT[x.effect].label}</span> {x.push.headline}
                              {x.push.kind === "ticket" && x.push.ticketId && (
                                <>
                                  {" "}
                                  (<a href={`#/tickets/${x.push.ticketId}`}>{x.push.ref ?? "its ticket"}</a>)
                                </>
                              )}
                            </p>
                            {x.push.warnings.map((w) => (
                              <p key={w} role="alert" style={{ margin: "4px 0" }}>
                                <span className="tag red">Warning</span> {w}
                              </p>
                            ))}
                          </>
                        ) : (
                          <p>
                            <span className={`tag ${EFFECT[x.effect].tone}`}>{EFFECT[x.effect].label}</span> {x.summary}
                            {x.effect === "unknown" && " Read the exact command before you allow it."}
                          </p>
                        )}
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
                    {asking && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        CEO is looking at this{advice.note ? <span className="muted" style={{ fontWeight: 400 }}> · you asked: {advice.note}</span> : null}. You can still answer it yourself.
                      </p>
                    )}
                    {advice?.state === "clarified" && (
                      <>
                        <p className="muted">Rewritten by the CEO with more detail, after you asked for advice.</p>
                        {advice.originalQuestion && (
                          <details>
                            <summary>Original question (before the CEO rewrote it)</summary>
                            <p style={{ fontSize: 14 }}>{advice.originalQuestion}</p>
                          </details>
                        )}
                      </>
                    )}
                    {advice?.state === "timed_out" && <p className="muted">You asked the CEO for advice, but the CEO didn't respond. It's back with you.</p>}
                    {advice?.state === "replacement" && advice.replaces && <p className="muted">Written by the CEO to replace an earlier, unclear decision. <a href="#/decisions">The original is closed</a>; it is listed under "Settled or withdrawn by the team" with what it asked.</p>}
                    <p className="muted" style={{ fontSize: 13 }}>{why(d)}</p>
                    <div className="meta">
                      {d.blocks.length > 0 && (
                        <span>
                          Blocks{" "}
                          {d.blocks.map((t, i) => (
                            <span key={t.ticketId}>{i > 0 && ", "}<TicketLink t={t} /></span>
                          ))}
                        </span>
                      )}
                      <span>Raised <time dateTime={d.createdAt}>{when(d.createdAt)}</time></span>
                      {d.dueDate && <span>Due {new Date(d.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
                      {d.reasons.map((r) => (
                        <span key={r}>{r}</span>
                      ))}
                    </div>
                    {d.evidence && !done && <StallEvidenceView e={d.evidence} />}
                    {d.context?.type === "self_deploy" && d.context.handSteps && d.context.handSteps.length > 0 && (
                      <details className="plan">
                        <summary>What you'll need to do</summary>
                        <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                          {d.context.handSteps.map((s, i) => (
                            <li key={i}><Linked text={s} refs={d.refs} /></li>
                          ))}
                        </ol>
                      </details>
                    )}
                    {d.context?.steps && d.context.steps.length > 0 && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>What to do</p>
                        <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                          {d.context.steps.map((s, i) => (
                            <li key={i}><Linked text={s} refs={d.refs} /></li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {d.context?.check && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>How to check it worked</p>
                        <p style={{ fontSize: 14 }}>{d.context.check}</p>
                      </div>
                    )}
                    {d.context?.rollback && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>How to roll back</p>
                        <p style={{ fontSize: 14 }}>{d.context.rollback}</p>
                      </div>
                    )}
                    {d.context?.lastFailure && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>Last step failed</p>
                        <p style={{ fontSize: 14 }}>{d.context.lastFailure.note}</p>
                        <p className="muted" style={{ fontSize: 12 }}>Reported {when(d.context.lastFailure.at)}</p>
                      </div>
                    )}
                    {d.context?.triedFirst && (
                      <details className="plan">
                        <summary>What {d.agentName ?? "the agent"} tried first</summary>
                        <p style={{ fontSize: 14 }}><Linked text={d.context.triedFirst} refs={d.refs} /></p>
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
                    {d.context?.type === "model_change" && (
                      <ModelChange
                        d={d}
                        editing={!!modelEdits[d.id]}
                        onEdit={() => setModelEdits((m) => ({ ...m, [d.id]: true }))}
                        onCancel={() => setModelEdits(({ [d.id]: _, ...rest }) => rest)}
                        onSubmit={(config) => void answer(d, "Edit", { modelConfig: config })}
                        busy={busy === d.id}
                      />
                    )}
                    {checking && land?.state === "running" && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        Checking and merging since {atTime(land.startedAt)}, started by {startedByLabel(land.startedBy)}. This can take several minutes; nothing more to do here.
                      </p>
                    )}
                    {staleCheck && land?.state === "running" && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        The merge check started by {startedByLabel(land.startedBy)} at {atTime(land.startedAt)} looks stuck, so it may have stopped. Nothing is running now: you can answer again below.
                      </p>
                    )}
                    {notices[d.id] && (
                      <p role="status" className="muted">
                        {notices[d.id]}
                      </p>
                    )}
                    {done ? (
                      <p style={{ color: "var(--green-ink)", fontWeight: 500, fontSize: 14 }}>Answered: {done}.{done === "Let the CEO decide" ? " The CEO has it now and was woken; it comes back to you if they do not settle it in time." : ""}{d.context?.always?.some((a) => a.label === done) ? " Saved as a rule in Settings → Rules." : ""}{endedHere[d.id] ? " The runner is offline, so Boss Man marked the run as stopped." : ""}</p>
                    ) : checking ? null : (
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
                        {d.options.some((o) => o === "Keep planning" || o === "Send it back" || o === "A step failed") && (
                          <div className="field">
                            <label htmlFor={`note-${d.id}`}>{d.context?.type === "owner_todo" ? "What went wrong (if a step failed)" : "Note for the agent (if you send it back)"}</label>
                            <textarea id={`note-${d.id}`} rows={2} value={notes[d.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))} />
                          </div>
                        )}
                        {d.context?.type === "workflow_change" && (
                          <>
                            <div className="field">
                              <label htmlFor={`reason-${d.id}`}>Why (shown on the Changes table, required)</label>
                              <textarea id={`reason-${d.id}`} rows={2} maxLength={500} required value={notes[d.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))} placeholder="e.g. adds a skill; waits for BOS-172" />
                            </div>
                            <div className="field">
                              <label htmlFor={`reason-link-${d.id}`}>Wiki page that explains it (optional)</label>
                              <input id={`reason-link-${d.id}`} maxLength={400} value={reasonLinks[d.id] ?? ""} onChange={(e) => setReasonLinks((l) => ({ ...l, [d.id]: e.target.value }))} placeholder="slug or slug#Heading" />
                            </div>
                          </>
                        )}
                        {d.evidence && (
                          <ul className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
                            {d.options.filter((o) => OPTION_HELP[o]).map((o) => (
                              <li key={o}>{OPTION_HELP[o]}</li>
                            ))}
                          </ul>
                        )}
                        {reassign[d.id] ? (
                          <form
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (reassign[d.id]!.pick) void answer(d, "Reassign", { assigneeAgentId: reassign[d.id]!.pick });
                              else setErrors((x) => ({ ...x, [d.id]: "Pick who should take this ticket." }));
                            }}
                          >
                            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                              <legend style={{ fontWeight: 600, marginBottom: 4 }}>Who should take this ticket?</legend>
                              {(companies.find((c) => c.id === d.companyId)?.agents ?? []).map((a) => (
                                <label key={a.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                                  <input type="radio" name={`assignee-${d.id}`} checked={reassign[d.id]!.pick === a.id} onChange={() => setReassign((r) => ({ ...r, [d.id]: { ...r[d.id]!, pick: a.id } }))} />
                                  <span>
                                    <strong>{a.name}</strong>
                                    {a.title ? `, ${a.title}` : ""}
                                    {a.id === reassign[d.id]!.current ? <span className="muted"> (has it now)</span> : null}
                                  </span>
                                </label>
                              ))}
                            </fieldset>
                            <div className="actions">
                              <button type="submit" className="btn primary" disabled={busy === d.id}>
                                Reassign to the one I picked
                              </button>
                              <button type="button" className="btn" disabled={busy === d.id} onClick={() => void answer(d, "Let the CEO decide")}>
                                Let the CEO decide
                              </button>
                              <button type="button" className="btn" onClick={() => setReassign(({ [d.id]: _, ...rest }) => rest)}>
                                Back to the options
                              </button>
                            </div>
                          </form>
                        ) : ownWords[d.id] === undefined || modelEdits[d.id] ? (
                          <div className="actions">
                            {!modelEdits[d.id] && d.options.map((o) => (
                              <button type="button" key={o} className={`btn${o === d.recommendedOption ? " primary" : ""}`} disabled={busy === d.id || (d.context?.type === "workflow_change" && !notes[d.id]?.trim())} onClick={() => (d.context?.type === "model_change" && o === "Edit" ? setModelEdits((m) => ({ ...m, [d.id]: true })) : o === "Reassign" && d.context?.type === "stale_blocker" && d.context.blockerTicketId ? void openReassign(d) : void answer(d, o))}>
                                {o}
                              </button>
                            ))}
                            {!modelEdits[d.id] && d.kind === "question" && (
                              <button type="button" className="btn" disabled={busy === d.id} onClick={() => setOwnWords((w) => ({ ...w, [d.id]: "" }))}>
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
                              if (text) void answer(d, text, { custom: true });
                            }}
                          >
                            <div className="field">
                              <label htmlFor={`own-${d.id}`}>Your answer, in your own words. It goes to {d.agentName ?? "the agent"} exactly as you write it.</label>
                              <textarea
                                id={`own-${d.id}`}
                                className="own-answer"
                                rows={5}
                                maxLength={4000}
                                autoFocus
                                placeholder={d.recommendedOption ?? undefined}
                                value={ownWords[d.id]}
                                onChange={(e) => setOwnWords((w) => ({ ...w, [d.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Tab" && !e.shiftKey && d.recommendedOption && !ownWords[d.id]) {
                                    e.preventDefault();
                                    setOwnWords((w) => ({ ...w, [d.id]: d.recommendedOption! }));
                                  }
                                }}
                                style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
                              />
                              {d.recommendedOption && !ownWords[d.id] && (
                                <button type="button" className="use-suggestion" onClick={() => setOwnWords((w) => ({ ...w, [d.id]: d.recommendedOption! }))}>
                                  Use suggestion
                                </button>
                              )}
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
                        {d.kind !== "permission" && d.context?.type !== "permission" && !asking && ownWords[d.id] === undefined && (
                          <details className="advice">
                            <summary>Not enough detail?</summary>
                            <div className="field">
                              <label htmlFor={`advice-${d.id}`}>What's unclear (optional, one line)</label>
                              <input id={`advice-${d.id}`} type="text" maxLength={500} value={adviceNote[d.id] ?? ""} onChange={(e) => setAdviceNote((n) => ({ ...n, [d.id]: e.target.value }))} />
                            </div>
                            <div className="actions">
                              <button type="button" className="btn" disabled={busy === d.id} onClick={() => void askAdvice(d)}>
                                Ask the CEO for advice
                              </button>
                            </div>
                          </details>
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
