import { useState, type FormEvent } from "react";
import {
  api,
  FEATURE_STATUS_LABEL,
  FEATURE_STATUSES,
  IMPORTANCE_LABEL,
  type Company,
  RISKS,
  type Driver,
  type Feature,
  type FeatureDetail,
  type FeatureStatus,
  type FeedbackSettingsView,
  type Project,
  type Risk,
  type ScoredFeatures,
} from "../api";
import { usePoll } from "../hooks";
import { when } from "./Runs";

export const STATUS_TONE: Record<FeatureStatus, string> = { idea: "", considering: "blue", planned: "blue", in_progress: "amber", released: "green", declined: "red" };
const EFFORT = ["", "Tiny", "Small", "Medium", "Large", "Huge"];

/** A 0 to 5 score, or unscored. */
function ScoreSelect({ value, onChange, label }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string }) {
  return (
    <select className="mini" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">–</option>
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <span className="bar" style={{ width: 64, display: "inline-block", verticalAlign: "middle" }} aria-label={label}>
      <span style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

// Scores used only to illustrate the sum with the company's own weights.
const EXAMPLE_SCORES = [4, 2, 5, 3, 1];
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** The prioritisation sum in plain words, worked through with the company's own weights. */
export function ScoreExplainer({ demandWeight, drivers }: { demandWeight: number; drivers: Array<{ name: string; weight: number }> }) {
  const rows = [{ name: "Demand (no feedback yet)", weight: demandWeight, score: 0 }, ...drivers.filter((x) => x.weight > 0).map((x, i) => ({ name: x.name, weight: x.weight, score: EXAMPLE_SCORES[i % EXAMPLE_SCORES.length]! }))].filter((r) => r.weight > 0);
  const top = rows.reduce((sum, r) => sum + r.score * r.weight, 0);
  const bottom = rows.reduce((sum, r) => sum + r.weight, 0);
  const value = bottom ? top / bottom : 0;
  return (
    <details className="explain" style={{ fontSize: 14 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>How the score is worked out</summary>
      <ol style={{ margin: "8px 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
        <li>
          <strong>Scores, each 0 to 5.</strong> Demand comes from the feedback linked to a feature (nice to have 1, important 2, critical 3; each customer counts once), scaled so your most wanted feature scores 5. Each criterion is scored 0 to 5 by you, the CEO or the product manager.
        </li>
        <li>
          <strong>Value is a weighted average.</strong> Multiply each score by its weight, add those up, then divide by the total of the weights. Only the weights' sizes compared with each other matter: a weight of 4 counts twice as much as a weight of 2.
        </li>
        <li>
          <strong>Priority is value for effort:</strong> value × 3 ÷ effort, where effort is 1 (tiny) to 5 (huge) and unsized counts as 3. Small work rises, big work sinks; priority runs from 0 to 15.
        </li>
      </ol>
      {rows.length > 0 && (
        <>
          <p style={{ margin: "8px 0 4px" }}>An example with your weights, for a feature with no feedback yet:</p>
          <div className="md-table">
            <table>
              <thead>
                <tr>
                  <th>Score for</th>
                  <th>Score</th>
                  <th>Weight</th>
                  <th>Score × weight</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td>{r.score}</td>
                    <td>{r.weight}</td>
                    <td>{r.score * r.weight}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td />
                  <td>
                    <strong>{bottom}</strong>
                  </td>
                  <td>
                    <strong>{top}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p style={{ margin: "6px 0" }}>
            Value = {top} ÷ {bottom} = <strong>{num(value)}</strong>. Sized as effort 2: priority = {num(value)} × 3 ÷ 2 = <strong>{num((value * 3) / 2)}</strong>. Unsized (effort 3): priority = <strong>{num(value)}</strong>.
          </p>
        </>
      )}
      <ul style={{ margin: "6px 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
        <li>A criterion that hasn't been scored on a feature is left out of both totals, so a missing score doesn't count as 0.</li>
        <li>Demand always counts. With no feedback it adds 0 to the top but its weight to the bottom, which pulls value down; set its weight to 0 if you don't use feedback.</li>
        <li>Each feature's page shows its own sum under its scores.</li>
      </ul>
    </details>
  );
}

/** Criteria, demand weight, areas and CEO triage for a company. */
function PrioritySettings({ companyId, onChanged }: { companyId: string; onChanged: () => void }) {
  const s = usePoll((signal) => api<FeedbackSettingsView>(`/api/companies/${companyId}/feedback-settings`, { signal }), 60_000, `fs-${companyId}`);
  const [driver, setDriver] = useState({ name: "", weight: 1 });
  const [area, setArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => void p.then(() => (setError(null), s.reload(), onChanged()), (err: Error) => setError(err.message));
  if (!s.data) return null;
  const d = s.data;
  return (
    <section className="card" aria-labelledby="prio-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 id="prio-h" style={{ fontSize: 17, fontWeight: 600 }}>
        How features are prioritised
      </h2>
      <p className="muted" style={{ fontSize: 14 }}>
        Value is the weighted average of demand (the most wanted feature scores 5) and each criterion a feature has been scored on (0 to 5). Priority is value × 3 ÷ effort, so small work rises and big work sinks; unsized work counts as medium.
      </p>
      <ScoreExplainer demandWeight={d.demandWeight} drivers={d.drivers} />
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field">
          <label htmlFor="demand-weight">Weight of demand</label>
          <select id="demand-weight" value={d.demandWeight} onChange={(e) => run(api(`/api/companies/${companyId}/feedback-settings`, { method: "PATCH", body: { demandWeight: Number(e.target.value) } }))}>
            {Array.from({ length: 11 }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44, fontSize: 14 }}>
          <input type="checkbox" checked={d.ceoTriage} onChange={(e) => run(api(`/api/companies/${companyId}/feedback-settings`, { method: "PATCH", body: { ceoTriage: e.target.checked } }))} />
          The CEO triages new feedback (each batch costs a run)
        </label>
      </div>
      <div>
        <p className="label">Criteria</p>
        <ul className="link-list">
          {d.drivers.map((x) => (
            <li key={x.id}>
              <span>{x.name}</span>
              <label className="muted" style={{ fontSize: 13 }}>
                weight{" "}
                <select className="mini" value={x.weight} onChange={(e) => run(api(`/api/feature-drivers/${x.id}`, { method: "PATCH", body: { weight: Number(e.target.value) } }))}>
                  {Array.from({ length: 11 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn small" onClick={() => window.confirm(`Remove "${x.name}" and its scores?`) && run(api(`/api/feature-drivers/${x.id}`, { method: "DELETE" }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(api(`/api/companies/${companyId}/feature-drivers`, { method: "POST", body: { name: driver.name.trim(), weight: driver.weight } }).then(() => setDriver({ name: "", weight: 1 })));
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}
        >
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label htmlFor="new-driver">New criterion</label>
            <input id="new-driver" required maxLength={80} placeholder="e.g. Fits the mission, Revenue, Strategic" value={driver.name} onChange={(e) => setDriver({ ...driver, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="new-driver-weight">Weight</label>
            <select id="new-driver-weight" value={driver.weight} onChange={(e) => setDriver({ ...driver, weight: Number(e.target.value) })}>
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit">
            Add
          </button>
        </form>
      </div>
      <div>
        <p className="label">Areas</p>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Labels for grouping features on this page, such as Calculators or Content. They don't change any score.
        </p>
        <ul className="link-list">
          {d.areas.map((a) => (
            <li key={a.id}>
              <span>{a.name}</span>
              <button type="button" className="btn small" onClick={() => window.confirm(`Remove the area "${a.name}"? Its features stay, without an area.`) && run(api(`/api/feature-areas/${a.id}`, { method: "DELETE" }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(api(`/api/companies/${companyId}/feature-areas`, { method: "POST", body: { name: area.trim() } }).then(() => setArea("")));
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}
        >
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label htmlFor="new-area">New area</label>
            <input id="new-area" required maxLength={80} placeholder="e.g. Billing, Reporting" value={area} onChange={(e) => setArea(e.target.value)} />
          </div>
          <button className="btn" type="submit">
            Add
          </button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function AddFeature({ companyId, areas, onAdded }: { companyId: string; areas: Array<{ id: string; name: string }>; onAdded: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void api<Feature>(`/api/companies/${companyId}/features`, { method: "POST", body: { title: title.trim(), ...(areaId ? { areaId } : {}) } }).then(
      (f) => (setTitle(""), setError(null), onAdded(f.id)),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} aria-label="Add a feature">
      <div className="field" style={{ flex: "2 1 240px" }}>
        <label htmlFor="new-feature">New feature</label>
        <input id="new-feature" required maxLength={200} placeholder="e.g. Export reports as CSV" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {areas.length > 0 && (
        <div className="field">
          <label htmlFor="new-feature-area">Area</label>
          <select id="new-feature-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">None</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button className="btn primary" type="submit">
        Add feature
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

type Sort = "priority" | "demand" | "newest";
const ACTIVE: FeatureStatus[] = ["idea", "considering", "planned", "in_progress"];

function FeatureRow({ f, drivers, maxDemand, sub, onPatch }: { f: Feature; drivers: Driver[]; maxDemand: number; sub?: boolean; onPatch: (id: string, body: Record<string, unknown>) => void }) {
  return (
    <>
    <tr>
      <td style={{ paddingLeft: sub ? 36 : undefined, minWidth: 220 }}>
        <a href={`#/features/${f.companyId}/${f.id}`}>{f.title}</a>
        {f.portalVisible && <span className="tag" style={{ marginLeft: 6 }}>portal</span>}
      </td>
      <td>
        <select className="mini" aria-label={`Status of ${f.title}`} value={f.status} onChange={(e) => onPatch(f.id, { status: e.target.value })}>
          {FEATURE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FEATURE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="mono" style={{ whiteSpace: "nowrap" }}>
        <Bar value={f.demand} max={maxDemand} label={`Demand ${f.demand}`} /> {f.demand}
        <small className="muted"> ({f.customerCount})</small>
      </td>
      {drivers.map((d) => (
        <td key={d.id}>
          <ScoreSelect label={`${d.name} for ${f.title}`} value={f.driverScores[d.id]} onChange={(v) => onPatch(f.id, { driverScores: { [d.id]: v } })} />
        </td>
      ))}
      <td>
        <select className="mini" aria-label={`Effort of ${f.title}`} value={f.effort ?? ""} onChange={(e) => onPatch(f.id, { effort: e.target.value === "" ? null : Number(e.target.value) })}>
          <option value="">–</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n} {EFFORT[n]}
            </option>
          ))}
        </select>
      </td>
      <td className="mono">{f.value.toFixed(1)}</td>
      <td className="mono">
        <b>{f.priority.toFixed(1)}</b>
      </td>
      <td className="mono muted" style={{ whiteSpace: "nowrap" }}>{f.tickets.total ? `${f.tickets.done}/${f.tickets.total} tasks` : "–"}</td>
    </tr>
    {f.tickets.items.length > 0 && (
      <tr>
        <td colSpan={7 + drivers.length} style={{ paddingLeft: sub ? 56 : 20 }}>
          <ul className="link-list" aria-label={`Tasks of ${f.title}`}>
            {f.tickets.items.map((t) => (
              <li key={t.id}>
                <a href={`#/tickets/${t.id}`}>{t.title}</a>
                <span className={`tag ${t.state === "done" ? "green" : ""}`}>{t.outcome === "cancelled" ? "cancelled" : t.state.replace(/_/g, " ")}</span>
                <span className="muted">{t.assignee ?? "unassigned"}</span>
              </li>
            ))}
          </ul>
        </td>
      </tr>
    )}
    </>
  );
}

export function Features({ companies, companyId, featureId, go }: { companies: Company[]; companyId: string | undefined; featureId: string | undefined; go: (to: string) => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  if (company && featureId) return <FeaturePage key={featureId} id={featureId} companyId={company.id} go={go} />;
  return <FeatureList key={company?.id ?? "none"} companies={companies} company={company} go={go} />;
}

function FeatureList({ companies, company, go }: { companies: Company[]; company: Company | undefined; go: (to: string) => void }) {
  const data = usePoll((signal) => (company ? api<ScoredFeatures>(`/api/companies/${company.id}/features`, { signal }) : Promise.resolve(null)), 30_000, `features-${company?.id}`);
  const settings = usePoll((signal) => (company ? api<FeedbackSettingsView>(`/api/companies/${company.id}/feedback-settings`, { signal }) : Promise.resolve(null)), 60_000, `fs-list-${company?.id}`);
  const [sort, setSort] = useState<Sort>("priority");
  const [all, setAll] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (id: string, body: Record<string, unknown>) => void api(`/api/features/${id}`, { method: "PATCH", body }).then(data.reload, (err: Error) => setError(err.message));
  const d = data.data;
  const areas = settings.data?.areas ?? [];
  const order = (a: Feature, b: Feature) => (sort === "priority" ? b.priority - a.priority || b.demand - a.demand : sort === "demand" ? b.demand - a.demand || b.priority - a.priority : b.createdAt.localeCompare(a.createdAt));
  const shown = (d?.features ?? []).filter((f) => all || ACTIVE.includes(f.status));
  const top = shown.filter((f) => !f.parentId || !shown.some((p) => p.id === f.parentId)).sort(order);
  const groups = [...areas.map((a) => ({ id: a.id, name: a.name })), { id: "", name: areas.length ? "No area" : "" }]
    .map((g) => ({ ...g, features: top.filter((f) => (f.areaId ?? "") === g.id) }))
    .filter((g) => g.features.length);
  const cols = 7 + (d?.drivers.length ?? 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Features</h1>
          <p className="sub">What people have asked for, how much it matters to them, and what to build next.</p>
        </div>
      </header>
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : (
        <>
          <section className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <AddFeature companyId={company.id} areas={areas} onAdded={(id) => go(`features/${company.id}/${id}`)} />
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                Sort by
                <select className="mini" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="priority">Priority</option>
                  <option value="demand">Demand</option>
                  <option value="newest">Newest</option>
                </select>
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                Show released and declined
              </label>
              <a href={`#/feedback/${company.id}`} style={{ marginLeft: "auto" }}>
                Feedback inbox
              </a>
              <button type="button" className="btn small" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}>
                Criteria and areas
              </button>
            </div>
          </section>
          {showSettings && <PrioritySettings companyId={company.id} onChanged={() => (data.reload(), settings.reload())} />}
          {error && <p className="error">{error}</p>}
          {d && !shown.length ? (
            <p className="muted">No features yet. Add one above, or create one while linking feedback in the inbox.</p>
          ) : d ? (
            <div className="table-wrap">
              <table className="features">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Status</th>
                    <th title="Importance from linked feedback; each customer counts once. In brackets: how many people.">Demand</th>
                    {d.drivers.map((x) => (
                      <th key={x.id} title={`Weight ${x.weight}`}>
                        {x.name}
                      </th>
                    ))}
                    <th>Effort</th>
                    <th title="Weighted average of demand and criteria, 0 to 5">Value</th>
                    <th title="Value × 3 ÷ effort">Priority</th>
                    <th title="Tasks done">Work</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.id || "none"}>
                    {g.name && (
                      <tr className="group">
                        <th colSpan={cols} scope="colgroup">
                          {g.name}
                        </th>
                      </tr>
                    )}
                    {g.features.flatMap((f) => [
                      <FeatureRow key={f.id} f={f} drivers={d.drivers} maxDemand={d.maxDemand} onPatch={patch} />,
                      ...shown
                        .filter((s) => s.parentId === f.id)
                        .sort(order)
                        .map((s) => <FeatureRow key={s.id} f={s} sub drivers={d.drivers} maxDemand={d.maxDemand} onPatch={patch} />),
                    ])}
                  </tbody>
                ))}
              </table>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/** A ticket that delivers this feature, described from what people asked for. */
function CreateTicket({ featureId, companyId, title, go }: { featureId: string; companyId: string; title: string; go: (to: string) => void }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${companyId}/projects`, { signal }), 120_000, `projects-${companyId}`);
  const [projectId, setProjectId] = useState("");
  const [risk, setRisk] = useState<Risk>("medium");
  const [name, setName] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const list = projects.data ?? [];
  const pid = projectId || list[0]?.id || "";
  if (projects.data && !list.length)
    return (
      <p className="muted" style={{ fontSize: 14 }}>
        Create a project on the Kanban to turn this into tasks.
      </p>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void api<{ id: string }>(`/api/features/${featureId}/tickets`, { method: "POST", body: { projectId: pid, title: name.trim() || title, risk } }).then((t) => go(`tickets/${t.id}`), (err: Error) => setError(err.message));
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }} aria-label="Create a task for this feature">
      <div className="field" style={{ flex: "2 1 220px" }}>
        <label htmlFor="ft-title">New task</label>
        <input id="ft-title" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {list.length > 1 && (
        <div className="field">
          <label htmlFor="ft-project">Project</label>
          <select id="ft-project" value={pid} onChange={(e) => setProjectId(e.target.value)}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="ft-risk">Risk</label>
        <select id="ft-risk" value={risk} onChange={(e) => setRisk(e.target.value as Risk)}>
          {RISKS.map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <button className="btn primary" type="submit" disabled={!pid}>
        Create task
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export type Tree = Array<{ id: string; title: string; milestones: Array<{ id: string; title: string; targetDate: string | null }> }>;
export type GoalLink = { objectiveId: string | null; milestoneId: string | null };

/** A feature's one roadmap link: a whole objective (o:) or one of its milestones (m:). */
export function GoalSelect({ id, tree, value, onChange }: { id: string; tree: Tree; value: GoalLink; onChange: (v: GoalLink) => void }) {
  return (
    <select
      id={id}
      value={value.milestoneId ? `m:${value.milestoneId}` : value.objectiveId ? `o:${value.objectiveId}` : ""}
      onChange={(e) => {
        const [kind, ref] = e.target.value.split(":");
        onChange({ milestoneId: kind === "m" ? ref! : null, objectiveId: kind === "o" ? ref! : null });
      }}
    >
      <option value="">None</option>
      {tree.map((o) => (
        <optgroup key={o.id} label={o.title}>
          <option value={`o:${o.id}`}>{o.title} (the whole objective)</option>
          {o.milestones.map((m) => (
            <option key={m.id} value={`m:${m.id}`}>
              {m.title}
              {m.targetDate ? ` (${m.targetDate})` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function FeaturePage({ id, companyId, go }: { id: string; companyId: string; go: (to: string) => void }) {
  const data = usePoll((signal) => api<FeatureDetail>(`/api/features/${id}`, { signal }), 30_000, `feature-${id}`);
  const list = usePoll((signal) => api<ScoredFeatures>(`/api/companies/${companyId}/features`, { signal }), 60_000, `fl-${companyId}`);
  const settings = usePoll((signal) => api<FeedbackSettingsView>(`/api/companies/${companyId}/feedback-settings`, { signal }), 60_000, `fs-page-${companyId}`);
  const tree = usePoll((signal) => api<Tree>(`/api/companies/${companyId}/objectives`, { signal }), 120_000, `tree-f-${companyId}`);
  const [editing, setEditing] = useState<{ title: string; description: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = (body: Record<string, unknown>) => void api(`/api/features/${id}`, { method: "PATCH", body }).then(() => (setError(null), data.reload()), (err: Error) => setError(err.message));
  if (data.error) return <p className="error">{data.error.status === 404 ? "There's no such feature." : data.error.message}</p>;
  const d = data.data;
  if (!d) return null;
  const f = d.feature;
  const parents = (list.data?.features ?? []).filter((x) => !x.parentId && x.id !== id);
  const hasChildren = d.subfeatures.length > 0;
  const scored = d.drivers.filter((x) => f.driverScores[x.id] != null && x.weight > 0);
  return (
    <>
      <header className="page-head">
        <div style={{ minWidth: 0 }}>
          <p className="label">
            <a href={`#/features/${companyId}`}>Features</a>
            {f.parentId && (
              <>
                {" "}
                · <a href={`#/features/${companyId}/${f.parentId}`}>{parents.find((p) => p.id === f.parentId)?.title ?? "parent"}</a>
              </>
            )}
          </p>
          {editing ? (
            <input className="title-input" aria-label="Title" value={editing.title} maxLength={200} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          ) : (
            <h1>{f.title}</h1>
          )}
          <p className="sub" style={{ display: "flex", gap: "4px 14px", flexWrap: "wrap", alignItems: "center" }}>
            <span className={`tag ${STATUS_TONE[f.status]}`}>{FEATURE_STATUS_LABEL[f.status]}</span>
            <span>
              Priority <b className="mono">{f.priority.toFixed(1)}</b>
            </span>
            <span>
              {f.insightCount} insight{f.insightCount === 1 ? "" : "s"} from {f.customerCount} {f.customerCount === 1 ? "person" : "people"}
            </span>
            {f.releasedAt && <span>Released {when(f.releasedAt)}</span>}
          </p>
        </div>
      </header>

      {f.goalCheckAnswer ? (
        <section className="card" aria-label="Did it move the goal?">
          <p>
            <b>Did it move the goal?</b> You answered <span className="tag">{f.goalCheckAnswer}</span>
            {f.goalCheckAnsweredAt && <> {when(f.goalCheckAnsweredAt)}</>}.
          </p>
        </section>
      ) : f.goalCheckDueAt ? (
        <section className="card" aria-label="Did it move the goal?">
          <p className="muted">
            <b>Did it move the goal?</b> You will be asked {when(f.goalCheckDueAt)}.
          </p>
        </section>
      ) : null}

      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Description">
        {editing ? (
          <>
            <div className="field">
              <label htmlFor="f-desc">Description</label>
              <textarea id="f-desc" rows={6} maxLength={20_000} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={!editing.title.trim()}
                onClick={() => (patch({ title: editing.title.trim(), description: editing.description.trim() || null }), setEditing(null))}
              >
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {f.description ? <p style={{ whiteSpace: "pre-wrap" }}>{f.description}</p> : <p className="muted">No description yet.</p>}
            <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setEditing({ title: f.title, description: f.description ?? "" })}>
              Edit title and description
            </button>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="f-settings-h" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="f-settings-h" style={{ fontSize: 17, fontWeight: 600 }}>
          Status and scores
        </h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" value={f.status} onChange={(e) => patch({ status: e.target.value })}>
              {FEATURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FEATURE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-effort">Effort</label>
            <select id="f-effort" value={f.effort ?? ""} onChange={(e) => patch({ effort: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">Not sized (counts as medium)</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} · {EFFORT[n]}
                </option>
              ))}
            </select>
          </div>
          {d.drivers.map((x) => (
            <div className="field" key={x.id}>
              <label htmlFor={`f-d-${x.id}`}>
                {x.name} <small className="muted">(weight {x.weight})</small>
              </label>
              <select id={`f-d-${x.id}`} value={f.driverScores[x.id] ?? ""} onChange={(e) => patch({ driverScores: { [x.id]: e.target.value === "" ? null : Number(e.target.value) } })}>
                <option value="">Not scored</option>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="field">
            <label htmlFor="f-area">Area</label>
            <select id="f-area" value={f.areaId ?? ""} onChange={(e) => patch({ areaId: e.target.value || null })}>
              <option value="">None</option>
              {(settings.data?.areas ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {!hasChildren && (
            <div className="field">
              <label htmlFor="f-parent">Subfeature of</label>
              <select id="f-parent" value={f.parentId ?? ""} onChange={(e) => patch({ parentId: e.target.value || null })}>
                <option value="">Nothing (top level)</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="f-milestone">Objective or milestone</label>
            <GoalSelect id="f-milestone" tree={tree.data ?? []} value={f} onChange={patch} />
          </div>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={f.portalVisible} onChange={(e) => patch({ portalVisible: e.target.checked })} />
          Show on the feedback portal, where visitors can vote on it
        </label>
        <p className="muted" style={{ fontSize: 13 }}>
          Demand {f.demand} of {d.maxDemand} gives {f.demandPart.toFixed(1)}/5 at weight {d.settings.demandWeight}
          {scored.map((x) => `; ${x.name} ${f.driverScores[x.id]}/5 at weight ${x.weight}`).join("")}. Value {f.value.toFixed(1)}, × 3 ÷ effort {f.effort ?? 3} = priority {f.priority.toFixed(1)}.
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card" aria-labelledby="f-insights-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 id="f-insights-h" style={{ fontSize: 17, fontWeight: 600 }}>
          What people said
        </h2>
        {d.insights.length ? (
          <ul className="insight-list">
            {d.insights.map((i) => (
              <li key={i.id}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                  <span className={`tag ${i.importance === "critical" ? "red" : i.importance === "important" ? "amber" : ""}`}>{IMPORTANCE_LABEL[i.importance]}</span>
                  <b>{i.customer?.name ?? "Anonymous"}</b>
                  {i.customer?.segment && <span className="muted">{i.customer.segment}</span>}
                  {i.fromSubfeature && <span className="tag">subfeature</span>}
                  {i.note.untrusted && <span className="tag">from outside</span>}
                  <span className="muted" style={{ marginLeft: "auto" }}>
                    {when(i.createdAt)}
                  </span>
                </div>
                <blockquote>{i.highlight ?? i.note.text.slice(0, 400)}</blockquote>
                <a href={`#/feedback/${companyId}/${i.noteId}`} style={{ fontSize: 13 }}>
                  Open the note
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            No feedback linked yet. Link passages to it from the <a href={`#/feedback/${companyId}`}>feedback inbox</a>.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="f-work-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="f-work-h" style={{ fontSize: 17, fontWeight: 600 }}>
          Delivery
        </h2>
        <p className="muted" style={{ fontSize: 13 }}>
          A task made here is described from the feature and what people asked for, strongest first. The feature moves to in progress when work on a task starts, and to released when every task is done.
        </p>
        <CreateTicket featureId={id} companyId={companyId} title={f.title} go={go} />
      </section>

      {(d.subfeatures.length > 0 || d.tickets.length > 0) && (
        <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {d.subfeatures.length > 0 && (
            <div>
              <p className="label">Subfeatures</p>
              <ul className="link-list">
                {d.subfeatures.map((s) => (
                  <li key={s.id}>
                    <a href={`#/features/${companyId}/${s.id}`}>{s.title}</a>
                    <span className={`tag ${STATUS_TONE[s.status]}`}>{FEATURE_STATUS_LABEL[s.status]}</span>
                    <span className="mono muted">demand {s.demand}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.tickets.length > 0 && (
            <div>
              <p className="label">Tasks delivering it</p>
              <ul className="link-list">
                {d.tickets.map((t) => (
                  <li key={t.id}>
                    <a href={`#/tickets/${t.id}`}>{t.title}</a>
                    <span className={`tag ${t.state === "done" ? "green" : ""}`}>{t.outcome === "cancelled" ? "cancelled" : t.state.replace(/_/g, " ")}</span>
                    <span className="muted">{t.assignee ?? "unassigned"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <button
        type="button"
        className="btn"
        style={{ alignSelf: "flex-start" }}
        onClick={() =>
          window.confirm(`Delete "${f.title}"? The feedback stays in the inbox, but its links to this feature${hasChildren ? " and its subfeatures" : ""} go.`) &&
          void api(`/api/features/${id}`, { method: "DELETE" }).then(() => go(`features/${companyId}`), (err: Error) => setError(err.message))
        }
      >
        Delete feature
      </button>
    </>
  );
}
