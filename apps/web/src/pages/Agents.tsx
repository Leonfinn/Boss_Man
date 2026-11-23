// Agents (R62): who works for the company, what each is doing and has used this month, and
// hiring from role templates. Every change is kept with what it was before, and can be undone.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { NoCompany } from "../components/NoCompany";
import { Star } from "lucide-react";
import { DAY_NAMES, describeRoles, HARNESSES, isInfiniteModel, reviewRolesOf, SENIOR_DEV_TEMPLATE, THINKING_LEVELS, type ReviewPolicy as SharedPolicy } from "@boss-man/shared";
import { api, usd, type Company, type FundingSource, type ReviewPolicy } from "../api";
import { Avatar } from "../components/Avatar";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { RowMenu } from "../components/RowMenu";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { usePoll } from "../hooks";
import { when } from "./Runs";
import { span } from "./Workflow";
import { buildCsv, download } from "../csv";
import { clearDraft, saveDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { MoreAbout } from "../components/MoreAbout";

type AgentRecord = { days: number; finished: number; passedFirstTime: number; sendBacks: number; medianMergeMs: number | null; costPerFinishedMicros: number | null; recent: Array<{ id: string; ref: string | null; title: string; size: number | null; finishedAt: string; sendBacks: number; costMicros: number }> };
type Template = { id: string; title: string; role: "manager" | "worker"; modelTier: string; summary: string; instructions: string };
export type AgentRow = {
  id: string;
  name: string;
  role: "ceo" | "manager" | "worker";
  title: string | null;
  template: string | null;
  instructions: string | null;
  agentKind: string;
  model: string | null;
  thinking: string | null;
  fundingSourceId: string | null;
  funding: string | null;
  fundingKind: string | null;
  paused: boolean;
  starred: boolean;
  /** BOS-2200: working hours (null: always available), and while outside them, when they open. */
  workingHours?: { days: number[]; start: string; end: string; timeZone: string } | null;
  offUntil?: { at: string; label: string } | null;
  duty: string | null;
  avatarAt?: string | null;
  retiredAt: string | null;
  status: "working" | "idle" | "paused" | "retired";
  current: { ticketId: string; title: string | null } | null;
  openTickets: number;
  /** Tickets in progress, and the owner's limit per agent (null: no limit), for "3 of 2 tickets in progress" (BOS-1029). */
  wipCount?: number;
  wipLimit?: number | null;
  /** BOS-1909: tickets of this agent's that count toward no limit: being checked, and next up in Ready. Missing from an older server. */
  beingChecked?: number;
  nextUp?: number;
  pa: { posted: number; escalated: number; wrong: number } | null;
  month: { costMicros: number; runs: number; tokens: number };
};
type Change = { c: { id: string; field: string; before: unknown; after: unknown; undoneAt: string | null; createdAt: string; byAgentId: string | null }; by: string | null };

type ModelChoice = { value: string; name: string; description?: string | null };
type ModelLists = {
  runner: Record<string, { models: ModelChoice[]; observedAt: string }>;
  api: Array<{ fundingSourceId: string; name: string; provider: string; models: ModelChoice[]; error: string | null }>;
  /** Synthetic's Infinite mode (free, slow) for this funding source (BOS-279); empty for other providers. */
  infinite?: Array<{ fundingSourceId: string; name: string; model: ModelChoice }>;
};
const OTHER = "__other__";
const KINDS: Array<[string, string]> = HARNESSES.map((h) => [h.value, h.label]);
function KindSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {KINDS.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * The model field (R60): Default, then what the agent's kind offers on the runner and what its
 * funding source's API key can use, then Other… for a typed ID.
 */
function ModelPicker({ id, value, onChange, agentKind, fundingSourceId, lists, refresh }: { id: string; value: string; onChange: (v: string) => void; agentKind: string; fundingSourceId: string; lists: ModelLists | null; refresh: () => Promise<string> }) {
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // Asks the runner for the list now, without a chat message (a throwaway session that sends no prompt).
  const refreshButton = (
    <>
      {" "}
      <button
        type="button"
        className="linkish"
        disabled={asking}
        onClick={() => {
          setAsking(true);
          refresh().then(setSaid, (err: Error) => setSaid(err.message)).finally(() => setAsking(false));
        }}
      >
        {asking ? "Asking the runner…" : "Refresh models"}
      </button>
      {said && <span role="status"> {said}</span>}
    </>
  );
  // The adapter's own "default" is the same as leaving the model blank.
  const fromRunner = (lists?.runner[agentKind]?.models ?? []).filter((m) => m.value !== "default");
  const fromApi = lists?.api.find((a) => a.fundingSourceId === fundingSourceId);
  // Infinite mode is its own group, labelled free and slow, so it's never mistaken for a normal model (BOS-279).
  const infinite = agentKind === "opencode" ? lists?.infinite?.find((i) => i.fundingSourceId === fundingSourceId)?.model : undefined;
  const known = [...fromRunner, ...(fromApi?.models ?? []), ...(infinite ? [infinite] : [])].some((m) => m.value === value);
  const [typing, setTyping] = useState(false);
  const [q, setQ] = useState("");
  const match = (m: { value: string; name: string }) => `${m.name} ${m.value}`.toLowerCase().includes(q.trim().toLowerCase());
  const runnerShown = fromRunner.filter(match);
  const apiShown = (fromApi?.models ?? []).filter(match);
  const infiniteShown = infinite && match(infinite) && ![...fromRunner, ...(fromApi?.models ?? [])].some((m) => m.value === infinite.value) ? [infinite] : [];
  const offered = fromRunner.length + (fromApi?.models.length ?? 0) + (infinite ? 1 : 0) > 0;
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
            `No list yet: the runner reports ${agentKind}'s models when it connects with a credential, or on request.`
          )}
          {refreshButton}
        </small>
      </>
    );
  return (
    <>
      <input type="search" className="mono" placeholder="Search models" aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
      <select id={id} value={value} onChange={(e) => (e.target.value === OTHER ? setTyping(true) : onChange(e.target.value))}>
        <option value="">Default</option>
        {/* A full ID still works on Claude (the runner pins it to the opus alias), so it's shown as typed, not refused. */}
        {value && !known && <option value={value}>{value} (typed ID)</option>}
        {/* The chosen model stays listed while a search hides it, so the select still shows it. */}
        {value && known && !runnerShown.concat(apiShown).some((m) => m.value === value) && <option value={value}>{value}</option>}
        {runnerShown.length > 0 && (
          <optgroup label={`Offered by the runner (${agentKind})`}>
            {runnerShown.map((m) => (
              <option key={`r-${m.value}`} value={m.value}>
                {m.name === m.value ? m.value : `${m.name} (${m.value})`}
              </option>
            ))}
          </optgroup>
        )}
        {fromApi && apiShown.length > 0 && (
          <optgroup label={`On ${fromApi.name}'s API key`}>
            {apiShown.map((m) => (
              <option key={`a-${m.value}`} value={m.value}>
                {m.name === m.value ? m.value : `${m.name} (${m.value})`}
              </option>
            ))}
          </optgroup>
        )}
        {infiniteShown.length > 0 && (
          <optgroup label="Synthetic Infinite mode (free, slow, background runs)">
            {infiniteShown.map((m) => (
              <option key={`i-${m.value}`} value={m.value}>
                {m.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>Other…</option>
      </select>
      <small className="muted">
        {q.trim() && `${runnerShown.length + apiShown.length + infiniteShown.length} of ${fromRunner.length + (fromApi?.models.length ?? 0) + (infinite ? 1 : 0)} models match.`}
        {refreshButton}
      </small>
      {fromApi?.error && <small className="error">{fromApi.error}</small>}
    </>
  );
}

/** How hard the model thinks; the run skips a level the model doesn't offer and says so in the runner log. */
function ThinkingField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>Thinking</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default</option>
        {THINKING_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l === "xhigh" ? "Extra high" : l[0]!.toUpperCase() + l.slice(1)}
          </option>
        ))}
      </select>
      <small className="muted">More thinking is slower and uses more tokens. Not every model offers every level; one it doesn't is left at its default.</small>
    </div>
  );
}

