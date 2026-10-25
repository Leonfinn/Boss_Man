import { useState, type FormEvent } from "react";
import { api, FEATURE_STATUSES, FEATURE_STATUS_LABEL, RISKS, type Board as BoardData, type Company, type Feature, type FeatureStatus, type Project, type Risk, type ScoredFeatures } from "../api";
import { ticketRef } from "@boss-man/shared";
import { art } from "../brand";
import { RiskHelp, useRiskTiers, type RiskTiers } from "../components/RiskHelp";
import { State } from "../components/State";
import { usePoll } from "../hooks";
import { GoalSelect, STATUS_TONE, type GoalLink, type Tree } from "./Features";
import { StarButton } from "./Agents";
import { ProjectBudget } from "./ProjectBudget";
import { ArchiveProject, ProjectBrief, ProjectRow } from "./Settings";
import { Avatar } from "../components/Avatar";

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

type NewTicketInput = { title: string; body: string | null; risk: Risk | null; planFirst: boolean; assigneeAgentId: string | null; assignedToOwner: boolean; featureId: string | null; acceptanceCriteria?: string[] };
type NewFeatureInput = { title: string; description: string | null; planWithCeo: boolean } & GoalLink;
/** What the add form was opened for: a feature, or a task (optionally inside one feature). */
type Adding = { mode: "feature" | "task"; featureId: string };

