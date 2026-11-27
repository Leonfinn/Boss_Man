// The menu's own shortcuts (BOS-2669 ticket 2): the list the owner pinned, the "Add to shortcuts" button beside
// the title of the 26 pinnable pages, and the toast (with Undo) after a press. The list is the owner's saved
// preference (read with the sign-in answer, so the menu never moves after it is first drawn); a press saves the
// whole new list and the screen changes only when the server has taken it, so a failed save leaves the button
// exactly as it was. One shared piece: every page puts <AddToShortcuts .../> beside its title.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pin } from "lucide-react";
import { PINNABLE_PAGES, SHORTCUTS_MAX, shortcutEntries, type SavedShortcut, type ShortcutEntry } from "@boss-man/shared";
import { usePreferences } from "./preferences";
import { NotFoundBlock } from "./components/NotFoundBlock";

type Toast = { id: number; text: string; undo?: SavedShortcut[] };

type Pinned = {
  saved: SavedShortcut[];
  entries: ShortcutEntry[];
  /** The id outlined for 2 seconds after it was added. */
  justAdded: string | null;
  /** Add the page, or take it out if it is already there. */
  toggle: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const Ctx = createContext<Pinned | null>(null);

export const usePinned = () => useContext(Ctx);

/** How long a toast stays: long enough to reach Undo with a pointer or a screen reader. */
const TOAST_MS = 8000;
const HIGHLIGHT_MS = 2000;

export function PinnedProvider({ companyId, children }: { companyId: string | undefined; children: ReactNode }) {
  const { prefs, save } = usePreferences();
  const saved = prefs.pinnedPages ?? [];
  const [toast, setToast] = useState<Toast | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const say = useCallback((text: string, undo?: SavedShortcut[]) => {
    const id = ++seq.current;
    setToast({ id, text, undo });
    timers.current.push(window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), TOAST_MS));
  }, []);
  const failed = useCallback(() => say("Couldn't save your shortcuts. Check the connection and try again."), [say]);
  const nameOf = (list: SavedShortcut[], id: string) => shortcutEntries(list).find((e) => e.id === id)?.name ?? "That page";

  const write = useCallback(
    async (next: SavedShortcut[]) => {
      try {
        await save({ pinnedPages: next });
        return true;
      } catch {
        failed();
        return false;
      }
    },
    [save, failed],
  );

  const toggle = useCallback(
    async (id: string) => {
      const before = saved;
      if (before.some((s) => s.id === id)) {
        const name = nameOf(before, id);
        if (await write(before.filter((s) => s.id !== id))) say(`${name} removed from your shortcuts.`, before);
        return;
      }
      if (before.length >= SHORTCUTS_MAX) {
        say(`You have ${SHORTCUTS_MAX} shortcuts, the most there's room for. Remove one first: press In shortcuts on its page.`);
        return;
      }
      const next = [...before, { id }];
      if (await write(next)) {
        say(`${nameOf(next, id)} added to your shortcuts.`, before);
        setJustAdded(id);
        timers.current.push(window.setTimeout(() => setJustAdded((cur) => (cur === id ? null : cur)), HIGHLIGHT_MS));
      }
    },
    [saved, write, say],
  );

  const remove = useCallback(
    async (id: string) => {
      const before = saved;
      const name = nameOf(before, id);
      if (await write(before.filter((s) => s.id !== id))) say(`${name} removed from your shortcuts.`, before);
    },
    [saved, write, say],
  );

  const undo = async (to: SavedShortcut[]) => {
    setToast(null);
    await write(to);
  };

  return (
    <Ctx.Provider value={{ saved, entries: shortcutEntries(saved, companyId), justAdded, toggle, remove }}>
      {children}
      {toast && (
        <div className="pin-toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="pin-toast-undo" onClick={() => void undo(toast.undo!)}>
              Undo
            </button>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

/** What a shortcut to a page an update removed opens: the usual not-found block, with a way to drop the shortcut. */
export function ShortcutGone({ id }: { id: string }) {
  const pinned = usePinned();
  const entry = pinned?.entries.find((e) => e.id === id);
  return (
    <NotFoundBlock
      title="Page no longer exists"
      backHref="#/dashboard"
      backLabel="Back to Dashboard"
      extra={
        entry ? (
          <button type="button" className="btn" onClick={() => void pinned!.remove(id).then(() => { window.location.hash = "#/dashboard"; })}>
            Remove this shortcut
          </button>
        ) : null
      }
    >
      {entry ? `${entry.name} was a page in an earlier version of Boss Man and an update took it away. Your shortcut is kept until you remove it.` : "That shortcut is not in your list any more."}
    </NotFoundBlock>
  );
}

/** The pinnable page for a top-level page id (e.g. "roadmap") or a Settings page id (e.g. "updates"). */
export function pinnableFor(where: { page: string } | { settingsPage: string }) {
  return PINNABLE_PAGES.find((p) => ("settingsPage" in where ? p.settingsPage === where.settingsPage : !p.settingsPage && p.page === where.page));
}

/**
 * The chip beside a page's title. Shows nothing for a page that isn't one of the 26, and nothing outside the
 * signed-in app. Pressed = in shortcuts; pressing again takes it out (with Undo).
 */
export function AddToShortcuts(where: { page: string } | { settingsPage: string }) {
  const pinned = usePinned();
  const page = pinnableFor(where);
  if (!pinned || !page) return null;
  const on = pinned.saved.some((s) => s.id === page.id);
  return (
    <button type="button" className="pin-chip" aria-pressed={on} title={on ? `Press to remove ${page.name} from your shortcuts` : `Add ${page.name} to the Shortcuts section of the menu`} onClick={() => void pinned.toggle(page.id)}>
      <Pin size={14} strokeWidth={1.75} aria-hidden="true" fill={on ? "currentColor" : "none"} />
      <span>{on ? "In shortcuts" : "Add to shortcuts"}</span>
    </button>
  );
}
