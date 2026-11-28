import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { FilterPanel, useIsPhone } from "../components/FilterPanel";
import { buildCsv, download } from "../csv";
import { api, today, FEATURE_STATUSES, FEATURE_STATUS_LABEL, RISKS, type Board as BoardData, type Company, type Feature, type FeatureStatus, type Project, type Risk, type ScoredFeatures } from "../api";
import { BULK_TICKET_MAX, isLiveCheckWait, POINTS_EXPLAINED, ticketRef, type Criterion } from "@boss-man/shared";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerAsksLaneHead, OwnerAsksStrip, SameQuestionLine, sameQuestionAs, sameQuestionText } from "../components/OwnerAsks";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { art } from "../brand";
import { RiskHelp, useRiskTiers, type RiskTiers } from "../components/RiskHelp";
import { State } from "../components/State";
import { Loader } from "../components/Loader";
import { statusLineText, type StatusLine } from "./MergeQueue";
import { hashQuery, useHasCode, usePoll } from "../hooks";
import { useWheelToPage } from "../wheel-to-page";
import { DRAFT_CHANGED, clearDraft, readDraftJson, saveFormDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { away } from "../server-watch";
import { GoalSelect, STATUS_TONE, type GoalLink, type Tree } from "./Features";
import { StarButton } from "./Agents";
import { ProjectBudget } from "./ProjectBudget";
import { WatchdogHealth } from "../components/WatchdogHealth";
import { QueuedBehindLine } from "../components/QueuedBehindLine";
import { ArchiveProject, ProjectBrief, ProjectRow } from "./settings/Projects";
import { Avatar } from "../components/Avatar";
import { RunLabelLink } from "./Runs";
import { ago } from "./Dashboard";
import { ageShort } from "../age";
import { yourReviewFirst } from "../board-lane-order";
import { waitingOnThis, waitingWords } from "../board-waiting";
import { WorkStands } from "../components/WorkStands";
import { GuideLink } from "../guide-links";
import { RecurringTag } from "../components/RecurringTag";
import { HeldBehindFixLine, heldSummary, type MergeLine } from "../components/MergesStuckBanner";

const DONE_SHOWN = 8;
const PARKED_SHOWN = 4;
/** A merged ticket whose watch has run past its end date (the agent's date, or the 14-day default): it sorts first in Merged, watching. */
const watchPastEnd = (t: { watchEndsAt?: string | null }) => !!t.watchEndsAt && Date.parse(t.watchEndsAt) < Date.now();
/** Past the 14-day default with no date from the agent: the amber "No date" tag; whole days since the watch began. */
const watchNoDateDays = (t: { watchEndsAt?: string | null; watchUntil?: string | null }) => (t.watchEndsAt && !t.watchUntil && watchPastEnd(t) ? 14 + Math.floor((Date.now() - Date.parse(t.watchEndsAt)) / 86_400_000) : null);
/** "3 days", or hours when it has been less than a day. */
const stuckFor = (ms: number) => {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};
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
  backlog: "Nothing waiting. Add a task to start, or ask the CEO in Chat to plan the work.",
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
  return iso ? ageShort(now - new Date(iso).getTime()) : "";
}
const STATE_AGE_WORDS: Record<string, string> = { in_progress: "in progress", review: "in Review", blocked: "blocked" };
/** BOS-2400: how long a ticket has sat in its state ("2 d", "5 h"). Only in progress, review and blocked show one. */
export function stateAge(t: { systemState: string; stateChangedAt?: string }, now = Date.now()): { text: string; label: string; days: number; old: boolean } | null {
  const word = STATE_AGE_WORDS[t.systemState];
  if (!word || !t.stateChangedAt) return null;
  const ms = Math.max(0, now - new Date(t.stateChangedAt).getTime());
  if (Number.isNaN(ms)) return null;
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);
  const text = hours < 24 ? `${hours} h` : `${days} d`;
  return { text, label: `${word} ${text}`, days: ms / 86_400_000, old: ms > 3 * 86_400_000 };
}
/** The lane header's "oldest 4 d": the longest-sitting card shown in the lane. */
export function oldestAge(ts: Array<{ systemState: string; stateChangedAt?: string }>, now = Date.now()): string | null {
  const ages = ts.map((t) => stateAge(t, now)).filter((a): a is NonNullable<typeof a> => !!a);
  if (!ages.length) return null;
  return `oldest ${ages.reduce((a, b) => (b.days > a.days ? b : a)).text}`;
}
/** The card footer's time: how long the run has been going ("23m"), or "now" in its first minute. */
export function workingFor(since: string | null | undefined, now = Date.now()) {
  return age(since ?? undefined, now) || "now";
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
  const hasCode = useHasCode();
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
          placeholder={isFeature ? "" : hasCode ? "What should be done, and what counts as finished." : "What should be done, and what counts as finished. For example: plan this month's client reports."}
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
          <DraftTextarea
            draftKey={null}
            noDraft="the whole New task form keeps one draft, so this box's text is saved under the form's key"
            id="nt-criteria"
            rows={3}
            maxLength={2_000}
            placeholder={"Health check returns 200\nNo criteria is fine"}
            value={form.criteria}
            onChange={(text) => setForm({ ...form, criteria: text })}
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
type BoardView = "all" | "features" | "tasks";
type SavedFilters = { feature: string; working: boolean; view: BoardView; assignee: string; stuckOnly: boolean; hideRecurring: boolean; holding: boolean };
/** The view, Assigned to, feature and "working now" filters, kept for the browser session like the feature states below. */
function readFilters(): SavedFilters {
  try {
    const saved = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "null") as Partial<SavedFilters> | null;
    return {
      feature: typeof saved?.feature === "string" ? saved.feature : "any",
      working: saved?.working === true,
      view: saved?.view === "features" || saved?.view === "tasks" ? saved.view : "all",
      assignee: typeof saved?.assignee === "string" && saved.assignee ? saved.assignee : "anyone",
      stuckOnly: saved?.stuckOnly === true,
      hideRecurring: saved?.hideRecurring === true,
      holding: saved?.holding === true,
    };
  } catch {
    return { feature: "any", working: false, view: "all", assignee: "anyone", stuckOnly: false, hideRecurring: false, holding: false };
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

/** True while the element's text is cut by its line clamp or its ellipsis. Frozen while the card is open (the clamp is off then), so the arrow stays. */
function useCut(ref: { current: HTMLElement | null }, text: string, open: boolean) {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!open) setCut(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, text, open]);
  return cut;
}

