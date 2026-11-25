import { useEffect, useRef, useState, type FormEvent } from "react";
import { NoCompany } from "../components/NoCompany";
import { api, FEATURE_STATUS_LABEL, today, type Company, type FeatureRoadmapCompany, type Horizon, type RoadmapCompany, type RoadmapFeature, type RoadmapMilestone, type RoadmapObjective } from "../api";
import { MilestoneLeft, type MilestoneTicketRow } from "./MilestoneLeft";
import { MilestoneRows, STATUS, rangeOf, type DateRange } from "./RoadmapRows";
import { usePoll } from "../hooks";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { STATUS_TONE } from "./Features";
import { short } from "../short-date";
import { buildCsv, download } from "../csv";

export { STATUS };

function MilestoneDetail({ m, onChanged }: { m: RoadmapMilestone; onChanged: () => void }) {
  const list = usePoll((signal) => api<MilestoneTicketRow[]>(`/api/milestones/${m.id}/tickets`, { signal }), 30_000, m.id);
  const [title, setTitle] = useState(m.title);
  const [date, setDate] = useState(m.targetDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void api(`/api/milestones/${m.id}`, { method: "PATCH", body: { title: title.trim(), targetDate: date || null } }).then(onChanged, (err: Error) => setError(err.message));
  };
  return (
    <div className="rm-detail">
      <form onSubmit={save} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "2 1 220px" }}>
          <label htmlFor={`ms-t-${m.id}`}>Milestone</label>
          <input id={`ms-t-${m.id}`} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`ms-d-${m.id}`}>Target date</label>
          <input id={`ms-d-${m.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <button className="btn" type="submit">
          Save
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => window.confirm(`Delete "${m.title}"? Its tickets stay, without a milestone.`) && void api(`/api/milestones/${m.id}`, { method: "DELETE" }).then(onChanged, (err: Error) => setError(err.message))}
        >
          Delete
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {m.blocked > 0 && <p className="muted" style={{ fontSize: 14 }}>{m.blocked} blocked: see what they're waiting on in the Plan.</p>}
      {list.data?.length ? (
        <MilestoneLeft rows={list.data} today={today()} />
      ) : (
        list.data && <p className="muted">No tickets yet. Pick this milestone on a ticket's page to add it.</p>
      )}
    </div>
  );
}

function AddMilestone({ objectiveId, onAdded, horizon }: { objectiveId: string; onAdded: () => void; horizon?: Horizon }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        Add a milestone
      </button>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void api(`/api/objectives/${objectiveId}/milestones`, { method: "POST", body: { title: title.trim(), ...(date ? { targetDate: date } : {}), ...(horizon ? { horizon } : {}) } }).then(
      () => (setTitle(""), setDate(""), setOpen(false), onAdded()),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
      <div className="field" style={{ flex: "2 1 220px" }}>
        <label htmlFor={`new-ms-${objectiveId}`}>New milestone</label>
        <input id={`new-ms-${objectiveId}`} required maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`new-ms-d-${objectiveId}`}>Target date</label>
        <input id={`new-ms-d-${objectiveId}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <button className="btn primary" type="submit">
        Add
      </button>
      <button className="btn" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

const STALE_KEY_RESULT_DAYS = 14;

/** A small line of recent values, left oldest (BOS-2458). */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${16 - ((v - lo) / span) * 14 - 1}`).join(" ");
  return (
    <svg width={60} height={16} role="img" aria-label={label} style={{ verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

/** A key result with "Change" (an inline form) and "Remove" (asks first). BOS-2250. */
function KeyResultRow({ k, onChanged }: { k: RoadmapObjective["keyResults"][number]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(k.title);
  const [current, setCurrent] = useState(k.current === null ? "" : String(k.current));
  const [target, setTarget] = useState(k.target === null ? "" : String(k.target));
  const [unit, setUnit] = useState(k.unit ?? "");
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setTitle(k.title);
    setCurrent(k.current === null ? "" : String(k.current));
    setTarget(k.target === null ? "" : String(k.target));
    setUnit(k.unit ?? "");
    setError(null);
    setEditing(true);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    void api(`/api/key-results/${k.id}`, { method: "PATCH", body: { title: title.trim(), current: num(current), target: num(target), unit: unit.trim() || null } }).then(
      () => (setEditing(false), onChanged()),
      (err: Error) => setError(err.message),
    );
  };
  if (editing)
    return (
      <li>
        <form onSubmit={save} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", width: "100%" }}>
          <div className="field" style={{ flex: "2 1 200px" }}>
            <label htmlFor={`kr-t-${k.id}`}>Key result</label>
            <input id={`kr-t-${k.id}`} required maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label htmlFor={`kr-c-${k.id}`}>Current</label>
            <input id={`kr-c-${k.id}`} type="number" step="any" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label htmlFor={`kr-g-${k.id}`}>Target</label>
            <input id={`kr-g-${k.id}`} type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label htmlFor={`kr-u-${k.id}`}>Unit</label>
            <input id={`kr-u-${k.id}`} maxLength={20} value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
          <button className="btn primary small" type="submit">
            Save
          </button>
          <button className="btn small" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </li>
    );
  const readings = k.readings ?? [];
  const last = readings.length ? readings[readings.length - 1]! : null;
  const days = last ? Math.max(0, Math.floor((Date.now() - new Date(last.at).getTime()) / 86_400_000)) : null;
  const stale = days === null || days >= STALE_KEY_RESULT_DAYS;
  const spark = readings.slice(-12).map((r) => r.value);
  return (
    <li>
      <span>{k.title}</span>
      {k.progress !== null && (
        <span className="bar" style={{ width: 90 }} aria-label={`${Math.round(k.progress * 100)}%`}>
          <span style={{ width: `${k.progress * 100}%` }} />
        </span>
      )}
      <span className="mono muted">
        {k.current ?? 0}
        {k.target !== null ? ` / ${k.target}` : ""}
        {k.unit ? ` ${k.unit}` : ""}
      </span>
      {spark.length >= 2 && <Sparkline values={spark} label={`Last ${spark.length} readings of ${k.title}`} />}
      <span className="muted">{days === null ? "never updated" : days === 0 ? "updated today" : `updated ${days} day${days === 1 ? "" : "s"} ago`}</span>
      {stale && <span className="tag">Not updated in {STALE_KEY_RESULT_DAYS} days</span>}
      <button type="button" className="btn small" aria-label={`Change the key result ${k.title}`} onClick={open}>
        Change
      </button>
      <button
        type="button"
        className="btn small"
        aria-label={`Remove the key result ${k.title}`}
        onClick={() => window.confirm(`Remove the key result ${k.title}?`) && void api(`/api/key-results/${k.id}`, { method: "DELETE" }).then(onChanged, (err: Error) => setError(err.message))}
      >
        Remove
      </button>
      {error && <span className="error">{error}</span>}
      {readings.length > 0 && (
        <details style={{ width: "100%" }}>
          <summary className="muted">Readings ({readings.length})</summary>
          <ul>
            {[...readings].reverse().map((r) => (
              <li key={`${r.at}-${r.value}-${r.by}`} className="muted">
                {new Date(r.at).toLocaleString()}: {r.value}
                {k.unit ? ` ${k.unit}` : ""} ({r.by})
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function Objective({ o, win, now, onChanged }: { o: RoadmapObjective; win: DateRange; now: string; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const setStatus = (status: "done" | "dropped" | "active") => void api(`/api/objectives/${o.id}`, { method: "PATCH", body: { status } }).then(onChanged);
  // "Change": rename the objective or change its priority (BOS-2254). Only title and priority are sent; the reload
  // brings the objectives back in the server's priority order.
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(o.title);
  const [priority, setPriority] = useState(o.priority);
  const [error, setError] = useState<string | null>(null);
  const open = () => (setTitle(o.title), setPriority(o.priority), setError(null), setEditing(true));
  const save = (e: FormEvent) => {
    e.preventDefault();
    // `required` lets a title of only spaces through; it would trim to "" on the server.
    if (!title.trim()) return setError("Give the objective a name.");
    void api(`/api/objectives/${o.id}`, { method: "PATCH", body: { title: title.trim(), priority } }).then(
      () => (setEditing(false), onChanged()),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <article className="rm-obj" aria-labelledby={`obj-${o.id}`}>
      <div className="rm-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={`obj-${o.id}`}>
            <span className="tag" title="Priority (1 is highest)">
              P{o.priority}
            </span>{" "}
            {o.title}
            {o.status !== "active" && <span className="tag"> {o.status === "dropped" ? "removed" : o.status}</span>}
          </h3>
          {editing && (
            <form onSubmit={save} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", margin: "8px 0" }}>
              <div className="field" style={{ flex: "2 1 220px" }}>
                <label htmlFor={`obj-t-${o.id}`}>Objective</label>
                <input id={`obj-t-${o.id}`} required maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={`obj-p-${o.id}`}>Priority</label>
                <select id={`obj-p-${o.id}`} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((p) => (
                    <option key={p} value={p}>
                      P{p}
                      {p === 1 ? " (highest)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn primary small" type="submit">
                Save
              </button>
              <button className="btn small" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              {error && <p className="error">{error}</p>}
            </form>
          )}
          {o.keyResults.length > 0 && (
            <ul className="rm-krs">
              {o.keyResults.map((k) => (
                <KeyResultRow key={`${k.id}-${k.title}-${k.current}-${k.target}-${k.unit}`} k={k} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </div>
      </div>
      {o.milestones.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          No milestones yet. Add one to see whether it will be ready by its date.
        </p>
      ) : (
        <MilestoneRows ms={o.milestones} range={win} now={now} selected={selected} onSelect={setSelected} detail={(m) => <MilestoneDetail key={m.id} m={m} onChanged={onChanged} />} />
      )}
      {/* Under the milestones, so the status is the first thing seen. */}
      <div className="rm-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <AddMilestone objectiveId={o.id} onAdded={onChanged} />
        {!editing && (
          <button type="button" className="btn small" aria-label={`Change the objective ${o.title}`} onClick={open}>
            Change
          </button>
        )}
        {o.status === "active" ? (
          <>
            <button type="button" className="btn small" onClick={() => setStatus("done")}>
              Mark done
            </button>
            <button type="button" className="btn small" onClick={() => window.confirm(`Remove "${o.title}" from the roadmap? It's kept: tick "Show done work" to see it again, and Reopen to bring it back.`) && setStatus("dropped")}>
              Remove
            </button>
          </>
        ) : (
          <button type="button" className="btn small" onClick={() => setStatus("active")}>
            Reopen
          </button>
        )}
      </div>
    </article>
  );
}