export function StarButton({ agent, onToggle, where = "Chat", disabled }: { agent: { name: string; starred: boolean }; onToggle: () => void; where?: string; disabled?: boolean }) {
  return (
    <button type="button" className="btn star" disabled={disabled} aria-pressed={agent.starred} aria-label={`Star ${agent.name}`} title={agent.starred ? `Starred: shown under ${where}` : `Star to show under ${where}`} onClick={onToggle}>
      <Star size={16} aria-hidden="true" fill={agent.starred ? "currentColor" : "none"} />
    </button>
  );
}

const STATUS: Record<AgentRow["status"], [string, string]> = { working: ["Working", "green"], idle: ["Idle", ""], paused: ["Paused", "amber"], retired: ["Retired", ""] };
const FIELD: Record<string, string> = { hired: "Hired", retired: "Retired", rehired: "Rehired", name: "Name", title: "Job title", instructions: "Instructions", model: "Model", thinking: "Thinking", funding: "Paid from", kind: "Agent kind", paused: "Paused", working_hours: "Working hours" };
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const jobOf = (a: Pick<AgentRow, "role" | "title" | "duty">) => (a.role === "ceo" ? "CEO" : (a.title ?? (a.duty === "wiki" ? "Wiki Maintainer" : a.role === "manager" ? "Manager" : "Agent")));
/** Boolean fields read as plain words, e.g. paused true -> "Paused", false -> "Unpaused", not "yes -> no". */
const FLIP: Record<string, [string, string]> = { paused: ["Paused", "Unpaused"], starred: ["Starred", "Unstarred"] };
export const flipWord = (field: string, after: unknown) => (typeof after === "boolean" && FLIP[field] ? FLIP[field]![after ? 0 : 1] : null);
export type Hours = { days: number[]; start: string; end: string; timeZone: string };
const isHours = (v: unknown): v is Hours => !!v && typeof v === "object" && Array.isArray((v as Hours).days) && typeof (v as Hours).start === "string";
export const hoursText = (h: Hours) => `${h.days.map((d) => DAY_NAMES[d]).join(", ")}, ${h.start} to ${h.end} (${h.timeZone})`;
const show = (v: unknown, sources: FundingSource[]) =>
  isHours(v) ? hoursText(v) : v === null || v === undefined || v === "" ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : typeof v === "string" ? (sources.find((s) => s.id === v)?.name ?? v) : JSON.stringify(v);

