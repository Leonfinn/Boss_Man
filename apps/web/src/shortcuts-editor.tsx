// The Edit shortcuts dialog (BOS-2669 ticket 3): rename, move and remove the owner's menu shortcuts. Everything
// is worked on a copy; nothing is saved until Save, so Cancel and Esc leave the list as it was. Every action has a
// button (Move up, Move down, Remove), so dragging is only an extra for a mouse or a held touch. Moves and
// removals are said in a polite live region for screen readers.
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from "lucide-react";
import { SHORTCUTS_MAX, SHORTCUT_NAME_MAX, shortcutEntries, type SavedShortcut, type ShortcutEntry } from "@boss-man/shared";

type Row = { id: string; name: string; entry: ShortcutEntry; defaultName: string };

/** How long a touch must be held on the handle before a drag starts, so a swipe still scrolls the list. */
const HOLD_MS = 250;

function rowsFor(saved: SavedShortcut[], companyId: string | undefined): Row[] {
  return saved.map((s) => {
    const entry = shortcutEntries([s], companyId)[0]!;
    const defaultName = shortcutEntries([{ id: s.id }], companyId)[0]!.name;
    return { id: s.id, name: s.name ?? defaultName, entry, defaultName };
  });
}

/** The list to save from the rows: an emptied or unchanged name is left out, so the page's own name shows. */
export function listFromRows(rows: Array<{ id: string; name: string; defaultName: string }>): SavedShortcut[] {
  return rows.map((r) => {
    const name = [...r.name.trim()].slice(0, SHORTCUT_NAME_MAX).join("");
    return name === "" || name === r.defaultName ? { id: r.id } : { id: r.id, name };
  });
}