function AddObjective({ companies, onAdded }: { companies: Company[]; onAdded: () => void }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void api(`/api/companies/${companyId || companies[0]!.id}/objectives`, { method: "POST", body: { title: title.trim(), priority } }).then(
      () => (setTitle(""), setError(null), onAdded()),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }} aria-label="Add an objective">
      {companies.length > 1 && (
        <div className="field">
          <label htmlFor="obj-company">Company</label>
          <select id="obj-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field" style={{ flex: "3 1 260px" }}>
        <label htmlFor="obj-title">New objective</label>
        <input id="obj-title" required maxLength={200} placeholder="e.g. Launch the public beta" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="obj-priority">Priority</label>
        <select id="obj-priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((p) => (
            <option key={p} value={p}>
              P{p}
              {p === 1 ? " (highest)" : ""}
            </option>
          ))}
        </select>
      </div>
      <button className="btn primary" type="submit">
        Add objective
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

const TABS = [
  { id: "features", label: "Roadmap", help: "Features in Now, Next and Later, grouped by objective; unfold a feature to see its milestones." },
  { id: "timeline", label: "Timeline", help: "Your milestones and whether each will be ready by its date. Tap one to see its tickets and progress." },
] as const;
type Tab = (typeof TABS)[number]["id"];
const COLUMNS: Array<{ id: Horizon; label: string; help: string }> = [
  { id: "now", label: "Now", help: "Being built" },
  { id: "next", label: "Next", help: "Planned and prioritised" },
  { id: "later", label: "Later", help: "Accepted, not scheduled" },
];

