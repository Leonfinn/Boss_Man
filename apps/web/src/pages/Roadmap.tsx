import { useEffect, useRef, useState, type FormEvent } from "react";
import { NoCompany } from "../components/NoCompany";
import { api, FEATURE_STATUS_LABEL, today, type Company, type FeatureRoadmapCompany, type Horizon, type MilestoneStatus, type RoadmapCompany, type RoadmapFeature, type RoadmapMilestone, type RoadmapObjective } from "../api";
import { usePoll } from "../hooks";
import { Loader } from "../components/Loader";
import { STATUS_TONE } from "./Features";
import { dayOf, short } from "../short-date";

export const STATUS: Record<MilestoneStatus, { label: string; tone: string; colour: string }> = {
  done: { label: "Done", tone: "green", colour: "var(--green-ink)" },
  late: { label: "Late", tone: "red", colour: "var(--red-ink)" },
  at_risk: { label: "At risk", tone: "amber", colour: "var(--amber)" },
  on_track: { label: "On track", tone: "blue", colour: "var(--accent)" },
  no_work: { label: "No tasks", tone: "", colour: "#8b95a3" },
  unscheduled: { label: "No date", tone: "", colour: "#8b95a3" },
};

const DAY = 86_400_000;

/** The date range every timeline on the page shares, so objectives line up. */
function windowOf(companies: RoadmapCompany[], now: string): { start: number; end: number } {
  const dates = companies.flatMap((c) => c.objectives.flatMap((o) => o.milestones.flatMap((m) => (m.targetDate ? [dayOf(m.targetDate)] : []))));
  const t = dayOf(now);
  const start = Math.min(t - 14 * DAY, ...dates) - 7 * DAY;
  const end = Math.max(t + 60 * DAY, ...dates) + 14 * DAY;
  return { start, end };
}

/** Month starts inside the window, for the axis. */
function months(win: { start: number; end: number }) {
  const out: Array<{ at: number; label: string }> = [];
  const d = new Date(win.start);
  let m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  while (m.getTime() < win.end) {
    out.push({ at: m.getTime(), label: m.toLocaleDateString(undefined, { month: "short", year: m.getUTCMonth() === 0 ? "numeric" : undefined, timeZone: "UTC" }) });
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }
  return out;
}

const LABEL_PX = 150;

/** Puts each dated milestone in the first lane where its label doesn't overlap the previous one. */
function lanes(ms: RoadmapMilestone[], x: (m: RoadmapMilestone) => number, width: number) {
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const m of [...ms].sort((a, b) => x(a) - x(b))) {
    const px = (x(m) / 100) * width;
    let i = ends.findIndex((e) => e <= px);
    if (i === -1) i = ends.length;
    ends[i] = px + LABEL_PX;
    lane.set(m.id, i);
  }
  return { lane, count: Math.max(1, ends.length) };
}

