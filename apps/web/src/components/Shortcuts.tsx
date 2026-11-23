// Keyboard shortcuts (BOS-2321): "?" lists them, and "g" then a letter jumps to a main screen.
// BOS-2330: j/k move between cards and Enter opens one, on screens that mark their cards (Board, Decisions).
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
 * Card keys (BOS-2330). A screen opts in by marking each card `data-shortcut-card` (with tabIndex -1, so it
 * can hold focus) and, inside it, what Enter opens with `data-shortcut-open`. The cards are read from the page
 * at press time, in document order, so whatever the screen shows (filters, folded lanes) is what j/k walks.
 * Board lanes are sections in order with their cards inside, so document order is down a lane, then the next.
 */
export const CARD_SELECTOR = "[data-shortcut-card]";

/** The current screen's own keys for the "?" list, or null on a screen without any. */
export function screenKeys(hash: string): { title: string; rows: Array<{ keys: string[]; what: string }> } | null {
  const on = /^#\/board(\/|$)/.test(hash)
    ? "Board"
    : /^#\/decisions(\/|$)/.test(hash)
      ? "Decisions"
      : /^#\/runs\/?(\?|$)/.test(hash)
        ? "Runs"
        : /^#\/features(\/[^/?]+)?\/?(\?|$)/.test(hash)
          ? "Features"
          : null;
  if (!on) return null;
  const list = on === "Runs" || on === "Features";
  const noun = on === "Runs" ? "run" : "feature";
  return {
    title: `On ${on === "Board" ? "the Board" : on}`,
    rows: [
      { keys: ["j"], what: on === "Board" ? "Next card (down the lane, then the next lane)" : list ? "Next row" : "Next card" },
      { keys: ["k"], what: list ? "Previous row" : "Previous card" },
      { keys: ["Enter"], what: on === "Board" ? "Open the card's task" : list ? `Open the ${noun}'s page` : "Go to the card's answer buttons" },
    ],
  };
}

/** Moves focus to the next (+1) or previous (-1) card. False when the screen has no cards. */
function moveCard(step: 1 | -1): boolean {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  if (cards.length === 0) return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(CARD_SELECTOR) : null;
  const at = active ? cards.indexOf(active) : -1;
  // With no card focused yet, j starts at the first card and k at the last.
  const next = at === -1 ? (step === 1 ? 0 : cards.length - 1) : Math.min(cards.length - 1, Math.max(0, at + step));
  const card = cards[next]!;
  card.focus({ preventScroll: true });
  card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

/**
 * Enter on a focused card: a link target is clicked (as the mouse would); anything else is a group whose first
 * enabled control takes focus, so the owner can then pick with Tab and Enter (no answer is given by key). A card
 * with no target (a decision already answered or waiting on advice) focuses its own first control. Only when the
 * card itself has focus: Enter on a button or link inside it is that control's own.
 */
function openCard(): boolean {
  const card = document.activeElement instanceof HTMLElement && document.activeElement.matches(CARD_SELECTOR) ? document.activeElement : null;
  if (!card) return false;
  const target = card.querySelector<HTMLElement>("[data-shortcut-open]") ?? card;
  if (target instanceof HTMLAnchorElement) target.click();
  else target.querySelector<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")?.focus();
  return true;
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
      if (key === "g") {
        gAt.current = Date.now();
        return;
      }
      if (e.key === "j" || e.key === "k") {
        if (moveCard(e.key === "j" ? 1 : -1)) e.preventDefault();
        return;
      }
      if (e.key === "Enter" && openCard()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  if (!open) return null;
  const mod = isMac() ? "⌘" : "Ctrl";
  const here = screenKeys(window.location.hash);
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
            <dd>Search tickets, wiki, chats, features, decisions, runs, agents and skills</dd>
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
        {here && (
          <>
            <h3 className="shortcuts-section">{here.title}</h3>
            <dl className="shortcuts-list" aria-label={here.title}>
              {here.rows.map((r) => (
                <div key={r.keys.join()} className="shortcuts-row">
                  <dt>{r.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                  <dd>{r.what}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <p className="muted shortcuts-note">Shortcuts don't work while you're typing in a box.</p>
      </div>
    </div>
  );
}
