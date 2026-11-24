// The search box (BOS-2192): Ctrl+K / Cmd+K from any screen, or the sidebar's search button, finds
// tickets, wiki pages and chat messages in the company on screen and jumps to the one picked; since BOS-2326
// also features, decisions (owner cards) and runs.
// Mounted once in App.tsx; the button lives in the sidebar and opens it through a window event, so
// neither has to pass state through the shell.
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api";

export type SearchHit = { id: string; title: string; snippet: string; link: string; ref?: string | null; exact?: boolean; who?: string; at?: string };
export type SearchResults = { q: string; tickets: SearchHit[]; wiki: SearchHit[]; chats: SearchHit[]; features?: SearchHit[]; decisions?: SearchHit[]; runs?: SearchHit[]; agents?: SearchHit[]; skills?: SearchHit[]; counts?: Partial<Record<SearchKind, number>> };
export type SearchKind = (typeof GROUPS)[number]["key"];
/** The box's name, on the sidebar button and the input alike. */
export const SEARCH_LABEL = "Search tickets, wiki, chats, features, decisions, runs, agents and skills";

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
export const GROUPS: Array<{ key: "tickets" | "wiki" | "chats" | "features" | "decisions" | "runs" | "agents" | "skills"; label: string }> = [
  { key: "tickets", label: "Tickets" },
  { key: "wiki", label: "Wiki" },
  { key: "chats", label: "Chats" },
  { key: "features", label: "Features" },
  { key: "decisions", label: "Decisions" },
  { key: "runs", label: "Runs" },
  { key: "agents", label: "Agents" },
  { key: "skills", label: "Skills" },
];
const hitsOf = (r: SearchResults, key: (typeof GROUPS)[number]["key"]) => r[key] ?? [];
/** When a decision was raised or a run started, short and in the owner's own time. */
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const TIMED = new Set(["decisions", "runs"]);

/** The Search page's date filter (BOS-2378): empty is any time. */
export type SearchSince = "" | "7d" | "30d";
/** The Search page's address for these words (BOS-2378), without the "#/". */
export function searchAddress(p: { q: string; kind?: SearchKind | ""; since?: SearchSince; n?: number }): string {
  const qs = new URLSearchParams({ q: p.q });
  if (p.kind) qs.set("kind", p.kind);
  if (p.since) qs.set("since", p.since);
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
    if (open) input.current?.focus();
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
  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    close();
    go(hit.link);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(flat[active]);
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
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            aria-activedescendant={flat[active] ? `search-hit-${active}` : undefined}
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
            <a href={`#/${searchAddress({ q: term })}`} onClick={close}>
              See all {Object.values(results.counts).reduce((a, b) => a + (b ?? 0), 0)} results
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
