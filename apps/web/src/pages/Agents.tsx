// Agents (R62): who works for the company, what each is doing and has used this month, and
// hiring from role templates. Every change is kept with what it was before, and can be undone.
import { useState, type FormEvent } from "react";
import { api, usd, type Company, type FundingSource } from "../api";
import { usePoll } from "../hooks";
import { when } from "./Runs";

type Template = { id: string; title: string; role: "manager" | "worker"; modelTier: string; summary: string; instructions: string };
type AgentRow = {
  id: string;
  name: string;
  role: "ceo" | "manager" | "worker";
  title: string | null;
  template: string | null;
  instructions: string | null;
  agentKind: string;
  model: string | null;
  fundingSourceId: string | null;
  funding: string | null;
  fundingKind: string | null;
  paused: boolean;
  duty: string | null;
  retiredAt: string | null;
  status: "working" | "idle" | "paused" | "retired";
  current: { ticketId: string; title: string | null } | null;
  openTickets: number;
  month: { costMicros: number; runs: number; tokens: number };
};
type Change = { c: { id: string; field: string; before: unknown; after: unknown; undoneAt: string | null; createdAt: string; byAgentId: string | null }; by: string | null };

type ModelChoice = { value: string; name: string; description?: string | null };
type ModelLists = { runner: Record<string, { models: ModelChoice[]; observedAt: string }>; api: Array<{ fundingSourceId: string; name: string; provider: string; models: ModelChoice[]; error: string | null }> };
const OTHER = "__other__";

/**
 * The model field (R60): Default, then what the agent's kind offers on the runner and what its
 * funding source's API key can use, then Other… for a typed ID.
 */