/** A milestone inside a feature card, with the control that pins it to a column. */
function FeatureMilestone({ m, onChanged }: { m: RoadmapFeature["milestones"][number]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const pin = (value: string) =>
    void api(`/api/milestones/${m.id}`, { method: "PATCH", body: { horizon: value === "auto" ? null : value } }).then(onChanged, (err: Error) => setError(err.message));
  return (
    <li>
      <span>
        <b>{m.title}</b>
        <span className="muted"> · {m.targetDate ? short(m.targetDate) : "No date"}</span>
      </span>
      <label className="rm-pin">
        <span className="visually-hidden">Where "{m.title}" sits</span>
        <select value={m.pinned ?? "auto"} onChange={(e) => pin(e.target.value)}>
          <option value="auto">Automatic</option>
          <option value="now">Pinned to Now</option>
          <option value="next">Pinned to Next</option>
          <option value="later">Pinned to Later</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
    </li>
  );
}

/** A feature on the roadmap: opens the feature, and unfolds its milestones. */
function FeatureCard({ f, companyId, onChanged }: { f: RoadmapFeature; companyId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rm-card" style={{ ["--c" as string]: "var(--accent)" }}>
      <div className="rm-card-title">
        <a href={`#/features/${companyId}/${f.id}`}>
          <b>{f.title}</b>
        </a>
        {f.milestones.length > 0 && (
          <button type="button" className={`btn small rm-unfold ${open ? "open" : ""}`} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} milestones for ${f.title}`} onClick={() => setOpen(!open)}>
            <span aria-hidden="true" className="rm-chevron">›</span>
            Milestones
          </button>
        )}
      </div>
      <div className="rm-card-meta">
        <span className={`tag ${STATUS_TONE[f.status]}`}>{FEATURE_STATUS_LABEL[f.status]}</span>
        {f.rank !== null && <span className="tag" title="Rank">P{f.rank}</span>}
        <span className="muted">Priority {f.priority.toFixed(1)}</span>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {f.tickets.done === 0 ? "Not started" : `${f.tickets.done} of ${f.tickets.total} done`}
      </span>
      {open && (
        <ul className="rm-milestones">
          {f.milestones.map((m) => (
            <FeatureMilestone key={m.id} m={m} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </li>
  );
}

type FeatureRow = { key: string; objective: RoadmapFeature["objective"]; features: Record<Horizon, RoadmapFeature[]> };

/** One company's feature roadmap: an objective per row and the three columns, then the folded Released list. */
function FeatureBoard({ c, onChanged }: { c: FeatureRoadmapCompany; onChanged: () => void }) {
  const live = c.features.filter((f) => f.column !== "released");
  const released = c.features.filter((f) => f.column === "released").sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || a.title.localeCompare(b.title));
  const rows = new Map<string, FeatureRow>();
  for (const f of live) {
    const key = f.objective?.id ?? "";
    const row = rows.get(key) ?? { key, objective: f.objective, features: { now: [], next: [], later: [] } };
    row.features[f.column as Horizon].push(f);
    rows.set(key, row);
  }
  if (!rows.has("")) rows.set("", { key: "", objective: null, features: { now: [], next: [], later: [] } });
  const ordered = [...rows.values()].sort((a, b) => (a.objective?.priority ?? 99) - (b.objective?.priority ?? 99) || (a.objective?.title ?? "Unassigned").localeCompare(b.objective?.title ?? "Unassigned"));
  const order = (a: RoadmapFeature, b: RoadmapFeature) => (a.rank ?? 99) - (b.rank ?? 99) || b.priority - a.priority || a.title.localeCompare(b.title);
  return (
    <section className="card rm-company" aria-labelledby={`rmf-${c.id}`}>
      <h2 id={`rmf-${c.id}`}>
        {c.name}{" "}
        <a href={`#/plan/${c.id}`} style={{ fontSize: 14, fontWeight: 400 }}>
          See the plan
        </a>
      </h2>
      {!c.features.length ? (
        <p className="muted">
          No features yet. <a href={`#/features/${c.id}`}>Add one on the Features page</a>.
        </p>
      ) : (
        <>
          <div className="rm-grid" role="table" aria-label={`Feature roadmap for ${c.name}`}>
            <div className="rm-grid-head" role="row">
              <span role="columnheader">Objective</span>
              {COLUMNS.map((col) => (
                <span role="columnheader" key={col.id}>
                  {col.label} <small>{col.help}</small>
                </span>
              ))}
            </div>
            {ordered.map((row) => (
              <div className="rm-grid-row" role="row" key={row.key || "unassigned"}>
                <div className="rm-grid-obj" role="rowheader">
                  {row.objective ? (
                    <>
                      <span className="tag" title="Priority (1 is highest)">
                        P{row.objective.priority}
                      </span>{" "}
                      {row.objective.title}
                    </>
                  ) : (
                    <span className="muted">Unassigned</span>
                  )}
                </div>
                {COLUMNS.map((col) => (
                  <div className="rm-grid-cell" role="cell" key={col.id}>
                    {row.features[col.id].length ? (
                      <ul className="rm-cards">
                        {[...row.features[col.id]].sort(order).map((f) => (
                          <FeatureCard key={f.id} f={f} companyId={c.id} onChanged={onChanged} />
                        ))}
                      </ul>
                    ) : (
                      <span className="muted" aria-label={`No ${col.label} features`}>
                        —
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {released.length > 0 && (
            <details className="rm-released">
              <summary>Released ({released.length})</summary>
              <ul className="rm-cards">
                {released.map((f) => (
                  <FeatureCard key={f.id} f={f} companyId={c.id} onChanged={onChanged} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

const COLUMN_LABEL: Record<RoadmapFeature["column"], string> = { now: "Now", next: "Next", later: "Later", released: "Released" };
export const FEATURES_CSV_HEAD = ["company", "column", "rank", "feature", "status", "objective", "milestones", "tasks_done", "tasks_total", "released", "on_portal"];
export const MILESTONES_CSV_HEAD = ["company", "objective", "milestone", "target_date", "status", "tasks_done", "tasks_total", "points_left", "expected_finish", "days_late"];

const day = (s: string | null) => (s ? s.slice(0, 10) : "");

/** One row per feature on the Roadmap tab, in the order the page shows them: each company's columns Now, Next, Later, then Released. */
export function featuresToCsvRows(companies: FeatureRoadmapCompany[]): Array<Array<string | number>> {
  const order = (a: RoadmapFeature, b: RoadmapFeature) => (a.rank ?? 99) - (b.rank ?? 99) || b.priority - a.priority || a.title.localeCompare(b.title);
  return companies.flatMap((c) =>
    (["now", "next", "later", "released"] as const).flatMap((col) =>
      c.features
        .filter((f) => f.column === col)
        .sort(order)
        .map((f) => [
          c.name,
          COLUMN_LABEL[col],
          f.rank ?? "",
          f.title,
          FEATURE_STATUS_LABEL[f.status],
          f.objective?.title ?? "",
          f.milestones.map((m) => (m.targetDate ? `${m.title} (${day(m.targetDate)})` : m.title)).join("; "),
          f.tickets.done,
          f.tickets.total,
          day(f.releasedAt),
          f.showPublicly ? "yes" : "no",
        ]),
    ),
  );
}

/** One row per milestone on the Timeline tab, with the status label the page shows. */
export function milestonesToCsvRows(companies: RoadmapCompany[]): Array<Array<string | number>> {
  return companies.flatMap((c) =>
    c.objectives.flatMap((o) =>
      o.milestones.map((m) => [c.name, o.title, m.title, day(m.targetDate), STATUS[m.status].label, m.done, m.total, m.forecast.pointsLeft, day(m.forecast.expectedFinish), m.forecast.daysLate]),
    ),
  );
}

export const roadmapFileName = (kind: "features" | "milestones", now = new Date()) => `roadmap-${kind}-${now.toISOString().slice(0, 10)}.csv`;

export function Roadmap({ companies, tab: tabParam, go }: { companies: Company[]; tab: string | undefined; go: (to: string) => void }) {
  const tab: Tab = (TABS.find((t) => t.id === tabParam)?.id ?? "features") as Tab;
  const [closed, setClosed] = useState(false);
  const now = today();
  const data = usePoll((signal) => api<RoadmapCompany[]>(`/api/roadmap?today=${now}${closed ? "&closed=1" : ""}`, { signal }), 60_000, `roadmap-${closed}`);
  const board = usePoll((signal) => api<FeatureRoadmapCompany[]>(`/api/roadmap/features`, { signal }), 60_000, "roadmap-features");
  const list = data.data ?? [];
  const win = rangeOf(list, now);
  const reload = () => {
    data.reload();
    board.reload();
  };
  const featureCount = (board.data ?? []).reduce((n, c) => n + c.features.filter((f) => f.column !== "released").length, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Roadmap</h1>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {tab === "timeline" && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44, fontSize: 14 }}>
              <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
              Show done work
            </label>
          )}
          <button
            type="button"
            className="btn small"
            disabled={tab === "timeline" ? !data.data : !board.data}
            onClick={() =>
              tab === "timeline"
                ? download(roadmapFileName("milestones"), buildCsv(MILESTONES_CSV_HEAD, milestonesToCsvRows(list)))
                : download(roadmapFileName("features"), buildCsv(FEATURES_CSV_HEAD, featuresToCsvRows(board.data ?? [])))
            }
          >
            Download CSV
          </button>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Roadmap views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`rm-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="rm-panel" onClick={() => go(`roadmap/${t.id}`)}>
            {t.label}
            {t.id === "features" && board.data && <span className="tab-count">{featureCount}</span>}
          </button>
        ))}
      </div>
      <div id="rm-panel" role="tabpanel" aria-labelledby={`rm-tab-${tab}`} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <p className="muted" style={{ fontSize: 13 }}>
          {TABS.find((t) => t.id === tab)!.help}        </p>
        {tab === "timeline" && data.error && <LoadError what="the timeline" message={data.error.message} onRetry={data.reload} />}
        {tab === "features" && board.error && <LoadError what="the features" message={board.error.message} onRetry={board.reload} />}
        {tab === "timeline" && !data.data && !data.error && <Loader label="Loading the timeline" />}
        {tab === "features" && !board.data && !board.error && <Loader label="Loading the features" />}
        {tab === "timeline" ? (
          list.map((c) => (
            <section key={c.id} className="card rm-company" aria-labelledby={`rm-${c.id}`}>
              <h2 id={`rm-${c.id}`}>
                {c.name}{" "}
                <a href={`#/plan/${c.id}`} style={{ fontSize: 14, fontWeight: 400 }}>
                  See the plan
                </a>
              </h2>
              {c.objectives.length ? c.objectives.map((o) => <Objective key={o.id} o={o} win={win} now={now} onChanged={data.reload} />) : <p className="muted">No objectives yet.</p>}
            </section>
          ))
        ) : (
          board.data?.map((c) => <FeatureBoard key={c.id} c={c} onChanged={reload} />)
        )}
      </div>
      {companies.length > 0 ? <AddObjective companies={companies} onAdded={reload} /> : <NoCompany />}
    </>
  );
}
