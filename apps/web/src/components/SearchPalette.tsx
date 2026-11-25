// The search box (BOS-2192): Ctrl+K / Cmd+K from any screen, or the sidebar's search button, finds
// tickets, wiki pages and chat messages in the company on screen and jumps to the one picked; since BOS-2326
// also features, decisions (owner cards) and runs.
// Mounted once in App.tsx; the button lives in the sidebar and opens it through a window event, so
// neither has to pass state through the shell.
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";

export type SearchHit = { id: string; title: string; snippet: string; link: string; ref?: string | null; exact?: boolean; who?: string; at?: string; state?: string; outcome?: string | null };
export type SearchResults = { q: string; tickets: SearchHit[]; wiki: SearchHit[]; chats: SearchHit[]; features?: SearchHit[]; decisions?: SearchHit[]; runs?: SearchHit[]; agents?: SearchHit[]; skills?: SearchHit[]; feedback?: SearchHit[]; counts?: Partial<Record<SearchKind, number>> };
export type SearchKind = (typeof GROUPS)[number]["key"];
/** The box's name, on the sidebar button and the input alike. */
export const SEARCH_LABEL = "Search tickets, wiki, chats, features, decisions, runs, agents, skills and feedback";

/** The sidebar's button sends this; the palette listens for it. */
export const OPEN_SEARCH = "bm-open-search";
/** How long typing must pause before the box asks the server. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Below this many characters the box doesn't ask. */
export const SEARCH_MIN = 2;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The key hint shown on the button (a hint, not a label: the owner-control list leaves it out). */
const keyHint = () => (isMac() ? "⌘K" : "Ctrl K");

/** The search button for the sidebar: works with a touch or a mouse, no keyboard needed. */
export function SearchButton() {
  return (
    <button type="button" className="side-search" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH))} title={`Search (${isMac() ? "⌘" : "Ctrl"}+K)`} aria-label={SEARCH_LABEL}>
      <Search size={18} strokeWidth={1.75} aria-hidden="true" />
      <span className="nav-label">Search</span>
      <kbd className="side-search-key" aria-hidden="true">{keyHint()}</kbd>
    </button>
  );
}

// Features, decisions and runs (BOS-2326), then agents and skills (BOS-2347), come after the first three. They are
// optional in the answer so a page opened before the server was updated, talking to the older server, still works.
export const GROUPS: Array<{ key: "tickets" | "wiki" | "chats" | "features" | "decisions" | "runs" | "agents" | "skills" | "feedback"; label: string }> = [
  { key: "tickets", label: "Tickets" },
  { key: "wiki", label: "Wiki" },
  { key: "chats", label: "Chats" },
  { key: "features", label: "Features" },
  { key: "decisions", label: "Decisions" },
  { key: "runs", label: "Runs" },
  { key: "agents", label: "Agents" },
  { key: "skills", label: "Skills" },
  { key: "feedback", label: "Feedback" },
];

/** (BOS-2433) The last searches made in this browser, newest first: shown when the box is empty. */
export const RECENT_KEY = "bm-recent-searches";
export const RECENT_MAX = 5;
export function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length >= SEARCH_MIN).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
/** Puts a search at the front (no repeats, ignoring case) and keeps the newest five. Storage that refuses is skipped: the box still works. */
export function rememberSearch(term: string): string[] {
  const t = term.trim();
  if (t.length < SEARCH_MIN) return readRecent();
  const next = [t, ...readRecent().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode or full: nothing to keep */
  }
  return next;
}
export function clearRecent(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    /* nothing to clear */
  }
}
const hitsOf = (r: SearchResults, key: (typeof GROUPS)[number]["key"]) => r[key] ?? [];

// (BOS-2477) A ticket hit's state, in the ticket page's words and colours (Ticket.tsx STATE_LABEL / STATE_TONE).
const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" };
const STATE_TONE: Record<string, string> = { backlog: "", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };
/** The tag's word: a done ticket that was cancelled reads "Cancelled". */
export const ticketStateWord = (state: string, outcome?: string | null) => (state === "done" && outcome === "cancelled" ? "Cancelled" : (STATE_LABEL[state] ?? state));
/** The small state tag at the start of a ticket hit's title line (first, as a long title is cut with "…" at the end); nothing for other kinds, or from a server that sends no state. */
export function HitState({ hit }: { hit: SearchHit }) {
  if (!hit.state) return null;
  const cancelled = hit.state === "done" && hit.outcome === "cancelled";
  return <span className={`tag search-state ${cancelled ? "" : (STATE_TONE[hit.state] ?? "")}`}>{ticketStateWord(hit.state, hit.outcome)}</span>;
}
/** When a decision was raised or a run started, short and in the owner's own time. */
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const TIMED = new Set(["decisions", "runs", "feedback"]);

