import { useState, type FormEvent, type ReactNode } from "react";
import { featureHorizon, HORIZONS, portalTitle, type Horizon } from "@boss-man/shared";
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
import { useMediaQuery, usePoll } from "../hooks";
import { clearDraft, readDraftJson, useFormDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { away } from "../server-watch";
import { when } from "./Runs";
import { NotFoundBlock } from "../components/NotFoundBlock";

export const STATUS_TONE: Record<FeatureStatus, string> = { idea: "", considering: "blue", planned: "blue", in_progress: "amber", released: "green", declined: "red" };
const EFFORT = ["", "Tiny", "Small", "Medium", "Large", "Huge"];
const HORIZON_LABEL: Record<Horizon, string> = { now: "Now", next: "Next", later: "Later" };

/** An editable value that reads as text (BOS-1257): the value shows as plain text and the real <select> lies over it at
 * opacity 0, so it is still one tab stop, opens the browser's own list and keeps its aria-label. Hover or keyboard focus
 * reveals the field edge and a ▾ (its space is always kept). */
function Cell({ text, empty, children }: { text: ReactNode; empty?: boolean; children: ReactNode }) {
  return (
    <span className={`cell${empty ? " empty" : ""}`}>
      <span className="cell-text" aria-hidden="true">
        {text}
      </span>
      <span className="cell-caret" aria-hidden="true">▾</span>
      {children}
    </span>
  );
}

/** A 0 to 5 score, or unscored. */
function ScoreSelect({ value, onChange, label }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string }) {
  return (
    <Cell text={value ?? "–"} empty={value == null}>
      <select className="cell-select" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">–</option>
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </Cell>
  );
}

type Patch = (id: string, body: Record<string, unknown>) => void;

