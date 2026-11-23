// Keyboard shortcuts (BOS-2321): "?" lists them, and "g" then a letter jumps to a main screen.
// Mounted once in App.tsx beside the search box. Ctrl/Cmd+K itself stays the search box's own listener;
// this only lists it.
import { useEffect, useRef, useState } from "react";

/** How long after "g" the second letter still counts. */
export const G_WINDOW_MS = 1500;

/** "g" + letter → the route the sidebar's link for that screen opens. "b" is worked out at press time. */
export const JUMPS: Array<{ key: string; label: string; to: string }> = [
  { key: "d", label: "Dashboard", to: "dashboard" },
  { key: "b", label: "Board", to: "board" },
  { key: "c", label: "Chat", to: "chat" },
  { key: "i", label: "Decisions", to: "decisions" },
  { key: "n", label: "Notifications", to: "notifications" },
  { key: "r", label: "Runs", to: "runs" },
  { key: "w", label: "Wiki", to: "wiki" },
  { key: "f", label: "Features", to: "features" },
  { key: "s", label: "Settings", to: "settings" },
];

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True when a key press belongs to something else: a text box, or another open dialog (search box, lightbox). */
function busyElsewhere(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (el && (el.isContentEditable || el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))) return true;
  return document.querySelector("[aria-modal='true']:not(.shortcuts-palette), dialog[open]") !== null;
}

/**
 * hasProjects: whether the company on screen has a project, so "g b" opens its board (Board picks the
 * current project from the address, else the first) or, with none, the Projects list.
 */
export function Shortcuts({ go, hasProjects }: { go: (to: string) => void; hasProjects: boolean }) {
  const [open, setOpen] = useState(false);
  const gAt = useRef(0);
  const back = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The listener is added once; it reads the latest props through this ref.
  const latest = useRef({ go, hasProjects, open });
  latest.current = { go, hasProjects, open };

  const close = () => {
    setOpen(false);
    const to = back.current;
    back.current = null;
    if (to && to.isConnected) to.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (latest.current.open) return; // the dialog's own handler deals with Escape
      if (busyElsewhere(e.target)) {
        gAt.current = 0;
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        gAt.current = 0;
        back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
        return;
      }
      if (e.shiftKey) {
        gAt.current = 0;
        return;
      }
      const key = e.key.toLowerCase();
      const pending = gAt.current && Date.now() - gAt.current <= G_WINDOW_MS;
      if (pending) {
        gAt.current = 0;
        const jump = JUMPS.find((j) => j.key === key);
        if (jump) {
          e.preventDefault();
          // Already on a project's board: stay on it, since a bare "board" would open the first project.
          if (jump.key === "b" && window.location.hash.startsWith("#/board/")) return;
          latest.current.go(jump.key === "b" && !latest.current.hasProjects ? "projects" : jump.to);
          return;
        }
      }
      if (key === "g") gAt.current = Date.now();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  if (!open) return null;
  const mod = isMac() ? "⌘" : "Ctrl";
  return (
    <div className="search-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="search-palette shortcuts-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="search-input">
          <h2 id="shortcuts-title" className="shortcuts-title">Keyboard shortcuts</h2>
          <button ref={closeButton} type="button" className="linkish" onClick={close}>
            Close
          </button>
        </div>
        <dl className="shortcuts-list">
          <div className="shortcuts-row">
            <dt><kbd>{mod}</kbd> <kbd>K</kbd></dt>
            <dd>Search tickets, wiki, chats, features, decisions and runs</dd>
          </div>
          <div className="shortcuts-row">
            <dt><kbd>?</kbd></dt>
            <dd>Show this list</dd>
          </div>
          {JUMPS.map((j) => (
            <div key={j.key} className="shortcuts-row">
              <dt><kbd>g</kbd> then <kbd>{j.key}</kbd></dt>
              <dd>Go to {j.key === "b" ? "the Board (or Projects if there is none)" : j.label}</dd>
            </div>
          ))}
        </dl>
        <p className="muted shortcuts-note">Shortcuts don't work while you're typing in a box.</p>
      </div>
    </div>
  );
}