/** Add form: a new feature (the top-level card) or a new task, optionally part of a feature. */
function AddForm({ initial, agents, features, goals, tiers, hasCeo, onAddTask, onAddFeature, onGrill, onClose }: { initial: Adding; agents: Company["agents"]; features: Feature[]; goals: Tree; tiers: RiskTiers; hasCeo: boolean; onAddTask: (t: NewTicketInput) => Promise<unknown>; onAddFeature: (f: NewFeatureInput) => Promise<unknown>; onGrill: (d: { kind: "task" | "feature"; title: string; description: string | null }) => Promise<unknown>; onClose: () => void }) {
  const blank = { title: "", body: "", risk: "none" as Risk | "none", assignee: "", feature: initial.featureId, plan: hasCeo, goal: { objectiveId: null, milestoneId: null } as GoalLink, criteria: "" };
  const [mode, setMode] = useState(initial.mode);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isFeature = mode === "feature";
  // Plan first follows the risk level: high and critical work is planned and approved first.
  const planFirst = form.risk === "high" || form.risk === "critical";
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      if (isFeature) await onAddFeature({ title: form.title.trim(), description: form.body.trim() || null, planWithCeo: form.plan && hasCeo, ...form.goal });
      else
        await onAddTask({
          title: form.title.trim(),
          body: form.body.trim() || null,
          risk: form.risk === "none" ? null : form.risk,
          planFirst,
          assigneeAgentId: form.assignee && form.assignee !== "owner" ? form.assignee : null,
          assignedToOwner: form.assignee === "owner",
          featureId: form.feature || null,
          acceptanceCriteria: form.criteria.split("\n").map((l) => l.trim()).filter(Boolean),
        });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Hands the draft to the CEO, who questions the owner in chat and then creates it.
  const grill = async () => {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      await onGrill({ kind: mode, title: form.title.trim(), description: form.body.trim() || null });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
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
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn${mode === m ? " primary" : ""}`} onClick={() => setMode(m)}>
            {m === "feature" ? "New feature" : "New task"}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="nt-title">Title</label>
        <input id="nt-title" autoFocus required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="nt-body">{isFeature ? "What problem does it solve, and for whom?" : "Description"}</label>
        <textarea
          id="nt-body"
          rows={6}
          maxLength={20_000}
          placeholder={isFeature ? "" : "What should be done, and what counts as finished."}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
        />
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
          <small className="muted">Optional, up to 10. The agent reports pass or fail against each when it asks for review.</small>
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
        <button className="btn primary" type="submit" disabled={busy || !form.title.trim()}>
          {isFeature ? "Add feature" : agentChosen ? "Add and start" : "Add to backlog"}
        </button>
        {hasCeo && (
          <button className="btn" type="button" disabled={busy || !form.title.trim()} onClick={() => void grill()}>
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
  const visibleFeatures = featureList.filter((f) => shownStates.includes(f.status));
  // The review column is two lanes: agent review, and the tickets whose next step is the owner's sign-off.
  const label = (c: BoardData["columns"][number]) => (c.systemState === "review" && c.name === DEFAULT_LABEL.review ? "Agent review" : c.name);
  const lanes = (board.data?.columns ?? []).flatMap((col) =>
    col.systemState === "review"
      ? [{ col, tickets: col.tickets.filter((t) => !t.waitingOnOwner), mine: false }, { col, tickets: col.tickets.filter((t) => t.waitingOnOwner), mine: true }]
      : [{ col, tickets: col.tickets, mine: false }],
  );
  const waiting = (board.data?.columns ?? []).flatMap((c) => c.tickets.filter((t) => t.waitingOnOwner));
  const rename = async (columnId: string, name: string) => {
    // The columns endpoint takes the whole list, so send every column with only this one renamed.
    await api(`/api/projects/${current!.id}/columns`, { method: "PUT", body: board.data!.columns.map((c) => ({ name: c.id === columnId ? name : c.name, systemState: c.systemState, wipLimit: c.wipLimit })) });
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
      {board.error && (
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
            <input type="search" aria-label="Search tasks" placeholder="Search: HOL-12, title, words…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 220 }} />
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
          {lanes.map(({ col, tickets, mine }) => {
            const full = col.wipLimit != null && col.tickets.length >= col.wipLimit;
            const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
            // Every word must appear in the ticket's reference, title, feature or description.
            const hit = (t: (typeof tickets)[number]) => !words.length || words.every((w) => [t.number ? ticketRef(company?.ticketPrefix, t.number) : "", t.title, t.featureTitle ?? "", t.body ?? ""].join("\n").toLowerCase().includes(w));
            const shown = tickets.filter((t) => (assignee === "anyone" || (assignee === "owner" ? t.assignedToOwner : t.assigneeAgentId === assignee)) && hit(t));
            const named = (t: (typeof shown)[number]) => {
              const a = t.assigneeAgentId ? agents.get(t.assigneeAgentId) : undefined;
              return a ? a.name : t.assignedToOwner ? "You" : "Nobody yet";
            };
            const done = col.systemState === "done";
            const rows = done ? [...shown].sort((x, y) => (y.lastActivityAt ?? "").localeCompare(x.lastActivityAt ?? "")) : shown;
            const visible = done && !allDone && !words.length ? rows.slice(0, DONE_SHOWN) : rows;
            return (
              <section className={`lane${mine ? " mine" : ""}`} key={mine ? "your-review" : col.id} id={mine ? "your-review" : undefined} aria-labelledby={mine ? "lane-your-review" : `lane-${col.id}`}>
                {mine ? (
                  <header className="lane-head">
                    <div className="lane-title">
                      <h2 id="lane-your-review">Your review</h2>
                      <span className="count-badge">{shown.length}</span>
                    </div>
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
                {shown.length === 0 && <p className="lane-empty">{EMPTY_HINT[col.systemState] ?? "No tasks here."}</p>}
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
                      </div>
                      <h3>
                        <a href={`#/tickets/${t.id}`}>{t.title}</a>
                      </h3>
                      {mine && <span className="note">{t.approvedBy ? `${t.approvedBy} approved.` : "Approved."} Needs your sign-off to merge.</span>}
                      {mine && (
                        <a className="btn primary small" href={`#/tickets/${t.id}`} style={{ justifyContent: "center" }}>
                          Review and approve
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
                      {!!t.working?.length && (
                        <span className="working" role="status">
                          <span className="pulse-dot" aria-hidden="true" />
                          {t.working.join(" and ")} working now
                        </span>
                      )}
                      <div className="row">
                        <span className="who">
                          {who && (
                            <Avatar agent={who} title={`${who.name} (${who.agentKind})`} />
                          )}
                          {named(t)}
                        </span>
                        <span className="mono">{t.dueDate ? `Due ${t.dueDate}` : t.working?.length ? "now" : age(t.lastActivityAt)}</span>
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
