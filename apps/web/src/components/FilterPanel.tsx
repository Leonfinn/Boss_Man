import { useEffect, useRef, useState, type RefObject } from "react";

export type ShowView = "all" | "features" | "tasks";

/** True on a phone-width window (640 px and under): the panel is a bottom sheet there, a popover above. */
export function useIsPhone(): boolean {
  const query = "(max-width: 640px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return phone;
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export type FilterPanelProps = {
  view: ShowView;
  onView: (v: ShowView) => void;
  assignee: string;
  onAssignee: (v: string) => void;
  feature: string;
  onFeature: (v: string) => void;
  working: boolean;
  onWorking: (v: boolean) => void;
  agents: Array<{ id: string; name: string }>;
  features: Array<{ id: string; title: string }>;
  /** Agents working now, shown beside the switch; undefined until the board has loaded. */
  workingCount: number | undefined;
  /** Tasks the board shows with these filters; undefined until the board has loaded. */
  shownCount: number | undefined;
  anyOn: boolean;
  onClear: () => void;
  onClose: () => void;
  phone: boolean;
  triggerRef: RefObject<HTMLElement | null>;
};

/** The Board's filters (BOS-1194): a popover under the Filter button on a wide screen, a bottom sheet on a phone. Changes apply at once. */
export function FilterPanel(p: FilterPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose, phone, triggerRef } = p;
  const featuresView = p.view === "features";

  // Opening moves focus to the first control; closing returns it to the Filter button.
  useEffect(() => {
    const trigger = triggerRef.current;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => trigger?.focus();
  }, [triggerRef]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || triggerRef.current?.contains(t)) return;
      if (!phone) onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [phone, onClose, triggerRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab" && phone) {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  // On a wide screen the panel is not modal: Tab past its edge closes it and moves on.
  const onBlur = (e: React.FocusEvent) => {
    if (phone) return;
    const next = e.relatedTarget as Node | null;
    if (next && !ref.current?.contains(next) && !triggerRef.current?.contains(next)) onClose();
  };

  // One announcement after a short pause when a filter changes on a wide screen.
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    if (p.shownCount === undefined) return;
    const t = setTimeout(() => setAnnounce(`${p.shownCount} ${p.shownCount === 1 ? "task" : "tasks"} shown`), 400);
    return () => clearTimeout(t);
  }, [p.shownCount]);

  const countText = p.workingCount === undefined ? "…" : String(p.workingCount);
  const showText = p.shownCount === undefined ? "Show tasks" : `Show ${p.shownCount} ${p.shownCount === 1 ? "task" : "tasks"}`;

  return (
    <>
      {phone && <div className="filter-scrim" onClick={onClose} aria-hidden="true" />}
      <div ref={ref} id="filter-panel" className={`filter-panel${phone ? " sheet" : ""}`} role="dialog" aria-label="Filter tasks" aria-modal={phone ? "true" : undefined} onKeyDown={onKeyDown} onBlur={onBlur}>
        {phone && <div className="filter-handle" aria-hidden="true" />}
        <header className="filter-head">
          <h2>Filter tasks</h2>
          {p.anyOn && !phone && (
            <button type="button" className="linkish" onClick={p.onClear}>
              Clear all
            </button>
          )}
        </header>
        <div className="filter-body">
          <div className="filter-group" role="group" aria-label="Show">
            <span className="filter-label">Show</span>
            <div className="segmented">
              {(["all", "features", "tasks"] as const).map((v) => (
                <button key={v} type="button" className="chip" aria-pressed={p.view === v} onClick={() => p.onView(v)}>
                  {v === "all" ? "All" : v === "features" ? "Features" : "Tasks"}
                </button>
              ))}
            </div>
          </div>
          {featuresView && <p className="muted filter-note">These filter tasks. Switch Show to All or Tasks to use them.</p>}
          <label className="filter-group">
            <span className="filter-label">Assigned to</span>
            <select value={p.assignee} disabled={featuresView} onChange={(e) => p.onAssignee(e.target.value)}>
              <option value="anyone">Anyone</option>
              <option value="owner">You</option>
              {p.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span className="filter-label">Feature</span>
            <select value={p.feature} disabled={featuresView} onChange={(e) => p.onFeature(e.target.value)}>
              <option value="any">Any feature</option>
              <option value="none">No feature</option>
              {p.features.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-group">
            <span className="filter-label" id="filter-working-label">
              Working now
            </span>
            <button type="button" role="switch" aria-checked={p.working} aria-labelledby="filter-working-label filter-working-desc" disabled={featuresView} className={`switch${p.working ? " on" : ""}`} onClick={() => p.onWorking(!p.working)}>
              <span className="switch-knob" aria-hidden="true" />
            </button>
            <small className="muted" id="filter-working-desc">
              Only tasks an agent is working on ({countText})
            </small>
          </div>
        </div>
        {phone ? (
          <footer className="filter-foot">
            <button type="button" className="btn" onClick={p.onClear} disabled={!p.anyOn}>
              Clear all
            </button>
            <button type="button" className="btn primary" onClick={onClose} aria-live="polite">
              {showText}
            </button>
          </footer>
        ) : (
          <footer className="filter-foot muted">Changes apply at once. Esc closes.</footer>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {phone ? "" : announce}
        </span>
      </div>
    </>
  );
}