function ModelPicker({ id, value, onChange, agentKind, fundingSourceId, lists }: { id: string; value: string; onChange: (v: string) => void; agentKind: string; fundingSourceId: string; lists: ModelLists | null }) {
  // The adapter's own "default" is the same as leaving the model blank.
  const fromRunner = (lists?.runner[agentKind]?.models ?? []).filter((m) => m.value !== "default");
  const fromApi = lists?.api.find((a) => a.fundingSourceId === fundingSourceId);
  const known = [...fromRunner, ...(fromApi?.models ?? [])].some((m) => m.value === value);
  const [typing, setTyping] = useState(false);
  const offered = fromRunner.length + (fromApi?.models.length ?? 0) > 0;
  if (!offered || typing)
    return (
      <>
        <input id={id} className="mono" placeholder="default" value={value} onChange={(e) => onChange(e.target.value)} />
        <small className="muted">
          {offered ? (
            <button type="button" className="linkish" onClick={() => setTyping(false)}>
              Choose from the list
            </button>
          ) : (
            `No list yet: ${agentKind} reports its models the first time it runs.`
          )}
        </small>
      </>
    );
  return (
    <>
      <select id={id} value={value} onChange={(e) => (e.target.value === OTHER ? setTyping(true) : onChange(e.target.value))}>
        <option value="">Default</option>
        {/* A full ID still works on Claude (the runner pins it to the opus alias), so it's shown as typed, not refused. */}
        {value && !known && <option value={value}>{value} (typed ID)</option>}
        {fromRunner.length > 0 && (
          <optgroup label={`Offered by the runner (${agentKind})`}>
            {fromRunner.map((m) => (
              <option key={`r-${m.value}`} value={m.value}>
                {m.name === m.value ? m.value : `${m.name} (${m.value})`}
              </option>
            ))}
          </optgroup>
        )}
        {fromApi && fromApi.models.length > 0 && (
          <optgroup label={`On ${fromApi.name}'s API key`}>
            {fromApi.models.map((m) => (
              <option key={`a-${m.value}`} value={m.value}>
                {m.name === m.value ? m.value : `${m.name} (${m.value})`}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>Other…</option>
      </select>
      {fromApi?.error && <small className="error">{fromApi.error}</small>}
    </>
  );
}

const STATUS: Record<AgentRow["status"], [string, string]> = { working: ["Working", "green"], idle: ["Idle", ""], paused: ["Paused", "amber"], retired: ["Retired", ""] };
const FIELD: Record<string, string> = { hired: "Hired", retired: "Retired", rehired: "Rehired", name: "Name", title: "Job title", instructions: "Instructions", model: "Model", funding: "Paid from", kind: "Agent kind", paused: "Paused" };
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const jobOf = (a: Pick<AgentRow, "role" | "title" | "duty">) => (a.role === "ceo" ? "CEO" : (a.title ?? (a.duty === "wiki" ? "Wiki Maintainer" : a.role === "manager" ? "Manager" : "Agent")));
const show = (v: unknown, sources: FundingSource[]) =>
  v === null || v === undefined || v === "" ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" ? (sources.find((s) => s.id === v)?.name ?? v) : JSON.stringify(v);

function Hire({ companyId, templates, sources, lists, onDone }: { companyId: string; templates: Template[]; sources: FundingSource[]; lists: ModelLists | null; onDone: (name: string) => void }) {
  const [tpl, setTpl] = useState<Template | null>(null);
  const [form, setForm] = useState({ name: "", title: "", instructions: "", model: "", fundingSourceId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = (t: Template | null) => {
    setTpl(t);
    setForm({ ...form, name: form.name || t?.title || "", title: t?.title ?? "", instructions: t?.instructions ?? "" });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/companies/${companyId}/agents`, {
        method: "POST",
        body: {
          name: form.name.trim(),
          ...(tpl ? { template: tpl.id } : {}),
          title: form.title.trim() || null,
          instructions: form.instructions.trim() || null,
          model: form.model.trim() || null,
          fundingSourceId: form.fundingSourceId || null,
        },
      });
      onDone(form.name.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-labelledby="hire-h">
      <h2 id="hire-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Hire an agent
      </h2>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="section-label" style={{ marginBottom: 8 }}>
          Start from
        </legend>
        <div className="template-grid">
          {templates.map((t) => (
            <label key={t.id} className={`template${tpl?.id === t.id ? " on" : ""}`}>
              <input type="radio" name="template" className="sr-only" checked={tpl?.id === t.id} onChange={() => choose(t)} />
              <strong>{t.title}</strong>
              <span>{t.summary}</span>
              <small className="muted">Suggested model: {t.modelTier}</small>
            </label>
          ))}
          <label className={`template${tpl === null ? " on" : ""}`}>
            <input type="radio" name="template" className="sr-only" checked={tpl === null} onChange={() => choose(null)} />
            <strong>Blank</strong>
            <span>Write the job yourself.</span>
          </label>
        </div>
      </fieldset>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <div className="field">
          <label htmlFor="hire-name">Name</label>
          <input id="hire-name" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="hire-title">Job title</label>
          <input id="hire-title" maxLength={80} placeholder="e.g. Scrum Master" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="hire-model">Model</label>
          <ModelPicker id="hire-model" value={form.model} onChange={(model) => setForm({ ...form, model })} agentKind="claude" fundingSourceId={form.fundingSourceId} lists={lists} />
          <small className="muted">{tpl ? `Suggested: a ${tpl.modelTier} model. ` : ""}Blank uses the agent's default.</small>
        </div>
        <div className="field">
          <label htmlFor="hire-funding">Paid from</label>
          <select id="hire-funding" value={form.fundingSourceId} onChange={(e) => setForm({ ...form, fundingSourceId: e.target.value })}>
            <option value="">Not set</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="hire-instructions">Instructions</label>
        <textarea id="hire-instructions" rows={7} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        <small className="muted">Given to the agent at the start of every run. Tailor them to your company.</small>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy || !form.name.trim()}>
        Hire {form.name.trim() || "agent"}
      </button>
    </form>
  );
}

function Edit({ a, sources, lists, onSaved }: { a: AgentRow; sources: FundingSource[]; lists: ModelLists | null; onSaved: () => void }) {
  const [form, setForm] = useState({ name: a.name, title: a.title ?? "", instructions: a.instructions ?? "", model: a.model ?? "", fundingSourceId: a.fundingSourceId ?? "" });
  const history = usePoll((signal) => api<Change[]>(`/api/agents/${a.id}/history`, { signal }), 60_000, `history-${a.id}`);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNote({ ok: true, text: done });
      history.reload();
      onSaved();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = { name: form.name.trim(), title: form.title.trim() || null, instructions: form.instructions.trim() || null, model: form.model.trim() || null, fundingSourceId: form.fundingSourceId || null };
    void run(() => api(`/api/agents/${a.id}`, { method: "PATCH", body }), "Saved.");
  };
  const retired = !!a.retiredAt;
  return (
    <div className="agent-edit">
      {!retired && (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div className="field">
              <label htmlFor={`name-${a.id}`}>Name</label>
              <input id={`name-${a.id}`} required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            {a.role !== "ceo" && (
              <div className="field">
                <label htmlFor={`title-${a.id}`}>Job title</label>
                <input id={`title-${a.id}`} maxLength={80} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
            )}
            <div className="field">
              <label htmlFor={`model-${a.id}`}>Model</label>
              <ModelPicker id={`model-${a.id}`} value={form.model} onChange={(model) => setForm({ ...form, model })} agentKind={a.agentKind} fundingSourceId={form.fundingSourceId} lists={lists} />
            </div>
            <div className="field">
              <label htmlFor={`funding-${a.id}`}>Paid from</label>
              <select id={`funding-${a.id}`} value={form.fundingSourceId} onChange={(e) => setForm({ ...form, fundingSourceId: e.target.value })}>
                <option value="">Not set</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={`instructions-${a.id}`}>Instructions</label>
            <textarea id={`instructions-${a.id}`} rows={6} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
            <small className="muted">{a.role === "ceo" ? "The CEO picks up new instructions in its next chapter (Settings › CEO chapters)." : "Used from the agent's next run."}</small>
          </div>
          <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }}>
            Save
          </button>
        </form>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
      <h3 className="section-label">History</h3>
      {history.data?.length ? (
        <ol className="history">
          {history.data.map(({ c, by }) => (
            <li key={c.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>
                  <strong>{FIELD[c.field] ?? c.field}</strong> <span className="muted">by {by ?? "you"}, {when(c.createdAt)}</span>
                  {c.undoneAt && <span className="tag" style={{ marginLeft: 6 }}>Undone</span>}
                </span>
                {!c.undoneAt && c.field !== "hired" && c.field !== "rehired" && (
                  <button type="button" className="btn" style={{ minHeight: 32, padding: "4px 10px" }} onClick={() => void run(() => api(`/api/agent-changes/${c.id}/undo`, { method: "POST" }), c.field === "retired" ? "Rehired, with their tickets back." : "Undone.")}>
                    {c.field === "retired" ? "Rehire" : "Undo"}
                  </button>
                )}
              </div>
              {c.field === "instructions" ? (
                <details>
                  <summary className="muted">Show the change</summary>
                  <div className="diff-pair">
                    <pre className="mono codebox before">{show(c.before, sources)}</pre>
                    <pre className="mono codebox after">{show(c.after, sources)}</pre>
                  </div>
                </details>
              ) : (
                !["hired", "retired", "rehired"].includes(c.field) && (
                  <span className="muted">
                    {show(c.before, sources)} → {show(c.after, sources)}
                  </span>
                )
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No changes yet.</p>
      )}
    </div>
  );
}

/** What the CEO may change about the team without asking (R62). */
const APPROVALS: Array<[string, string]> = [
  ["hires", "Hires wait for you"],
  ["hires_and_edits", "Hires and instruction changes wait"],
  ["nothing", "Nothing waits; you're told"],
];

function CeoApprovals({ companyId }: { companyId: string }) {
  const current = usePoll((signal) => api<{ approvals: string }>(`/api/companies/${companyId}/agent-approvals`, { signal }), 300_000, `approvals-${companyId}`);
  const [error, setError] = useState<string | null>(null);
  const set = async (approvals: string) => {
    try {
      await api(`/api/companies/${companyId}/agent-approvals`, { method: "PUT", body: { approvals } });
      current.reload();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="field" style={{ maxWidth: 560 }}>
      <label htmlFor="ceo-approvals">When the CEO builds the team</label>
      <select id="ceo-approvals" value={current.data?.approvals ?? "hires"} onChange={(e) => void set(e.target.value)}>
        {APPROVALS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <small className="muted">The CEO can propose hires from the templates and tailor agents' instructions. What waits for you shows in Decisions; anything else you're told about, and can undo from the agent's history.</small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Agents({ company, onChanged }: { company: Company | undefined; onChanged: () => void }) {
  const list = usePoll((signal) => (company ? api<AgentRow[]>(`/api/companies/${company.id}/agents`, { signal }) : Promise.resolve([])), 15_000, `agents-${company?.id ?? "none"}`);
  const templates = usePoll((signal) => api<{ templates: Template[] }>("/api/agent-templates", { signal }), 3_600_000, "agent-templates");
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, "sources");
  const models = usePoll((signal) => (company ? api<ModelLists>(`/api/companies/${company.id}/models`, { signal }) : Promise.resolve(null)), 300_000, `models-${company?.id ?? "none"}`);
  const [hiring, setHiring] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!company) return <p>Create a company on the Kanban first.</p>;
  const changed = (text?: string) => {
    list.reload();
    onChanged();
    if (text) setNote({ ok: true, text });
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      changed(done);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const rows = list.data ?? [];
  const active = rows.filter((a) => !a.retiredAt);
  const retired = rows.filter((a) => a.retiredAt);
  const srcs = sources.data ?? [];
  const row = (a: AgentRow) => {
    const [label, tone] = STATUS[a.status];
    const used = a.fundingKind === "subscription" || !a.month.costMicros ? `${compact(a.month.tokens)} tokens` : usd(a.month.costMicros);
    return (
      <li key={a.id} className="card agent-card">
        <div className="agent-line">
          <div style={{ minWidth: 0 }}>
            <strong>{a.name}</strong>
            {jobOf(a) !== a.name && <span className="muted"> · {jobOf(a)}</span>}
            <div className="muted" style={{ fontSize: 13 }}>
              {a.current ? (
                <>
                  Working on <a href={`#/tickets/${a.current.ticketId}`}>{a.current.title ?? "a ticket"}</a>
                </>
              ) : a.openTickets ? (
                `${a.openTickets} open ticket${a.openTickets === 1 ? "" : "s"}`
              ) : (
                "No open tickets"
              )}
              {" · "}
              <span className="mono">{a.model ?? "default model"}</span> · {a.funding ?? "no funding set"} · this month {a.month.runs} run{a.month.runs === 1 ? "" : "s"}, {used}
            </div>
          </div>
          <div className="agent-actions">
            <span className={`tag ${tone}`}>{label}</span>
            {!a.retiredAt && (
              <button type="button" className="btn" onClick={() => void act(() => api(`/api/agents/${a.id}`, { method: "PATCH", body: { paused: !a.paused } }), a.paused ? `${a.name} started.` : `${a.name} paused.`)}>
                {a.paused ? "Start" : "Pause"}
              </button>
            )}
            <button type="button" className="btn" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              {open === a.id ? "Close" : a.retiredAt ? "History" : "Edit"}
            </button>
            {!a.retiredAt && a.role !== "ceo" && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  window.confirm(`Retire ${a.name}? They stop working, their open tickets go back to unassigned and they stop watching tickets. You can rehire them from their history.`) &&
                  void act(() => api(`/api/agents/${a.id}/retire`, { method: "POST" }), `${a.name} retired.`)
                }
              >
                Retire
              </button>
            )}
          </div>
        </div>
        {open === a.id && <Edit a={a} sources={srcs} lists={models.data} onSaved={() => changed()} />}
      </li>
    );
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Agents</h1>
          <p className="sub">Who works for {company.name}, what each is doing, and what they've used this month. Hire from a role template and tailor the instructions; every change is kept and can be undone.</p>
        </div>
        <button type="button" className="btn primary" aria-expanded={hiring} onClick={() => setHiring(!hiring)}>
          {hiring ? "Close" : "Hire"}
        </button>
      </header>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <CeoApprovals companyId={company.id} />
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Model lists come from the runner when agents run{models.data?.api.length ? ", and from your API keys" : ""}.{" "}
          <button type="button" className="linkish" onClick={() => void api<ModelLists>(`/api/companies/${company.id}/models?refresh=1`).then(() => models.reload())}>
            Refresh
          </button>
        </p>
      </div>
      {hiring && templates.data && (
        <Hire
          companyId={company.id}
          templates={templates.data.templates}
          sources={srcs}
          lists={models.data}
          onDone={(name) => {
            setHiring(false);
            changed(`${name} hired. Give them a ticket on the Kanban, or make them a ticket's watcher.`);
          }}
        />
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
      <ul className="agent-list">{active.map(row)}</ul>
      {retired.length > 0 && (
        <details>
          <summary className="section-label">Retired ({retired.length})</summary>
          <ul className="agent-list">{retired.map(row)}</ul>
        </details>
      )}
    </>
  );
}