/** The listed agents as a spreadsheet: funding source by name only, working hours as days, times and zone. */
export function agentsToCsv(rows: AgentRow[]): string {
  return buildCsv(
    ["name", "role", "job_title", "model", "thinking", "funding_source", "state", "working_days", "working_from", "working_to", "working_time_zone"],
    rows.map((a) => [
      a.name,
      a.role,
      jobOf(a),
      a.model ?? "default",
      a.thinking ?? "",
      a.funding ?? "",
      a.status,
      a.workingHours ? a.workingHours.days.map((d) => DAY_NAMES[d] ?? d).join(" ") : "",
      a.workingHours?.start ?? "",
      a.workingHours?.end ?? "",
      a.workingHours?.timeZone ?? "",
    ]),
  );
}

function Hire({ companyId, templates, sources, lists, refresh, onDone }: { companyId: string; templates: Template[]; sources: FundingSource[]; lists: ModelLists | null; refresh: () => Promise<string>; onDone: (name: string) => void }) {
  const [tpl, setTpl] = useState<Template | null>(null);
  const [form, setForm] = useState({ name: "", title: "", instructions: "", model: "", thinking: "", fundingSourceId: "", agentKind: "claude" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The instructions box is kept in this browser as it is typed (DR-045); it goes once the hire goes
  // through, and Cancel/the sheet closing keeps it on purpose.
  const instructionsKey = `hire-instructions/${companyId}`;
  const choose = (t: Template | null) => {
    setTpl(t);
    // Swap the name along with the template unless the owner typed their own.
    setForm({ ...form, name: form.name === (tpl?.title ?? "") ? (t?.title ?? "") : form.name, title: t?.title ?? "", instructions: t?.instructions ?? "" });
    saveDraft(instructionsKey, t?.instructions ?? "");
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
          thinking: form.thinking || null,
          fundingSourceId: form.fundingSourceId || null,
          agentKind: form.agentKind,
        },
      });
      clearDraft(instructionsKey);
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
          <label htmlFor="hire-kind">Agent</label>
          <KindSelect id="hire-kind" value={form.agentKind} onChange={(agentKind) => setForm({ ...form, agentKind, model: "" })} />
        </div>
        <div className="field">
          <label htmlFor="hire-model">Model</label>
          <ModelPicker id="hire-model" value={form.model} onChange={(model) => setForm({ ...form, model })} agentKind={form.agentKind} fundingSourceId={form.fundingSourceId} lists={lists} refresh={refresh} />
          <small className="muted">{tpl ? `Suggested: a ${tpl.modelTier} model. ` : ""}Blank uses the agent's default.</small>
        </div>
        <ThinkingField id="hire-thinking" value={form.thinking} onChange={(thinking) => setForm({ ...form, thinking })} />
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
        <DraftTextarea draftKey={instructionsKey} id="hire-instructions" rows={7} value={form.instructions} onChange={(text) => setForm({ ...form, instructions: text })} />
        <small className="muted">Given to the agent at the start of every run. Tailor them to your company.</small>
      </div>
      <small className="muted">
        Who does code, security, infra and adversarial reviews is chosen in <a href={`#/settings/${companyId}/reviews`}>Settings › Reviews</a>. A Senior Developer hire takes the cells set to Senior Developer; name any other reviewer there.
      </small>
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

/** The agent's picture: the template's portrait until the owner uploads one. */
function Picture({ a, run }: { a: AgentRow; run: (fn: () => Promise<unknown>, done: string) => Promise<boolean> }) {
  const url = `/api/agents/${a.id}/avatar`;
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024) return void run(() => Promise.reject(new Error("The picture must be 256 KB or smaller.")), "");
    const r = new FileReader();
    r.onload = () => void run(() => api(url, { method: "PUT", body: { data: String(r.result).split(",")[1] ?? "" } }), "Picture saved.");
    r.readAsDataURL(file);
  };
  return (
    <div className="field" style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Avatar agent={a} className={`huge ${a.role}`} />
      <label className="btn small" style={{ cursor: "pointer" }}>
        Upload a picture
        <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label={`Picture for ${a.name}`} onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {a.avatarAt && (
        <button type="button" className="btn small" onClick={() => window.confirm(`Remove ${a.name}'s picture? You would have to upload it again to get it back.`) && void run(() => api(url, { method: "DELETE" }), "Back to the default picture.")}>
          Use the default
        </button>
      )}
      <small className="muted">PNG, JPEG or WebP, up to 256 KB. Square works best.</small>
    </div>
  );
}

