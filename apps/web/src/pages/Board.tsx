import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, FEATURE_STATUSES, FEATURE_STATUS_LABEL, RISKS, type Board as BoardData, type Company, type Feature, type FeatureStatus, type Project, type Risk, type ScoredFeatures } from "../api";
import { ticketRef, type Criterion } from "@boss-man/shared";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { art } from "../brand";
import { RiskHelp, useRiskTiers, type RiskTiers } from "../components/RiskHelp";
import { State } from "../components/State";
import { usePoll } from "../hooks";
import { DRAFT_CHANGED, clearDraft, readDraftJson, saveFormDraft } from "../drafts";
import { away } from "../server-watch";
import { GoalSelect, STATUS_TONE, type GoalLink, type Tree } from "./Features";
import { StarButton } from "./Agents";
import { ProjectBudget } from "./ProjectBudget";
import { WatchdogHealth } from "../components/WatchdogHealth";
import { ArchiveProject, ProjectBrief, ProjectRow } from "./Settings";
import { Avatar } from "../components/Avatar";
import { RunLabelLink } from "./Runs";
import { ago } from "./Dashboard";

const DONE_SHOWN = 8;
const PROJECT_TABS = [
  { id: "kanban", label: "Kanban" },
  { id: "budget", label: "Budget" },
  { id: "config", label: "Config" },
] as const;
const projectTab = (s: string | undefined) => PROJECT_TABS.find((t) => t.id === s)?.id ?? "kanban";