/** The Search page's date filter (BOS-2378): empty is any time. */
export type SearchSince = "" | "7d" | "30d";
/** The Search page's address for these words (BOS-2378), without the "#/". */
export function searchAddress(p: { q: string; kind?: SearchKind | ""; since?: SearchSince; open?: boolean; n?: number }): string {
  const qs = new URLSearchParams({ q: p.q });
  if (p.kind) qs.set("kind", p.kind);
  if (p.since) qs.set("since", p.since);
  if (p.open) qs.set("open", "1");
  if (p.n) qs.set("n", String(p.n));
  return `search?${qs}`;
}

export function SearchPalette({ companyId, go }: { companyId: string | undefined; go: (to: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  // Bumped by Retry after a failed search: the same query is asked again.
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Only the latest request's answer is shown: a slow reply to "pel" must not replace "pelican"'s.
  const asked = useRef(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      setRecent(readRecent());
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    const n = ++asked.current;
    if (!open || !companyId || term.length < SEARCH_MIN) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      api<SearchResults>(`/api/companies/${companyId}/search?q=${encodeURIComponent(term)}`).then(
        (r) => {
          if (n !== asked.current) return;
          setResults(r);
          setActive(0);
          setError(null);
          setLoading(false);
        },
        (err: Error) => {
          if (n !== asked.current) return;
          setError(err.message);
          setLoading(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, open, companyId, attempt]);

  const close = () => {
    setOpen(false);
    setQ("");
    setResults(null);
    setActive(0);
  };
  const flat = results ? GROUPS.flatMap((g) => hitsOf(results, g.key)) : [];
  // (BOS-2433) With the box empty, the arrows and Enter work on the recent searches instead.
  const showRecent = !!companyId && q.trim().length < SEARCH_MIN && recent.length > 0;
  const navLength = showRecent ? recent.length : flat.length;
  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    rememberSearch(q);
    close();
    go(hit.link);
  };
  const rerun = (term: string | undefined) => {
    if (term === undefined) return;
    setQ(term);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (navLength) setActive((a) => (a + 1) % navLength);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (navLength) setActive((a) => (a - 1 + navLength) % navLength);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (showRecent) rerun(recent[active]);
      else pick(flat[active]);
    }
  };

  if (!open) return null;
  const term = q.trim();
  let index = -1;
  return (
    <div className="search-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKey}>
        <div className="search-input">
          <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={navLength > 0}
            aria-controls="search-results"
            aria-activedescendant={active < navLength ? `search-hit-${active}` : undefined}
            aria-label={SEARCH_LABEL}
            placeholder="Search tickets, wiki, chats, runs, agents, skills…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="linkish" onClick={close}>
            Close
          </button>
        </div>
        <div id="search-results" role="listbox" aria-label="Results" className="search-results">
          {!companyId && <p className="muted">Pick a company first.</p>}
          {companyId && term.length < SEARCH_MIN && <p className="muted">Type at least {SEARCH_MIN} letters, or a ticket number like BOS-12.</p>}
          {showRecent && (
            <section aria-label="Recent searches">
              <h3>
                Recent searches{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    clearRecent();
                    setRecent([]);
                    input.current?.focus();
                  }}
                >
                  Clear
                </button>
              </h3>
              <ul>
                {recent.map((r, i) => (
                  <li key={r} id={`search-hit-${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : undefined} onMouseMove={() => setActive(i)} onClick={() => rerun(r)}>
                    <span className="search-title">{r}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {error && (
            <p className="error" role="alert">
              {error}{" "}
              <button type="button" className="linkish" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </button>
            </p>
          )}
          {term.length >= SEARCH_MIN && loading && !results && <p className="muted">Searching…</p>}
          {results && !flat.length && !loading && <p className="muted">Nothing matches "{term}".</p>}
          {results &&
            GROUPS.map((g) =>
              hitsOf(results, g.key).length ? (
                <section key={g.key} aria-label={g.label}>
                  <h3>{g.label}</h3>
                  <ul>
                    {hitsOf(results, g.key).map((hit) => {
                      index += 1;
                      const i = index;
                      return (
                        <li key={hit.link} id={`search-hit-${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : undefined} onMouseMove={() => setActive(i)} onClick={() => pick(hit)}>
                          <span className="search-title">
                            <HitState hit={hit} />
                            {hit.ref && <span className="mono">{hit.ref} </span>}
                            {hit.title}
                          </span>
                          {(hit.snippet || (TIMED.has(g.key) && hit.at)) && (
                            <span className="search-snippet">
                              {hit.snippet}
                              {TIMED.has(g.key) && hit.at ? `${hit.snippet ? " · " : ""}${when(hit.at)}` : null}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null,
            )}
        </div>
        {/* (BOS-2378) The box shows a few of each kind; the Search page shows them all. Outside the listbox, as it isn't a hit.
            A server from before BOS-2378 sends no counts, so the link stays away rather than say a wrong number. */}
        {results?.counts && flat.length > 0 && (
          <p className="search-all">
            <a href={`#/${searchAddress({ q: term })}`} onClick={() => { rememberSearch(term); close(); }}>
              See all {Object.values(results.counts).reduce((a, b) => a + (b ?? 0), 0)} results
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
