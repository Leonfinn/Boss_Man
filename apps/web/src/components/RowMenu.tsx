import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

export type RowMenuItem = { label: string; hint?: string; onSelect: () => void; danger?: boolean; dividerBefore?: boolean };

/**
 * A "⋯" button with a menu of the less-used actions for one row (BOS-1256).
 * Desktop: a dropdown below the button, right-aligned. Below 641 px the CSS turns it into a bottom panel
 * with a dimmed page behind it, headed with `heading`.
 * Keys: Enter / Space / ↓ open it with focus on the first item; ↑ ↓ Home End move; Esc or Tab closes and
 * returns focus to the button; a click outside closes it.
 */
export function RowMenu({ label, heading, subheading, items }: { label: string; heading: string; subheading?: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const focusItem = (i: number) => {
    const els = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!els || !els.length) return;
    els[(i + els.length) % els.length]?.focus();
  };
  const close = (back: boolean) => {
    setOpen(false);
    if (back) trigger.current?.focus();
  };

  useEffect(() => {
    if (open) focusItem(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent | TouchEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const els = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(els.length - 1);
    }
  };

  return (
    <span className="row-menu" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="btn row-menu-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          } else if (e.key === "Escape" && open) {
            close(true);
          }
        }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="row-menu-dim" aria-hidden="true" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="row-menu-list" id={id} role="menu" aria-label={label} ref={menu} onKeyDown={onMenuKey}>
            <div className="row-menu-head" aria-hidden="true">
              <strong>{heading}</strong>
              {subheading && <span className="muted"> · {subheading}</span>}
            </div>
            {items.map((it) => (
              <div key={it.label} role="none">
                {it.dividerBefore && <hr className="row-menu-sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`row-menu-item${it.danger ? " danger" : ""}`}
                  onClick={() => {
                    close(true);
                    it.onSelect();
                  }}
                >
                  <span>{it.label}</span>
                  {it.hint && <small>{it.hint}</small>}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