type HoursForm = { on: boolean; days: number[]; start: string; end: string; timeZone: string };
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const hoursForm = (h: Hours | null | undefined): HoursForm => (h ? { on: true, ...h } : { on: false, days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", timeZone: browserZone() });

/** BOS-2200: off by default (always available); when on, days, a from-to time (it may cross midnight) and a time zone. */
export function WorkingHoursField({ id, name, value, onChange }: { id: string; name: string; value: HoursForm; onChange: (v: HoursForm) => void }) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label">Working hours</legend>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        Only start {name} on new work during set hours
      </label>
      {value.on && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <div role="group" aria-label="Days" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {DAY_NAMES.map((d, i) => (
              <label key={d} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="checkbox" checked={value.days.includes(i)} onChange={(e) => onChange({ ...value, days: e.target.checked ? [...value.days, i] : value.days.filter((x) => x !== i) })} />
                {d}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <label htmlFor={`${id}-from`}>
              From <input id={`${id}-from`} type="time" required value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
            </label>
            <label htmlFor={`${id}-to`}>
              To <input id={`${id}-to`} type="time" required value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
            </label>
            <label htmlFor={`${id}-zone`}>
              Time zone <input id={`${id}-zone`} required maxLength={80} value={value.timeZone} onChange={(e) => onChange({ ...value, timeZone: e.target.value })} />
            </label>
          </div>
        </div>
      )}
      <small className="muted">
        {value.on
          ? `Outside these hours ${name} isn't started on new work; it starts by itself when they open. A run already going finishes, and urgent tickets and your replies still start it. Use a "to" earlier than "from" for a window past midnight (22:00 to 07:00); it belongs to the day it starts on.`
          : `Off: ${name} is available at any time.`}
      </small>
    </fieldset>
  );
}

function Edit({ a, sources, lists, refresh, onSaved, template, policy }: { a: AgentRow; sources: FundingSource[]; lists: ModelLists | null; refresh: () => Promise<string>; onSaved: () => void; template?: { title: string; instructions: string }; policy?: { rules: ReviewPolicy; companyId: string } | null }) {
  const [form, setForm] = useState({ name: a.name, title: a.title ?? "", instructions: a.instructions ?? "", model: a.model ?? "", thinking: a.thinking ?? "", fundingSourceId: a.fundingSourceId ?? "", agentKind: a.agentKind, hours: hoursForm(a.workingHours) });
  // The instructions box is kept in this browser as it is typed (DR-045); it goes once saved.
  const instructionsKey = `agent-instructions/${a.id}`;
  const history = usePoll((signal) => api<Change[]>(`/api/agents/${a.id}/history`, { signal }), 60_000, `history-${a.id}`);
  const record = usePoll((signal) => api<AgentRecord>(`/api/agents/${a.id}/record`, { signal }), 60_000, `record-${a.id}`);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const sv = useSaveState(form);
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNote({ ok: true, text: done });
      history.reload();
      onSaved();
      return true;
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
      return false;
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: form.name.trim(), title: form.title.trim() || null, instructions: form.instructions.trim() || null, model: form.model.trim() || null, thinking: form.thinking || null, fundingSourceId: form.fundingSourceId || null, agentKind: form.agentKind, workingHours: form.hours.on ? { days: [...form.hours.days].sort(), start: form.hours.start, end: form.hours.end, timeZone: form.hours.timeZone.trim() } : null };
    if (form.hours.on && !form.hours.days.length) {
      setNote({ ok: false, text: "Choose at least one day for the working hours." });
      return;
    }
    setBusy(true);
    const ok = await run(() => api(`/api/agents/${a.id}`, { method: "PATCH", body }), "Saved.");
    setBusy(false);
    if (ok) {
      sv.markSaved();
      clearDraft(instructionsKey);
    }
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
            {a.role !== "ceo" && policy?.rules.medium && (
              // Read-only: Settings > Reviews is the one place that says who reviews (BOS-198).
              <div className="field">
                <span className="label">Reviews</span>
                <p style={{ margin: 0 }}>
                  {describeRoles(reviewRolesOf(policy.rules as SharedPolicy, a.id, a.template === SENIOR_DEV_TEMPLATE))} <a href={`#/settings/${policy.companyId}/reviews`}>Change in Settings › Reviews</a>
                </p>
              </div>
            )}
            <div className="field">
              <label htmlFor={`kind-${a.id}`}>Agent</label>
              <KindSelect id={`kind-${a.id}`} value={form.agentKind} onChange={(agentKind) => setForm({ ...form, agentKind, model: "" })} />
            </div>
            <div className="field">
              <label htmlFor={`model-${a.id}`}>Model</label>
              <ModelPicker id={`model-${a.id}`} value={form.model} onChange={(model) => setForm({ ...form, model })} agentKind={form.agentKind} fundingSourceId={form.fundingSourceId} lists={lists} refresh={refresh} />
            </div>
            <ThinkingField id={`thinking-${a.id}`} value={form.thinking} onChange={(thinking) => setForm({ ...form, thinking })} />
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
          <WorkingHoursField id={`hours-${a.id}`} name={a.name} value={form.hours} onChange={(hours) => setForm({ ...form, hours })} />
          <div className="field">
            <label htmlFor={`instructions-${a.id}`}>Instructions</label>
            <DraftTextarea draftKey={instructionsKey} id={`instructions-${a.id}`} rows={6} value={form.instructions} onChange={(text) => setForm({ ...form, instructions: text })} />
            <small className="muted">{a.role === "ceo"
                ? "The CEO picks up new instructions in its next chapter (Settings › Team and CEO › CEO chapters)."
                : a.duty === "wiki"
                  ? "Boss Man gives the wiki maintainer its job in every run (the Index, Log, Status pages, filing finished work, the health check). Add only extra house rules here; they're used from its next run."
                  : "Used from the agent's next run."}</small>
            {template && form.instructions.trim() !== template.instructions.trim() && (
              <button type="button" className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => { setForm({ ...form, instructions: template.instructions }); saveDraft(instructionsKey, template.instructions); }}>
                {form.instructions.trim() ? `Replace with the current ${template.title} template` : `Fill in from the ${template.title} template`}
              </button>
            )}
          </div>
          <SaveButton {...sv} busy={busy} style={{ alignSelf: "flex-start" }} />
        </form>
      )}
      {!retired && <Picture a={a} run={run} />}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
      <details>
        <summary className="section-label">Record (last 30 days)</summary>
        {record.data ? (
          record.data.finished === 0 ? (
            <p className="muted">Nothing finished in the last 30 days</p>
          ) : (
            <>
              <p>
                {record.data.finished} finished · {record.data.passedFirstTime} passed review first time · {record.data.sendBacks} send-backs · median {span(record.data.medianMergeMs)} to merge · {usd(record.data.costPerFinishedMicros ?? 0)} per finished ticket
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Title</th>
                    <th>Size</th>
                    <th>Finished</th>
                    <th>Send-backs</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {record.data.recent.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <a href={`#/tickets/${t.id}`}>{t.ref ?? "a task"}</a>
                      </td>
                      <td>{t.title}</td>
                      <td>{t.size ?? "–"}</td>
                      <td>{when(t.finishedAt)}</td>
                      <td>{t.sendBacks}</td>
                      <td>{usd(t.costMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : record.error ? (
          <LoadError what="the record" message={record.error.message} onRetry={record.reload} />
        ) : (
          <Loader label="Loading record" size={16} />
        )}
      </details>
      <h3 className="section-label">History</h3>
      {history.data?.length ? (
        <ol className="history">
          {history.data.map(({ c, by }) => (
            <li key={c.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span>
                  <strong>{flipWord(c.field, c.after) ?? FIELD[c.field] ?? c.field}</strong> <span className="muted">by {by ?? "you"}, {when(c.createdAt)}</span>
                  {c.undoneAt && <span className="tag" style={{ marginLeft: 6 }}>Undone</span>}
                </span>
                {!c.undoneAt && c.field !== "hired" && c.field !== "rehired" && (
                  <button
                    type="button"
                    className="btn"
                    style={{ minHeight: 32, padding: "4px 10px" }}
                    disabled={undoing}
                    onClick={() => {
                      setUndoing(true);
                      void run(() => api(`/api/agent-changes/${c.id}/undo`, { method: "POST" }), c.field === "retired" ? "Rehired, with their tasks back." : "Undone.").finally(() => setUndoing(false));
                    }}
                  >
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
                !["hired", "retired", "rehired"].includes(c.field) && !flipWord(c.field, c.after) && (
                  <span className="muted">
                    {show(c.before, sources)} → {show(c.after, sources)}
                  </span>
                )
              )}
            </li>
          ))}
        </ol>
      ) : history.data ? (
        <p className="muted">No changes yet.</p>
      ) : history.error ? (
        <LoadError what="the history" message={history.error.message} onRetry={history.reload} />
      ) : (
        <Loader label="Loading history" size={16} />
      )}
    </div>
  );
}

type AgentNote = { id: string; title: string; text: string; why: string; source: "chat" | "ticket" | "owner" | "request"; requestedBy: string | null; ticketId: string | null; ticketRef: string | null; updatedAt: string; reviewBy: string | null; ageDays: number; reviewDue: boolean; reviewReason: string | null };
type NoteRequest = { id: string; title: string; text: string; why: string; from: string; ticketId: string; ticketRef: string | null; status: "pending" | "accepted" | "declined"; declineReason: string | null; createdAt: string };

/** Where a note came from, for the owner. */
function NoteOrigin({ n }: { n: AgentNote }) {
  if (n.source === "owner") return <>written by you</>;
  if (n.source === "chat") return <>saved by the CEO from your chat</>;
  if (n.source === "ticket")
    return (
      <>
        saved by the CEO from your message on {n.ticketId ? <a href={`#/tickets/${n.ticketId}`}>{n.ticketRef ?? "a task"}</a> : "a task"}
      </>
    );
  return (
    <>
      asked by {n.requestedBy ?? "a former agent"}
      {n.ticketId && (
        <>
          {" "}
          on <a href={`#/tickets/${n.ticketId}`}>{n.ticketRef ?? "a task"}</a>
        </>
      )}
      , accepted by the CEO
    </>
  );
}
type NoteLimits = { count: number; title: number; text: number; why: number };

/** One note's fields, for adding or editing. */
function NoteForm({ id, start, limits, onSave, onCancel }: { id: string; start: { title: string; text: string; why: string; reviewBy: string | null }; limits: NoteLimits; onSave: (f: { title: string; text: string; why: string; reviewBy: string | null }) => Promise<boolean>; onCancel?: () => void }) {
  const [f, setF] = useState({ title: start.title, text: start.text, why: start.why, reviewBy: start.reviewBy });
  // The note text is kept in this browser as it is typed (DR-045); it goes once the note is saved.
  const textKey = `agent-note/${id}`;
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ title: f.title.trim(), text: f.text.trim(), why: f.why.trim(), reviewBy: f.reviewBy || null }).then((ok) => {
          if (!ok) return;
          clearDraft(textKey);
          if (!onCancel) setF({ title: "", text: "", why: "", reviewBy: null });
        });
      }}
    >
      <div className="field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input id={`${id}-title`} maxLength={limits.title} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-text`}>Note</label>
        <DraftTextarea draftKey={textKey} id={`${id}-text`} rows={2} maxLength={limits.text} value={f.text} onChange={(text) => setF({ ...f, text })} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-why`}>Why (what you said)</label>
        <input id={`${id}-why`} maxLength={limits.why} value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-review`}>Review by (optional)</label>
        <input id={`${id}-review`} type="date" value={f.reviewBy ?? ""} onChange={(e) => setF({ ...f, reviewBy: e.target.value || null })} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn primary">
          {onCancel ? "Save" : "Add note"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The CEO's lasting notes from the chat (BOS-85): what it keeps between chats and runs, which the owner can change. */
function CeoNotes({ agentId }: { agentId: string }) {
  const notes = usePoll((signal) => api<{ items: AgentNote[]; requests?: NoteRequest[]; limits: NoteLimits }>(`/api/agents/${agentId}/notes`, { signal }), 60_000, `notes-${agentId}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const items = notes.data?.items ?? [];
  const limits = notes.data?.limits;
  // Accepted requests already show as notes.
  const open = (notes.data?.requests ?? []).filter((r) => r.status !== "accepted");
  const waiting = open.filter((r) => r.status === "pending").length;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      notes.reload();
      setMsg({ ok: true, text: done });
      return true;
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
      return false;
    }
  };
  // Before the first answer the section keeps its heading, with the loader or the error, so a
  // missing load never reads as "no notes" (BOS-2279). A failed re-poll keeps the last list.
  if (!limits)
    return (
      <div className="agent-notes">
        <h3 className="section-label">CEO notes</h3>
        {notes.error ? <LoadError what="the CEO notes" message={notes.error.message} onRetry={notes.reload} /> : <Loader label="Loading CEO notes" size={16} />}
      </div>
    );
  return (
    <details className="agent-notes">
      <summary className="section-label">
        CEO notes ({items.length} of {limits.count}){waiting ? ` · ${waiting} request${waiting === 1 ? "" : "s"} waiting` : ""}
      </summary>
      <small className="muted">
        Corrections and preferences the CEO saved from what you told it in chat, and requests from the team it accepted. It reads them at the start of every chat and run. You're told in the chat when it saves one. Up to {limits.count} notes; when full, it must update or remove one before saving another. These are separate from its instructions.
      </small>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "muted" : "error"}>
          {msg.text}
        </p>
      )}
      {items.length ? (
        <ul className="history">
          {items.map((n) =>
            editing === n.id ? (
              <li key={n.id}>
                <NoteForm id={`note-${n.id}`} start={n} limits={limits} onCancel={() => setEditing(null)} onSave={(f) => run(() => api(`/api/agent-notes/${n.id}`, { method: "PATCH", body: f }), "Note saved.").then((ok) => (ok && setEditing(null), ok))} />
              </li>
            ) : (
              <li key={n.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong>{n.title}</strong>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button type="button" className="btn" style={{ minHeight: 32, padding: "4px 10px" }} aria-label={`Edit note: ${n.title}`} onClick={() => setEditing(n.id)}>
                      Edit
                    </button>
                    <button type="button" className="btn" style={{ minHeight: 32, padding: "4px 10px" }} aria-label={`Delete note: ${n.title}`} onClick={() => window.confirm(`Delete the note "${n.title}"?`) && void run(() => api(`/api/agent-notes/${n.id}`, { method: "DELETE" }), "Note deleted.")}>
                      Delete
                    </button>
                  </span>
                </div>
                <div>{n.text}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Why: “{n.why}” · <NoteOrigin n={n} />, {when(n.updatedAt)} ({n.ageDays === 0 ? "today" : `${n.ageDays} d ago`}){n.reviewBy ? ` · review by ${n.reviewBy}` : ""}
                  {n.reviewDue && (
                    <strong className="error"> · Review due: {n.reviewReason}</strong>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="muted">No notes yet.</p>
      )}
      {open.length > 0 && (
        <>
          <h4 className="section-label">Requests from the team</h4>
          <small className="muted">Other agents can ask the CEO to keep a note; only the CEO can accept or decline. Each agent can ask at most a few times an hour.</small>
          <ul className="history">
            {open.map((r) => (
              <li key={r.id}>
                <strong>{r.title}</strong> <span className={`tag ${r.status === "pending" ? "amber" : ""}`}>{r.status === "pending" ? "Waiting for the CEO" : "Declined"}</span>
                <div>{r.text}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  From {r.from} on <a href={`#/tickets/${r.ticketId}`}>{r.ticketRef ?? "a task"}</a>, {when(r.createdAt)} · Why: {r.why}
                  {r.declineReason && <> · Declined: {r.declineReason}</>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {items.length < limits.count && <NoteForm id={`note-new-${agentId}`} start={{ title: "", text: "", why: "", reviewBy: null }} limits={limits} onSave={(f) => run(() => api(`/api/agents/${agentId}/notes`, { method: "POST", body: f }), "Note added.")} />}
    </details>
  );
}


export function Agents({ company, agentId, onChanged }: { company: Company | undefined; agentId?: string; onChanged: () => void }) {
  const list = usePoll((signal) => (company ? api<AgentRow[]>(`/api/companies/${company.id}/agents`, { signal }) : Promise.resolve([])), 15_000, `agents-${company?.id ?? "none"}`);
  const templates = usePoll((signal) => api<{ templates: Template[]; ceo?: Omit<Template, "role"> }>("/api/agent-templates", { signal }), 3_600_000, "agent-templates");
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, "sources");
  const models = usePoll((signal) => (company ? api<ModelLists>(`/api/companies/${company.id}/models`, { signal }) : Promise.resolve(null)), 300_000, `models-${company?.id ?? "none"}`);
  const reviewPolicy = usePoll((signal) => (company ? api<ReviewPolicy>(`/api/companies/${company.id}/review-policy`, { signal }) : Promise.resolve(null)), 60_000, `agent-reviews-${company?.id ?? "none"}`);
  const [hiring, setHiring] = useState(false);
  // #/agents/<id> (the search box, BOS-2347) opens that agent's panel. App remounts the page on every address
  // change, so the first value is enough; the panel is scrolled into view once the list has drawn it.
  const [open, setOpen] = useState<string | null>(agentId ?? null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = useRef(false);
  useEffect(() => {
    if (!agentId || shown.current || !list.data) return;
    const panel = document.getElementById(`agent-panel-${agentId}`);
    if (!panel) return;
    shown.current = true;
    panel.closest("li")?.scrollIntoView?.({ block: "start" });
  }, [agentId, list.data]);
  if (!company) return <NoCompany />;
  const refreshModels = async () => {
    const r = await api<{ probed: Record<string, { ok: boolean; error?: string }> }>(`/api/companies/${company!.id}/models/refresh`, { method: "POST" });
    models.reload();
    const bad = Object.entries(r.probed).filter(([, v]) => !v.ok);
    if (bad.length) return bad.map(([k, v]) => `${k}: ${v.error}`).join(" ");
    return Object.keys(r.probed).length ? "Updated." : "Nothing to ask: the runner is offline, or the company has no Claude or OpenAI credential.";
  };
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
  const rows = (list.data ?? []).filter((a) => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [a.name, a.role, a.title, jobOf(a), a.model].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const active = rows.filter((a) => !a.retiredAt);
  const retired = rows.filter((a) => a.retiredAt);
  const srcs = sources.data ?? [];
  const row = (a: AgentRow) => {
    const [label, tone] = STATUS[a.status];
    const used = a.fundingKind === "subscription" || !a.month.costMicros ? `${compact(a.month.tokens)} tokens` : usd(a.month.costMicros);
    return (
      <li key={a.id} className="card agent-card">
        <div
          className="agent-line"
          onClick={(e) => {
            // A click on the card itself opens the row too, but never one meant for a link, button or the menu.
            if ((e.target as HTMLElement).closest("a, button, input, select, textarea, [role=menu]")) return;
            setOpen(open === a.id ? null : a.id);
          }}
        >
          <Avatar agent={a} className={`big ${a.role}`} />
          <div className="agent-head">
            <button type="button" className="agent-name" aria-expanded={open === a.id} aria-controls={`agent-panel-${a.id}`} onClick={() => setOpen(open === a.id ? null : a.id)}>
              {a.name}
            </button>
            {a.starred && !a.retiredAt && <Star size={14} className="agent-star" aria-label="Starred" fill="currentColor" />}
            {jobOf(a) !== a.name && <span className="muted agent-job">{jobOf(a)}</span>}
            <span className={`pill ${tone || "grey"} ${a.status}`}>
              <span className="pill-mark" aria-hidden="true" />
              {label}
            </span>
          </div>
          <div className="agent-actions">
            {!a.retiredAt && (
              <button type="button" className="btn" onClick={() => void act(() => api(`/api/agents/${a.id}`, { method: "PATCH", body: { paused: !a.paused } }), a.paused ? `${a.name} started.` : `${a.name} paused.`)}>
                {a.paused ? "Start" : "Pause"}
              </button>
            )}
            {a.retiredAt ? (
              <button type="button" className="btn" aria-expanded={open === a.id} aria-controls={`agent-panel-${a.id}`} onClick={() => setOpen(open === a.id ? null : a.id)}>
                {open === a.id ? "Close" : "History"}
              </button>
            ) : (
              <RowMenu
                label={`More for ${a.name}`}
                heading={a.name}
                subheading={jobOf(a) !== a.name ? jobOf(a) : undefined}
                items={[
                  { label: `Edit ${a.name}`, hint: "Name, model, instructions and history", onSelect: () => setOpen(a.id) },
                  {
                    label: a.starred ? `Unstar ${a.name}` : `Star ${a.name}`,
                    hint: a.starred ? "Stop showing under Chat" : "Show under Chat in the menu",
                    onSelect: () => void act(() => api(`/api/agents/${a.id}`, { method: "PATCH", body: { starred: !a.starred } }), a.starred ? `${a.name} unstarred.` : `${a.name} starred.`),
                  },
                  ...(a.role !== "ceo"
                    ? [
                        {
                          label: `Retire ${a.name}…`,
                          hint: "Asks first. Their tasks go back to unassigned.",
                          danger: true,
                          dividerBefore: true,
                          onSelect: () =>
                            window.confirm(`Retire ${a.name}? They stop working, their open tasks go back to unassigned and they stop watching tasks. You can rehire them from their history.`) &&
                            void act(() => api(`/api/agents/${a.id}/retire`, { method: "POST" }), `${a.name} retired.`),
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </div>
          <div className="agent-body">
            <div className="agent-doing">
              {a.current ? (
                <>
                  Working on <a href={`#/tickets/${a.current.ticketId}`}>{a.current.title ?? "a task"}</a>
                </>
              ) : a.openTickets ? (
                `${a.openTickets} open task${a.openTickets === 1 ? "" : "s"}`
              ) : (
                "No open tasks"
              )}
              {a.wipLimit != null && a.wipCount !== undefined && (
                <>
                  {" · "}
                  <span title="Tickets in progress, against the limit per agent set in Settings" className={a.wipCount > a.wipLimit ? "over-limit" : undefined}>
                    {a.wipCount} of {a.wipLimit} tickets in progress{a.wipCount > a.wipLimit ? ", over the limit" : ""}
                  </span>
                  {!!a.beingChecked && <span title="Handed in, waiting for the quick check. Counts toward no limit."> · {a.beingChecked} being checked</span>}
                  {!!a.nextUp && <span title="Waiting in Ready; starts by itself when the agent finishes. Counts toward no limit."> · {a.nextUp} next up</span>}
                </>
              )}
              {isInfiniteModel(a.model) && (
                <>
                  {" "}
                  <span className="tag" title="Synthetic Infinite mode: free (doesn't spend the plan's credits) and slow. Runs in the background slots from Settings › Server and runner › Limits and checks › Agents at once.">
                    Infinite mode · free, slow
                  </span>
                </>
              )}
            </div>
            <div className="muted agent-stats">
              <span className="mono">{a.model ?? "default model"}</span>{a.thinking ? `, ${a.thinking} thinking` : ""} · {a.funding ?? "No account to run on yet"} · this month {a.month.runs} run{a.month.runs === 1 ? "" : "s"}, {used}
            </div>
            {a.offUntil && !a.retiredAt && (
              <div className="muted agent-stats" data-testid={`off-until-${a.id}`}>
                Off until {a.offUntil.label} (working hours)
              </div>
            )}
            {a.pa && (
              <div className="muted agent-stats">
                Answers: {a.pa.posted} posted, {a.pa.escalated} passed to the CEO
                {a.pa.posted + a.pa.escalated > 0 && ` (${Math.round((a.pa.escalated / (a.pa.posted + a.pa.escalated)) * 100)}%)`}, {a.pa.wrong} marked wrong
              </div>
            )}
          </div>
        </div>
        {a.role === "ceo" && !a.retiredAt && <CeoNotes agentId={a.id} />}
        {open === a.id && (
          <div id={`agent-panel-${a.id}`}>
            <Edit a={a} sources={srcs} lists={models.data} refresh={refreshModels} onSaved={() => changed()} template={a.role === "ceo" ? templates.data?.ceo : templates.data?.templates.find((t) => t.id === a.template)} policy={reviewPolicy.data && company ? { rules: reviewPolicy.data, companyId: company.id } : null} />
          </div>
        )}
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
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          CEO approval rules: change in <a href={`#/settings/${company.id}/team`}>Settings → Team and CEO</a>
        </p>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Model lists come from the runner when agents run{models.data?.api.length ? ", and from your API keys" : ""}.{" "}
          <button
            type="button"
            className="linkish"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              setNote(null);
              api<ModelLists>(`/api/companies/${company.id}/models?refresh=1`)
                .then(() => models.reload())
                .catch((err) => setNote({ ok: false, text: `Couldn't refresh the model lists: ${(err as Error).message}` }))
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </p>
      </div>
      {hiring && templates.data && (
        <Hire
          companyId={company.id}
          templates={templates.data.templates}
          sources={srcs}
          lists={models.data}
          refresh={refreshModels}
          onDone={(name) => {
            setHiring(false);
            changed(`${name} hired. Give them a task on the Kanban, or make them a task's watcher.`);
          }}
        />
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
      {!list.data && list.error && <LoadError what="agents" message={list.error.message} onRetry={list.reload} />}
      {!list.data && !list.error && <Loader label="Loading agents" />}
      {list.data && list.data.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input type="search" placeholder="Filter agents" aria-label="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button
            type="button"
            className="btn"
            disabled={!rows.length}
            onClick={() => download(`agents-${company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-${new Date().toISOString().slice(0, 10)}.csv`, agentsToCsv(rows))}
          >
            Download CSV
          </button>
        </div>
      )}
      {list.data && filter.trim() && rows.length === 0 && (
        <p className="muted">
          No agents match "{filter.trim()}".{" "}
          <button type="button" className="btn" onClick={() => setFilter("")}>
            Clear search
          </button>
        </p>
      )}
      {list.data && <ul className="agent-list">{active.map(row)}</ul>}
      {retired.length > 0 && (
        <details>
          <summary className="section-label">Retired ({retired.length})</summary>
          <ul className="agent-list">{retired.map(row)}</ul>
        </details>
      )}
    </>
  );
}