/** What a column is called until the owner renames it (the server's DEFAULT_COLUMNS). */
const DEFAULT_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Review", done: "Done" };
/** One line shown in a column with no tasks. */
const EMPTY_HINT: Record<string, string> = {
  backlog: "Nothing waiting. Add a task to start.",
  ready: "Nothing ready. Move a task here when it can start.",
  in_progress: "Nothing underway right now.",
  blocked: "Nothing is stuck.",
  review: "Nothing to review.",
  done: "Nothing finished yet.",
};
const PENCIL = <path d="M4 20h4L19 9l-4-4L4 16z" />;
const iconProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** "25m", "3h", "2d": how long since the ticket last moved (there is no per-column timestamp, so this is its last activity). */
function age(iso: string | undefined, now = Date.now()) {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
/** The card footer's time: how long the run has been going ("23m"), or "now" in its first minute. */
export function workingFor(since: string | null | undefined, now = Date.now()) {
  const a = age(since ?? undefined, now);
  return !a || a === "0m" ? "now" : a;
}
/** "today", "3 days ago": for the done list. */
function when(iso: string | undefined, now = Date.now()) {
  if (!iso) return "";
  const d = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/** One-field inline form that renames a column. Escape cancels. */
function RenameColumn({ col, onSave, onCancel }: { col: BoardData["columns"][number]; onSave: (name: string) => Promise<unknown>; onCancel: () => void }) {
  const [name, setName] = useState(col.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `rename-${col.id}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(name.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="rename" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <label htmlFor={id}>Column name</label>
      <input id={id} autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <span className="lane-hint">
        Agents still see <span className="mono">{col.systemState}</span>
      </span>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A one-field form: the board's onboarding steps and "new ticket" all look like this. */
export function QuickAdd({ label, button, onAdd }: { label: string; button: string; onAdd: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `quick-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onAdd(value.trim());
      setValue("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
      <div className="field" style={{ flex: "1 1 220px" }}>
        <label htmlFor={id}>{label}</label>
        <input id={id} value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <button className="btn primary" type="submit" disabled={busy}>
        {button}
      </button>
      {error && (
        <p className="error" role="alert" style={{ flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </form>
  );
}

type NewTicketInput = { title: string; body: string | null; risk: Risk | null; planFirst: boolean; assigneeAgentId: string | null; assignedToOwner: boolean; featureId: string | null; acceptanceCriteria?: Criterion[] };
type NewFeatureInput = { title: string; description: string | null; planWithCeo: boolean } & GoalLink;
/** What the add form was opened for: a feature, or a task (optionally inside one feature). */
type Adding = { mode: "feature" | "task"; featureId: string };

/**
 * The New task / New feature form, one draft per project and form type (BOS-773): a reload or the
 * "please reload" prompt must not take what the owner wrote. The draft goes only once the task or
 * feature is created, or the owner presses Discard; Cancel keeps it on purpose.
 */
type FormDraft = { mode: "feature" | "task"; title: string; body: string; risk: Risk | "none"; assignee: string; feature: string; plan: boolean; goal: GoalLink; criteria: string; after: number[]; attached: string[] };

/** Add form: a new feature (the top-level card) or a new task, optionally part of a feature. */
function AddForm({ companyId, projectId, initial, agents, features, goals, tiers, hasCeo, onAddTask, onAddFeature, onGrill, onClose }: { companyId: string; projectId: string; initial: Adding; agents: Company["agents"]; features: Feature[]; goals: Tree; tiers: RiskTiers; hasCeo: boolean; onAddTask: (t: NewTicketInput) => Promise<unknown>; onAddFeature: (f: NewFeatureInput) => Promise<unknown>; onGrill: (d: { kind: "task" | "feature"; title: string; description: string | null }) => Promise<unknown>; onClose: () => void }) {
  const blank = { title: "", body: "", risk: "none" as Risk | "none", assignee: "", feature: initial.featureId, plan: hasCeo, goal: { objectiveId: null, milestoneId: null } as GoalLink, criteria: "", after: new Set<number>() };
  const draftKey = (mode: "feature" | "task") => `new-${mode}/${companyId}/${projectId}`;
  // Restoring is worked out once, before the first save, or the save would write the blank form over it.
  const [mode, setMode] = useState(initial.mode);
  const [restored, setRestored] = useState(() => readDraftJson<FormDraft>(draftKey(initial.mode)));
  const [form, setForm] = useState(() => (restored ? { ...blank, ...restored, goal: restored.goal ?? blank.goal, after: new Set(restored.after ?? []) } : blank));
  const img = useImageAttach(companyId);
  // A restored draft keeps its attached files: they are already uploaded, so their links go back with it.
  // After the first render, so it is this form's attachment state and not the hook's opening order.
  useEffect(() => {
    if (restored?.attached?.length) img.setAttached(restored.attached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Set while switching tabs: the save effect must not run for the swapped-over form, or the tab
  // being left could save its text under the key of the one being opened.
  const reading = useRef(false);
  const isFeature = mode === "feature";
  // What the form holds that is worth keeping; an untouched form has no draft at all.
  const settingsTouched = form.assignee !== "" || form.risk !== "none" || form.plan !== blank.plan || !!form.goal.objectiveId || !!form.goal.milestoneId;
  const filled = () => !!(form.title.trim() || form.body.trim() || form.criteria.trim() || settingsTouched || img.attached.length);
  // Kept as it is typed, under the key for the form on screen; switching tab moves to that one's own draft.
  useEffect(() => {
    // A tab swap just settled the new form and its draft; writing again would put a blank (or the old
    // tab's text) under the new key. switchMode already saved the tab being left.
    if (reading.current) {
      reading.current = false;
      return;
    }
    if (!filled()) {
      clearDraft(draftKey(mode));
      window.dispatchEvent(new Event(DRAFT_CHANGED));
      return;
    }
    saveFormDraft(draftKey(mode), { ...form, mode, after: [...form.after], attached: img.attached } satisfies FormDraft);
    setSaved(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, form, img.attached]);
  // Both tabs keep their own draft (one per project and form type): moving between them saves and swaps.
  const switchMode = (next: "feature" | "task") => {
    if (next === mode) return;
    if (!filled()) {
      clearDraft(draftKey(mode));
      window.dispatchEvent(new Event(DRAFT_CHANGED));
    } else {
      saveFormDraft(draftKey(mode), { ...form, mode, after: [...form.after], attached: img.attached } satisfies FormDraft);
    }
    // The tab being left is saved above; the form below is the one being opened. Skip the save
    // effect for it, or it would re-save the old text (or a blank) under this tab's key.
    reading.current = true;
    const other = readDraftJson<FormDraft>(draftKey(next));
    setMode(next);
    setError(null);
    setRestored(other);
    setSaved(false);
    setForm(other ? { ...blank, ...other, goal: other.goal ?? blank.goal, after: new Set(other.after ?? []) } : blank);
    img.setAttached(other?.attached ?? []);
  };
  const discardDraft = () => {
    clearDraft(draftKey(mode));
    window.dispatchEvent(new Event(DRAFT_CHANGED));
    setForm(blank);
    img.clear();
    setRestored(null);
    setSaved(false);
    setError(null);
  };
  // Plan first follows the risk level: high and critical work is planned and approved first.
  const planFirst = form.risk === "high" || form.risk === "critical";
  const body = () => withAttachments(form.body, img.attached).trim();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.title.trim() || busy || tooLongToSend(body())) return;
    setBusy(true);
    try {
      if (isFeature) await onAddFeature({ title: form.title.trim(), description: body() || null, planWithCeo: form.plan && hasCeo, ...form.goal });
      else
        await onAddTask({
          title: form.title.trim(),
          body: body() || null,
          risk: form.risk === "none" ? null : form.risk,
          planFirst,
          assigneeAgentId: form.assignee && form.assignee !== "owner" ? form.assignee : null,
          assignedToOwner: form.assignee === "owner",
          featureId: form.feature || null,
          acceptanceCriteria: form.criteria
            .split("\n")
            .map((l, i) => ({ line: l.trim(), on: form.after.has(i) }))
            .filter((x) => x.line)
            .map((x): Criterion => (x.on ? { text: x.line, after: "merge" } : x.line)),
        });
      // Created: the draft goes, or a reload would offer to create it again. A failed create keeps it.
      clearDraft(draftKey(mode));
      window.dispatchEvent(new Event(DRAFT_CHANGED));
      img.clear();
      onClose();
    } catch (err) {
      setError(`${(err as Error).message} What you wrote is still here: it wasn't saved as a task.`);
    } finally {
      setBusy(false);
    }
  };
  // Hands the draft to the CEO, who questions the owner in chat and then creates it.
  const grill = async () => {
    if (!form.title.trim() || busy || tooLongToSend(body())) return;
    setBusy(true);
    try {
      await onGrill({ kind: mode, title: form.title.trim(), description: body() || null });
      // Handed to the CEO: the CEO's conversation now holds it, and the draft must not create it twice.
      clearDraft(draftKey(mode));
      window.dispatchEvent(new Event(DRAFT_CHANGED));
      img.clear();
    } catch (err) {
      setError(`${(err as Error).message} What you wrote is still here: it wasn't handed to the CEO.`);
      setBusy(false);
    }
  };
  // Too long for the description: put it in a .txt file and link that instead, so it isn't cut.
  const bodyAsFile = async (long: string) => {
    try {
      const markdown = await img.uploadText(long, "description.txt");
      setForm((f) => ({ ...f, body: withAttachments("The text was too long for the description box, so it's in this file:\n\n", [markdown]) }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const agentChosen = !isFeature && !!form.assignee && form.assignee !== "owner";
  return (
    <form
      className="card"
      aria-label={isFeature ? "New feature" : "New task"}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        if (e.key === "Escape") onClose();
      }}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div role="radiogroup" aria-label="What are you adding?" style={{ display: "flex", gap: 8 }}>
        {(["feature", "task"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn${mode === m ? " primary" : ""}`} onClick={() => switchMode(m)}>
            {m === "feature" ? "New feature" : "New task"}
          </button>
        ))}
      </div>
      {restored && (
        <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
          Draft restored. It's kept in this browser until you add it or discard it.{" "}
          <button type="button" className="link" style={{ padding: 0 }} onClick={discardDraft}>
            Discard draft
          </button>
        </p>
      )}
      <div className="field">
        <label htmlFor="nt-title">Title</label>
        <input id="nt-title" autoFocus required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="nt-body">{isFeature ? "What problem does it solve, and for whom?" : "Description"}</label>
        <OwnerMessageBox
          id="nt-body"
          label={isFeature ? "What problem does it solve, and for whom?" : "Description"}
          rows={6}
          placeholder={isFeature ? "" : "What should be done, and what counts as finished."}
          value={form.body}
          onChange={(text) => setForm({ ...form, body: text })}
          onPaste={img.onPaste}
          onSendAsFile={bodyAsFile}
          attaching={img.busy}
          error={img.error}
          textareaStyle={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
        >
          <ImagePreviews attached={img.attached} onRemove={img.remove} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {img.button}
            <small className="muted">Or paste a screenshot into the description.</small>
          </div>
        </OwnerMessageBox>
      </div>
      {!isFeature && (
        <div className="field">
          <label htmlFor="nt-criteria">Done when (one acceptance criterion per line)</label>
          <textarea
            id="nt-criteria"
            rows={3}
            maxLength={2_000}
            placeholder={"Health check returns 200\nNo criteria is fine"}
            value={form.criteria}
            onChange={(e) => setForm({ ...form, criteria: e.target.value })}
            style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
          />
          <small className="muted">Optional, up to 10. The agent reports pass or fail against each before merge when it asks for review.</small>
          {form.criteria
            .split("\n")
            .some((l) => l.trim()) && (
            <fieldset style={{ border: "1px solid var(--line-strong)", borderRadius: 8, padding: "6px 10px", margin: 0 }}>
              <legend style={{ fontSize: 13 }} className="muted">
                On a real host (checked after merge)
              </legend>
              {form.criteria.split("\n").map((l, i) =>
                l.trim() ? (
                  <label key={i} style={{ display: "block", fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={form.after.has(i)}
                      onChange={(e) =>
                        setForm((f) => {
                          const n = new Set(f.after);
                          if (e.target.checked) n.add(i);
                          else n.delete(i);
                          return { ...f, after: n };
                        })
                      }
                    />{" "}
                    {l.trim()}
                  </label>
                ) : null,
              )}
              <small className="muted">Tick the checks only the real host can settle: reviewers skip them, and the task stays open after the merge until they're reported.</small>
            </fieldset>
          )}
        </div>
      )}
      {isFeature ? (
        <>
          <div className="field">
            <label htmlFor="nt-goal">Objective or milestone</label>
            <GoalSelect id="nt-goal" tree={goals} value={form.goal} onChange={(goal) => setForm({ ...form, goal })} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={form.plan && hasCeo} disabled={!hasCeo} onChange={(e) => setForm({ ...form, plan: e.target.checked })} />
            Ask the CEO to plan it
          </label>
        </>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div className="field">
            <label htmlFor="nt-feature">Part of feature</label>
            <select id="nt-feature" value={form.feature} onChange={(e) => setForm({ ...form, feature: e.target.value })}>
              <option value="">None (a standalone task)</option>
              {features.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt-assignee">Assign to</label>
            <select id="nt-assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
              <option value="">Nobody yet</option>
              <option value="owner">You</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: "1 1 280px" }}>
            <label htmlFor="nt-risk">Risk</label>
            <select id="nt-risk" value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value as Risk | "none" })} style={{ maxWidth: 200 }}>
              <option value="none">Let the CEO rate it</option>
              {RISKS.map((r) => (
                <option key={r} value={r}>
                  {r[0]!.toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
            <RiskHelp tiers={tiers} current={form.risk === "none" ? null : form.risk} />
          </div>
        </div>
      )}
      {agentChosen && (
        <p role="note" style={{ fontSize: 14, margin: 0 }}>
          <strong>Starts straight away:</strong> {agents.find((a) => a.id === form.assignee)?.name ?? "The agent"} begins as soon as you add the task.
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn primary" type="submit" disabled={busy || !form.title.trim() || tooLongToSend(body())}>
          {isFeature ? "Add feature" : agentChosen ? "Add and start" : "Add to backlog"}
        </button>
        {hasCeo && (
          <button className="btn" type="button" disabled={busy || !form.title.trim() || tooLongToSend(body())} onClick={() => void grill()}>
            Let the CEO question me first
          </button>
        )}
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Ctrl+Enter (Cmd+Enter on a Mac) adds it.{isFeature ? "" : " The milestone is set on the task page."}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const FILTERS_KEY = "board-filters";
type SavedFilters = { feature: string; working: boolean };
/** The feature and "working now" filters, kept for the browser session like the feature states below. */
function readFilters(): SavedFilters {
  try {
    const saved = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "null") as Partial<SavedFilters> | null;
    return { feature: typeof saved?.feature === "string" ? saved.feature : "any", working: saved?.working === true };
  } catch {
    return { feature: "any", working: false };
  }
}

const STATES_KEY = "board-feature-states";
/** Every state but Declined, as before the toggles; the choice is kept for the browser session. */
function readShownStates(): FeatureStatus[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STATES_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) return FEATURE_STATUSES.filter((st) => saved.includes(st));
  } catch {
    /* unreadable: use the default */
  }
  return FEATURE_STATUSES.filter((st) => st !== "declined");
}

/** One card per feature: its status and how many of its tasks are done. */
function FeatureCards({ features, onAddTask }: { features: Feature[]; onAddTask: (featureId: string) => void }) {
  if (!features.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
      {features.map((f) => (
        <article className="ticket" key={f.id} aria-label={`Feature ${f.title}`}>
          <span className="type feature">Feature</span>
          <h3>
            <a href={`#/features/${f.companyId}/${f.id}`}>{f.title}</a>
          </h3>
          <span className={`tag ${STATUS_TONE[f.status]}`} style={{ alignSelf: "flex-start" }}>{FEATURE_STATUS_LABEL[f.status]}</span>
          <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={f.tickets.total} aria-valuenow={f.tickets.done} aria-label={`${f.title} progress`}>
            <span style={{ width: `${f.tickets.total ? (f.tickets.done / f.tickets.total) * 100 : 0}%` }} />
          </span>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {f.tickets.done} of {f.tickets.total} tasks done
          </span>
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} aria-label={`Add task to ${f.title}`} onClick={() => onAddTask(f.id)}>
            Add task
          </button>
        </article>
      ))}
    </div>
  );
}

export function Board({ companies, projectId, subpage, go, onCompaniesChanged }: { companies: Company[]; projectId: string | undefined; subpage?: string; go: (to: string) => void; onCompaniesChanged: () => void }) {
  const projects = usePoll(
    async (signal) => (await Promise.all(companies.map((c) => api<Project[]>(`/api/companies/${c.id}/projects`, { signal })))).flat(),
    60_000,
    companies.map((c) => c.id).join(","),
  );
  // An archived project opens only by its own link.
  const current = projects.data?.find((p) => p.id === projectId) ?? projects.data?.find((p) => !p.archivedAt);
  const board = usePoll((signal) => (current ? api<BoardData>(`/api/projects/${current.id}/board`, { signal }) : Promise.resolve(null)), 10_000, current?.id ?? "none");
  const feats = usePoll((signal) => (current ? api<ScoredFeatures>(`/api/companies/${current.companyId}/features`, { signal }) : Promise.resolve(null)), 30_000, `board-feats-${current?.companyId ?? "none"}`);
  const goals = usePoll((signal) => (current ? api<Tree>(`/api/companies/${current.companyId}/objectives`, { signal }) : Promise.resolve(null)), 120_000, `board-goals-${current?.companyId ?? "none"}`);
  const [view, setView] = useState<"all" | "features" | "tasks">("all");
  const [adding, setAdding] = useState<(Adding & { n: number }) | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("anyone");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(readFilters);
  const setFilter = (change: Partial<SavedFilters>) =>
    setFilters((cur) => {
      const next = { ...cur, ...change };
      try {
        sessionStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the choice lasts until the page reloads */
      }
      return next;
    });
  const [allDone, setAllDone] = useState(false);
  const [shownStates, setShownStates] = useState(readShownStates);
  const toggleState = (st: FeatureStatus) =>
    setShownStates((cur) => {
      const next = cur.includes(st) ? cur.filter((x) => x !== st) : [...cur, st];
      try {
        sessionStorage.setItem(STATES_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the choice lasts until the page reloads */
      }
      return next;
    });
  const featureList = feats.data?.features ?? [];
  // A saved feature that is not in this company's list (other company, deleted) counts as any.
  const featureFilter = filters.feature === "any" || filters.feature === "none" || featureList.some((f) => f.id === filters.feature) ? filters.feature : "any";
  const visibleFeatures = featureList.filter((f) => shownStates.includes(f.status));
  // The review column is three lanes (BOS-667): still with its reviewers, approved by all of them and
  // only merging, and every ticket, from any column, whose next step is the owner's. Approved work used
  // to sit with the work awaiting review, so a long merge line read as a reviewer shortage.
  const label = (c: BoardData["columns"][number]) => (c.systemState === "review" && c.name === DEFAULT_LABEL.review ? "Awaiting review" : c.name);
  const waiting = (board.data?.columns ?? []).flatMap((c) => c.tickets.filter((t) => t.waitingOnOwner));
  const lanes = (board.data?.columns ?? []).flatMap((col): Array<{ col: typeof col; tickets: typeof col.tickets; mine: boolean; merging?: boolean; held?: boolean }> => {
    const open = col.tickets.filter((t) => !t.waitingOnOwner);
    if (col.systemState !== "review") return [{ col, tickets: open, mine: false }];
    // A reviewer's hold (BOS-808): passed, kept from merging on purpose. Its own lane, shown only when something is held.
    const held = open.filter((t) => t.reviewStage === "held");
    return [
      { col, tickets: open.filter((t) => t.reviewStage !== "merging" && t.reviewStage !== "held"), mine: false },
      { col, tickets: open.filter((t) => t.reviewStage === "merging"), mine: false, merging: true },
      ...(held.length ? [{ col, tickets: held, mine: false, held: true }] : []),
      { col, tickets: waiting, mine: true },
    ];
  });
  const rename = async (columnId: string, name: string) => {
    // The columns endpoint takes the whole list, so send every column with only this one renamed.
    await api(`/api/projects/${current!.id}/columns`, { method: "PUT", body: board.data!.columns.map((c) => ({ name: c.id === columnId ? name : c.name, systemState: c.systemState, wipLimit: c.wipLimit })) });
    board.reload();
  };
  const runNow = async (id: string) => {
    await api(`/api/tickets/${id}/run-now`, { method: "POST" });
    board.reload();
  };
  const openForm = (a: Adding) => setAdding({ ...a, n: (adding?.n ?? 0) + 1 });
  const agents = new Map(companies.flatMap((c) => c.agents.map((a) => [a.id, a] as const)));
  const tiers = useRiskTiers(current?.companyId);

  if (companies.length === 0) {
    return (
      <State img={art.setup} alt="Set up your first company" title="Start your first company">
        <p>A company gets a CEO agent that plans the work, hires agents and asks you when it needs a decision.</p>
        <QuickAdd
          label="Company name"
          button="Create company"
          onAdd={async (name) => {
            await api("/api/companies", { method: "POST", body: { name } });
            onCompaniesChanged();
          }}
        />
      </State>
    );
  }
  if (projects.data && !current) {
    return (
      <State img={art.setup} alt="No projects yet" title="No projects yet">
        <p>Projects hold a board of tasks and, optionally, a git repo the agents work in.</p>
        <QuickAdd
          label={`Project name for ${companies[0]!.name}`}
          button="Create project"
          onAdd={async (name) => {
            const p = await api<Project>(`/api/companies/${companies[0]!.id}/projects`, { method: "POST", body: { name } });
            projects.reload();
            go(`board/${p.id}`);
          }}
        />
      </State>
    );
  }

  const company = companies.find((c) => c.id === current?.companyId);
  const ceo = company?.agents.find((a) => a.role === "ceo");
  const tab = projectTab(subpage);
  const head = (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company ? `${company.name} · project` : "Project"}</p>
          <h1>{current?.name ?? "Kanban"}</h1>
          {current?.repoUrl && <p className="sub mono" style={{ fontSize: 13 }}>{current.repoUrl}</p>}
        </div>
        {current && <WatchdogHealth companyId={current.companyId} />}
        {current && (
          <StarButton
            agent={current}
            where="Projects"
            onToggle={() => void api(`/api/projects/${current.id}`, { method: "PATCH", body: { starred: !current.starred } }).then(() => { projects.reload(); onCompaniesChanged(); })}
          />
        )}
        {(projects.data?.length ?? 0) > 1 && (
          <div className="field">
            <label htmlFor="project-pick">Project</label>
            <select id="project-pick" value={current?.id} onChange={(e) => go(`board/${e.target.value}`)}>
              {projects.data!.filter((p) => !p.archivedAt || p.id === current?.id).map((p) => (
                <option key={p.id} value={p.id}>
                  {companies.find((c) => c.id === p.companyId)?.name} · {p.name}
                  {p.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>
      {current && (
        <div className="tabs" role="tablist" aria-label="Project views">
          {PROJECT_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" id={`proj-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="proj-panel" onClick={() => go(`board/${current.id}${t.id === "kanban" ? "" : `/${t.id}`}`)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
  if (current && tab !== "kanban") {
    return (
      <>
        {head}
        <div id="proj-panel" role="tabpanel" aria-labelledby={`proj-tab-${tab}`} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {tab === "budget" ? <ProjectBudget key={current.id} project={current} /> : <><ProjectRow key={current.id} p={current} agents={company?.agents} onChanged={() => { projects.reload(); onCompaniesChanged(); }} /><ProjectBrief key={`brief-${current.id}`} p={current} /><ArchiveProject key={`archive-${current.id}`} p={current} onChanged={() => { projects.reload(); onCompaniesChanged(); }} /></>}
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      {current && adding && (
        <AddForm
          key={adding.n}
          companyId={current.companyId}
          projectId={current.id}
          initial={adding}
          agents={company?.agents ?? []}
          features={(feats.data?.features ?? []).filter((f) => f.status !== "declined")}
          goals={goals.data ?? []}
          tiers={tiers}
          hasCeo={!!ceo}
          onClose={() => setAdding(null)}
          onGrill={async (d) => {
            const r = await api<{ agentId: string }>(`/api/companies/${current.companyId}/chat/grill`, { method: "POST", body: { ...d, projectId: current.id } });
            go(`chat/${current.companyId}/${r.agentId}`);
          }}
          onAddTask={async (t) => {
            await api(`/api/projects/${current.id}/tickets`, { method: "POST", body: t });
            setNote(null);
            board.reload();
          }}
          onAddFeature={async (f) => {
            const created = await api<Feature>(`/api/companies/${current.companyId}/features`, { method: "POST", body: { title: f.title, description: f.description, status: f.planWithCeo ? "planned" : "idea", objectiveId: f.objectiveId, milestoneId: f.milestoneId } });
            if (view === "tasks") setView("features");
            feats.reload();
            if (f.planWithCeo) {
              // The feature exists now: a failed planning task mustn't make a retry add it twice.
              try {
                await api(`/api/features/${created.id}/tickets`, { method: "POST", body: { projectId: current.id, title: `Plan: ${f.title}`, assigneeAgentId: ceo!.id, noCode: true } });
              } catch (err) {
                setNote(`Feature added, but its planning task couldn't be created (${(err as Error).message}). Use "Add task" on the feature's card.`);
                return;
              } finally {
                board.reload();
                feats.reload();
              }
            }
            setNote(f.planWithCeo ? "Feature added. The CEO will plan it and break it into tasks." : "Feature added.");
          }}
        />
      )}
      {note && <p role="status">{note}</p>}
      {board.error && !away(board.error) && (
        <p className="error" role="alert">
          {board.error.message}
        </p>
      )}
      {waiting.length > 0 && (
        <a className="strip" href="#your-review" onClick={(e) => { e.preventDefault(); document.getElementById("your-review")?.scrollIntoView?.({ behavior: "smooth", inline: "center" }); }}>
          <span>
            <span className="count-badge">{waiting.length}</span>
            <span>
              <strong>{waiting.length === 1 ? "1 task is waiting on you." : `${waiting.length} tasks are waiting on you.`}</strong> {waiting[0]!.title}
            </span>
          </span>
          <strong style={{ whiteSpace: "nowrap" }}>Review it <span aria-hidden="true">→</span></strong>
        </a>
      )}
      {!!board.data?.withoutTicket?.length && (
        <section className="unticketed" aria-label="Working on something other than a ticket">
          <strong>Working on something other than a ticket</strong>
          <ul>
            {board.data.withoutTicket.map((r) => (
              <li key={r.id}>
                <strong>{r.agent ?? "An agent"}</strong> <RunLabelLink run={{ ...r, note: r.wakeNote }} /> <span className="muted">· started {ago(r.startedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="board-bar">
        <div>
          {current && !adding && (
            <button type="button" className="btn primary" onClick={() => openForm({ mode: view === "features" ? "feature" : "task", featureId: "" })}>
              Add task
            </button>
          )}
          <div className="segmented" role="group" aria-label="Show">
            {(["all", "features", "tasks"] as const).map((v) => (
              <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "all" ? "All" : v === "features" ? "Features" : "Tasks"}
              </button>
            ))}
          </div>
          {view !== "features" && (
            <input type="search" aria-label="Search tasks" placeholder="Search: HOL-12, title, words…" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {view !== "features" && (
            <label>
              Assigned to
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="anyone">Anyone</option>
                <option value="owner">You</option>
                {company?.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {view !== "features" && (
            <label>
              Feature
              <select value={featureFilter} onChange={(e) => setFilter({ feature: e.target.value })}>
                <option value="any">Any feature</option>
                <option value="none">No feature</option>
                {featureList.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {view !== "features" && (
            <button type="button" className="chip" aria-pressed={filters.working} onClick={() => setFilter({ working: !filters.working })}>
              Working now{board.data ? ` (${board.data.workingAgents})` : ""}
            </button>
          )}
        </div>
        {view !== "features" && (
          <p>
            <svg width="14" height="14" {...iconProps}>{PENCIL}</svg>
            Rename a column with its pencil. Agents always see the fixed state.
          </p>
        )}
      </div>
      {/* The cards with progress only on the Features view: on All the list would grow above the columns; each task's chip names its feature. */}
      {view === "features" && (
        <div className="segmented state-filter" role="group" aria-label="Show features that are">
          {FEATURE_STATUSES.map((st) => (
            <button key={st} type="button" className="chip" aria-pressed={shownStates.includes(st)} onClick={() => toggleState(st)}>
              {FEATURE_STATUS_LABEL[st]} ({featureList.filter((f) => f.status === st).length})
            </button>
          ))}
        </div>
      )}
      {view === "features" && featureList.length > 0 && !visibleFeatures.length && <p className="muted">No features in the states you have switched on. Switch more states on above.</p>}
      {view === "features" && <FeatureCards features={visibleFeatures} onAddTask={(featureId) => { setNote(null); openForm({ mode: "task", featureId }); }} />}
      {view !== "features" && (
      <div className="board-scroll">
        <div className="board">
          {lanes.map(({ col, tickets, mine, merging, held }) => {
            const full = col.wipLimit != null && col.tickets.length >= col.wipLimit;
            const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
            // Every word must appear in the ticket's reference, title, feature or description.
            const hit = (t: (typeof tickets)[number]) => !words.length || words.every((w) => [t.number ? ticketRef(company?.ticketPrefix, t.number) : "", t.title, t.featureTitle ?? "", t.body ?? ""].join("\n").toLowerCase().includes(w));
            const shown = tickets.filter((t) => (assignee === "anyone" || (assignee === "owner" ? t.assignedToOwner : t.assigneeAgentId === assignee)) && (featureFilter === "any" || (featureFilter === "none" ? !t.featureId : t.featureId === featureFilter)) && (!filters.working || !!t.working?.length) && hit(t));
            const named = (t: (typeof shown)[number]) => {
              const a = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
              return a ? a.name : t.assignedToOwner ? "You" : "Nobody yet";
            };
            const done = col.systemState === "done";
            const rows = done ? [...shown].sort((x, y) => (y.lastActivityAt ?? "").localeCompare(x.lastActivityAt ?? "")) : shown;
            const visible = done && !allDone && !words.length ? rows.slice(0, DONE_SHOWN) : rows;
            return (
              <section className={`lane${mine ? " mine" : ""}`} key={mine ? "your-review" : merging ? "merging" : held ? "held" : col.id} id={mine ? "your-review" : undefined} aria-labelledby={mine ? "lane-your-review" : merging ? "lane-merging" : held ? "lane-held" : `lane-${col.id}`}>
                {mine ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-your-review">Your review</h2>
                      <span className="count-badge">{shown.length}</span>
                    </div>
                  </header>
                ) : merging ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-merging">Approved, merging</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">
                      Every reviewer approved. Boss Man checks and merges these itself. <a href={`#/merge-queue/${current?.companyId ?? ""}`}>See the merge queue</a>
                    </span>
                  </header>
                ) : held ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-held">Passed, held</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">A reviewer passed these but is holding the merge on purpose. Nothing is wrong, and nobody is woken until the hold ends.</span>
                  </header>
                ) : renaming === col.id ? (
                  <RenameColumn col={col} onCancel={() => setRenaming(null)} onSave={async (name) => { await rename(col.id, name); setRenaming(null); }} />
                ) : (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id={`lane-${col.id}`}>{label(col)}</h2>
                      <span className="mono" style={full ? { color: "var(--amber-ink)" } : undefined}>
                        {col.wipLimit != null ? `${shown.length} / ${col.wipLimit}` : shown.length}
                      </span>
                      <button type="button" className="icon-btn" aria-label={`Rename the ${label(col)} column`} onClick={() => setRenaming(col.id)}>
                        <svg width="15" height="15" {...iconProps}>{PENCIL}</svg>
                      </button>
                    </div>
                    {col.name !== DEFAULT_LABEL[col.systemState] && (
                      <span className="lane-hint">
                        Agents see: <span className="mono">{col.systemState}</span>
                      </span>
                    )}
                  </header>
                )}
                {shown.length === 0 && <p className="lane-empty">{merging ? "Nothing approved is waiting to merge." : (EMPTY_HINT[col.systemState] ?? "No tasks here.")}</p>}
                {done ? (
                  <>
                    <ul className="done-list">
                      {visible.map((t) => (
                        <li key={t.id}>
                          <svg width="16" height="16" {...iconProps} strokeWidth={2.2}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                          <span>
                            <a href={`#/tickets/${t.id}`}>{t.title}</a>
                            <small>{t.number ? `${ticketRef(company?.ticketPrefix, t.number)} · ` : ""}{named(t)} · {when(t.lastActivityAt)}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {rows.length > DONE_SHOWN && (
                      <button type="button" className="linkish" onClick={() => setAllDone(!allDone)}>
                        {allDone ? "Show fewer" : "Show all done tasks"}
                      </button>
                    )}
                  </>
                ) : (
                  shown.map((t) => {
                  const who = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
                  return (
                    <article className={`ticket${mine ? " mine" : ""}${t.working?.length ? " live" : ""}`} key={t.id}>
                      <div className="top">
                        <span className={`type${t.parentTitle ? " sub" : ""}`}>{t.parentTitle ? "Sub-task" : "Task"}</span>
                        {t.number && <span className="mono muted">{ticketRef(company?.ticketPrefix, t.number)}</span>}
                        {(t.risk === "high" || t.risk === "critical") && (
                          <span className={`tag ${t.risk === "critical" ? "red" : "amber"}`} title={tiers.find((x) => x.tier === t.risk)?.summary}>
                            {t.risk} risk
                          </span>
                        )}
                        {t.size && (
                          <span className="tag" title="Size, relative to other tasks">
                            Size {t.size}
                          </span>
                        )}
                      </div>
                      <h3>
                        <a href={`#/tickets/${t.id}`}>{t.title}</a>
                      </h3>
                      {mine && <span className="note">{t.ownerQuestion ? `Waiting on your decision: ${t.ownerQuestion}` : t.noReviewer ? "No agent can review this. Open it to approve or send it back." : `${t.approvedBy ? `${t.approvedBy} approved.` : "Approved."} Needs your sign-off to merge.`}</span>}
                      {mine && (
                        <a className="btn primary small" href={t.ownerQuestion ? "#/decisions" : `#/tickets/${t.id}`} style={{ justifyContent: "center" }}>
                          {t.ownerQuestion ? "Answer in Decisions" : "Review and approve"}
                        </a>
                      )}
                      {t.planFirst && !t.planApprovedAt && <span className="tag blue" style={{ alignSelf: "flex-start" }}>{t.plan ? "Plan waiting" : "Planning"}</span>}
                      {t.parentTitle && <span className="note">Sub-task of {t.parentTitle}</span>}
                      {t.featureTitle && (
                        <span className="fchip" title={t.featureTitle}>
                          <b>Feature</b>
                          <span>{t.featureTitle}</span>
                        </span>
                      )}
                      {t.blockedBy.length > 0 && <span className="tag amber" style={{ alignSelf: "flex-start" }}>Blocked by {t.blockedBy.length === 1 ? (t.blockedBy[0]!.decisionId ? "a decision" : t.blockedBy[0]!.engagementId ? "an engagement" : "a task") : `${t.blockedBy.length} things`}</span>}
                      {t.blockedBy.some((b) => b.ticketId) && (
                        <span className="note">
                          Waits on{" "}
                          {t.blockedBy
                            .filter((b) => b.ticketId)
                            .map((b, i) => (
                              <span key={b.ticketId}>
                                {i > 0 && ", "}
                                <a href={`#/tickets/${b.ticketId}`}>{b.ticketTitle ?? "a task"}</a>
                              </span>
                            ))}
                        </span>
                      )}
                      {t.outcome === "cancelled" && <span className="tag" style={{ alignSelf: "flex-start" }}>Cancelled</span>}
                      {t.quotaHeldUntil && !t.working?.length && (
                        <span className="note" role="status">
                          Held by the quota hold{t.quotaHeldReason ? ` (${t.quotaHeldReason.replace(/^subscription /, "").replace(/ window nearly used up$/, "")})` : ""}.{" "}
                          <button type="button" className="linkish" onClick={() => void runNow(t.id)}>
                            Run now
                          </button>
                        </span>
                      )}
                      {t.reviewWait && !t.working?.length && <span className="muted" style={{ fontSize: 12 }}>Waiting: {t.reviewWait}</span>}
                      {merging && t.mergeNote && <span className="note">{t.mergeNote}</span>}
                      {t.hold && (
                        <span className="tag amber" style={{ alignSelf: "flex-start" }} title={t.hold.reason}>
                          Held: {t.hold.label}
                          {t.hold.reviewer ? ` · ${t.hold.reviewer}` : ""}
                        </span>
                      )}
                      {!!t.working?.length && (
                        <span className="working" role="status">
                          <span className="pulse-dot" aria-hidden="true" />
                          {t.working.join(" and ")}
                        </span>
                      )}
                      <div className="row">
                        <span className="who">
                          {who && (
                            <Avatar agent={who} title={`${who.name} (${who.agentKind})`} />
                          )}
                          {named(t)}
                        </span>
                        <span className="mono">{t.dueDate ? `Due ${t.dueDate}` : t.working?.length ? workingFor(t.workingSince) : age(t.lastActivityAt)}</span>
                      </div>
                    </article>
                  );
                  })
                )}
              </section>
            );
          })}
        </div>
      </div>
      )}
    </>
  );
}