export function ShortcutsEditor({ saved, companyId, onSave, onClose }: { saved: SavedShortcut[]; companyId: string | undefined; onSave: (list: SavedShortcut[]) => Promise<boolean>; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => rowsFor(saved, companyId));
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const nameBoxes = useRef(new Map<string, HTMLInputElement>());
  const drag = useRef<{ id: string; timer: number | null; active: boolean } | null>(null);
  const pendingFocus = useRef<string | null>(null);

  // Focus starts on the first name box.
  useEffect(() => {
    listRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  // After a move the same button keeps focus (the row re-renders in a new place).
  useEffect(() => {
    if (!pendingFocus.current) return;
    panel.current?.querySelector<HTMLElement>(`[data-focus-key="${pendingFocus.current}"]`)?.focus();
    pendingFocus.current = null;
  });

  const move = (id: string, by: -1 | 1, focusKey?: string) => {
    const at = rows.findIndex((r) => r.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= rows.length) return;
    const next = rows.slice();
    const [item] = next.splice(at, 1);
    next.splice(to, 0, item!);
    setRows(next);
    setSay(`${item!.name || item!.defaultName} moved to position ${to + 1} of ${next.length}.`);
    if (focusKey) pendingFocus.current = focusKey;
  };

  const remove = (id: string) => {
    const at = rows.findIndex((r) => r.id === id);
    if (at < 0) return;
    const gone = rows[at]!;
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    setSay(`${gone.name || gone.defaultName} removed. ${next.length} of ${SHORTCUTS_MAX} shortcuts.`);
    // Focus goes to the next row's name box, or the previous one, or Save when none is left.
    const target = next[at] ?? next[at - 1];
    window.setTimeout(() => {
      if (target) nameBoxes.current.get(target.id)?.focus();
      else panel.current?.querySelector<HTMLElement>(".shortcut-edit-save")?.focus();
    }, 0);
  };

  const save = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await onSave(listFromRows(rows));
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  };

  // Esc is Cancel; Tab stays inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Dragging by the handle: a mouse starts at once, a touch after a short hold. The row under the pointer is where
  // the dragged row goes.
  const overRow = (y: number): string | null => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>("li[data-row-id]") ?? []);
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return el.dataset.rowId ?? null;
    }
    return null;
  };
  const onHandleDown = (e: React.PointerEvent, id: string) => {
    const state = { id, timer: null as number | null, active: false };
    drag.current = state;
    const target = e.currentTarget as HTMLElement;
    const pid = e.pointerId;
    const begin = () => {
      state.active = true;
      try {
        target.setPointerCapture(pid);
      } catch {
        // a pointer that has already gone: the drag just does not start
      }
    };
    if (e.pointerType === "touch") state.timer = window.setTimeout(begin, HOLD_MS);
    else begin();
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d?.active) return;
    const over = overRow(e.clientY);
    if (!over || over === d.id) return;
    setRows((cur) => {
      const from = cur.findIndex((r) => r.id === d.id);
      const to = cur.findIndex((r) => r.id === over);
      if (from < 0 || to < 0) return cur;
      const next = cur.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      setSay(`${item!.name || item!.defaultName} moved to position ${to + 1} of ${next.length}.`);
      return next;
    });
  };
  const onHandleUp = () => {
    if (drag.current?.timer) window.clearTimeout(drag.current.timer);
    drag.current = null;
  };

  return (
    <div className="shortcut-edit-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className="shortcut-edit" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} onKeyDown={onKeyDown}>
        <header className="shortcut-edit-head">
          <h2 id={titleId}>Edit shortcuts</h2>
          <span className="shortcut-edit-count">{rows.length} of {SHORTCUTS_MAX}</span>
        </header>
        <p id={hintId} className="shortcut-edit-hint">Rename, move or remove. To add one, open the page and press Add to shortcuts beside its title.</p>
        <ul ref={listRef} className="shortcut-edit-list">
          {rows.map((r, i) => {
            const label = r.name.trim() || r.defaultName;
            return (
              <li key={r.id} data-row-id={r.id} className="shortcut-edit-row">
                <span className="shortcut-edit-handle" aria-hidden="true" title="Drag to reorder" onPointerDown={(e) => onHandleDown(e, r.id)} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
                  <GripVertical size={18} strokeWidth={1.75} />
                </span>
                <div className="shortcut-edit-main">
                  <input
                    ref={(el) => {
                      if (el) nameBoxes.current.set(r.id, el);
                      else nameBoxes.current.delete(r.id);
                    }}
                    type="text"
                    className="shortcut-edit-name"
                    aria-label={`Name of shortcut ${i + 1}, ${r.defaultName}`}
                    value={r.name}
                    maxLength={SHORTCUT_NAME_MAX}
                    placeholder={r.defaultName}
                    onChange={(e) => setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                  />
                  <small className="shortcut-edit-dest">{r.entry.gone ? "Page no longer exists" : `Opens ${r.entry.path}`}</small>
                </div>
                <div className="shortcut-edit-actions">
                  <button type="button" className="shortcut-edit-btn" data-focus-key={`up-${r.id}`} aria-label={`Move ${label} up`} title="Move up" disabled={i === 0} onClick={() => move(r.id, -1, `up-${r.id}`)}>
                    <ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button type="button" className="shortcut-edit-btn" data-focus-key={`down-${r.id}`} aria-label={`Move ${label} down`} title="Move down" disabled={i === rows.length - 1} onClick={() => move(r.id, 1, `down-${r.id}`)}>
                    <ArrowDown size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button type="button" className="shortcut-edit-btn" aria-label={`Remove ${label}`} title="Remove" onClick={() => remove(r.id)}>
                    <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="shortcut-edit-empty">No shortcuts. Save to clear the Shortcuts section from the menu.</p>}
        <div className="sr-only" role="status" aria-live="polite">{say}</div>
        {failed && <p className="shortcut-edit-error" role="alert">Couldn't save your shortcuts. Check the connection and try again.</p>}
        <footer className="shortcut-edit-foot">
          <button type="button" className="btn primary shortcut-edit-save" disabled={busy} onClick={() => void save()}>Save</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
