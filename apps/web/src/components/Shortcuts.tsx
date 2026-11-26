// Keyboard shortcuts (BOS-2321): "?" lists them, and "g" then a letter jumps to a main screen.
// BOS-2330: j/k move between cards and Enter opens one, on screens that mark their cards (Board, Decisions).
// Mounted once in App.tsx beside the search box. Ctrl/Cmd+K itself stays the search box's own listener;
// this only lists it.
import { useEffect, useRef, useState } from "react";
import { G_WINDOW_MS, HELP_KEY, JUMPS, JUMP_PREFIX, SHOW_SHORTCUTS_EVENT, cardActionFor, screenKeys } from "../shortcut-list";

/** The event that opens the list from outside the menu (BOS-2689), fired by Settings → Account's "Show all keyboard shortcuts". */
export const OPEN_SHORTCUTS_EVENT = "bossman:open-shortcuts";

// The keys themselves live in ../shortcut-list.ts (BOS-2687); re-exported so existing imports keep working.
export { G_WINDOW_MS, JUMPS, screenKeys };

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True on a touch screen with no mouse or trackpad (design 3a): the keys need a keyboard. Unknown counts as having a mouse. */
const noFinePointer = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia("(any-pointer: fine)").matches;

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
 * singleLetterKeys (BOS-2689): with it off, "?", the g-sequences, g 1 to g 6 and the j/k/Enter card keys do
 * nothing, while Ctrl/Cmd+K and Escape keep working. The list still opens from the menu button and says so.
 * onTurnKeysOn: the list's "Turn them on", saved per login.
 */
export function Shortcuts({ go, hasProjects, singleLetterKeys = true, onTurnKeysOn, initialOpen = false, noMouse }: { go: (to: string) => void; hasProjects: boolean; singleLetterKeys?: boolean; onTurnKeysOn?: () => void; /** For the rendering test, which has no window when it builds the markup: forces the "These need a keyboard." line on or off. */ noMouse?: boolean;/** Open on the first draw: for the rendering test, which reads the markup. */ initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const gAt = useRef(0);
  const back = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The listener is added once; it reads the latest props through this ref.
  const latest = useRef({ go, hasProjects, open, singleLetterKeys });
  latest.current = { go, hasProjects, open, singleLetterKeys };

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
      if (e.key === HELP_KEY) {
        gAt.current = 0;
        // Single-letter keys off (BOS-2689): "?" does nothing; the menu button still opens the list.
        if (!latest.current.singleLetterKeys) return;
        e.preventDefault();
        back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
        return;
      }
      // Everything below is a single-letter key (a letter, "g", a number, j/k/Enter), so with them off
      // the event is left alone: Tab, Escape and Enter on a button stay the browser's.
      if (!latest.current.singleLetterKeys) {
        gAt.current = 0;
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
      if (key === JUMP_PREFIX) {
        gAt.current = Date.now();
        return;
      }
      const action = cardActionFor(e.key);
      if (action === "next" || action === "prev") {
        if (moveCard(action === "next" ? 1 : -1)) e.preventDefault();
        return;
      }
      if (action === "open" && openCard()) e.preventDefault();
    };
    // The menu's keyboard button (BOS-2688). Focus goes back to it on close; Safari doesn't focus a clicked button.
    const onShow = () => {
      back.current = document.querySelector<HTMLElement>(".shortcuts-button") ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, onShow);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHOW_SHORTCUTS_EVENT, onShow);
    };
  }, []);

  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  // "Show all keyboard shortcuts" on Settings → Account (BOS-2689) opens the list, the way the menu's
  // keyboard button does, so a page with keys off can still reach it.
  useEffect(() => {
    const onOpen = () => {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);

  if (!open) return null;
  const mod = isMac() ? "⌘" : "Ctrl";
  const here = screenKeys(typeof window === "undefined" ? "" : window.location.hash);
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
            return;
          }
          // Keep Tab inside the open dialog (aria-modal): wrap from the last control to the first and back.
          if (e.key === "Tab") {
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
            if (items.length === 0) {
              e.preventDefault();
              return;
            }
            const first = items[0]!;
            const last = items[items.length - 1]!;
            const at = document.activeElement;
            if (e.shiftKey && (at === first || !e.currentTarget.contains(at))) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && (at === last || !e.currentTarget.contains(at))) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="search-input">
          <h2 id="shortcuts-title" className="shortcuts-title">Keyboard shortcuts</h2>
          <button ref={closeButton} type="button" className="linkish" onClick={close}>
            Close
          </button>
        </div>
        {!singleLetterKeys && (
          <p className="shortcuts-off" role="status">
            Single-letter keys are off, so only the ones with {mod} work.{" "}
            {onTurnKeysOn && (
              <button type="button" className="linkish" onClick={() => void onTurnKeysOn()}>
                Turn them on
              </button>
            )}
          </p>
        )}
        {/* The middle scrolls on a short window; the title above and the note below stay in view (BOS-2688). */}
        <div className="shortcuts-scroll">
          {here && (
            <>
              <h3 className="shortcuts-section first">{here.title}</h3>
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
          {/* With no keys of this page's own, the whole list is "everywhere", so it needs no heading. */}
          {here && <h3 className="shortcuts-section">Everywhere</h3>}
          <dl className="shortcuts-list" aria-label="Everywhere">
            <div className="shortcuts-row">
              <dt><kbd>{mod}</kbd> <kbd>K</kbd></dt>
              <dd>Search tickets, wiki, chats, features, decisions, runs, agents, skills and feedback</dd>
            </div>
            <div className="shortcuts-row">
              <dt><kbd>{HELP_KEY}</kbd></dt>
              <dd>Show this list</dd>
            </div>
            {JUMPS.map((j) => (
              <div key={j.key} className="shortcuts-row">
                <dt><kbd>{JUMP_PREFIX}</kbd> then <kbd>{j.key}</kbd></dt>
                <dd>Go to {j.key === "b" ? "the Board (or Projects if there is none)" : j.label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="muted shortcuts-note">
          {(noMouse ?? noFinePointer()) && <>These need a keyboard. </>}
          Shortcuts don't work while you're typing in a box.
          {singleLetterKeys && onTurnKeysOn && (
            <>
              {" "}
              <button type="button" className="linkish" onClick={() => void onTurnKeysOn()}>
                Turn off single-letter keys
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