function StatusSelect({ f, onPatch }: { f: Feature; onPatch: Patch }) {
  return (
    <Cell text={<span className={`tag ${STATUS_TONE[f.status]}`}>{FEATURE_STATUS_LABEL[f.status]}</span>}>
      <select className="cell-select" aria-label={`Status of ${f.title}`} value={f.status} onChange={(e) => onPatch(f.id, { status: e.target.value })}>
        {FEATURE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {FEATURE_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
    </Cell>
  );
}

function EffortSelect({ f, onPatch }: { f: Feature; onPatch: Patch }) {
  return (
    <Cell text={f.effort ? `${f.effort} ${EFFORT[f.effort]}` : "–"} empty={!f.effort}>
      <select className="cell-select" aria-label={`Effort of ${f.title}`} value={f.effort ?? ""} onChange={(e) => onPatch(f.id, { effort: e.target.value === "" ? null : Number(e.target.value) })}>
        <option value="">–</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {n} {EFFORT[n]}
          </option>
        ))}
      </select>
    </Cell>
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
    <form onSubmit={submit} className="features-add" aria-label="Add a feature">
      <div className="field" style={{ flex: "2 1 220px" }}>
        <label htmlFor="new-feature" className="sr-only">New feature</label>
        <input id="new-feature" required maxLength={200} placeholder="New feature, e.g. Export reports as CSV" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {areas.length > 0 && (
        <div className="field">
          <label htmlFor="new-feature-area" className="sr-only">Area</label>
          <select id="new-feature-area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">No area</option>
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

// (BOS-956) Each feature's tasks are folded behind the arrow and the choice stays in this browser,
// like the "This host" fold (BOS-924). Every read and write is wrapped: private browsing can refuse
// localStorage, and the list must still work when it does.
const FEATURE_OPEN_KEY = "bossman.features.open";
function readFeatureOpen(): { ids: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(FEATURE_OPEN_KEY) ?? "") as { ids?: unknown };
    return { ids: Array.isArray(saved.ids) ? saved.ids.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    return { ids: [] };
  }
}
function saveFeatureOpen(state: { ids: string[] }) {
  try {
    localStorage.setItem(FEATURE_OPEN_KEY, JSON.stringify(state));
  } catch {}
}

/** Done, all and blocked tasks of a feature (cancelled ones count for none). */
function taskCounts(f: Feature) {
  const live = f.tickets.items.filter((t) => t.outcome !== "cancelled");
  return { total: live.length, done: live.filter((t) => t.state === "done").length, blocked: live.filter((t) => t.state === "blocked").length };
}

/** The WORK column in plain words: done of all tasks (cancelled ones count for neither), and any blocked. */
export function taskSummary(f: Feature): string {
  const { total, done, blocked } = taskCounts(f);
  if (!total) return "–";
  return `${done} of ${total} complete${blocked ? ` · ${blocked} blocked` : ""}`;
}

/** A blocked task is said on its own line, with a mark so it isn't colour alone (BOS-1257). */
function BlockedLine({ n }: { n: number }) {
  return n ? <span className="feature-blocked">⚠ {n} blocked</span> : null;
}

/** What a visitor reads as the feature's title on the portal, shown under the feature's name on the list row (BOS-997):
 * the public title, or the public summary's first line when no public title is set, said in plain words. Nothing for a
 * feature off the portal. */
function VisitorsWillSee({ f }: { f: Feature }) {
  if (!f.portal?.onPortal) return null;
  const seen = portalTitle(f.publicTitle, f.publicSummary);
  if (!seen) return null;
  // One line on the row (BOS-1257); the full text and where it comes from are in the tooltip.
  const source = f.publicTitle?.trim() ? "" : " (from the summary, no public title set)";
  return (
    <span className="feature-visitors">
      <small title={`Visitors will see: ${seen}${source}`}>Visitors will see: {seen}</small>
    </span>
  );
}

/** The "On portal" tick on a list row (BOS-957): saves at once, and says why a feature is held off when it is. */
function PortalTick({ f, onPatch, word }: { f: Feature; onPatch: Patch; word?: boolean }) {
  const reason = f.portal?.reason ?? null;
  const hint = !f.portalVisible && (reason === "security" || reason === "sensitive") ? `kept off: ${reason}` : reason === "needs public summary" ? "needs public summary" : null;
  // Ticked but the portal won't show it: say so, with the reason and the fix (BOS-1496).
  const notShown = f.portalShow && !f.portalShow.shown && f.portalShow.ticked ? f.portalShow : null;
  if (notShown) {
    const fix = notShown.reason === "needs public summary" ? "write a public summary" : notShown.reason === "looks like security work" ? "reword the public summary" : notShown.reason === "kept off (sensitive)" ? "untick \"Keep off the portal\" in the feature" : "check the feature's status";
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
        <label className={word ? "portal-tick-word" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title="Show on the feedback portal, where visitors can vote on it">
          <input type="checkbox" aria-label={`On portal: ${f.title}`} checked={f.portalVisible} onChange={(e) => onPatch(f.id, { portalVisible: e.target.checked })} />
          <span className="muted" style={{ fontSize: 13 }}>Not shown yet</span>
        </label>
        <small className="muted" style={{ fontSize: 11 }}>{notShown.reason}: {fix}</small>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <label className={word ? "portal-tick-word" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title="Show on the feedback portal, where visitors can vote on it">
        <input type="checkbox" aria-label={`On portal: ${f.title}`} checked={f.portalVisible} onChange={(e) => onPatch(f.id, { portalVisible: e.target.checked })} />
        {word && <span className="muted" style={{ fontSize: 13 }}>On portal</span>}
      </label>
      {hint && <small className="muted" style={{ fontSize: 11 }}>{hint}</small>}
    </span>
  );
}

function FeatureRow({ f, drivers, maxDemand, sub, hasSubfeatures, open, onToggle, onPatch }: { f: Feature; drivers: Driver[]; maxDemand: number; sub?: boolean; hasSubfeatures: boolean; open: boolean; onToggle: () => void; onPatch: (id: string, body: Record<string, unknown>) => void }) {
  const counts = taskCounts(f);
  const foldable = f.tickets.items.length > 0;
  return (
    <>
    <tr>
      <td className="feature-name" style={{ paddingLeft: sub ? 28 : undefined }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {foldable && (
            <button type="button" className="feature-fold" aria-expanded={open} aria-controls={`feature-tasks-${f.id}`} aria-label={`${open ? "Hide" : "Show"} tasks of ${f.title}`} onClick={onToggle}>
              <span className="pl-arrow" aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
          )}
          <a href={`#/features/${f.companyId}/${f.id}`}>{f.title}</a>
        </span>
        <VisitorsWillSee f={f} />
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <PortalTick f={f} onPatch={onPatch} />
      </td>
      <td>
        <StatusSelect f={f} onPatch={onPatch} />
      </td>
      <td className="mono" style={{ whiteSpace: "nowrap" }}>
        <Bar value={f.demand} max={maxDemand} label={`Demand ${f.demand}`} /> {f.demand}
        <small className="muted"> ({f.customerCount})</small>
      </td>
      {drivers.map((d) => (
        <td key={d.id} className="num">
          <ScoreSelect label={`${d.name} for ${f.title}`} value={f.driverScores[d.id]} onChange={(v) => onPatch(f.id, { driverScores: { [d.id]: v } })} />
        </td>
      ))}
      <td>
        <EffortSelect f={f} onPatch={onPatch} />
      </td>
      <td className="mono num">{f.value.toFixed(1)}</td>
      <td className="mono num feature-priority">{f.priority.toFixed(1)}</td>
      <td className="mono muted" style={{ whiteSpace: "nowrap" }}>
        {foldable ? (
          <button type="button" className="feature-fold feature-work" aria-expanded={open} aria-controls={`feature-tasks-${f.id}`} onClick={onToggle}>
            {counts.total ? `${counts.done} of ${counts.total} done` : "–"}
          </button>
        ) : (
          "–"
        )}
        <BlockedLine n={counts.blocked} />
      </td>
    </tr>
    {foldable && (
      <tr id={`feature-tasks-${f.id}`} hidden={!open}>
        <td colSpan={8 + drivers.length} style={{ paddingLeft: sub ? 56 : 32 }}>
          <ul className="link-list" aria-label={`Tasks of ${f.title}`}>
            {f.tickets.items.map((t) => (
              <li key={t.id}>
                <a href={`#/tickets/${t.id}`}>{t.title}</a>
                <span className={`tag ${t.state === "done" ? "green" : t.state === "blocked" ? "amber" : ""}`}>{t.outcome === "cancelled" ? "cancelled" : t.state.replace(/_/g, " ")}</span>
                <span className="muted">{t.assignee ?? "unassigned"}</span>
              </li>
            ))}
          </ul>
          {hasSubfeatures && (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
              {f.title} has its own tasks too: open it to see them.
            </p>
          )}
        </td>
      </tr>
    )}
    </>
  );
}

/** One feature as a card, for a phone (BOS-1257). It shows the same values as the table row and shares its onPatch. */
function FeatureCard({ f, drivers, sub, hasSubfeatures, open, onToggle, onPatch }: { f: Feature; drivers: Driver[]; sub?: boolean; hasSubfeatures: boolean; open: boolean; onToggle: () => void; onPatch: Patch }) {
  const counts = taskCounts(f);
  const foldable = f.tickets.items.length > 0;
  return (
    <li className={`fcard${sub ? " sub" : ""}`}>
      <div className="fcard-top">
        <div className="fcard-title">
          <a href={`#/features/${f.companyId}/${f.id}`}>{f.title}</a>
          <VisitorsWillSee f={f} />
          <StatusSelect f={f} onPatch={onPatch} />
        </div>
        <div className="fcard-priority" title="Value × 3 ÷ effort">
          <b className="mono">{f.priority.toFixed(1)}</b>
          <small className="muted">Priority</small>
        </div>
      </div>
      <div className="fcard-grid">
        <div>
          <small className="muted">Demand</small>
          <span className="mono">
            {f.demand}
            <small className="muted"> ({f.customerCount})</small>
          </span>
        </div>
        <div>
          <small className="muted">Effort</small>
          <EffortSelect f={f} onPatch={onPatch} />
        </div>
        <div>
          <small className="muted">Value</small>
          <span className="mono">{f.value.toFixed(1)}</span>
        </div>
        {drivers.map((d) => (
          <div key={d.id}>
            <small className="muted">{d.name}</small>
            <ScoreSelect label={`${d.name} for ${f.title}`} value={f.driverScores[d.id]} onChange={(v) => onPatch(f.id, { driverScores: { [d.id]: v } })} />
          </div>
        ))}
      </div>
      <div className="fcard-foot">
        <PortalTick f={f} onPatch={onPatch} word />
        {foldable ? (
          <button type="button" className="feature-fold feature-work" aria-expanded={open} aria-controls={`feature-tasks-${f.id}`} onClick={onToggle}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> Tasks: {counts.total ? `${counts.done} of ${counts.total} complete` : "none"}
          </button>
        ) : (
          <span className="muted">Tasks: none</span>
        )}
        <BlockedLine n={counts.blocked} />
      </div>
      {foldable && (
        <div id={`feature-tasks-${f.id}`} hidden={!open}>
          <ul className="link-list" aria-label={`Tasks of ${f.title}`}>
            {f.tickets.items.map((t) => (
              <li key={t.id}>
                <a href={`#/tickets/${t.id}`}>{t.title}</a>
                <span className={`tag ${t.state === "done" ? "green" : t.state === "blocked" ? "amber" : ""}`}>{t.outcome === "cancelled" ? "cancelled" : t.state.replace(/_/g, " ")}</span>
                <span className="muted">{t.assignee ?? "unassigned"}</span>
              </li>
            ))}
          </ul>
          {hasSubfeatures && (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
              {f.title} has its own tasks too: open it to see them.
            </p>
          )}
        </div>
      )}
    </li>
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
  const phone = useMediaQuery("(max-width: 640px)");
  const [sort, setSort] = useState<Sort>("priority");
  const [all, setAll] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [fold, setFold] = useState(readFeatureOpen);
  const [error, setError] = useState<string | null>(null);
  const patch = (id: string, body: Record<string, unknown>) => void api(`/api/features/${id}`, { method: "PATCH", body }).then(data.reload, (err: Error) => setError(err.message));
  const isOpen = (id: string) => fold.ids.includes(id);
  const setFeatureOpen = (id: string, open: boolean) => {
    const next = { ids: open ? [...fold.ids.filter((x) => x !== id), id] : fold.ids.filter((x) => x !== id) };
    setFold(next);
    saveFeatureOpen(next);
  };
  const d = data.data;
  const areas = settings.data?.areas ?? [];
  const order = (a: Feature, b: Feature) => (sort === "priority" ? b.priority - a.priority || b.demand - a.demand : sort === "demand" ? b.demand - a.demand || b.priority - a.priority : b.createdAt.localeCompare(a.createdAt));
  const shown = (d?.features ?? []).filter((f) => all || ACTIVE.includes(f.status));
  const top = shown.filter((f) => !f.parentId || !shown.some((p) => p.id === f.parentId)).sort(order);
  const groups = [...areas.map((a) => ({ id: a.id, name: a.name })), { id: "", name: areas.length ? "No area" : "" }]
    .map((g) => ({ ...g, features: top.filter((f) => (f.areaId ?? "") === g.id) }))
    .filter((g) => g.features.length);
  const foldableIds = shown.filter((f) => f.tickets.items.length > 0).map((f) => f.id);
  const allOpen = foldableIds.length > 0 && foldableIds.every((id) => fold.ids.includes(id));
  const setAllOpen = (open: boolean) => {
    const next = { ids: open ? foldableIds : [] };
    setFold(next);
    saveFeatureOpen(next);
  };
  const cols = 8 + (d?.drivers.length ?? 0);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Features</h1>
          <p className="sub">
            New features show on your feedback portal unless they look like security work.{" "}
            <button type="button" className="link" style={{ padding: 0 }} aria-expanded={showHelp} aria-controls="features-portal-help" onClick={() => setShowHelp(!showHelp)}>
              {showHelp ? "Less" : "How the portal works"}
            </button>
          </p>
          {d && (() => {
            const ticked = d.features.filter((f) => f.portalVisible).length;
            const showing = d.features.filter((f) => f.portalShow?.shown).length;
            return <p className="muted" style={{ fontSize: 13 }} data-testid="portal-count">{showing} of {ticked} ticked showing on the portal</p>;
          })()}
          {showHelp && (
            <ul id="features-portal-help" className="muted" style={{ fontSize: 13, marginTop: 4, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
              <li>Tick "On portal" on a row to put a feature on the portal or take it off.</li>
              <li>Visitors only see a feature once it has a public summary.</li>
              <li>Visitors see the public title if you write one. If not, the first line of the public summary is the title. They never see the internal title or description.</li>
              <li>To keep a feature off on purpose, open it and tick "Keep off the portal (sensitive)".</li>
            </ul>
          )}
        </div>
      </header>
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : (
        <>
          <section className="card features-toolbar">
            <AddFeature companyId={company.id} areas={areas} onAdded={(id) => go(`features/${company.id}/${id}`)} />
            <div className="features-toolbar-tools">
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
              {/* sort + toggles share the bar with New feature at desktop width (BOS-1257) */}
              {foldableIds.length > 0 && (
                <button type="button" className="link" style={{ padding: 0 }} onClick={() => setAllOpen(!allOpen)}>
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
              )}
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
          ) : d && phone ? (
            <div className="fcards">
              {groups.map((g) => (
                <section key={g.id || "none"} aria-label={g.name || "Features"}>
                  {g.name && <h2 className="fcards-area">{g.name}</h2>}
                  <ul className="fcard-list">
                    {g.features.flatMap((f) => [
                      <FeatureCard key={f.id} f={f} drivers={d.drivers} hasSubfeatures={shown.some((s) => s.parentId === f.id)} open={isOpen(f.id)} onToggle={() => setFeatureOpen(f.id, !isOpen(f.id))} onPatch={patch} />,
                      ...shown
                        .filter((s) => s.parentId === f.id)
                        .sort(order)
                        .map((s) => <FeatureCard key={s.id} f={s} sub drivers={d.drivers} hasSubfeatures={false} open={isOpen(s.id)} onToggle={() => setFeatureOpen(s.id, !isOpen(s.id))} onPatch={patch} />),
                    ])}
                  </ul>
                </section>
              ))}
            </div>
          ) : d ? (
            <div className="table-wrap">
              <table className="features">
                <thead>
                  <tr>
                    <th className="feature-name">Feature</th>
                    <th title="Show on the feedback portal, where visitors can vote on it">Portal</th>
                    <th>Status</th>
                    <th title="Importance from linked feedback; each customer counts once. In brackets: how many people.">Demand</th>
                    {d.drivers.map((x) => (
                      <th key={x.id} className="num" title={`${x.name} (weight ${x.weight})`}>
                        <span className="th-clamp">{x.name}</span>
                      </th>
                    ))}
                    <th>Effort</th>
                    <th className="num" title="Weighted average of demand and criteria, 0 to 5">Value</th>
                    <th className="num" title="Value × 3 ÷ effort">Priority</th>
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
                      <FeatureRow key={f.id} f={f} drivers={d.drivers} maxDemand={d.maxDemand} hasSubfeatures={shown.some((s) => s.parentId === f.id)} open={isOpen(f.id)} onToggle={() => setFeatureOpen(f.id, !isOpen(f.id))} onPatch={patch} />,
                      ...shown
                        .filter((s) => s.parentId === f.id)
                        .sort(order)
                        .map((s) => <FeatureRow key={s.id} f={s} sub drivers={d.drivers} maxDemand={d.maxDemand} hasSubfeatures={false} open={isOpen(s.id)} onToggle={() => setFeatureOpen(s.id, !isOpen(s.id))} onPatch={patch} />),
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
  const [editing, setEditing] = useState(false);
  // Title and description while editing are kept in this browser (BOS-773), queued under this
  // feature's id: reload or an update swap brings them back until saved or cancelled.
  const [fields, setFields, resetFields, fieldsRestored] = useFormDraft<{ title: string; description: string }>(`feature-edit/${id}`, { title: "", description: "" });
  const startEdit = (seed: { title: string; description: string }) => {
    // Only seed when nothing was kept; a kept draft wins so a reload doesn't reset the owner's words.
    if (!readDraftJson<{ title: string; description: string }>(`feature-edit/${id}`)) setFields(seed);
    setEditing(true);
  };
  // The public summary is kept in this browser as it is typed (DR-045); the draft is used only while
  // the box is being edited, and it goes once the server has taken the summary.
  const summaryDraftKey = `feature-summary/${id}`;
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
  // The public title is saved with the summary, so the owner is not left with a summary that still shows the internal
  // title to visitors (BOS-991).
  const publicTitleDraftKey = `feature-public-title/${id}`;
  const [publicTitleDraft, setPublicTitleDraft] = useState<string | null>(null);
  // Why the feature is kept off the portal is saved with the mark (BOS-1358), so the owner's card says why.
  const keepOffReasonDraftKey = `feature-keep-off-reason/${id}`;
  const [keepOffReasonDraft, setKeepOffReasonDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = (body: Record<string, unknown>) => void api(`/api/features/${id}`, { method: "PATCH", body }).then(() => (setError(null), data.reload()), (err: Error) => setError(err.message));
  const saveKeepOffReason = (reason: string) =>
    void api(`/api/features/${id}`, { method: "PATCH", body: { keepOffPortal: true, keepOffReason: reason.trim() || null } }).then(
      () => (setError(null), setKeepOffReasonDraft(null), clearDraft(keepOffReasonDraftKey), data.reload()),
      (err: Error) => setError(err.message),
    );
  const saveSummary = (summary: string) =>
    void api(`/api/features/${id}`, { method: "PATCH", body: { publicSummary: summary.trim() || null, ...(publicTitleDraft !== null ? { publicTitle: publicTitleDraft.trim() || null } : {}) } }).then(
      () => (setError(null), setSummaryDraft(null), clearDraft(summaryDraftKey), clearDraft(publicTitleDraftKey), setPublicTitleDraft(null), data.reload()),
      (err: Error) => setError(err.message),
    );
  if (data.error && !away(data.error)) return data.error.status === 404 ? <NotFoundBlock title="Feature not found" backHref="#/features" backLabel="Back to Features">This feature doesn't exist any more, or the link is wrong.</NotFoundBlock> : <p className="error">{data.error.message}</p>;
  const d = data.data;
  if (!d) return null;
  const f = d.feature;
  const parents = (list.data?.features ?? []).filter((x) => !x.parentId && x.id !== id);
  const hasChildren = d.subfeatures.length > 0;
  const scored = d.drivers.filter((x) => f.driverScores[x.id] != null && x.weight > 0);
  const autoColumn = featureHorizon(f);
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
            <input className="title-input" aria-label="Title" value={fields.title} maxLength={200} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
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
            {fieldsRestored && (
              <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
                Draft restored. It stays in this browser until you save or discard it.{" "}
                <button type="button" className="link" style={{ padding: 0 }} onClick={() => { resetFields(); setEditing(false); }}>
                  Discard draft
                </button>
              </p>
            )}
            <div className="field">
              <label htmlFor="f-desc">Description</label>
              {/* The edit form (title and description) is kept by useFormDraft above, so this box only displays
                  its text: a second draft here could restore a different description over the form's. */}
              <DraftTextarea draftKey={null} noDraft="the edit form keeps title and description with useFormDraft, so this box only shows them" id="f-desc" rows={6} maxLength={20_000} value={fields.description} onChange={(text) => setFields({ ...fields, description: text })} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn primary"
                disabled={!fields.title.trim()}
                onClick={() => {
                  patch({ title: fields.title.trim(), description: fields.description.trim() || null });
                  resetFields();
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {f.description ? <p style={{ whiteSpace: "pre-wrap" }}>{f.description}</p> : <p className="muted">No description yet.</p>}
            <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => startEdit({ title: f.title, description: f.description ?? "" })}>
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
          <div className="field">
            <label htmlFor="f-column">Roadmap column</label>
            <select id="f-column" value={f.horizon ?? "auto"} onChange={(e) => patch({ horizon: e.target.value === "auto" ? null : e.target.value })}>
              <option value="auto">Automatic ({autoColumn === "released" ? "Released" : HORIZON_LABEL[autoColumn]})</option>
              {HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {HORIZON_LABEL[h]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-rank">Rank</label>
            <select id="f-rank" value={f.rank ?? ""} onChange={(e) => patch({ rank: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">Not ranked</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                  {n === 1 ? " (highest)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={f.portalVisible} onChange={(e) => patch({ portalVisible: e.target.checked })} />
          Show on the feedback portal, where visitors can vote on it
        </label>
        {f.portal?.reason === "needs public summary" && <p className="muted" style={{ fontSize: 13 }}>Held off the portal until you write a public summary below: visitors see the public summary and its first line, not the internal title or description.</p>}
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={f.keepOffPortal} onChange={(e) => patch({ keepOffPortal: e.target.checked })} />
          Keep off the portal (sensitive)
        </label>
        {f.keepOffPortal && (
          <div className="field">
            <label htmlFor="f-keep-off-reason">Why it's kept off (optional)</label>
            <DraftTextarea
              draftKey={keepOffReasonDraftKey}
              id="f-keep-off-reason"
              rows={2}
              maxLength={500}
              placeholder="A short reason; the owner sees it if they are asked about this feature"
              value={keepOffReasonDraft ?? f.keepOffReason ?? ""}
              onChange={setKeepOffReasonDraft}
            />
            <button
              type="button"
              className="btn small"
              style={{ alignSelf: "flex-start" }}
              disabled={keepOffReasonDraft === null || keepOffReasonDraft.trim() === (f.keepOffReason ?? "")}
              onClick={() => saveKeepOffReason(keepOffReasonDraft!)}
            >
              Save reason
            </button>
          </div>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Demand {f.demand} of {d.maxDemand} gives {f.demandPart.toFixed(1)}/5 at weight {d.settings.demandWeight}
          {scored.map((x) => `; ${x.name} ${f.driverScores[x.id]}/5 at weight ${x.weight}`).join("")}. Value {f.value.toFixed(1)}, × 3 ÷ effort {f.effort ?? 3} = priority {f.priority.toFixed(1)}.
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card" aria-labelledby="f-public-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="f-public-h" style={{ fontSize: 17, fontWeight: 600 }}>
          Public roadmap
        </h2>
        <p className="muted" style={{ fontSize: 13 }}>
          A plain-language summary for readers outside the team. Nothing is published by Boss Man yet; these fields are ready for a public roadmap. Visitors to the feedback portal see the public summary as the description and its first line as the title, or the public title below when you write one; they never see this feature's internal title.
        </p>
        <div className="field">
          <label htmlFor="f-public-title">Public title (optional)</label>
          <input
            id="f-public-title"
            maxLength={200}
            placeholder="Shown to visitors; leave empty to use the public summary's first line"
            value={publicTitleDraft ?? f.publicTitle ?? ""}
            onChange={(e) => setPublicTitleDraft(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="f-public-summary">Public summary</label>
          <DraftTextarea
            draftKey={summaryDraftKey}
            id="f-public-summary"
            rows={4}
            maxLength={2000}
            value={summaryDraft ?? f.publicSummary ?? ""}
            onChange={setSummaryDraft}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="btn small"
            disabled={(summaryDraft === null || summaryDraft.trim() === (f.publicSummary ?? "")) && (publicTitleDraft === null || publicTitleDraft.trim() === (f.publicTitle ?? ""))}
            onClick={() => saveSummary(summaryDraft ?? f.publicSummary ?? "")}
          >
            Save summary
          </button>
          <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 44, fontSize: 14 }}>
            <input type="checkbox" checked={f.showPublicly} disabled={!(f.publicSummary ?? "").trim()} onChange={(e) => patch({ showPublicly: e.target.checked })} />
            Show publicly
          </label>
          {f.showPublicly && <span className="tag green">On</span>}
        </div>
        {!(f.publicSummary ?? "").trim() && <p className="muted" style={{ fontSize: 13 }}>Write and save a public summary before showing it publicly.</p>}
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
