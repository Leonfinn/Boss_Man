import { useEffect, useId, useRef, useState } from "react";

/**
 * Only one help pop-over is open at a time (BOS-1195), across every field on the page: opening one closes
 * whichever was open, since each keeps its own state.
 */
let openNow: string | null = null;
const listeners = new Set<() => void>();
const setOpenNow = (id: string | null) => {
  openNow = id;
  for (const hear of listeners) hear();
};

/**
 * A field's help behind a small "?" (BOS-1195): a real button that opens a pop-over, so a long paragraph
 * doesn't take space every time the page is read. It closes on ×, Esc, a second press or a click outside;
 * Esc and × put focus back on the "?"; the pop-over doesn't trap focus (it's help, not a dialog).
 */
export function FieldHelp({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Which way the pop-over drops: above the button when a row near the bottom of the window has no room below.
  const [above, setAbove] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  // × and Esc: close and put focus back on the "?".
  const close = () => {
    if (openNow === id) setOpenNow(null);
    setOpen(false);
    btn.current?.focus();
  };

  const toggle = () => {
    if (open) {
      if (openNow === id) setOpenNow(null);
      setOpen(false);
      return;
    }
    if (btn.current) setAbove(btn.current.getBoundingClientRect().bottom + 240 > window.innerHeight);
    setOpenNow(id);
    setOpen(true);
  };

  // Another field's "?" was opened: this one closes without taking focus from it.
  useEffect(() => {
    const hear = () => {
      if (openNow !== id) setOpen(false);
    };
    listeners.add(hear);
    return () => {
      listeners.delete(hear);
      if (openNow === id) openNow = null;
    };
  }, [id]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(`[data-field-help="${id}"]`)) setOpen(false);
    };
    // Captured, so Esc closes the help before anything behind it acts on the same key.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, id]);

  return (
    <>
      <button ref={btn} type="button" className="field-help" aria-expanded={open} aria-controls={id} aria-label={`About ${label}`} onClick={toggle}>
        ?
      </button>
      {open && (
        <div id={id} className={`help-pop${above ? " above" : ""}`} role="region" aria-label={`About ${label}`} data-field-help={id}>
          <div className="help-pop-head">
            <span className="help-pop-title">{label}</span>
            <button type="button" className="help-pop-close" aria-label={`Close ${label} help`} onClick={close}>
              ×
            </button>
          </div>
          <div className="help-pop-body">{children}</div>
        </div>
      )}
    </>
  );
}