/** A Done-column row: the title is cut to 2 lines, and the full title shows on hover only when it was cut. */
function DoneTitle({ id, title }: { id: string; title: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const cut = useCut(ref, title, false);
  return <a ref={ref} className="clamp2" href={`#/tickets/${id}`} title={cut ? title : undefined}>{title}</a>;
}

type BoardTicket = BoardData["columns"][number]["tickets"][number];

type BuildResult = NonNullable<BoardTicket["build"]>;

/** BOS-2435: the words on a Review card's build tag (words, not colour alone). */
export function buildWords(b: BuildResult): string {
  return b.state === "passed" ? "Build passed" : b.state === "failed" ? "Build failed" : b.state === "running" ? "Build running" : b.state === "none" ? "No build yet" : "Build result unavailable";
}

export function buildTitle(b: BuildResult): string {
  return b.state === "failed" && b.failing.length ? `Failing: ${b.failing.join(", ")}` : buildWords(b);
}

/** The Board's "Download CSV": one row per ticket shown, in the order the lanes show them. */
export function boardToCsv(rows: Array<{ t: BoardTicket; column: string; assignee: string; ref: string; waiting?: number }>): string {
  return buildCsv(
    ["Reference", "Title", "Column", "Assignee", "Risk", "Size", "Feature", "Priority 1", "Last activity", "Days in state", "Build", "Waiting on this"],
    rows.map(({ t, column, assignee, ref, waiting }) => {
      const a = stateAge(t);
      return [ref, t.title, column, assignee, t.risk ?? "", t.size ?? "", t.featureTitle ?? "", t.urgentByOwner ? "yes" : "no", t.lastActivityAt ?? "", a ? (Math.floor(a.days * 10) / 10).toString() : "", t.build ? (t.build.state === "failed" && t.build.failing.length ? `failed: ${t.build.failing.join(", ")}` : t.build.state) : "", String(waiting ?? 0)];
    }),
  );
}

/** BOS-2193: what the Select bar can do to every ticket it holds. Moves to In progress, Review or Done are not offered. */
export type BulkAction = { type: "move"; state: "backlog" | "ready" | "blocked" } | { type: "assign"; assigneeAgentId: string | null } | { type: "priority"; on: boolean };

/** "8 moved, 2 refused: BOS-12 (reason), BOS-14 (reason)", or "8 moved" when nothing was refused. */
export function bulkSummary(done: number, refused: { ref: string | null; reason: string }[], verb: "moved" | "changed") {
  if (!refused.length) return `${done} ${verb}`;
  return `${done} ${verb}, ${refused.length} refused: ${refused.map((r) => `${r.ref ?? "a ticket"} (${r.reason})`).join(", ")}`;
}

export function BulkBar({ count, agents, busy, result, onRun, onClear }: { count: number; agents: Company["agents"]; busy: boolean; result: string | null; onRun: (a: BulkAction) => void; onClear: () => void }) {
  const [agent, setAgent] = useState("");
  const tooMany = count > BULK_TICKET_MAX;
  const off = busy || count === 0 || tooMany;
  return (
    <div className="bulk-bar" role="region" aria-label="Selected tasks">
      <strong>{count} selected</strong>
      {tooMany && <span className="muted">Pick {BULK_TICKET_MAX} or fewer: that is the most one action can change.</span>}
      <span className="bulk-group" role="group" aria-label="Move to">
        Move to
        {(["backlog", "ready", "blocked"] as const).map((s) => (
          <button key={s} type="button" className="btn" disabled={off} onClick={() => onRun({ type: "move", state: s })}>
            {s === "backlog" ? "Backlog" : s === "ready" ? "Ready" : "Blocked"}
          </button>
        ))}
      </span>
      <span className="bulk-group">
        <select aria-label="Assign to" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Assign to…</option>
          <option value="none">Nobody</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={off || !agent} onClick={() => onRun({ type: "assign", assigneeAgentId: agent === "none" ? null : agent })}>
          Assign
        </button>
      </span>
      <span className="bulk-group" role="group" aria-label="Priority 1">
        <button type="button" className="btn" disabled={off} onClick={() => onRun({ type: "priority", on: true })}>
          Priority 1 on
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => onRun({ type: "priority", on: false })}>
          Priority 1 off
        </button>
      </span>
      <button type="button" className="linkish" disabled={busy || count === 0} onClick={onClear}>
        Clear
      </button>
      {result && <span className="bulk-result" role="status">{result}</span>}
    </div>
  );
}

