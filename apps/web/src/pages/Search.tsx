// The Search page (BOS-2378): every match for some words, where the Ctrl+K box (SearchPalette) shows only the top few.
// #/search?q=…&kind=…&since=…&n=… — with no kind, each kind's first few hits and its count, with a link to see that
// kind alone; with a kind, `n` of its hits (25 more per "Show more"). The address holds everything, so Back, a
// bookmark and a reload all land on the same list.
//
// Only links and selects (the owner-control rules for this page): a hit is a link to the place the box opens,
// "Show more" is a link that raises `n`, and the words box submits with Enter.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { GROUPS, rememberSearch, SEARCH_MIN, searchAddress, TIMED, when, type SearchHit, type SearchKind, type SearchResults, type SearchSince } from "../components/SearchPalette";
import { hashQuery } from "../hooks";

/** Hits per "Show more". */
export const SEARCH_PAGE = 25;
/** The server's most per ask (search.ts SEARCH_PAGE_MAX): a bookmarked n above it loads this many, then 25 at a time. */
const ASK_MAX = 100;
const SINCE_DAYS: Record<Exclude<SearchSince, "">, number> = { "7d": 7, "30d": 30 };
const SINCE_OPTIONS: Array<{ value: SearchSince; label: string }> = [
  { value: "", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

type Params = { q: string; kind: SearchKind | ""; since: SearchSince; n: number };

/** What the address asks for; anything it can't read falls back to the plain search. */
export function readSearchParams(qs: URLSearchParams = hashQuery()): Params {
  const kind = qs.get("kind") ?? "";
  const since = qs.get("since") ?? "";
  const n = Number.parseInt(qs.get("n") ?? "", 10);
  return {
    q: qs.get("q") ?? "",
    kind: GROUPS.some((g) => g.key === kind) ? (kind as SearchKind) : "",
    since: since in SINCE_DAYS ? (since as SearchSince) : "",
    n: Number.isFinite(n) && n > SEARCH_PAGE ? n : SEARCH_PAGE,
  };
}

/** One search's answer: the first reply (for the counts) and, with a kind, every hit loaded so far. */
type Loaded = { key: string; since: string | null; results: SearchResults; hits: SearchHit[] };

export function SearchPage({ companyId, go }: { companyId: string | undefined; go: (to: string) => void }) {
  const [p, setP] = useState(readSearchParams);
  useEffect(() => {
    const on = () => setP(readSearchParams());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [draft, setDraft] = useState(p.q);
  useEffect(() => setDraft(p.q), [p.q]);

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(data);
  loaded.current = data;
  // Only the latest ask's answer is shown.
  const asked = useRef(0);

  const term = p.q.trim();
  const key = `${companyId}|${term}|${p.kind}|${p.since}`;
  useEffect(() => {
    const n = ++asked.current;
    if (!companyId || term.length < SEARCH_MIN) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    // The same search with a higher n only asks for the rest; anything else starts again.
    const have = loaded.current?.key === key ? loaded.current : null;
    if (have && (!p.kind || have.hits.length >= p.n)) return;
    // "Last 7 days" is fixed when the search starts, so a later "Show more" pages through the same list.
    const since = have ? have.since : p.since ? new Date(Date.now() - SINCE_DAYS[p.since] * 86_400_000).toISOString() : null;
    const offset = have?.hits.length ?? 0;
    const qs = new URLSearchParams({ q: term });
    if (p.kind) {
      qs.set("kind", p.kind);
      qs.set("offset", String(offset));
      qs.set("limit", String(Math.min(ASK_MAX, p.n - offset)));
    }
    if (since) qs.set("since", since);
    setLoading(true);
    setError(null);
    api<SearchResults>(`/api/companies/${companyId}/search?${qs}`).then(
      (r) => {
        if (n !== asked.current) return;
        const more = p.kind ? (r[p.kind] ?? []) : [];
        setData(have ? { ...have, hits: [...have.hits, ...more.filter((h) => !have.hits.some((x) => x.link === h.link))] } : { key, since, results: r, hits: more });
        setLoading(false);
      },
      (err: Error) => {
        if (n !== asked.current) return;
        setError(err.message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, p.n, attempt]);

  const to = (change: Partial<Params>) => go(searchAddress({ ...p, n: undefined, ...change }));
  const current = data?.key === key ? data : null;
  const counts = current?.results.counts;
  const countOf = (k: SearchKind) => counts?.[k] ?? (current?.results[k]?.length ?? 0);
  const total = counts ? GROUPS.reduce((a, g) => a + countOf(g.key), 0) : null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Search</h1>
          <p className="sub">Every ticket, wiki page, chat message, feature, decision, run, agent, skill and feedback note that matches your words.</p>
        </div>
      </header>
      <form
        className="search-filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          rememberSearch(draft);
          to({ q: draft.trim() });
        }}
      >
        <input type="search" aria-label="Words to search for" placeholder="Search words, or a ticket number like BOS-12" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <select aria-label="Kind" value={p.kind} onChange={(e) => to({ kind: e.target.value as SearchKind | "" })}>
          <option value="">All kinds{total === null ? "" : ` (${total})`}</option>
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
              {counts ? ` (${countOf(g.key)})` : ""}
            </option>
          ))}
        </select>
        <select aria-label="When" value={p.since} onChange={(e) => to({ since: e.target.value as SearchSince })}>
          {SINCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </form>

      {!companyId && <p className="muted">Pick a company first.</p>}
      {companyId && term.length < SEARCH_MIN && <p className="muted">Type at least {SEARCH_MIN} letters and press Enter, or a ticket number like BOS-12.</p>}
      {error && <LoadError what="the results" message={error} onRetry={() => setAttempt((a) => a + 1)} />}
      {loading && !current && <p className="muted">Searching…</p>}
      {current && total === 0 && <p className="muted">Nothing matches "{term}"{p.since ? " in that time" : ""}.</p>}

      {current && !p.kind &&
        GROUPS.map((g) => {
          const hits = current.results[g.key] ?? [];
          if (!hits.length) return null;
          const count = countOf(g.key);
          return (
            <section key={g.key} className="search-group" aria-label={g.label}>
              <h2>
                {g.label} ({count})
              </h2>
              <HitList kind={g.key} hits={hits} />
              {count > hits.length && (
                <p className="search-more">
                  <a href={`#/${searchAddress({ ...p, n: undefined, kind: g.key })}`}>
                    See all {count} {g.label.toLowerCase()}
                  </a>
                </p>
              )}
            </section>
          );
        })}

      {current && p.kind && (
        <section className="search-group" aria-label={GROUPS.find((g) => g.key === p.kind)!.label}>
          <h2>
            {GROUPS.find((g) => g.key === p.kind)!.label} ({countOf(p.kind)})
          </h2>
          <HitList kind={p.kind} hits={current.hits.slice(0, p.n)} />
          {Math.min(p.n, current.hits.length) < countOf(p.kind) && (
            <p className="search-more">
              {loading ? (
                <span className="muted">Loading…</span>
              ) : (
                <a href={`#/${searchAddress({ ...p, n: Math.min(p.n, current.hits.length) + SEARCH_PAGE })}`}>Show more</a>
              )}
            </p>
          )}
        </section>
      )}
    </>
  );
}

/** Each hit links where the Ctrl+K box would go (the same `link`), so it opens the same place. */
function HitList({ kind, hits }: { kind: SearchKind; hits: SearchHit[] }) {
  return (
    <ul className="search-list">
      {hits.map((hit) => (
        <li key={hit.link}>
          <a href={`#/${hit.link}`}>
            <span className="search-title">
              {hit.ref && <span className="mono">{hit.ref} </span>}
              {hit.title}
            </span>
            {(hit.snippet || (TIMED.has(kind) && hit.at)) && (
              <span className="search-snippet">
                {hit.snippet}
                {TIMED.has(kind) && hit.at ? `${hit.snippet ? " · " : ""}${when(hit.at)}` : null}
              </span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
