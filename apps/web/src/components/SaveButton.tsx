import { useEffect, useState } from "react";

const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const shallowEqual = (a: object, b: object) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/**
 * Tracks whether a form differs from its last-saved values. The snapshot is the values at load;
 * call `markSaved()` after a successful save (pass the values to snapshot if the form resets, e.g. to cleared fields).
 */
export function useSaveState<T extends object>(form: T | null) {
  const [snap, setSnap] = useState<T | null>(form);
  const [saved, setSaved] = useState(false);
  // A form that loads later is snapshotted when it first appears.
  useEffect(() => {
    if (!snap && form) setSnap(form);
  }, [snap, form]);
  return {
    dirty: !!form && !!snap && !shallowEqual(form, snap),
    saved,
    markSaved: (next: T | null = form) => (setSnap(next), setSaved(true)),
    /** Values just loaded from the server: not "saved", just the new baseline. */
    reset: (next: T) => (setSnap(next), setSaved(false)),
  };
}

/**
 * The one Save button for Settings and other forms. Muted and disabled while nothing differs from the saved values;
 * primary (filled) with an "Unsaved changes" hint while something does; "Saving…" while busy; "Saved ✓" (muted) after a
 * save until a field changes. A failed save leaves the form dirty, so the button stays primary (the error text is the
 * caller's own note).
 */
export function SaveButton({ dirty, saved, busy, disabled, style, onClick }: { dirty: boolean; saved: boolean; busy?: boolean; disabled?: boolean; style?: React.CSSProperties; onClick?: () => void }) {
  const clean = !dirty;
  const hint = dirty && !busy;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", ...style }}>
      <button type={onClick ? "button" : "submit"} onClick={onClick} className={clean || busy ? "btn" : "btn primary"} disabled={busy || clean || disabled}>
        {busy ? "Saving…" : clean && saved ? "Saved ✓" : "Save"}
      </button>
      {hint ? (
        <span className="muted" style={{ fontSize: 14 }} data-testid="unsaved-hint">
          Unsaved changes
        </span>
      ) : null}
    </span>
  );
}