function Timeline({ o, win, now, selected, onSelect }: { o: RoadmapObjective; win: { start: number; end: number }; now: string; selected: string | null; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const x = (m: RoadmapMilestone) => ((dayOf(m.targetDate!) - win.start) / (win.end - win.start)) * 100;
  const dated = o.milestones.filter((m) => m.targetDate);
  const { lane, count } = lanes(dated, x, width);
  const todayX = ((dayOf(now) - win.start) / (win.end - win.start)) * 100;
  return (
    <div ref={ref} className="rm-track" style={{ height: 34 + count * 46 }}>
      {months(win).map((mo) => (
        <span key={mo.at} className="rm-month" style={{ left: `${((mo.at - win.start) / (win.end - win.start)) * 100}%` }}>
          {mo.label}
        </span>
      ))}
      <span className="rm-today" style={{ left: `${todayX}%` }} aria-hidden="true" />
      {dated.map((m) => {
        const left = x(m);
        const flip = (left / 100) * width + LABEL_PX > width;
        return (
          <button
            key={m.id}
            type="button"
            className="rm-ms"
            aria-pressed={selected === m.id}
            style={{ left: `${left}%`, top: 26 + lane.get(m.id)! * 46, ["--c" as string]: STATUS[m.status].colour, transform: flip ? "translateX(-100%)" : undefined, flexDirection: flip ? "row-reverse" : undefined, textAlign: flip ? "right" : undefined }}
            onClick={() => onSelect(m.id)}
          >
            <span className="rm-dot" aria-hidden="true" />
            <span>
              <b>{m.title}</b>
              <small>
                {short(m.targetDate!)} · {m.total ? `${m.done}/${m.total}` : "no tasks"} · {STATUS[m.status].label}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MilestoneDetail({ m, onChanged }: { m: RoadmapMilestone; onChanged: () => void }) {
  const list = usePoll((signal) => api<Array<{ id: string; title: string; state: string; outcome: string | null; assignee: string | null }>>(`/api/milestones/${m.id}/tickets`, { signal }), 30_000, m.id);
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
          onClick={() => window.confirm(`Delete "${m.title}"? Its tasks stay, without a milestone.`) && void api(`/api/milestones/${m.id}`, { method: "DELETE" }).then(onChanged, (err: Error) => setError(err.message))}
        >
          Delete
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {m.blocked > 0 && <p className="muted" style={{ fontSize: 14 }}>{m.blocked} blocked: see what they're waiting on in the Plan.</p>}
      {list.data?.length ? (
        <ul className="rm-tickets">
          {list.data.map((t) => (
            <li key={t.id}>
              <a href={`#/tickets/${t.id}`}>{t.title}</a>
              <span className={`tag ${t.state === "done" ? "green" : t.state === "blocked" ? "red" : ""}`}>{t.outcome === "cancelled" ? "cancelled" : t.state.replace(/_/g, " ")}</span>
              {t.assignee && <span className="muted">{t.assignee}</span>}
            </li>
          ))}
        </ul>
      ) : (
        list.data && <p className="muted">No tasks yet. Pick this milestone on a task's page to add it.</p>
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

function Objective({ o, win, now, onChanged }: { o: RoadmapObjective; win: { start: number; end: number }; now: string; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const sel = o.milestones.find((m) => m.id === selected) ?? null;
  const setStatus = (status: "done" | "dropped" | "active") => void api(`/api/objectives/${o.id}`, { method: "PATCH", body: { status } }).then(onChanged);
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
          {o.keyResults.length > 0 && (
            <ul className="rm-krs">
              {o.keyResults.map((k) => (
                <li key={k.id}>
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
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <AddMilestone objectiveId={o.id} onAdded={onChanged} />
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
      </div>
      {o.milestones.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          No milestones yet.
        </p>
      ) : (
        <>
          <div className="rm-wide">
            <Timeline o={o} win={win} now={now} selected={selected} onSelect={(id) => setSelected(selected === id ? null : id)} />
          </div>
          {/* On a phone, and for milestones without a date, a list instead of the timeline. */}
          <ul className="rm-list">
            {o.milestones.map((m) => (
              <li key={m.id} className={m.targetDate ? "dated" : ""}>
                <button type="button" aria-pressed={selected === m.id} onClick={() => setSelected(selected === m.id ? null : m.id)}>
                  <span className="rm-dot" style={{ ["--c" as string]: STATUS[m.status].colour }} aria-hidden="true" />
                  <b>{m.title}</b>
                  <span className="muted">{m.targetDate ? short(m.targetDate) : "No date"}</span>
                  <span className="muted">{m.total ? `${m.done}/${m.total} done` : "no tasks"}</span>
                  <span className={`tag ${STATUS[m.status].tone}`}>{STATUS[m.status].label}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {sel && <MilestoneDetail key={sel.id} m={sel} onChanged={onChanged} />}
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
  { id: "timeline", label: "Timeline", help: "Every milestone by its target date." },
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

export function Roadmap({ companies, tab: tabParam, go }: { companies: Company[]; tab: string | undefined; go: (to: string) => void }) {
  const tab: Tab = (TABS.find((t) => t.id === tabParam)?.id ?? "features") as Tab;
  const [closed, setClosed] = useState(false);
  const now = today();
  const data = usePoll((signal) => api<RoadmapCompany[]>(`/api/roadmap?today=${now}${closed ? "&closed=1" : ""}`, { signal }), 60_000, `roadmap-${closed}`);
  const board = usePoll((signal) => api<FeatureRoadmapCompany[]>(`/api/roadmap/features`, { signal }), 60_000, "roadmap-features");
  const list = data.data ?? [];
  const win = windowOf(list, now);
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
        {tab === "timeline" && (
          <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44, fontSize: 14 }}>
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            Show done work
          </label>
        )}
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
          {TABS.find((t) => t.id === tab)!.help}
          {tab === "timeline" && " At risk means due within two weeks with blocked tasks or less than half done. Late means the date has passed with work left."}
        </p>
        {data.error && <p className="error">{data.error.message}</p>}
        {tab === "features" && board.error && <p className="error">{board.error.message}</p>}
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