function TicketCard({ sameAs, waiters, t, mine, merging, who, name, prefix, tiers, numberOf, onRunNow, runState, mergeLine, quiet, select }: { sameAs?: BoardTicket[]; waiters?: BoardTicket[]; select?: { checked: boolean; onClick: (id: string, shift: boolean) => void }; quiet?: boolean; runState?: { busy: boolean; error?: string }; mergeLine?: StatusLine; t: BoardTicket; mine: boolean; merging: boolean; who: Company["agents"][number] | undefined; name: string; prefix: string | null | undefined; tiers: RiskTiers; numberOf: (id: string) => number | null | undefined; onRunNow: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const titleRef = useRef<HTMLAnchorElement>(null);
  const noteRef = useRef<HTMLSpanElement>(null);
  const waitsRef = useRef<HTMLSpanElement>(null);
  const noteText = t.ownerQuestion ? `Waiting on your decision: ${t.ownerQuestion}` : t.noReviewer ? "No agent can review this. Open it to approve or send it back." : `${t.approvedBy ? `${t.approvedBy} approved.` : "Approved."} Needs your sign-off to merge.`;
  const blockers = t.blockedBy.filter((b) => b.ticketId);
  const refOf = (b: (typeof blockers)[number]) => {
    const n = b.ticketNumber ?? numberOf(b.ticketId!);
    return n ? ticketRef(prefix, n) : null;
  };
  const waitsFull = blockers.map((b) => `${refOf(b) ? `${refOf(b)} · ` : ""}${b.ticketTitle ?? "a task"}${b.until ? ` (until ${b.until})` : ""}`).join("; ");
  const titleCut = useCut(titleRef, t.title, open);
  const noteCut = useCut(noteRef, noteText, open);
  const waitsCut = useCut(waitsRef, waitsFull, open);
  const ticketRefText = t.number ? ticketRef(prefix, t.number) : t.title;
  const hover = (cut: boolean, text: string) => (cut && !open ? text : undefined);
  const first = who ? name.split(" ")[0]! : name;
  return (
    <article className={`ticket${quiet ? " quietcard" : ""}${mine ? " mine" : ""}${t.working?.length ? " live" : ""}${open ? " open" : ""}`} id={bodyId} data-ticket-id={t.id} data-shortcut-card tabIndex={-1}>
      <div className="top">
        {select && (
          <input type="checkbox" className="bulk-check" aria-label={`Select ${ticketRefText}`} checked={select.checked} onChange={() => {}} onClick={(e) => select.onClick(t.id, e.shiftKey)} />
        )}
        <span className={`type${t.parentTitle ? " sub" : ""}`}>{t.parentTitle ? "Sub-task" : "Task"}</span>
        {(t.risk === "high" || t.risk === "critical") && (
          <span className={`tag ${t.risk === "critical" ? "red" : "amber"}`} title={tiers.find((x) => x.tier === t.risk)?.summary}>
            {t.risk === "critical" ? "Critical" : "High"} risk
          </span>
        )}
        {t.size && (
          <span className="tag" title={POINTS_EXPLAINED}>
            Size {t.size}
          </span>
        )}
        {t.planFirst && !t.planApprovedAt && <span className="tag blue">{t.hasPlan ? "Plan waiting" : "Planning"}</span>}
        {t.blockedBy.length > 0 && <span className="tag amber">Blocked by {t.blockedBy.length === 1 ? (t.blockedBy[0]!.decisionId ? "a decision" : t.blockedBy[0]!.engagementId ? "an engagement" : "a task") : t.blockedBy.length}</span>}
        {waiters && waiters.length > 0 && (
          <span className="tag amber" tabIndex={0} title={waiters.map((w) => (w.number ? ticketRef(prefix, w.number) : w.title)).join(", ")}>
            {waitingWords(waiters.length)}
          </span>
        )}
        {t.nextUp && t.systemState === "ready" && (
          <span className="tag" title="The agent is busy on another ticket. This one starts by itself when they finish, and counts toward no limit until then.">
            Next up
          </span>
        )}
        {t.looksStuck && <span className="tag amber" title="The watchdog has handed this to the Scrum Master.">Looks stuck</span>}
        {t.reviewStage === "checking" && <span className="tag">Being checked</span>}
        {t.systemState === "review" && t.build && (
          <span className={`tag${t.build.state === "failed" ? " amber" : t.build.state === "passed" ? " green" : ""}`} title={buildTitle(t.build)}>
            {buildWords(t.build)}
          </span>
        )}
        {isLiveCheckWait(t) && <span className="tag green">Merged</span>}
        {isLiveCheckWait(t) && watchNoDateDays(t) !== null && <span className="tag amber">No date · {watchNoDateDays(t)} days</span>}
        {t.wipExempt === "busy" && !isLiveCheckWait(t) && <span className="tag">Agent busy</span>}
        {t.hold && (
          <span className="tag amber" title={t.hold.reason}>
            Held: {t.hold.label}
            {t.hold.reviewer ? ` · ${t.hold.reviewer}` : ""}
          </span>
        )}
        {t.outcome === "cancelled" && <span className="tag">Cancelled</span>}
        {t.urgent && t.systemState !== "done" && (
          <span className={`tag ${t.urgentByOwner ? "red" : "blue"}`} data-testid="board-priority" title={t.urgentByOwner ? "The owner marked this Priority 1: it goes first everywhere, including the merge line." : "Marked urgent."}>
            {t.urgentByOwner ? "Priority 1" : "Urgent"}
          </span>
        )}
        {t.recurring && <RecurringTag />}
        {t.number && <span className="mono muted ref">{ticketRef(prefix, t.number)}</span>}
      </div>
      <h3>
        <a ref={titleRef} className={open ? undefined : "clamp2"} href={`#/tickets/${t.id}`} data-shortcut-open title={hover(titleCut, t.title)}>{t.title}</a>
      </h3>
      {mine && <span ref={noteRef} className={`note${open ? "" : " clamp2"}`} title={hover(noteCut, noteText)}>{noteText}</span>}
      {mine && sameAs && sameAs.length > 0 && <SameQuestionLine text={sameQuestionText(sameAs, (n) => ticketRef(prefix, n) ?? `#${n}`)} />}
      {t.recheckingBy && !mine && <span className="note" data-testid="board-rechecking">Card being re-checked by {t.recheckingBy}</span>}
      {mine && (
        <a className="btn primary small" href={t.ownerQuestion ? (t.ownerQuestionId ? `#/decisions/${t.ownerQuestionId}` : "#/decisions") : `#/tickets/${t.id}`} style={{ justifyContent: "center" }}>
          {t.ownerQuestion ? "Answer in Decisions" : "Review and approve"}
        </a>
      )}
      {t.looksStuck && (
        <span className="state-line stuck-line" data-testid="board-looks-stuck-note">
          <span className="ico" aria-hidden="true">⚠</span>
          {/* BOS-2737: who acts on it is the server's actionClaim line; an older server sends none, so nothing is claimed. */}
          <span>No movement for {stuckFor(t.looksStuck.idleMs)}.{t.looksStuck.claim ? ` ${t.looksStuck.claim}` : ""}</span>
        </span>
      )}
      {t.systemState === "ready" && <QueuedBehindLine refs={t.queuedBehind} who={first} />}
      {t.wipExempt && t.wipExempt !== "live" && !isLiveCheckWait(t) && (
        <span className={t.wipExempt === "busy" ? "state-line" : "note"} title="This ticket can't move right now, so it doesn't count towards the work-in-progress limit.">
          {t.wipExempt === "busy" ? (
            <>
              <span className="ico" aria-hidden="true">⏸</span>
              <span>{first} is on {t.busyOnNumber ? ticketRef(prefix, t.busyOnNumber) : "another ticket"} right now. Not counted.</span>
            </>
          ) : (
            <>Not counted: {t.wipExempt === "plan" ? "plan with owner" : `waits on ${blockers.map((b) => refOf(b) ?? b.ticketTitle ?? "a task").join(", ")}`}</>
          )}
        </span>
      )}
      {t.nextUp && t.systemState === "ready" && (
        <span className="state-line" data-testid="board-next-up-note">
          <span className="ico" aria-hidden="true">→</span>
          <span>Starts by itself when {first} finishes what they are running. Counts toward no limit until then.</span>
        </span>
      )}
      {t.parentTitle && <span className="note">Sub-task of {t.parentTitle}</span>}
      {t.featureTitle && (
        <span className="fchip" title={t.featureTitle}>
          <b>Feature</b>
          <span>{t.featureTitle}</span>
        </span>
      )}
      {blockers.length > 0 &&
        (open ? (
          <span className="note waits-open">
            Waits on
            {blockers.map((b) => (
              <span key={b.ticketId} className="waits-line">
                <a href={`#/tickets/${b.ticketId}`}>{refOf(b) ? `${refOf(b)} · ` : ""}{b.ticketTitle ?? "a task"}</a>
                {b.until ? ` (until ${b.until})` : ""}
              </span>
            ))}
          </span>
        ) : (
          <span ref={waitsRef} className="note clamp1" title={hover(waitsCut, waitsFull)}>
            Waits on{" "}
            {blockers.length === 1 ? (
              <a href={`#/tickets/${blockers[0]!.ticketId}`}>{refOf(blockers[0]!) ? `${refOf(blockers[0]!)} · ` : ""}{blockers[0]!.ticketTitle ?? "a task"}</a>
            ) : (
              blockers.map((b, i) => (
                <span key={b.ticketId}>
                  {i > 0 && ", "}
                  <a href={`#/tickets/${b.ticketId}`}>{refOf(b) ?? b.ticketTitle ?? "a task"}</a>
                </span>
              ))
            )}
          </span>
        ))}
      {t.quotaHeldUntil && !t.working?.length && (
        <span className="note" role="status">
          Held by the quota hold{t.quotaHeldReason ? ` (${t.quotaHeldReason.replace(/^subscription /, "").replace(/ window nearly used up$/, "")})` : ""}.{" "}
          <button type="button" className="linkish" disabled={runState?.busy} onClick={() => onRunNow(t.id)}>
            Run now
          </button>
        </span>
      )}
      {t.workingHoursNote && !t.working?.length && <span className="note" role="status" data-testid="board-working-hours-note">{t.workingHoursNote}</span>}
      {runState?.error && <span className="note" role="alert">{runState.error}</span>}
      {t.reviewWait && !t.working?.length && <span className="muted" style={{ fontSize: 12 }}>Waiting: {t.reviewWait}</span>}
      {merging && t.mergeNote && !mergeLine && <span className="note">{t.mergeNote}</span>}
      {t.reviewStage === "checking" && (
        <span className="state-line" data-testid="board-being-checked-note">
          <span className="ico" aria-hidden="true">⧗</span>
          <span>Quick check: {t.checkLine ?? "waiting"}. Reviewers are woken when it passes.</span>
        </span>
      )}
      {mergeLine && <span className="note" data-testid="board-merge-line">{statusLineText(mergeLine)}</span>}
      {/* BOS-1565: a held card says what it waits for even before the merge queue's own line has loaded or if it has none. */}
      {t.reviewStage === "held" && t.hold && !mergeLine && (
        <span className="note" data-testid="board-held-note">
          {t.hold.system ? `Approved. Boss Man holds the merge: ${t.hold.label}. It merges by itself afterwards.` : `Approved. ${t.hold.reviewer ?? "A reviewer"} holds the merge: ${t.hold.label}.`}
        </span>
      )}
      {t.goLiveNote && (
        <span className="note" data-testid="board-go-live-note">
          {t.goLiveNote.text}{" "}
          {t.goLiveNote.cardId && <a href={`#/decisions/${t.goLiveNote.cardId}`}>Open the card</a>}
        </span>
      )}
      {isLiveCheckWait(t) && !t.goLiveNote && (
        <span className="state-line" data-testid="board-live-check-note">
          <span className="ico" aria-hidden="true">👁</span>
          <span>
            {t.ownerQuestionId ? (
              <>
                Merged and live. Waiting for your answer on a card. <a href={`#/decisions/${t.ownerQuestionId}`}>Open the card</a>
              </>
            ) : (
              `${t.watchingFor ? `Watching for: ${t.watchingFor}` : "Waiting for the agent to report the after-merge check"}${t.watchEndsAt ? ` · until ${new Date(t.watchEndsAt).toLocaleDateString()}${t.watchUntil ? "" : " (14-day default)"}` : ""}.${watchNoDateDays(t) !== null ? " Past 14 days with no date. The watchdog and then the CEO are told, not you." : ""}`
            )}
          </span>
        </span>
      )}
      {!!t.working?.length && (
        <span className="working" role="status">
          <span className="pulse-dot" aria-hidden="true" />
          {t.working.join(" and ")}
        </span>
      )}
      <div className="row">
        <span className="who" title={who ? `${who.name} (${who.agentKind})` : undefined}>
          {who && <Avatar agent={who} title={`${who.name} (${who.agentKind})`} />}
          <span className="who-name">{first}</span>
        </span>
        <span className="end">
          {(() => {
            const sa = stateAge(t);
            // The time in state already says how long; the last-activity age beside it would show the age twice.
            return <>{(!sa || t.dueDate || t.working?.length) && <span className="mono">{t.dueDate ? `Due ${t.dueDate}` : t.working?.length ? workingFor(t.workingSince) : age(t.lastActivityAt)}</span>}{sa ? <span className={`mono state-age${sa.old ? " old" : ""}`} title={sa.old ? `${sa.label}: more than 3 days in this state` : `Time in this state: ${sa.label}`} style={sa.old ? { color: "var(--amber-ink)" } : undefined}>{sa.text}</span> : null}</>;
          })()}
          {(titleCut || noteCut || waitsCut || open) && (
            <button type="button" className="icon-btn expand" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Show less of" : "Show all of"} ${ticketRefText}`} onClick={() => setOpen(!open)}>
              <svg width="16" height="16" {...iconProps} style={{ transform: open ? "rotate(180deg)" : undefined }}><path d="M6 9l6 6 6-6" /></svg>
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

export function Board({ companies, projectId, subpage, go, onCompaniesChanged, decisionsOpen }: { companies: Company[]; projectId: string | undefined; subpage?: string; go: (to: string) => void; onCompaniesChanged: () => void; /** The Decisions badge's figure, so the board can say how many open questions hold no task. */ decisionsOpen?: number | null }) {
  // The wheel over the sideways board must scroll the page even when the hand adds a little sideways movement (BOS-1915).
  const boardScrollRef = useWheelToPage();
  const hasCode = useHasCode();
  // BOS-2828: columns that run off the right edge say so, until the owner has scrolled to the last one.
  const [moreRight, setMoreRight] = useState(false);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".board-scroll");
    if (!el) return setMoreRight(false);
    const measure = () => setMoreRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 8);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  });
  const projects = usePoll(
    async (signal) => (await Promise.all(companies.map((c) => api<Project[]>(`/api/companies/${c.id}/projects`, { signal })))).flat(),
    60_000,
    companies.map((c) => c.id).join(","),
  );
  // An archived project opens only by its own link.
  const current = projects.data?.find((p) => p.id === projectId) ?? projects.data?.find((p) => !p.archivedAt);
  const [query, setQuery] = useState("");
  const [allDone, setAllDone] = useState(false);
  // BOS-2166: the server sends the newest done tickets only; every done ticket is asked for while "Show all done" is on or the search has words.
  const searching = query.trim() !== "";
  const wantAllDone = allDone || searching;
  // BOS-2497: cards come without descriptions; the search box matches them too, so they are asked for (text=1) only while it has words.
  const boardQuery = [wantAllDone ? "done=all" : "", searching ? "text=1" : ""].filter(Boolean).join("&");
  const board = usePoll((signal) => (current ? api<BoardData>(`/api/projects/${current.id}/board${boardQuery ? `?${boardQuery}` : ""}`, { signal }) : Promise.resolve(null)), 10_000, current?.id ?? "none");
  const reloadBoard = board.reload;
  const firstAsk = useRef(true);
  useEffect(() => {
    if (firstAsk.current) { firstAsk.current = false; return; }
    reloadBoard();
  }, [boardQuery, reloadBoard]);
  // BOS-1546: the merge queue's own status line for each approved ticket (place in line, check running since, the ticket it waits for). Asked only when the board has such a ticket.
  const inMergeLine = (board.data?.columns ?? []).some((c) => c.tickets.some((t) => t.reviewStage === "merging" || t.reviewStage === "held"));
  const mergeLines = usePoll(
    (signal) => (current && inMergeLine ? api<{ running: Array<{ ticketId: string; statusLine?: StatusLine }>; waiting: Array<{ ticketId: string; statusLine?: StatusLine }>; line?: MergeLine }>(`/api/companies/${current.companyId}/merge-queue`, { signal }) : Promise.resolve(null)),
    20_000,
    `board-mq-${current?.companyId ?? "none"}-${inMergeLine}`,
  );
  const mergeLineOf = (id: string) => [...(mergeLines.data?.running ?? []), ...(mergeLines.data?.waiting ?? [])].find((r) => r.ticketId === id)?.statusLine;
  const feats = usePoll((signal) => (current ? api<ScoredFeatures>(`/api/companies/${current.companyId}/features`, { signal }) : Promise.resolve(null)), 30_000, `board-feats-${current?.companyId ?? "none"}`);
  const goals = usePoll((signal) => (current ? api<Tree>(`/api/companies/${current.companyId}/objectives`, { signal }) : Promise.resolve(null)), 120_000, `board-goals-${current?.companyId ?? "none"}`);
  const [adding, setAdding] = useState<(Adding & { n: number }) | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // BOS-2475: "?holding=1" in the page link wins over the saved session value, so a shared link opens with it on.
  const [filters, setFilters] = useState(() => {
    const saved = readFilters();
    const linked = hashQuery().get("holding");
    return linked === "1" ? { ...saved, holding: true } : linked === "0" ? { ...saved, holding: false } : saved;
  });
  const setFilter = (change: Partial<SavedFilters>) =>
    setFilters((cur) => {
      const next = { ...cur, ...change };
      if ("holding" in change) {
        // Keep the choice in the page link without adding history entries or re-routing.
        const q = hashQuery();
        if (next.holding) q.set("holding", "1");
        else q.delete("holding");
        const base = window.location.hash.split("?")[0] || "#/board";
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${base}${q.toString() ? `?${q}` : ""}`);
      }
      try {
        sessionStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the choice lasts until the page reloads */
      }
      return next;
    });
  const { view, assignee } = filters;
  const setView = (v: BoardView) => setFilter({ view: v });
  const setAssignee = (a: string) => setFilter({ assignee: a });
  // BOS-1909: a parked lane shows this many cards, then "Show N more" (once pressed, all of them).
  const [moreOpen, setMoreOpen] = useState<Record<string, boolean>>({});
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
  // The Filter button and its panel (BOS-1194).
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const phone = useIsPhone();
  const closeFilter = useCallback(() => setFilterOpen(false), []);
  // A popover that crosses into phone width closes, keeping its filters.
  useEffect(() => {
    if (phone) setFilterOpen(false);
  }, [phone]);
  const filterCompany = companies.find((c) => c.id === current?.companyId);
  const filterCount = (view !== "all" ? 1 : 0) + (assignee !== "anyone" ? 1 : 0) + (featureFilter !== "any" ? 1 : 0) + (filters.working ? 1 : 0) + (filters.hideRecurring ? 1 : 0) + (filters.holding ? 1 : 0);
  const clearFilters = () => {
    setFilter({ view: "all", assignee: "anyone", feature: "any", working: false, stuckOnly: false, hideRecurring: false, holding: false });
  };
  const assigneeName = assignee === "owner" ? "You" : (filterCompany?.agents.find((a) => a.id === assignee)?.name ?? "Unknown");
  const featureName = featureFilter === "none" ? "none" : (featureList.find((f) => f.id === featureFilter)?.title ?? "");
  const chips: Array<{ key: string; label: string; remove: string; clear: () => void }> = [
    ...(view !== "all" ? [{ key: "view", label: `Showing: ${view === "tasks" ? "Tasks" : "Features"}`, remove: `showing ${view}`, clear: () => setView("all") }] : []),
    ...(assignee !== "anyone" ? [{ key: "assignee", label: `Assigned: ${assigneeName}`, remove: `assigned to ${assigneeName}`, clear: () => setAssignee("anyone") }] : []),
    ...(featureFilter !== "any" ? [{ key: "feature", label: `Feature: ${featureName}`, remove: `feature ${featureName}`, clear: () => setFilter({ feature: "any" }) }] : []),
    ...(filters.working ? [{ key: "working", label: "Working now", remove: "working now", clear: () => setFilter({ working: false }) }] : []),
    ...(filters.hideRecurring ? [{ key: "recurring", label: "Recurring hidden", remove: "recurring hidden", clear: () => setFilter({ hideRecurring: false }) }] : []),
    ...(filters.holding ? [{ key: "holding", label: "Holding others up", remove: "holding others up", clear: () => setFilter({ holding: false }) }] : []),
  ];
  // BOS-2475: for each open card, the open cards waiting on it.
  const waitersOf = waitingOnThis((board.data?.columns ?? []).flatMap((c) => c.tickets));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Every word must appear in the ticket's reference, title, feature or description.
  const passes = (t: BoardData["columns"][number]["tickets"][number]) =>
    (assignee === "anyone" || (assignee === "owner" ? t.assignedToOwner : t.assigneeAgentId === assignee)) &&
    (featureFilter === "any" || (featureFilter === "none" ? !t.featureId : t.featureId === featureFilter)) &&
    (!filters.working || !!t.working?.length) &&
    (!filters.stuckOnly || !!t.looksStuck) &&
    (!filters.hideRecurring || !t.recurring) &&
    (!filters.holding || (waitersOf.get(t.id)?.length ?? 0) > 0) &&
    (!words.length || words.every((w) => [t.number ? ticketRef(filterCompany?.ticketPrefix, t.number) : "", t.title, t.featureTitle ?? "", t.body ?? ""].join("\n").toLowerCase().includes(w)));
  // The review column is three lanes (BOS-667): still with its reviewers, approved by all of them and
  // only merging, and every ticket, from any column, whose next step is the owner's. Approved work used
  // to sit with the work awaiting review, so a long merge line read as a reviewer shortage.
  const label = (c: BoardData["columns"][number]) => (c.systemState === "review" && c.name === DEFAULT_LABEL.review ? "Awaiting review" : c.name);
  const waiting = (board.data?.columns ?? []).flatMap((c) => c.tickets.filter((t) => t.waitingOnOwner));
  const laneList = (board.data?.columns ?? []).flatMap((col): Array<{ col: typeof col; tickets: typeof col.tickets; mine: boolean; merging?: boolean; held?: boolean; liveCheck?: boolean; checking?: boolean }> => {
    const open = col.tickets.filter((t) => !t.waitingOnOwner);
    // BOS-1636: merged work in Blocked that only waits for its after-merge check is not stuck: its own lane, shown only when there is some.
    // BOS-1907: the lane is "Merged, watching". A merged ticket still in In progress (merged before the change) shows here too.
    if (col.systemState === "blocked") {
      const live = [...open.filter(isLiveCheckWait), ...(board.data?.columns ?? []).filter((c) => c.systemState === "in_progress").flatMap((c) => c.tickets.filter((t) => !t.waitingOnOwner && isLiveCheckWait(t)))];
      return [{ col, tickets: open.filter((t) => !isLiveCheckWait(t)), mine: false }, ...(live.length ? [{ col, tickets: live, mine: false, liveCheck: true }] : [])];
    }
    if (col.systemState === "in_progress") return [{ col, tickets: open.filter((t) => !isLiveCheckWait(t)), mine: false }];
    // BOS-1909: in Ready the "Next up" tickets (an agent's one waiting start) sit on top.
    if (col.systemState === "ready") return [{ col, tickets: [...open].sort((a, b) => Number(!!b.nextUp) - Number(!!a.nextUp)), mine: false }];
    if (col.systemState !== "review") return [{ col, tickets: open, mine: false }];
    // A reviewer's hold (BOS-808): passed, kept from merging on purpose. Its own lane, shown only when something is held.
    const held = open.filter((t) => t.reviewStage === "held");
    // BOS-1906: handed in, its quick check is queued or running, no reviewer is asked yet. Its own lane at the top, shown only when there is one.
    const checking = open.filter((t) => t.reviewStage === "checking");
    return [
      ...(checking.length ? [{ col, tickets: checking, mine: false, checking: true }] : []),
      { col, tickets: open.filter((t) => t.reviewStage !== "merging" && t.reviewStage !== "held" && t.reviewStage !== "checking"), mine: false },
      { col, tickets: open.filter((t) => t.reviewStage === "merging"), mine: false, merging: true },
      ...(held.length ? [{ col, tickets: held, mine: false, held: true }] : []),
      { col, tickets: waiting, mine: true },
    ];
  });
  // BOS-2337: "Your review" comes first when it has cards.
  const lanes = yourReviewFirst(laneList);
  const heldCount = lanes.find((l) => l.held)?.tickets.length ?? 0;
  const shownTotal = lanes.reduce((n, l) => n + l.tickets.filter(passes).length, 0);
  const downloadCsv = () => {
    const seen = new Set<string>();
    const rows = lanes.flatMap((l) =>
      l.tickets.filter(passes).flatMap((t) => {
        if (seen.has(t.id)) return [];
        seen.add(t.id);
        const a = t.assigneeAgentId ? companies.flatMap((c) => c.agents).find((x) => x.id === t.assigneeAgentId) : undefined;
        return [{ t, waiting: waitersOf.get(t.id)?.length ?? 0, column: l.col.name, assignee: a ? a.name : t.assignedToOwner ? "You" : "", ref: (t.number ? ticketRef(filterCompany?.ticketPrefix, t.number) : "") ?? "" }];
      }),
    );
    const slug = (current?.name ?? "project").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "project";
    download(`board-${slug}-${today()}.csv`, boardToCsv(rows));
  };
  // BOS-1909: the "Where work stands" strip. Counts follow the filters and the search, like the lanes, so they match what is shown.
  const cols = board.data?.columns ?? [];
  const progressCol = cols.find((c) => c.systemState === "in_progress");
  const readyCol = cols.find((c) => c.systemState === "ready");
  const standing = {
    inProgress: (progressCol?.tickets ?? []).filter((t) => !t.waitingOnOwner && !t.wipExempt && !t.recurring && !t.ownCheck && passes(t)).length,
    nextUp: (readyCol?.tickets ?? []).filter((t) => t.nextUp && passes(t)).length,
    beingChecked: (lanes.find((l) => l.checking)?.tickets.filter(passes).length ?? 0) + (progressCol?.tickets ?? []).filter((t) => !t.waitingOnOwner && !t.wipExempt && !t.recurring && t.ownCheck && passes(t)).length,
    watching: lanes.find((l) => l.liveCheck)?.tickets.filter(passes).length ?? 0,
  };
  // BOS-1910: every shown card the watchdog has handed on, in lane order; the strip links to the first.
  const stuckCards = lanes.flatMap((l) => l.tickets.filter((t) => t.looksStuck && passes(t)));
  const standingTargets = { inProgress: progressCol ? `lane-${progressCol.id}` : undefined, nextUp: readyCol ? `lane-${readyCol.id}` : undefined, beingChecked: "lane-being-checked", watching: "lane-live-check" };
  const rename = async (columnId: string, name: string) => {
    // The columns endpoint takes the whole list, so send every column with only this one renamed.
    await api(`/api/projects/${current!.id}/columns`, { method: "PUT", body: board.data!.columns.map((c) => ({ name: c.id === columnId ? name : c.name, systemState: c.systemState, wipLimit: c.wipLimit })) });
    board.reload();
  };
  // BOS-2193: Select mode. The selection lives only in this open page, so a reload starts clean.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastPicked = useRef<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const pick = (id: string, shift: boolean) => {
    setBulkResult(null);
    // Visible card order, as the page shows it.
    const order = Array.from(document.querySelectorAll<HTMLElement>("article.ticket[data-ticket-id]")).map((el) => el.dataset.ticketId!);
    const from = lastPicked.current ? order.indexOf(lastPicked.current) : -1;
    const to = order.indexOf(id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && from >= 0 && to >= 0) {
        // The range takes the state of the card just clicked.
        const on = !prev.has(id);
        for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) on ? next.add(x) : next.delete(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastPicked.current = id;
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setBulkResult(null);
    lastPicked.current = null;
  };
  const runBulk = async (action: BulkAction) => {
    if (bulkBusy || !selected.size) return;
    setBulkBusy(true);
    try {
      const r = await api<{ done: { id: string; ref: string | null }[]; refused: { id: string; ref: string | null; reason: string }[] }>("/api/tickets/bulk", { method: "POST", body: { ids: [...selected], action } });
      setBulkResult(bulkSummary(r.done.length, r.refused, action.type === "move" ? "moved" : "changed"));
      // Done ones leave the selection; refused ones stay selected so the owner can see them.
      setSelected(new Set(r.refused.map((x) => x.id)));
    } catch (e) {
      setBulkResult(`Nothing was changed: ${e instanceof Error && e.message ? e.message : "the request failed"}. Try again.`);
    } finally {
      setBulkBusy(false);
      board.reload();
    }
  };
  // Per card: "busy" while the request is out (a second click is ignored), or the error text if it failed.
  const [runState, setRunState] = useState<Record<string, { busy: boolean; error?: string }>>({});
  const runNowBusy = useRef(new Set<string>());
  const runNow = async (id: string) => {
    if (runNowBusy.current.has(id)) return;
    runNowBusy.current.add(id);
    setRunState((s) => ({ ...s, [id]: { busy: true } }));
    try {
      await api(`/api/tickets/${id}/run-now`, { method: "POST" });
      setRunState((s) => {
        const { [id]: _done, ...rest } = s;
        return rest;
      });
      board.reload();
    } catch (e) {
      const why = e instanceof Error && e.message ? ` (${e.message})` : "";
      setRunState((s) => ({ ...s, [id]: { busy: false, error: `Couldn't start this now${why}. Try again in a moment.` } }));
    } finally {
      runNowBusy.current.delete(id);
    }
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
          {/* (BOS-1126 Q10) The watchdog status is a small pill on the line under the project name, not floating mid-heading. */}
          {current && <p style={{ margin: "6px 0 0" }}><WatchdogHealth companyId={current.companyId} /> <GuideLink slug="the-watchdog">What's the watchdog?</GuideLink></p>}
        </div>
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
      {waiting.length > 0 && <OwnerAsksStrip waiting={waiting} decisionsOpen={decisionsOpen} />}
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
      {!!board.data?.otherProjects?.length && (
        <section className="unticketed" aria-label="Working on other projects">
          <strong>Working on other projects</strong>
          <ul>
            {board.data.otherProjects.map((r) => (
              <li key={r.id}>
                <strong>{r.agent ?? "An agent"}</strong> on <a href={`#/tickets/${r.ticketId}`}>{r.ticketNumber ? `${ticketRef(company?.ticketPrefix, r.ticketNumber)} · ` : ""}{r.ticketTitle}</a> in <a href={`#/board/${r.projectId}`}>{r.projectName}</a> <span className="muted">· started {ago(r.startedAt)}</span>
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
          <span className="search-field">
            <svg width="16" height="16" {...iconProps}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input type="search" className="board-search" aria-label="Search tasks" placeholder={`Search: ${company?.ticketPrefix || "HOL"}-12, title, words…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          <span className="filter-wrap">
          <button
            type="button"
            ref={filterBtn}
            className="btn filter-btn"
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            aria-controls="filter-panel"
            aria-label={filterCount ? `Filter, ${filterCount} on` : "Filter"}
            onClick={() => setFilterOpen((o) => !o)}
          >
            <svg width="16" height="16" {...iconProps}><path d="M4 7h16M7 12h10M10 17h4" /></svg>
            Filter
            {filterCount > 0 && <span className="filter-count" aria-hidden="true">{filterCount}</span>}
          </button>
          {filterOpen && (
            <FilterPanel
              view={view}
              onView={setView}
              assignee={assignee}
              onAssignee={setAssignee}
              feature={featureFilter}
              onFeature={(v) => setFilter({ feature: v })}
              working={filters.working}
              onWorking={(v) => setFilter({ working: v })}
              showRecurring={!filters.hideRecurring}
              onShowRecurring={(v) => setFilter({ hideRecurring: !v })}
              holding={filters.holding}
              onHolding={(v) => setFilter({ holding: v })}
              agents={company?.agents ?? []}
              features={featureList}
              workingCount={board.data?.workingAgents}
              shownCount={board.data ? shownTotal : undefined}
              anyOn={filterCount > 0}
              onClear={clearFilters}
              onClose={closeFilter}
              phone={phone}
              triggerRef={filterBtn}
            />
          )}
          </span>
          {current && view !== "features" && (
            <button type="button" className="btn" aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
              {selecting ? "Done selecting" : "Select"}
            </button>
          )}
          {current && view !== "features" && (
            <button type="button" className="btn" disabled={!board.data || shownTotal === 0} onClick={downloadCsv}>
              Download CSV
            </button>
          )}
          {!phone && chips.map((c) => (
            <span key={c.key} className="filter-chip" title={c.label}>
              <span>{c.label}</span>
              <button type="button" aria-label={`Remove filter: ${c.remove}`} onClick={c.clear}>
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
          {!phone && filterCount > 0 && (
            <button type="button" className="linkish" onClick={clearFilters}>
              Clear all
            </button>
          )}
        </div>
      </div>
      {selecting && view !== "features" && <BulkBar count={selected.size} agents={company?.agents ?? []} busy={bulkBusy} result={bulkResult} onRun={(a) => void runBulk(a)} onClear={() => { setSelected(new Set()); setBulkResult(null); lastPicked.current = null; }} />}
      {board.data && view !== "features" && <WorkStands counts={standing} targets={standingTargets} stuck={stuckCards.length} stuckTicketId={stuckCards[0]?.id} onShowStuck={() => setFilter({ stuckOnly: true })} />}
      {board.data && view !== "features" && (
        <p style={{ margin: "4px 0 0" }}>
          <GuideLink slug="board-and-decisions">How the board works</GuideLink>
        </p>
      )}
      {board.data && view !== "features" && filters.stuckOnly && (
        <p className="stuck-filter-line" role="status" data-testid="stuck-filter-line">
          Showing {stuckCards.length} stuck {stuckCards.length === 1 ? "card" : "cards"} ·{" "}
          <button type="button" className="chip" onClick={() => setFilter({ stuckOnly: false })}>Show all</button>
        </p>
      )}
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
      {view !== "features" && moreRight &&<p className="board-more muted" role="note">More columns to the right: scroll sideways →</p>}
      {view !== "features" && (
      <div className="board-scroll" ref={boardScrollRef}>
        <div className="board">
          {!board.data && current && !board.error && (
            <section className="lane" aria-label="Loading tasks"><Loader label="Loading tasks" /></section>
          )}
          {lanes.map(({ col, tickets, mine, merging, held, liveCheck, checking }) => {
            // Tickets that can't move (waits-on, plan with owner, merged and waiting to go live) don't count towards the limit (BOS-1172).
            const counted = col.tickets.filter((t) => !t.wipExempt).length;
            const full = col.wipLimit != null && counted >= col.wipLimit;
            const shown = tickets.filter(passes);
            const named = (t: (typeof shown)[number]) => {
              const a = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
              return a ? a.name : t.assignedToOwner ? "You" : "Nobody yet";
            };
            const done = col.systemState === "done";
            const rows = done ? [...shown].sort((x, y) => (y.lastActivityAt ?? "").localeCompare(x.lastActivityAt ?? "")) : shown;
            const visible = done && !allDone && !words.length ? rows.slice(0, DONE_SHOWN) : rows;
            // BOS-1909: parked lanes show 4 cards then "Show N more"; in Merged, watching a watch past its end sorts first.
            const parked = !!liveCheck || !!checking;
            const parkedKey = liveCheck ? "live-check" : "being-checked";
            const parkedRows = liveCheck ? [...shown].sort((x, y) => Number(watchPastEnd(y)) - Number(watchPastEnd(x))) : shown;
            const parkedShown = parked && !moreOpen[parkedKey] ? parkedRows.slice(0, PARKED_SHOWN) : parkedRows;
            return (
              <section className={`lane${mine ? " mine" : ""}${parked ? " parked" : ""}`} key={mine ? "your-review" : merging ? "merging" : held ? "held" : liveCheck ? "live-check" : checking ? "being-checked" : col.id} id={mine ? "your-review" : undefined} aria-labelledby={mine ? "lane-your-review" : merging ? "lane-merging" : held ? "lane-held" : liveCheck ? "lane-live-check" : checking ? "lane-being-checked" : `lane-${col.id}`}>
                {mine ? (
                  <OwnerAsksLaneHead waiting={shown} decisionsOpen={decisionsOpen} />
                ) : merging ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-merging">{hasCode ? "Approved, merging" : "Approved"}</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">
                      {hasCode ? <>Every reviewer approved. Boss Man checks and merges these itself. <a href={`#/merge-queue/${current?.companyId ?? ""}`}>See the merge queue</a></> : "Every reviewer approved."}
                    </span>
                  </header>
                ) : held ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-held">Passed, held</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">
                      {tickets.every((t) => t.hold?.system)
                        ? "Approved, but the merge waits on another ticket to be merged and live. Nothing is wrong: each one merges by itself afterwards."
                        : "A reviewer passed these but is holding the merge on purpose. Nothing is wrong, and nobody is woken until the hold ends."}
                    </span>
                    {heldSummary(mergeLines.data) && <HeldBehindFixLine held={heldSummary(mergeLines.data)!} />}
                  </header>
                ) : checking ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-being-checked" tabIndex={-1}>Being checked</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">Handed in. Boss Man is running each quick check, and nobody is asked to review until it passes. If it fails, the task goes back to its agent. Nothing is stuck.</span>
                  </header>
                ) : liveCheck ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-live-check" tabIndex={-1}>Merged, watching</h2>
                      <span className="mono">{shown.length}</span>
                    </div>
                    <span className="lane-hint">Already merged. Each card says what it waits for. Nothing is stuck and none of these count as blocked.</span>
                  </header>
                ) : renaming === col.id ? (
                  <RenameColumn col={col} onCancel={() => setRenaming(null)} onSave={async (name) => { await rename(col.id, name); setRenaming(null); }} />
                ) : (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id={`lane-${col.id}`} tabIndex={-1}>{label(col)}</h2>
                      <span className="mono" style={full ? { color: "var(--amber-ink)" } : undefined}>
                        {col.wipLimit != null ? `${counted} / ${col.wipLimit}` : done && !words.length && shown.length === tickets.length && board.data?.doneTotal != null ? board.data.doneTotal : shown.length}
                      </span>
                      <button type="button" className="icon-btn" aria-label={`Rename the ${label(col)} column`} title="Rename this column. Agents always see the fixed state." onClick={() => setRenaming(col.id)}>
                        <svg width="15" height="15" {...iconProps}>{PENCIL}</svg>
                      </button>
                    </div>
                    {oldestAge(shown) && <span className="lane-hint mono lane-oldest" title="The longest any card here has sat in its state">{oldestAge(shown)}</span>}
                    {col.name !== DEFAULT_LABEL[col.systemState] && (
                      <span className="lane-hint">
                        Agents see: <span className="mono">{col.systemState}</span>
                      </span>
                    )}
                  </header>
                )}
                {shown.length === 0 && tickets.length > 0 && words.length > 0 ? (
                  <p className="lane-empty">
                    No tasks match "{query.trim()}".{" "}
                    <button type="button" className="linkish" onClick={() => setQuery("")}>
                      Clear search
                    </button>
                  </p>
                ) : shown.length === 0 && tickets.length > 0 && filterCount > 0 ? (
                  <p className="lane-empty">
                    No tasks match your filters.{" "}
                    <button type="button" className="linkish" onClick={clearFilters}>
                      Clear filters
                    </button>
                  </p>
                ) : (
                  shown.length === 0 && <p className="lane-empty">{merging ? (heldCount > 0 ? `Nothing is merging right now. ${heldCount === 1 ? "1 approved task is" : `${heldCount} approved tasks are`} held, waiting: see "Passed, held" next.` : hasCode ? "Nothing approved is waiting to merge." : "Nothing approved yet.") : (EMPTY_HINT[col.systemState] ?? "No tasks here.")}</p>
                )}
                {done ? (
                  <>
                    <ul className="done-list">
                      {visible.map((t) => (
                        <li key={t.id}>
                          <svg width="16" height="16" {...iconProps} strokeWidth={2.2}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                          <span>
                            <DoneTitle id={t.id} title={t.title} />
                            <small title={named(t)}>{t.number ? `${ticketRef(company?.ticketPrefix, t.number)} · ` : ""}{t.assigneeAgentId ? named(t).split(" ")[0] : named(t)} · {when(t.lastActivityAt)}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {Math.max(rows.length, board.data?.doneTotal ?? 0) > DONE_SHOWN && (
                      <button type="button" className="linkish" onClick={() => setAllDone(!allDone)}>
                        {allDone ? "Show fewer" : `Show all done tasks (${Math.max(rows.length, board.data?.doneTotal ?? 0)})`}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                  {(parked ? parkedShown : shown).map((t) => (
                    <TicketCard
                      key={t.id}
                      quiet={parked}
                      sameAs={mine ? sameQuestionAs(t, waiting) : undefined}
                      waiters={waitersOf.get(t.id)}
                      select={selecting ? { checked: selected.has(t.id), onClick: pick } : undefined}
                      t={t}
                      mine={!!mine}
                      merging={!!merging}
                      who={t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined}
                      name={named(t)}
                      prefix={company?.ticketPrefix}
                      tiers={tiers}
                      numberOf={(id) => (board.data?.columns ?? []).flatMap((c) => c.tickets).find((x) => x.id === id)?.number}
                      onRunNow={(id) => void runNow(id)}
                      runState={runState[t.id]}
                      mergeLine={t.reviewStage === "merging" || t.reviewStage === "held" ? mergeLineOf(t.id) : undefined}
                    />
                  ))}
                  {parked && parkedRows.length > PARKED_SHOWN && (
                    <button type="button" className="btn show-more" aria-expanded={!!moreOpen[parkedKey]} onClick={() => setMoreOpen({ ...moreOpen, [parkedKey]: !moreOpen[parkedKey] })}>
                      {moreOpen[parkedKey] ? "Show fewer" : `Show ${parkedRows.length - PARKED_SHOWN} more`}
                    </button>
                  )}
                  </>
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
